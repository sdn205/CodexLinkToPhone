using System.Buffers;
using System.Threading.Channels;

namespace CodexPhoneProxy.Transport;

internal sealed class LineWriter : IAsyncDisposable
{
    private readonly Channel<byte[]> queue = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(8)
    { SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly CancellationTokenSource stopping = new();
    private readonly Task task;
    public LineWriter(Stream stream, Action<Exception> onError)
    {
        task = Task.Run(async () =>
        {
            try
            {
                await foreach (var line in queue.Reader.ReadAllAsync(stopping.Token))
                {
                    await stream.WriteAsync(line, stopping.Token);
                    await stream.WriteAsync("\n"u8.ToArray(), stopping.Token);
                    await stream.FlushAsync(stopping.Token);
                }
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
            catch (Exception error) { queue.Writer.TryComplete(error); onError(error); }
        });
    }
    public ValueTask WriteAsync(byte[] line, CancellationToken cancellation) => queue.Writer.WriteAsync(line, cancellation);
    public async ValueTask DisposeAsync()
    {
        queue.Writer.TryComplete();
        try { await task.WaitAsync(TimeSpan.FromMilliseconds(500)); }
        catch (TimeoutException) { await stopping.CancelAsync(); }
    }
}

internal static class LineReader
{
    public const int MaxMessageBytes = 100 * 1024 * 1024;
    public static async Task ReadAsync(Stream stream, Func<byte[], Task> receive, CancellationToken token)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(16 * 1024);
        var pending = new ArrayBufferWriter<byte>();
        try
        {
            while (true)
            {
                var count = await stream.ReadAsync(buffer.AsMemory(), token);
                if (count == 0) break;
                var start = 0;
                for (var index = 0; index < count; index++)
                {
                    if (buffer[index] != (byte)'\n') continue;
                    Append(pending, buffer.AsSpan(start, index - start));
                    var length = pending.WrittenCount;
                    if (length > 0 && pending.WrittenSpan[length - 1] == (byte)'\r') length--;
                    await receive(pending.WrittenMemory[..length].ToArray());
                    // Don't retain a giant history-response buffer for the whole session.
                    if (pending.Capacity > 256 * 1024) pending = new(); else pending.Clear();
                    start = index + 1;
                }
                Append(pending, buffer.AsSpan(start, count - start));
            }
            if (pending.WrittenCount > 0) await receive(pending.WrittenMemory.ToArray());
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }
    private static void Append(ArrayBufferWriter<byte> pending, ReadOnlySpan<byte> bytes)
    {
        if (pending.WrittenCount + bytes.Length > MaxMessageBytes) throw new IOException("stdio message exceeds 100 MiB");
        pending.Write(bytes);
    }
}
