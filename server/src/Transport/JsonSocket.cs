using System.Buffers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace CodexPhoneBridge;

internal sealed class JsonSocket(WebSocket socket, CancellationToken cancellation) : IDisposable
{
    private readonly Channel<byte[]> outgoing = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(256) { SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly CancellationTokenSource stop = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
    private long queuedBytes;
    public bool Open => socket.State == WebSocketState.Open && !stop.IsCancellationRequested;
    public long QueuedBytes => queuedBytes;
    public string LastError { get; private set; } = "";
    public bool Send(JsonNode value)
    {
        if (!Open) return false;
        var bytes = value.Bytes();
        if (queuedBytes + bytes.Length > 16 * 1024 * 1024 || !outgoing.Writer.TryWrite(bytes)) { Dispose(); return false; }
        queuedBytes += bytes.Length;
        return true;
    }
    public async Task Run(Action<JsonNode> onMessage)
    {
        var writer = WriteLoop();
        byte[] chunk = ArrayPool<byte>.Shared.Rent(16384);
        try
        {
            while (Open)
            {
                using var data = new MemoryStream();
                ValueWebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(chunk.AsMemory(), stop.Token);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        outgoing.Writer.TryComplete();
                        await writer;
                        await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", stop.Token);
                        return;
                    }
                    if (result.MessageType != WebSocketMessageType.Text) throw new InvalidDataException("只接受 JSON 文本帧");
                    if (data.Length + result.Count > 100 * 1024 * 1024) throw new InvalidDataException("WebSocket 消息过大");
                    data.Write(chunk, 0, result.Count);
                } while (!result.EndOfMessage);
                try { var message = JsonNode.Parse(data.GetBuffer().AsSpan(0, (int)data.Length)); if (message is not null) onMessage(message); }
                catch (System.Text.Json.JsonException) { onMessage(J.O(("type", "invalid-json"))); }
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException) { LastError = e.Message; }
        finally { ArrayPool<byte>.Shared.Return(chunk); Dispose(); await writer; }
    }
    private async Task WriteLoop()
    {
        try { await foreach (var bytes in outgoing.Reader.ReadAllAsync(stop.Token)) { await socket.SendAsync(bytes.AsMemory(), WebSocketMessageType.Text, true, stop.Token); queuedBytes -= bytes.Length; } }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException) { Dispose(); }
    }
    public void Dispose() { if (!stop.IsCancellationRequested) { stop.Cancel(); outgoing.Writer.TryComplete(); socket.Abort(); socket.Dispose(); } }
}
