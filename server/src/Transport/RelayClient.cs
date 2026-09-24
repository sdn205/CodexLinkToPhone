using System.Buffers.Binary;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace CodexPhoneBridge;

// CPR2: credits include queued and in-flight bytes. The common decoder never
// awaits tunnel I/O; each direction has its own bounded consumer.
internal sealed class RelayClient(Configuration config, CancellationToken cancellation)
{
    internal const int Window = 256 * 1024, Chunk = 16 * 1024, MaxTunnels = 128;
    private string agentName = "";
    public string Status { get; private set; } = "starting";
    public string Error { get; private set; } = "";
    public Action Changed { get; set; } = () => { };
    private void State(string state, string error = "")
    {
        Status = state; Error = error;
        Changed();
    }
    public async Task Run()
    {
        agentName = "codex-phone-" + Environment.MachineName; while (Encoding.UTF8.GetByteCount(agentName) > 64) agentName = agentName[..^1];
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                try { State("connecting"); using var session = new Session(config, cancellation); await session.Connect(agentName); State("connected"); await session.Run(); }
                catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { break; }
                catch (Exception e) when (e is IOException or SocketException or TimeoutException or OperationCanceledException or ObjectDisposedException or InvalidOperationException) { State("disconnected", e.Message); }
                await Task.Delay(config.ReconnectDelay + Random.Shared.Next(250), cancellation);
            }
        }
        finally { State("stopped"); }
    }
    private sealed record Frame(byte Type, uint Id, byte[] Data);
    private static byte[] Credit(ulong n) { byte[] data = new byte[8]; BinaryPrimitives.WriteUInt64BigEndian(data, n); return data; }
    private static ulong Limit(byte[] data) => data.Length == 8 ? BinaryPrimitives.ReadUInt64BigEndian(data) : throw new IOException("CPR2 credit length invalid");
    private sealed class Session(Configuration config, CancellationToken cancellation) : IDisposable
    {
        private readonly TcpClient control = new() { NoDelay = true };
        private readonly CancellationTokenSource stop = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        private readonly Dictionary<uint, Tunnel> tunnels = [];
        private readonly Queue<Frame> commands = new();
        private readonly Dictionary<uint, Frame> credits = [];
        private readonly Dictionary<uint, Queue<Frame>> data = [];
        private readonly Queue<uint> ready = new();
        private readonly SemaphoreSlim wake = new(0, 1);
        private int queuedBytes;
        private bool disposed;
        public CancellationToken Token => stop.Token;
        public async Task Connect(string name)
        {
            control.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.KeepAlive, true);
            await control.ConnectAsync(config.RelayServer, config.AgentPort, Token).AsTask().WaitAsync(TimeSpan.FromSeconds(15), Token);
            await Write(new(1, 0, Encoding.UTF8.GetBytes(name)));
            var challenge = await Read().WaitAsync(TimeSpan.FromSeconds(15), Token);
            if (challenge.Type != 2 || challenge.Id != 0 || challenge.Data.Length != 32) throw new IOException("CPR2 authentication challenge invalid");
            byte[] input = [.. challenge.Data, .. Encoding.UTF8.GetBytes(name), .. "CPR2"u8.ToArray()];
            await Write(new(3, 0, HMACSHA256.HashData(Encoding.UTF8.GetBytes(config.RelaySecret), input)));
            var auth = await Read().WaitAsync(TimeSpan.FromSeconds(15), Token);
            if (auth.Type != 4 || auth.Id != 0 || auth.Data.Length != 0) throw new IOException("Relay authentication failed");
        }
        public async Task Run()
        {
            var writer = Writer();
            try
            {
                while (!Token.IsCancellationRequested)
                {
                    var f = await Read().WaitAsync(TimeSpan.FromSeconds(90), Token);
                    if (f.Type is 9 or 10) { if (f.Id != 0 || f.Data.Length > 32) throw new IOException("CPR2 heartbeat invalid"); if (f.Type == 9) Send(new(10, 0, f.Data)); continue; }
                    if (f.Id == 0) throw new IOException("CPR2 tunnel id missing");
                    if (f.Type == 5)
                    {
                        ulong grant = Limit(f.Data); if (grant != Window) throw new IOException("CPR2 initial window invalid");
                        if (tunnels.ContainsKey(f.Id) || tunnels.Count >= MaxTunnels) { Send(new(8, f.Id, [])); continue; }
                        var tunnel = new Tunnel(this, f.Id, grant); tunnels.Add(f.Id, tunnel); EventLoop.Observe(tunnel.Run(config.LocalHost, config.Port)); continue;
                    }
                    if (!tunnels.TryGetValue(f.Id, out var target)) continue;
                    switch (f.Type)
                    {
                        case 7: target.Receive(f.Data); break;
                        case 12: target.Grant(Limit(f.Data)); break;
                        case 13: if (f.Data.Length != 0) throw new IOException("CPR2 FIN invalid"); target.Finish(); break;
                        case 8: if (f.Data.Length > 1) throw new IOException("CPR2 RESET invalid"); target.Close(false); break;
                        default: throw new IOException("CPR2 frame direction invalid");
                    }
                }
            }
            finally { Dispose(); await writer; }
        }
        public void Remove(uint id, bool reset)
        {
            tunnels.Remove(id); credits.Remove(id);
            if (reset)
            {
                if (data.Remove(id, out var queue)) queuedBytes -= queue.Sum(f => f.Data.Length);
                var retained = ready.Where(value => value != id).ToArray(); ready.Clear(); foreach (uint value in retained) ready.Enqueue(value);
            }
        }
        public void Send(byte type, uint id, byte[] payload) => Send(new(type, id, payload));
        private void Send(Frame f)
        {
            if (disposed) return;
            if (f.Type == 12) credits[f.Id] = f;
            else if (f.Type is 7 or 13)
            {
                if (queuedBytes + f.Data.Length > Window * MaxTunnels) throw new IOException("CPR2 aggregate send budget exceeded");
                if (!data.TryGetValue(f.Id, out var queue)) { data[f.Id] = queue = new(); ready.Enqueue(f.Id); }
                queue.Enqueue(f); queuedBytes += f.Data.Length;
            }
            else { if (commands.Count >= 512) throw new IOException("CPR2 control budget exceeded"); commands.Enqueue(f); }
            if (wake.CurrentCount == 0) wake.Release();
        }
        private Frame? Next()
        {
            if (commands.TryDequeue(out var command)) return command;
            if (credits.Count > 0) { var entry = credits.First(); credits.Remove(entry.Key); return entry.Value; }
            if (!ready.TryDequeue(out uint id)) return null;
            var queue = data[id]; var frame = queue.Dequeue(); if (queue.Count == 0) data.Remove(id); else ready.Enqueue(id); return frame;
        }
        private async Task Writer()
        {
            try
            {
                while (!Token.IsCancellationRequested)
                {
                    var frame = Next(); if (frame is null) { await wake.WaitAsync(Token); continue; }
                    await Write(frame).WaitAsync(TimeSpan.FromSeconds(60), Token); if (frame.Type == 7) queuedBytes -= frame.Data.Length;
                }
            }
            catch (Exception e) when (e is IOException or SocketException or OperationCanceledException or ObjectDisposedException or TimeoutException or InvalidOperationException) { if (!disposed) Console.Error.WriteLine("Relay writer stopped: " + e.Message); Dispose(); }
        }
        private async Task Write(Frame f)
        {
            byte[] head = new byte[16]; "CPR2"u8.CopyTo(head); head[4] = 2; head[5] = f.Type;
            BinaryPrimitives.WriteUInt32BigEndian(head.AsSpan(8), f.Id); BinaryPrimitives.WriteInt32BigEndian(head.AsSpan(12), f.Data.Length);
            var stream = control.GetStream(); await stream.WriteAsync(head, Token); if (f.Data.Length != 0) await stream.WriteAsync(f.Data, Token);
        }
        private async Task<Frame> Read()
        {
            byte[] head = new byte[16]; var stream = control.GetStream(); await stream.ReadExactlyAsync(head, Token);
            int size = BinaryPrimitives.ReadInt32BigEndian(head.AsSpan(12)); byte type = head[5]; uint id = BinaryPrimitives.ReadUInt32BigEndian(head.AsSpan(8));
            if (!head.AsSpan(0, 4).SequenceEqual("CPR2"u8) || head[4] != 2 || head[6] != 0 || head[7] != 0 || size < 0 || size > 65536 || type is < 1 or > 13) throw new IOException("CPR2 protocol header invalid (paired relay upgrade required)");
            byte[] payload = new byte[size]; await stream.ReadExactlyAsync(payload, Token); if (type == 11) throw new IOException("Relay rejected: " + Encoding.UTF8.GetString(payload)); return new(type, id, payload);
        }
        public void Dispose()
        {
            if (disposed) return; disposed = true; stop.Cancel(); control.Dispose(); foreach (var tunnel in tunnels.Values.ToArray()) tunnel.Close(false);
            tunnels.Clear(); commands.Clear(); credits.Clear(); data.Clear(); ready.Clear(); queuedBytes = 0;
        }
    }
    private sealed class Tunnel(Session owner, uint id, ulong sendLimit)
    {
        private readonly TcpClient local = new() { NoDelay = true };
        private readonly CancellationTokenSource stop = CancellationTokenSource.CreateLinkedTokenSource(owner.Token);
        private readonly byte[] incoming = new byte[Window];
        private readonly SemaphoreSlim readable = new(0, 1);
        private readonly SemaphoreSlim credit = new(0, 1);
        private ulong sent, received, consumed;
        private bool connected, remoteFin, closed;
        public void Grant(ulong limit) { if (limit < sendLimit || limit > sent + Window) { Close(true, "credit violation"); return; } sendLimit = limit; if (credit.CurrentCount == 0) credit.Release(); }
        public void Receive(byte[] bytes)
        {
            if (!connected || remoteFin || bytes.Length == 0 || bytes.Length > Chunk || received + (ulong)bytes.Length > consumed + Window) { Close(true, "receive window violation"); return; }
            int at = (int)(received % Window), first = Math.Min(bytes.Length, Window - at);
            bytes.AsSpan(0, first).CopyTo(incoming.AsSpan(at)); bytes.AsSpan(first).CopyTo(incoming);
            received += (ulong)bytes.Length;
            if (readable.CurrentCount == 0) readable.Release();
        }
        public void Finish() { remoteFin = true; if (readable.CurrentCount == 0) readable.Release(); }
        public async Task Run(string host, int port)
        {
            try { await local.ConnectAsync(host, port, stop.Token).AsTask().WaitAsync(TimeSpan.FromSeconds(5), stop.Token); if (closed) return; connected = true; owner.Send(6, id, Credit(Window)); await Task.WhenAll(ReadLocal(), WriteLocal()); Close(false); }
            catch (Exception e) when (e is IOException or SocketException or OperationCanceledException or ObjectDisposedException or TimeoutException or InvalidOperationException) { Close(true, e.GetType().Name); }
        }
        private async Task ReadLocal()
        {
            byte[] buffer = new byte[Chunk];
            try
            {
                while (!closed)
                {
                    while (sent == sendLimit) await credit.WaitAsync(stop.Token);
                    int count = await local.GetStream().ReadAsync(buffer.AsMemory(0, (int)Math.Min((ulong)Chunk, sendLimit - sent)), stop.Token);
                    if (count == 0) { owner.Send(13, id, []); return; }
                    sent += (ulong)count; owner.Send(7, id, buffer.AsSpan(0, count).ToArray());
                }
            }
            catch { Close(true, "local read ended"); throw; }
        }
        private async Task WriteLocal()
        {
            try
            {
                while (!closed)
                {
                    if (consumed == received) { if (remoteFin) break; await readable.WaitAsync(stop.Token); continue; }
                    int at = (int)(consumed % Window), count = (int)Math.Min((ulong)Math.Min(Chunk, Window - at), received - consumed);
                    await local.GetStream().WriteAsync(incoming.AsMemory(at, count), stop.Token);
                    consumed += (ulong)count; owner.Send(12, id, Credit(consumed + Window));
                }
                if (!closed) local.Client.Shutdown(SocketShutdown.Send);
            }
            catch { Close(true, "local write ended"); throw; }
        }
        public void Close(bool notify, string reason = "")
        {
            if (closed) return; closed = true; stop.Cancel(); local.Dispose(); owner.Remove(id, notify);
            if (notify) { owner.Send(8, id, []); Console.Error.WriteLine($"Relay tunnel {id} reset: {reason}; pending={received - consumed}"); }
        }
    }
}
