using System.Buffers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

// Raw proxy RPC and framed phone delivery have distinct endpoints. Phone
// transfers share one scheduler; state, replies and catalog cannot block each other.
internal sealed class JsonSocket(WebSocket socket, CancellationToken cancellation, bool flowControlled = false) : IDisposable
{
    // Keep enough data in flight for the public relay's round trip, while small
    // frames still let cancellation, catalog updates and heartbeats interleave.
    private const int ChunkCharacters = 16 * 1024, WindowCharacters = 256 * 1024;
    private sealed class Transfer(byte[] bytes, CancellationToken token, string requestId = "", bool urgent = false)
    {
        public readonly byte[] Bytes = bytes;
        public readonly string Text = Encoding.UTF8.GetString(bytes);
        public readonly CancellationToken Token = token;
        public readonly string RequestId = requestId;
        public readonly bool Urgent = urgent;
        public readonly TaskCompletionSource<bool> Done = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public long Id;
        public int Sent, Ack;
    }
    private readonly Queue<Transfer> normal = [], priority = [];
    private readonly Dictionary<long, Transfer> active = [];
    private readonly CancellationTokenSource stop = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
    private readonly SemaphoreSlim wake = new(0, 1);
    private TaskCompletionSource space = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private JsonObject? pong;
    private long nextId, normalBytes, priorityBytes;
    private bool disposed;
    public bool Open => socket.State == WebSocketState.Open && !stop.IsCancellationRequested;
    public string LastError { get; private set; } = "";

    // Used only for small proxy commands. No delivery state is advanced here.
    public bool Send(JsonNode value) => Queue(new(value.Bytes(), CancellationToken.None), false);
    public Task<bool> SendReliable(JsonNode value) => Deliver(value, CancellationToken.None, true);
    public async Task<bool> Deliver(JsonNode value, CancellationToken token, bool urgent = false)
    {
        var transfer = new Transfer(value.Bytes(), token, value.S("requestId"), urgent);
        using var registration = token.Register(Signal);
        while (Open && !token.IsCancellationRequested)
        {
            if (Queue(transfer, urgent)) return await transfer.Done.Task;
            try { await space.Task.WaitAsync(token); } catch (OperationCanceledException) { return false; }
        }
        return false;
    }
    private bool Queue(Transfer transfer, bool urgent)
    {
        if (!Open || transfer.Token.IsCancellationRequested) return false;
        long used = urgent ? priorityBytes : normalBytes;
        if ((urgent ? priority : normal).Count >= 128 || used > 0 && used + transfer.Bytes.Length > 16 * 1024 * 1024) return false;
        (urgent ? priority : normal).Enqueue(transfer);
        if (urgent) priorityBytes += transfer.Bytes.Length; else normalBytes += transfer.Bytes.Length;
        Signal(); return true;
    }
    private void Signal() { try { wake.Release(); } catch (SemaphoreFullException) { } }
    private bool Transport(JsonNode message)
    {
        if (!flowControlled) return false;
        if (message.S("type") == "transport:ping") { pong = J.O(("type", "transport:pong"), ("nonce", message.G("nonce"))); Signal(); return true; }
        if (message.S("type") != "transport:ack") return false;
        if (active.TryGetValue(message.N("id"), out var transfer))
        {
            long offset = message.N("offset", -1);
            if (offset >= transfer.Ack && offset <= transfer.Sent) { transfer.Ack = (int)offset; Signal(); }
        }
        return true;
    }
    public async Task Run(Action<JsonNode> onMessage)
    {
        var writer = WriteLoop(); byte[] chunk = ArrayPool<byte>.Shared.Rent(16384);
        try
        {
            while (Open)
            {
                using var data = new MemoryStream(); ValueWebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(chunk.AsMemory(), stop.Token);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    if (result.MessageType != WebSocketMessageType.Text || data.Length + result.Count > 100 * 1024 * 1024) throw new InvalidDataException("WebSocket JSON 消息无效");
                    data.Write(chunk, 0, result.Count);
                } while (!result.EndOfMessage);
                try { var message = JsonNode.Parse(data.GetBuffer().AsSpan(0, (int)data.Length)); if (message is not null && !Transport(message)) onMessage(message); }
                catch (System.Text.Json.JsonException) { onMessage(J.O(("type", "invalid-json"))); }
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException) { LastError = e.Message; }
        finally { ArrayPool<byte>.Shared.Return(chunk); Dispose(); await writer; }
    }
    private ValueTask Write(JsonNode value) => socket.SendAsync(value.Bytes().AsMemory(), WebSocketMessageType.Text, true, stop.Token);
    private void Finish(Transfer transfer, bool delivered)
    {
        active.Remove(transfer.Id);
        if (transfer.Urgent) priorityBytes -= transfer.Bytes.Length; else normalBytes -= transfer.Bytes.Length;
        transfer.Done.TrySetResult(delivered);
        var ready = space; space = new(TaskCreationOptions.RunContinuationsAsynchronously); ready.TrySetResult();
    }
    private void Start(Queue<Transfer> queue)
    {
        if (!queue.TryDequeue(out var transfer)) return;
        transfer.Id = ++nextId; active.Add(transfer.Id, transfer);
    }
    private async Task WriteLoop()
    {
        try
        {
            while (Open)
            {
                if (pong is not null) { var reply = pong; pong = null; await Write(reply); }
                // At most two logical messages are in flight. Urgent receipts get
                // their own slot even while a large state is still being read.
                if (!active.Values.Any(t => t.Urgent) && priority.Count > 0) Start(priority);
                if (!active.Values.Any(t => !t.Urgent) && normal.Count > 0) Start(normal);
                bool advanced = false;
                foreach (var transfer in active.Values.ToArray())
                {
                    if (transfer.Token.IsCancellationRequested)
                    {
                        if (flowControlled && transfer.Sent > 0) await Write(J.O(("type", "transport:cancel"), ("id", transfer.Id)));
                        Finish(transfer, false); advanced = true; continue;
                    }
                    if (!flowControlled)
                    {
                        await socket.SendAsync(transfer.Bytes.AsMemory(), WebSocketMessageType.Text, true, stop.Token);
                        Finish(transfer, true); advanced = true; continue;
                    }
                    if (transfer.Ack == transfer.Text.Length) { Finish(transfer, true); advanced = true; continue; }
                    int remaining = transfer.Text.Length - transfer.Sent;
                    if (remaining == 0 || transfer.Sent - transfer.Ack >= WindowCharacters) continue;
                    int count = Math.Min(ChunkCharacters, remaining);
                    if (count < remaining && char.IsHighSurrogate(transfer.Text[transfer.Sent + count - 1])) count--;
                    var frame = J.O(("type", "transport:chunk"), ("id", transfer.Id), ("offset", transfer.Sent), ("total", transfer.Text.Length), ("requestId", transfer.RequestId), ("data", transfer.Text.Substring(transfer.Sent, count)));
                    transfer.Sent += count; await Write(frame); advanced = true;
                }
                if (!advanced) await wake.WaitAsync(stop.Token);
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException or ObjectDisposedException) { LastError = e.Message; Dispose(); }
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true; stop.Cancel();
        foreach (var transfer in active.Values.Concat(normal).Concat(priority)) transfer.Done.TrySetResult(false);
        active.Clear(); normal.Clear(); priority.Clear(); space.TrySetResult(); Signal(); socket.Abort(); socket.Dispose();
    }
}
