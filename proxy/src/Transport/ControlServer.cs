using System.Buffers;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;

namespace CodexPhoneProxy.Transport;

internal sealed class ControlPeer(WebSocket socket, int bufferLimit) : IDisposable
{
    private readonly Channel<byte[]> outgoing = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(256)
    { SingleReader = false, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
    private long bufferedBytes;
    private int closed;
    public bool Closed => Volatile.Read(ref closed) != 0;
    public bool Send(byte[] bytes)
    {
        if (Closed) return false;
        // Like the JS proxy, allow one large response; drop a client already behind.
        if (Interlocked.Read(ref bufferedBytes) > bufferLimit) { Dispose(); return false; }
        Interlocked.Add(ref bufferedBytes, bytes.Length);
        if (outgoing.Writer.TryWrite(bytes)) return true;
        Interlocked.Add(ref bufferedBytes, -bytes.Length);
        Dispose();
        return false;
    }
    public async Task RunAsync(Func<byte[], Task> receive, CancellationToken token)
    {
        var writer = WriteAsync(token);
        var buffer = ArrayPool<byte>.Shared.Rent(16 * 1024);
        var message = new ArrayBufferWriter<byte>();
        try
        {
            while (!Closed && !token.IsCancellationRequested)
            {
                var result = await socket.ReceiveAsync(buffer.AsMemory(), token);
                if (result.MessageType == WebSocketMessageType.Close) break;
                if (message.WrittenCount + result.Count > LineReader.MaxMessageBytes) throw new IOException("control message exceeds 100 MiB");
                message.Write(buffer.AsSpan(0, result.Count));
                if (!result.EndOfMessage) continue;
                await receive(message.WrittenMemory.ToArray());
                if (message.Capacity > 256 * 1024) message = new(); else message.Clear();
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
            Dispose();
            try { await writer; } catch (Exception error) when (error is WebSocketException or OperationCanceledException or ObjectDisposedException or IOException) { }
        }
    }
    private async Task WriteAsync(CancellationToken token)
    {
        try
        {
            await foreach (var bytes in outgoing.Reader.ReadAllAsync(token))
            {
                try { await socket.SendAsync(bytes.AsMemory(), WebSocketMessageType.Text, true, token); }
                finally { Interlocked.Add(ref bufferedBytes, -bytes.Length); }
            }
        }
        finally { Dispose(); }
    }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref closed, 1) != 0) return;
        outgoing.Writer.TryComplete();
        socket.Abort();
        socket.Dispose();
        while (outgoing.Reader.TryRead(out var bytes)) Interlocked.Add(ref bufferedBytes, -bytes.Length);
    }
}

internal sealed class ControlServer(string token, int heartbeatMs, int bufferLimit) : IDisposable
{
    private readonly TcpListener listener = new(IPAddress.Loopback, 0);
    private readonly SemaphoreSlim connections = new(64);
    public int Port => ((IPEndPoint)listener.LocalEndpoint).Port;
    public void Start() => listener.Start();
    public async Task RunAsync(Func<ControlPeer, Task> connected, Func<ControlPeer, byte[], Task> receive,
        Func<ControlPeer, Task> disconnected, Action<Exception> error, CancellationToken cancellation)
    {
        while (!cancellation.IsCancellationRequested)
        {
            var client = await listener.AcceptTcpClientAsync(cancellation);
            if (!connections.Wait(0)) { client.Dispose(); continue; }
            _ = ServeAsync(client, connected, receive, disconnected, error, cancellation);
        }
    }
    private async Task ServeAsync(TcpClient client, Func<ControlPeer, Task> connected, Func<ControlPeer, byte[], Task> receive,
        Func<ControlPeer, Task> disconnected, Action<Exception> error, CancellationToken cancellation)
    {
        ControlPeer? peer = null;
        try
        {
            client.NoDelay = true;
            var stream = client.GetStream();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            var request = new ArrayBufferWriter<byte>();
            var next = new byte[1];
            // Don't consume any WebSocket frame bytes that follow the HTTP header.
            while (request.WrittenCount < 16 * 1024)
            {
                if (await stream.ReadAsync(next, timeout.Token) == 0) return;
                request.Write(next);
                if (request.WrittenCount >= 4 && request.WrittenSpan[^4..].SequenceEqual("\r\n\r\n"u8)) break;
            }
            var lines = Encoding.ASCII.GetString(request.WrittenSpan).Split("\r\n", StringSplitOptions.None);
            var first = lines[0].Split(' ');
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var line in lines.Skip(1))
            {
                var colon = line.IndexOf(':');
                if (colon > 0) headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
            }
            headers.TryGetValue("Sec-WebSocket-Key", out var key);
            var validKey = false;
            try { validKey = key is not null && Convert.FromBase64String(key).Length == 16; } catch (FormatException) { }
            if (first.Length != 3 || first[0] != "GET" || first[2] != "HTTP/1.1" || !validKey ||
                !headers.TryGetValue("Upgrade", out var upgrade) || !upgrade.Equals("websocket", StringComparison.OrdinalIgnoreCase) ||
                !headers.TryGetValue("Connection", out var connection) || !connection.Split(',').Any(part => part.Trim().Equals("upgrade", StringComparison.OrdinalIgnoreCase)) ||
                !headers.TryGetValue("Sec-WebSocket-Version", out var version) || version != "13" ||
                !request.WrittenSpan[^4..].SequenceEqual("\r\n\r\n"u8))
            {
                await stream.WriteAsync("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"u8.ToArray(), timeout.Token);
                return;
            }
            var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"), timeout.Token);
            using var socket = WebSocket.CreateFromStream(stream, new WebSocketCreationOptions
            {
                IsServer = true, KeepAliveInterval = TimeSpan.FromMilliseconds(heartbeatMs),
                KeepAliveTimeout = TimeSpan.FromMilliseconds(heartbeatMs)
            });
            var url = new Uri("http://127.0.0.1" + first[1]);
            var suppliedToken = url.Query.TrimStart('?').Split('&').Select(part => part.Split('=', 2))
                .FirstOrDefault(parts => Uri.UnescapeDataString(parts[0]) == "token");
            if (suppliedToken is null || suppliedToken.Length != 2 ||
                !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(Uri.UnescapeDataString(suppliedToken[1])), Encoding.UTF8.GetBytes(token)))
            {
                await socket.CloseOutputAsync(WebSocketCloseStatus.PolicyViolation, "bad token", timeout.Token);
                return;
            }
            peer = new(socket, bufferLimit);
            await connected(peer);
            await peer.RunAsync(data => receive(peer, data), cancellation);
        }
        catch (Exception exception) when (exception is IOException or WebSocketException or OperationCanceledException or SocketException or ObjectDisposedException or UriFormatException)
        { if (!cancellation.IsCancellationRequested) error(exception); }
        finally
        {
            if (peer is not null) { peer.Dispose(); await disconnected(peer); }
            client.Dispose();
            connections.Release();
        }
    }
    public void Dispose() => listener.Stop();
}
