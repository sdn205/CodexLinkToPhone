using System.Collections.Concurrent;

namespace CodexPhoneBridge;

// All bridge state lives on one event loop. Network waits yield the loop, so a
// pending RPC never prevents its response or a live notification being handled.
internal sealed class EventLoop : SynchronizationContext, IDisposable
{
    private readonly BlockingCollection<(SendOrPostCallback, object?)> queue = new();
    public override void Post(SendOrPostCallback callback, object? state) { try { if (!queue.IsAddingCompleted) queue.Add((callback, state)); } catch (InvalidOperationException) { } }
    public Task Invoke(Func<Task> action)
    {
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Post(async _ => { try { await action(); done.TrySetResult(); } catch (Exception e) { done.TrySetException(e); } }, null);
        return done.Task;
    }
    public void Run(Func<Task> action)
    {
        SetSynchronizationContext(this);
        var task = action();
        _ = task.ContinueWith(_ => queue.CompleteAdding(), TaskScheduler.Default);
        foreach (var (callback, state) in queue.GetConsumingEnumerable()) callback(state);
        task.GetAwaiter().GetResult();
        SetSynchronizationContext(null);
    }
    public void Dispose() => queue.Dispose();
    public static async void Observe(Task task) { try { await task; } catch (OperationCanceledException) { } catch (Exception e) { Console.Error.WriteLine(e); } }
}
