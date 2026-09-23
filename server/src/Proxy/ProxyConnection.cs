using System.Net.WebSockets;
using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed class ProxyConnection(JsonObject state, CancellationToken cancellation)
{
    private sealed record Pending(string Method, TaskCompletionSource<JsonNode> Source);
    private readonly Dictionary<long, Pending> pending = [];
    private readonly List<JsonNode> queued = [];
    private JsonSocket? socket;
    private long nextId;
    private bool historyPending;
    private bool overflow;
    private long generation;
    public long Cursor { get; private set; }
    public JsonObject State { get; private set; } = state;
    public string Id => State.S("instanceId");
    public bool Connected => socket?.Open == true;
    public bool Connecting { get; private set; }
    public Action<ProxyConnection, JsonNode, bool> Event { get; set; } = (_, _, _) => { };
    public Action<ProxyConnection> Changed { get; set; } = _ => { };
    public Task HistoryReady { get; private set; } = Task.CompletedTask;
    private TaskCompletionSource historyDone = new();
    public async Task Connect()
    {
        if (Connected || Connecting) return;
        Connecting = true;
        try
        {
            var uri = new UriBuilder(State.S("controlUrl"));
            if (uri.Scheme != "ws" || !uri.Uri.IsLoopback) throw new InvalidDataException("代理控制端点必须位于本机");
            uri.Query = "token=" + Uri.EscapeDataString(State.S("token"));
            using var ws = new ClientWebSocket();
            ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
            ws.Options.KeepAliveTimeout = TimeSpan.FromSeconds(30);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation); deadline.CancelAfter(3000);
            await ws.ConnectAsync(uri.Uri, deadline.Token);
            deadline.CancelAfter(Timeout.Infinite);
            socket = new JsonSocket(ws, cancellation);
            historyPending = true; overflow = false; queued.Clear();
            historyDone = new(TaskCreationOptions.RunContinuationsAsynchronously); HistoryReady = historyDone.Task;
            generation++;
            Changed(this);
            socket.Send(J.O(("type", "get-state"), ("includeHistory", true), ("afterSeq", Cursor)));
            EventLoop.Observe(HistoryTimeout(generation));
            await socket.Run(message => Handle(message, false));
            if (!cancellation.IsCancellationRequested && socket.LastError != "") Console.Error.WriteLine("代理控制连接断开：" + socket.LastError);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException) { }
        finally
        {
            socket?.Dispose(); socket = null; Connecting = false; historyDone.TrySetResult();
            foreach (var request in pending.Values) request.Source.TrySetException(new BridgeException("Trae Codex 代理连接已断开", "PROXY_DISCONNECTED", IsWrite(request.Method)));
            pending.Clear(); Changed(this);
        }
    }
    private async Task HistoryTimeout(long expected)
    {
        await Task.Delay(Configuration.Int("CODEX_PHONE_HISTORY_TIMEOUT_MS", 8000, 2000), cancellation);
        if (!historyPending || generation != expected) return;
        historyPending = false;
        foreach (var item in queued.OrderBy(x => x.N("seq")).ToArray()) Handle(item, false);
        queued.Clear(); historyDone.TrySetResult();
        Event(this, J.O(("type", "history-replayed"), ("incomplete", true)), false);
    }
    private void Handle(JsonNode message, bool replay)
    {
        if (message.S("type") == "" && message.G("id") is not null && (message.G("result") is not null || message.G("error") is not null))
        {
            if (!pending.Remove(message.N("id"), out var request)) return;
            var error = message.G("error");
            if (error is not null) request.Source.TrySetException(new BridgeException(error.S("message", request.Method + " 请求失败"), error.G("code").Text(), new[] { "-32098", "-32097", "-32096" }.Contains(error.G("code").Text())));
            else request.Source.TrySetResult(message.G("result") ?? new JsonObject());
            return;
        }
        string type = message.S("type");
        if (type == "hello")
        {
            if (message.G("state").S("instanceId") != Id) { Close(); return; }
            State = message.G("state").Obj(); Event(this, message, false); Changed(this); return;
        }
        if (type == "history")
        {
            historyPending = false;
            foreach (var item in message.Arr("events"))
            {
                if (item.S("type") is "history" or "hello") continue;
                if (Replayable(item) && item.N("seq") <= 0) { Close(); return; }
                Handle(item, true);
            }
            Cursor = Math.Max(Cursor, message.N("newestAvailableSeq"));
            foreach (var item in queued.OrderBy(x => x.N("seq")).ToArray()) Handle(item, false);
            queued.Clear(); historyDone.TrySetResult();
            Event(this, J.O(("type", "history-replayed"), ("incomplete", overflow || message.B("truncated") || message.G("complete")?.ToString() == "false")), false);
            return;
        }
        if (Replayable(message) || message.N("seq") > 0)
        {
            if (historyPending) { queued.Add(message); if (queued.Count > 5000) { queued.RemoveAt(0); overflow = true; } return; }
            long seq = message.N("seq");
            if (seq > 0 && seq <= Cursor) return;
            if (!replay && seq > Cursor + 1 && Cursor > 0) Event(this, J.O(("type", "history-gap")), false);
            if (seq > 0) Cursor = seq;
        }
        Event(this, message, replay);
    }
    private static bool Replayable(JsonNode message) => message.S("type") is "notification" or "stdio-request" or "stdio-response" or "server-request";
    public static bool IsWrite(string method) => method is "thread/start" or "thread/revert" or "turn/start" or "turn/steer";
    public async Task<JsonNode> Request(string method, JsonNode? args, int timeoutMs = 60000, bool select = false)
    {
        if (!Connected) throw new BridgeException("Trae Codex 代理尚未连接", "proxy_unavailable");
        long id = ++nextId;
        var completion = new TaskCompletionSource<JsonNode>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = new(method, completion);
        var payload = J.O(("id", id), ("method", method), ("params", args));
        if (select) payload["proxyIntent"] = "select-thread";
        if (!socket!.Send(payload)) { pending.Remove(id); throw new BridgeException("代理发送失败", "PROXY_DISCONNECTED", IsWrite(method)); }
        try { return await completion.Task.WaitAsync(TimeSpan.FromMilliseconds(timeoutMs), cancellation); }
        catch (TimeoutException) { throw new BridgeException(method + " 请求超时", "REQUEST_TIMEOUT", IsWrite(method)); }
        finally { pending.Remove(id); }
    }
    public void Respond(JsonNode? id, JsonNode result)
    {
        if (socket?.Send(J.O(("type", "server-response"), ("requestId", id), ("result", result))) != true) throw new BridgeException("审批所属窗口已断开", "approval_owner_disconnected");
    }
    public void Close() => socket?.Dispose();
}
