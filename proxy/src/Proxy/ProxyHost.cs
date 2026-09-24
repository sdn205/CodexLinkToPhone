using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using CodexPhoneProxy.Protocol;
using CodexPhoneProxy.Runtime;
using CodexPhoneProxy.Transport;

namespace CodexPhoneProxy.Proxy;

internal sealed partial class ProxyHost : IAsyncDisposable
{
    private sealed record Work(Func<Task> Action, TaskCompletionSource Done);
    private sealed record ParentRequest(string Method, JsonElement Parameters, long CreatedAt);
    private sealed record ControlRequest(ControlPeer Peer, JsonElement Id, string Method, JsonElement Parameters,
        bool SelectThread, long Deadline);
    private sealed record Abandoned(ControlRequest Request, long ExpiresAt);
    private sealed record ServerRequest(JsonElement Request, long Sequence);
    private readonly ProxyOptions options;
    private readonly ProxyLog log;
    private readonly ProxyState state;
    private readonly ReplayHistory history;
    private readonly ForwardProjection forwarding;
    private readonly ControlServer server;
    private readonly string registration;
    private readonly CancellationTokenSource stopping = new();
    private readonly Channel<Work> events = Channel.CreateBounded<Work>(new BoundedChannelOptions(64)
        { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly HashSet<ControlPeer> clients = new();
    private readonly Dictionary<string, ParentRequest> parentPending = new();
    private readonly Dictionary<string, ControlRequest> controlPending = new();
    private readonly Dictionary<string, Abandoned> abandoned = new();
    private readonly Dictionary<string, ServerRequest> serverPending = new();
    private readonly Dictionary<string, JsonElement> controlResponded = new();
    private readonly Queue<string> respondedOrder = new();
    private Process? child;
    private ProcessJob? job;
    private LineWriter? parentOutput, childInput;
    private long nextControlId = -1, stateDue, lastStateWrite;
    private int exitCode, stopped;
    private bool autoStartRequested;
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public ProxyHost(ProxyOptions options)
    {
        this.options = options;
        log = new(options.LogPath);
        var id = $"{Environment.ProcessId}-{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8))}";
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        state = new(id, token);
        history = new(options.HistoryCount, options.HistoryBytes);
        forwarding = new(options.ForwardedBytes);
        server = new(token, options.HeartbeatMs, options.ClientBufferedBytes);
        registration = Path.Combine(options.StatePath, id + ".json");
    }
    public async Task<int> RunAsync(string[] args)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(registration)!);
        server.Start();
        state.ControlUrl = $"ws://127.0.0.1:{server.Port}";
        job = new();
        child = Process.Start(ChildProcess.StartInfo(options.Codex, args)) ?? throw new IOException("Codex 启动失败");
        job.Assign(child);
        state.UpstreamPid = child.Id;
        state.Connected = true;
        WriteState();
        log.Write($"proxy_start pid={Environment.ProcessId} upstream={child.Id}");
        parentOutput = new(Console.OpenStandardOutput(), error => { log.Write("parent_output_error " + error.Message); Stop(1); });
        childInput = new(child.StandardInput.BaseStream, error => { log.Write("upstream_input_error " + error.Message); Stop(1); });
        _ = GuardAsync(() => server.RunAsync(peer => Post(() => Connect(peer)), (peer, data) => Post(() => HandleControl(peer, data)),
            peer => Post(() => Disconnect(peer)), error => log.Write("control_error " + error.Message), stopping.Token));
        _ = GuardAsync(async () =>
        {
            await LineReader.ReadAsync(Console.OpenStandardInput(), data => Post(() => HandleParent(data)), stopping.Token);
            Stop(0);
        });
        _ = GuardAsync(async () =>
        {
            await LineReader.ReadAsync(child.StandardOutput.BaseStream, data => Post(() => HandleChild(data)), stopping.Token);
            await child.WaitForExitAsync(stopping.Token);
            Stop(child.ExitCode);
        });
        _ = GuardAsync(() => child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError(), stopping.Token));
        _ = GuardAsync(async () =>
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(50));
            while (await timer.WaitForNextTickAsync(stopping.Token)) await Post(Tick);
        });
        try
        {
            await foreach (var work in events.Reader.ReadAllAsync(stopping.Token))
            {
                try { await work.Action(); work.Done.TrySetResult(); }
                catch (Exception error) { work.Done.TrySetException(error); throw; }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception error) { log.Write("proxy_fatal " + error); Stop(1); }
        finally
        {
            foreach (var (key, request) in controlPending.ToArray()) Fail(key, request, "Codex Phone 代理正在关闭", -32096);
            events.Writer.TryComplete();
            while (events.Reader.TryRead(out var pending)) pending.Done.TrySetCanceled();
        }
        return exitCode;
    }
    public void Stop(int code)
    {
        if (Interlocked.Exchange(ref stopped, 1) != 0) return;
        exitCode = code;
        stopping.Cancel();
    }
    private async Task GuardAsync(Func<Task> action)
    {
        try { await action(); }
        catch (Exception error) when (stopping.IsCancellationRequested && error is OperationCanceledException or ObjectDisposedException or IOException or ChannelClosedException) { }
        catch (Exception error) { log.Write("transport_error " + error.Message); Stop(1); }
    }
    private async Task Post(Func<Task> action)
    {
        if (stopping.IsCancellationRequested) return;
        var work = new Work(action, new(TaskCreationOptions.RunContinuationsAsynchronously));
        await events.Writer.WriteAsync(work, stopping.Token);
        await work.Done.Task.WaitAsync(stopping.Token);
    }
    private Task Connect(ControlPeer peer)
    {
        clients.Add(peer);
        Send(peer, Json.Obj(("type", "hello"), ("state", state.Snapshot())));
        return Task.CompletedTask;
    }
    private Task Disconnect(ControlPeer peer)
    {
        clients.Remove(peer);
        foreach (var (key, request) in controlPending.ToArray())
            if (ReferenceEquals(request.Peer, peer)) Abandon(key, request);
        return Task.CompletedTask;
    }
    private static bool IsRequest(JsonElement message) => message.Has("id") && message.Str("method").Length > 0;
    private static bool IsResponse(JsonElement message) => message.Has("id") && (message.Has("result") || message.Has("error"));
    private static JsonDocument? Parse(byte[] data) { try { return JsonDocument.Parse(data); } catch (JsonException) { return null; } }
    private void Send(ControlPeer peer, JsonElement message) => peer.Send(Json.Encode(message));
    private long Broadcast(JsonElement payload)
    {
        var bytes = history.Record(payload);
        foreach (var peer in clients) peer.Send(bytes);
        return history.Sequence;
    }
    private async Task WriteParent(byte[] data) => await parentOutput!.WriteAsync(data, stopping.Token);
    private async Task WriteChild(byte[] data) => await childInput!.WriteAsync(data, stopping.Token);

    private async Task HandleParent(byte[] data)
    {
        using var document = Parse(data);
        var message = document?.RootElement ?? default;
        var key = message.Get("id").Text();
        if (IsResponse(message))
        {
            if (controlResponded.Remove(key, out var controlled))
            {
                Broadcast(Json.Obj(("type", "server-response-dropped"), ("owner", "stdio"), ("response", message), ("request", controlled)));
                return;
            }
            if (serverPending.Remove(key, out var request))
                Broadcast(Json.Obj(("type", "server-response"), ("owner", "stdio"), ("response", message), ("request", request.Request)));
        }
        else if (IsRequest(message))
        {
            var parameters = message.Get("params");
            if (!parameters.Present()) parameters = Json.EmptyObject;
            parentPending[key] = new(message.Str("method"), parameters.Clone(), Now);
            Broadcast(Json.Obj(("type", "stdio-request"), ("method", message.Get("method")), ("id", message.Get("id")), ("params", message.Get("params"))));
        }
        await WriteChild(data);
    }
    private async Task HandleChild(byte[] data)
    {
        using var document = Parse(data);
        var message = document?.RootElement ?? default;
        if (!message.Present()) { await WriteParent(data); return; }
        var key = message.Get("id").Text();
        if (IsResponse(message))
        {
            if (controlPending.Remove(key, out var control))
            {
                Send(control.Peer, Json.With(message, ("id", control.Id)));
                Broadcast(Json.Obj(("type", "control-response"), ("method", control.Method), ("id", control.Id),
                    ("result", message.Get("result")), ("error", message.Get("error"))));
                ObserveResponse(control.Method, message, control.Parameters, control.SelectThread);
                forwarding.ObserveResponse(control.Parameters, message);
                return;
            }
            if (abandoned.Remove(key, out var late) || (message.Get("id").ValueKind == JsonValueKind.Number && message.Get("id").Number() < 0))
            {
                if (late is not null)
                {
                    ObserveResponse(late.Request.Method, message, late.Request.Parameters, late.Request.SelectThread);
                    forwarding.ObserveResponse(late.Request.Parameters, message);
                }
                Broadcast(Json.Obj(("type", "control-response-abandoned"), ("method", late?.Request.Method ?? ""),
                    ("id", late?.Request.Id ?? default), ("error", message.Get("error"))));
                return;
            }
            if (parentPending.Remove(key, out var parent))
            {
                Broadcast(Json.Obj(("type", "stdio-response"), ("method", parent.Method), ("id", message.Get("id")),
                    ("requestParams", parent.Parameters), ("requestStartedAt", parent.CreatedAt),
                    ("result", message.Get("result")), ("error", message.Get("error"))));
                if (parent.Method == "thread/revert" && message.Get("result").Get("thread").Str("id").Length > 0 && !message.Get("error").Present())
                {
                    var revertedThread = message.Get("result").Get("thread");
                    var revertedParameters = Json.Obj(("threadId", revertedThread.Get("id")),
                        ("beforeTurnId", parent.Parameters.Get("beforeTurnId")), ("thread", revertedThread));
                    var notification = Json.Obj(("method", "proxy/threadReverted"), ("params", revertedParameters));
                    Broadcast(Json.Obj(("type", "notification"), ("notification", notification)));
                }
                ObserveResponse(parent.Method, message, parent.Parameters, true);
                var decorated = forwarding.DecorateResponse(parent.Method, message);
                if (!decorated.Equals(message)) { await WriteParent(Json.Encode(decorated)); return; }
            }
        }
        else if (IsRequest(message))
        {
            controlResponded.Remove(key);
            serverPending[key] = new(message.Clone(), history.Sequence + 1);
            Broadcast(Json.Obj(("type", "server-request"), ("request", message)));
        }
        else if (message.Str("method").Length > 0)
        {
            var projected = forwarding.LiveProjection(message);
            if (projected.Present()) await WriteParent(Json.Encode(projected));
            ObserveNotification(message);
            var notificationBytes = history.RecordNotification(message);
            foreach (var peer in clients) peer.Send(notificationBytes);
        }
        await WriteParent(data);
    }
    private async Task HandleControl(ControlPeer peer, byte[] data)
    {
        if (peer.Closed) return;
        using var document = Parse(data);
        var message = document?.RootElement ?? default;
        if (!message.Present()) return;
        switch (message.Str("type"))
        {
            case "get-state":
                Send(peer, Json.Obj(("type", "hello"), ("state", state.Snapshot())));
                if (message.Get("includeHistory").True())
                    Send(peer, history.Snapshot(message, serverPending.Values.Select(request => (request.Sequence, request.Request))));
                return;
            case "server-response":
                var requestKey = message.Get("requestId").Text();
                if (!serverPending.Remove(requestKey, out var request)) return;
                var response = message.Has("error")
                    ? Json.Obj(("id", message.Get("requestId")), ("error", message.Get("error")))
                    : Json.Obj(("id", message.Get("requestId")), ("result", message.Get("result")));
                controlResponded[requestKey] = request.Request;
                respondedOrder.Enqueue(requestKey);
                while (respondedOrder.Count > 500) controlResponded.Remove(respondedOrder.Dequeue());
                await WriteChild(Json.Encode(response));
                Broadcast(Json.Obj(("type", "server-response"), ("owner", "control"), ("response", response), ("request", request.Request)));
                return;
        }
        if (!IsRequest(message)) return;
        var id = message.Get("id");
        var method = message.Str("method");
        if (!state.Initialized) { SendError(peer, id, -32002, "Codex app-server is still initializing"); return; }
        if (!CanForward(method)) { SendError(peer, id, -32003, $"{method} blocked while Codex turn is running"); return; }
        var upstreamId = nextControlId--;
        var parameters = message.Get("params");
        var control = new ControlRequest(peer, id.Clone(), method, parameters.Clone(), message.Str("proxyIntent") == "select-thread", Now + options.RequestTimeoutMs);
        controlPending[upstreamId.ToString(System.Globalization.CultureInfo.InvariantCulture)] = control;
        forwarding.Remember(method, parameters);
        await WriteChild(Json.Encode(Json.With(message, ("id", upstreamId), ("proxyIntent", default(JsonElement)))));
    }
    private bool CanForward(string method) => !state.Busy || (options.ScenarioTesting && method.StartsWith("test/", StringComparison.OrdinalIgnoreCase)) ||
        method.ToLowerInvariant() is "turn/start" or "turn/steer" or "turn/interrupt" or "thread/list" or "thread/start" or
        "thread/resume" or "thread/unsubscribe" or "thread/name/set" or "thread/settings/update" or "thread/archive" or "thread/unarchive" or "model/list";
    private void SendError(ControlPeer peer, JsonElement id, int code, string message) =>
        Send(peer, Json.Obj(("id", id), ("error", Json.Obj(("code", code), ("message", message)))));
    private void Abandon(string key, ControlRequest request)
    {
        controlPending.Remove(key);
        abandoned[key] = new(request, Now + 10 * 60 * 1000);
        while (abandoned.Count > 1000) abandoned.Remove(abandoned.Keys.First());
    }
    private void Fail(string key, ControlRequest request, string message, int code)
    {
        Abandon(key, request);
        SendError(request.Peer, request.Id, code, message);
    }
    private Task Tick()
    {
        var now = Now;
        foreach (var peer in clients.Where(peer => peer.Closed).ToArray()) _ = Disconnect(peer);
        foreach (var (key, request) in controlPending.ToArray())
            if (now >= request.Deadline) Fail(key, request, $"{request.Method} 请求超时", -32098);
        foreach (var (key, value) in abandoned.ToArray()) if (now >= value.ExpiresAt) abandoned.Remove(key);
        if (now - lastStateWrite >= 5000 || stateDue > 0 && now >= stateDue) WriteState();
        return Task.CompletedTask;
    }
    private void StateChanged() { if (stateDue == 0) stateDue = Now + 50; }
    private void WriteState()
    {
        stateDue = 0;
        lastStateWrite = Now;
        state.Revision++;
        try
        {
            File.WriteAllBytes(registration + ".tmp", Json.Encode(state.Snapshot()));
            File.Move(registration + ".tmp", registration, true);
        }
        catch (IOException error) { log.Write("state_write_error " + error.Message); }
    }
    public async ValueTask DisposeAsync()
    {
        Stop(exitCode);
        server.Dispose();
        foreach (var peer in clients) peer.Dispose();
        if (childInput is not null) await childInput.DisposeAsync();
        job?.Dispose();
        if (child is not null)
        {
            try { if (!child.HasExited) { child.Kill(true); await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(3)); } }
            catch (Exception error) when (error is InvalidOperationException or TimeoutException) { log.Write("child_shutdown " + error.Message); }
            child.Dispose();
        }
        if (parentOutput is not null) await parentOutput.DisposeAsync();
        foreach (var path in new[] { registration, registration + ".tmp" })
            try { File.Delete(path); } catch (IOException error) { log.Write("registry_cleanup " + error.Message); }
        log.Write($"proxy_exit code={exitCode}");
    }
}
