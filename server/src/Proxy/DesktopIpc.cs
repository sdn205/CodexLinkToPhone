using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed class DesktopIpc(CancellationToken cancellation) : IDisposable
{
    private sealed class Follow(string owner) { public string Owner = owner; public JsonObject? State; public long Revision = -1; public Exception? Error; public long Resync; }
    private readonly Dictionary<string, TaskCompletionSource<JsonNode>> pending = [];
    private readonly Dictionary<string, Follow> followed = [];
    private readonly SemaphoreSlim sendLock = new(1, 1);
    private NamedPipeClientStream? pipe;
    private Task? connecting;
    private string clientId = "initializing-client";
    private bool closed;
    public Action<JsonNode> Snapshot { get; set; } = _ => { };
    public Action Disconnected { get; set; } = () => { };
    private Task Connect() => pipe?.IsConnected == true ? Task.CompletedTask : connecting ??= ConnectCore();
    private async Task ConnectCore()
    {
        await Task.Yield();
        try
        {
            if (closed) throw new IOException("桌面协作连接已关闭");
            if (pipe?.IsConnected == true) return;
            var next = new NamedPipeClientStream(".", Configuration.Env("CODEX_PHONE_DESKTOP_PIPE", "codex-ipc"), PipeDirection.InOut, PipeOptions.Asynchronous);
            try { await next.ConnectAsync(350, cancellation); } catch { next.Dispose(); throw; }
            pipe = next; EventLoop.Observe(Receive(next));
            var response = await Raw("initialize", J.O(("clientType", "codex-phone")));
            if (response.S("resultType") != "success" || response.G("result").S("clientId") == "") throw new IOException("桌面协作初始化失败");
            clientId = response.G("result").S("clientId");
            foreach (var (id, entry) in followed) Following(id, entry.Owner);
        }
        finally { connecting = null; }
    }
    private async Task Send(JsonNode value)
    {
        byte[] data = value.Bytes(); byte[] header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, data.Length);
        await sendLock.WaitAsync(cancellation);
        try { var target = pipe ?? throw new IOException("桌面协作连接已断开"); await target.WriteAsync(header, cancellation); await target.WriteAsync(data, cancellation); }
        finally { sendLock.Release(); }
    }
    private async Task Receive(NamedPipeClientStream source)
    {
        try
        {
            byte[] header = new byte[4];
            while (!closed)
            {
                await source.ReadExactlyAsync(header, cancellation); int size = BinaryPrimitives.ReadInt32LittleEndian(header);
                if (size <= 0 || size > 256 * 1024 * 1024) throw new IOException("桌面协作帧长度无效");
                byte[] data = new byte[size]; await source.ReadExactlyAsync(data, cancellation); var message = JsonNode.Parse(data)!;
                if (message.S("type") == "response") { if (pending.Remove(message.S("requestId"), out var result)) result.TrySetResult(message); }
                else if (message.S("type") == "client-discovery-request") await Send(J.O(("type", "client-discovery-response"), ("requestId", message.G("requestId")), ("response", J.O(("canHandle", false)))));
                else if (message.S("type") == "broadcast") Broadcast(message);
            }
        }
        catch (Exception e) when (e is IOException or OperationCanceledException or ObjectDisposedException or System.Text.Json.JsonException) { }
        finally
        {
            source.Dispose();
            if (pipe == source)
            {
                pipe = null; clientId = "initializing-client";
                foreach (var entry in followed.Values) { entry.State = null; entry.Error = null; }
                Disconnected();
                foreach (var p in pending.Values) p.TrySetException(new BridgeException("桌面协作连接已断开", "desktop_ipc_disconnected", true));
                pending.Clear();
            }
        }
    }
    private async Task<JsonNode> Raw(string method, JsonNode args, string? target = null, bool write = false)
    {
        string id = J.Id(); var tcs = new TaskCompletionSource<JsonNode>(TaskCreationOptions.RunContinuationsAsynchronously); pending[id] = tcs;
        int version = method switch { "thread-owner-discovery" => 1, "thread-follower-start-turn" => 2, "thread-follower-steer-turn" => 1, "thread-follower-interrupt-turn" => 4, _ => 0 };
        int timeout = write ? 60000 : 10000;
        try
        {
            var message = J.O(("type", "request"), ("requestId", id), ("sourceClientId", clientId), ("version", version), ("method", method), ("params", args), ("timeoutMs", timeout));
            if (target is not null) message["targetClientId"] = target;
            await Send(message); return await tcs.Task.WaitAsync(TimeSpan.FromMilliseconds(timeout), cancellation);
        }
        catch (TimeoutException) { throw new BridgeException("桌面协作请求超时", "desktop_ipc_timeout", write); }
        finally { pending.Remove(id); }
    }
    public async Task<string?> FindOwner(string tid)
    {
        try { await Connect(); } catch (TimeoutException) { return null; } catch (IOException) { return null; }
        var response = await Raw("thread-owner-discovery", J.O(("hostId", "local"), ("conversationId", tid)));
        if (response.S("resultType") == "success") return J.Null(response.S("handledByClientId"));
        if (response.S("error") == "no-client-found") return null;
        throw new BridgeException(response.S("error", "无法确定会话所属客户端"));
    }
    private void Following(string tid, string owner, bool follow = true) => EventLoop.Observe(Send(J.O(("type", "broadcast"), ("method", "thread-stream-following-changed"), ("version", 1), ("sourceClientId", clientId), ("targetClientIds", J.Strings([owner])), ("params", J.O(("hostId", "local"), ("conversationId", tid), ("following", follow))))));
    private void Broadcast(JsonNode message)
    {
        string method = message.S("method"); var p = message.G("params"); string tid = p.S("conversationId");
        if (method == "client-status-changed" && p.S("status") == "disconnected") { foreach (var f in followed.Values.Where(x => x.Owner == p.S("clientId"))) f.State = null; return; }
        if (!followed.TryGetValue(tid, out var entry) || p.S("hostId") != "local" || entry.Owner != message.S("sourceClientId")) return;
        if (method == "thread-stream-following-status-requested") { Following(tid, entry.Owner); return; }
        if (method != "thread-stream-state-changed") return;
        if (message.G("targetClientIds") is JsonArray targets && !targets.Any(x => x.Text() == clientId)) return;
        if (message.N("version") != 11) { entry.State = null; entry.Error = new IOException("桌面会话同步协议版本不兼容"); return; }
        var change = p.G("change");
        try
        {
            if (change.S("type") == "snapshot")
            {
                if (change.G("conversationState").S("id") != tid) throw new IOException("会话快照身份不一致");
                if (entry.State is not null && change.N("revision") < entry.Revision) return;
                entry.State = change.G("conversationState").Obj();
            }
            else if (change.S("type") == "patches")
            {
                if (entry.State is not null && change.N("revision") <= entry.Revision) return;
                if (entry.State is null || change.N("baseRevision") != entry.Revision) throw new IOException("桌面会话增量缺失");
                entry.State = ApplyPatches(entry.State, change.Arr("patches"));
            }
            else return;
            entry.Revision = change.N("revision"); entry.Error = null; Snapshot(ToResponse(entry.State!));
        }
        catch (Exception e) when (e is IOException or InvalidOperationException or ArgumentException)
        { entry.State = null; entry.Error = e; if (J.Now - entry.Resync > 1000) { entry.Resync = J.Now; Following(tid, entry.Owner); } }
    }
    internal static JsonObject ApplyPatches(JsonObject original, IEnumerable<JsonNode> patches)
    {
        JsonNode root = original.DeepClone();
        foreach (var patch in patches)
        {
            string op = patch.S("op"); var path = patch.Arr("path").ToArray();
            if (patch.G("path") is not JsonArray || op is not ("add" or "replace" or "remove") || path.Any(x => x is not JsonValue || x.Text() is "__proto__" or "prototype" or "constructor")) throw new IOException("Invalid desktop patch");
            if (path.Length == 0) { root = op == "remove" ? throw new IOException("Cannot remove snapshot") : patch.G("value")?.DeepClone() ?? throw new IOException("Empty snapshot"); continue; }
            JsonNode node = root;
            foreach (var key in path[..^1]) node = (node is JsonArray arr ? arr[checked((int)key.Number(-1))] : node.G(key.Text())) ?? throw new IOException("Missing patch path");
            string last = path[^1].Text();
            if (node is JsonArray a)
            {
                if (!int.TryParse(last, out int index) || index < 0 || index > a.Count || (op != "add" && index == a.Count)) throw new IOException("Invalid array index");
                if (op == "add") a.Insert(index, patch.G("value")?.DeepClone()); else if (op == "remove") a.RemoveAt(index); else a[index] = patch.G("value")?.DeepClone();
            }
            else if (node is JsonObject o) { if (op == "remove") o.Remove(last); else o.Set(last, patch.G("value")); }
            else throw new IOException("Missing patch parent");
        }
        return root as JsonObject ?? throw new IOException("Invalid snapshot root");
    }
    internal static JsonObject ToResponse(JsonNode state)
    {
        var history = state.G("turnHistory"); var turns = state.Arr("turns");
        if (history.S("kind") == "canonical")
        {
            var h = history.G("history"); turns = h.Arr("islands").SelectMany(x => x.Arr("entries")).Select(x => h.G("entitiesByKey").G(x.S("value"))).OfType<JsonNode>();
        }
        var normalized = turns.Where(x => x.S("turnId") != "").DistinctBy(x => x.S("turnId")).Select(t => J.O(("id", t.G("turnId")), ("status", t.G("status")), ("startedAt", t.G("turnStartedAtMs")), ("completedAt", t.S("status") != "inProgress" && t.N("turnStartedAtMs") > 0 && t.G("durationMs") is not null ? t.N("turnStartedAtMs") + t.N("durationMs") : null), ("durationMs", t.G("durationMs")), ("error", t.G("error")), ("items", J.A(t.Arr("items"))), ("diff", t.G("diff"))));
        return J.Merge(state.G("latestThreadSettings"), J.O(("desktopSnapshot", true), ("model", state.G("latestModel")), ("reasoningEffort", state.G("latestReasoningEffort")), ("cwd", state.G("cwd")), ("thread", J.O(("id", state.G("id")), ("sessionId", state.G("sessionId")), ("cwd", state.G("cwd")), ("name", state.G("title")), ("source", state.G("source")), ("modelProvider", state.G("modelProvider")), ("model", state.G("latestModel")), ("reasoningEffort", state.G("latestReasoningEffort")), ("path", state.G("rolloutPath")), ("status", state.G("threadRuntimeStatus")), ("createdAt", state.N("createdAt") / 1000.0), ("updatedAt", state.N("updatedAt") / 1000.0), ("turns", J.A(normalized))))));
    }
    private async Task<JsonObject> Read(string tid, string owner)
    {
        await Connect();
        if (!followed.TryGetValue(tid, out var f) || f.Owner != owner) { if (f is not null) Following(tid, f.Owner, false); followed[tid] = f = new(owner); Following(tid, owner); }
        else if (f.State is null) Following(tid, owner);
        long deadline = J.Now + 10000;
        while (f.State is null) { if (f.Error is not null) throw f.Error; if (pipe?.IsConnected != true) throw new IOException("桌面协作连接已断开"); if (J.Now >= deadline) throw new TimeoutException("等待桌面会话快照超时"); await Task.Delay(20, cancellation); }
        return ToResponse(f.State);
    }
    public async Task<JsonNode> Request(string method, JsonObject args, string owner)
    {
        string tid = args.S("threadId"); var snapshot = await Read(tid, owner);
        if (method is "thread/read" or "thread/resume") return snapshot;
        string ipc; JsonObject input;
        if (method == "turn/start") { ipc = "thread-follower-start-turn"; input = J.O(("conversationId", tid), ("turnStart", J.O(("request", args), ("context", J.O(("inheritThreadSettings", true)))))); }
        else if (method == "turn/steer")
        {
            if (args.S("expectedTurnId") != "" && !snapshot.G("thread").Arr("turns").Any(t => t.S("id") == args.S("expectedTurnId") && t.S("status") == "inProgress")) throw new BridgeException("当前运行轮次已变化，请刷新后重试", "desktop_turn_changed");
            ipc = "thread-follower-steer-turn";
            input = J.O(("conversationId", tid), ("input", args.G("input")), ("clientUserMessageId", args.G("clientUserMessageId")), ("attachments", new JsonArray()), ("restoreMessage", J.O(("text", string.Join('\n', args.Arr("input").Where(x => x.S("type") == "text").Select(x => x.S("text")))), ("cwd", snapshot.G("cwd")), ("context", J.O(("workspaceRoots", J.Strings(snapshot.S("cwd") == "" ? [] : [snapshot.S("cwd")])))))));
            if (args.G("serviceTier") is not null) input.Set("serviceTier", args.G("serviceTier")); if (args.G("additionalContext") is not null) input.Set("additionalContext", args.G("additionalContext"));
        }
        else if (method == "turn/interrupt") { ipc = "thread-follower-interrupt-turn"; input = J.O(("conversationId", tid), ("mode", "user-stop"), ("expectedTurnId", args.G("turnId"))); }
        else throw new BridgeException("桌面协作不支持 " + method);
        var response = await Raw(ipc, input, owner, true);
        if (response.S("resultType") != "success") throw new BridgeException(response.S("error", "桌面提交失败"), "desktop_submission_failed", response.S("error") is not ("no-client-found" or "request-version-mismatch"));
        if (method == "turn/interrupt") return new JsonObject();
        var result = response.G("result").G("result");
        if ((method == "turn/start" ? result.G("turn").S("id") : result.S("turnId")) == "") throw new BridgeException("桌面提交回执不完整，正在核对结果", "desktop_submission_unconfirmed", true);
        return result!;
    }
    public void Forget(string tid) { if (followed.Remove(tid, out var f) && pipe?.IsConnected == true) Following(tid, f.Owner, false); }
    public void Dispose() { closed = true; pipe?.Dispose(); }
}
