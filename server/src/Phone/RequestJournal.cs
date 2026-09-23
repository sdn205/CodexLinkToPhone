using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    private readonly Dictionary<string, JsonObject> requests = [];
    private readonly Dictionary<string, Task<JsonObject>> inflight = [];
    private readonly Dictionary<string, Task> writeLanes = [];
    private readonly Dictionary<string, string> writeLaneAliases = [];
    private int pendingWrites;
    private TaskCompletionSource? writesDrained;
    private Task WaitWrites() => pendingWrites == 0 ? Task.CompletedTask : (writesDrained ??= new(TaskCreationOptions.RunContinuationsAsynchronously)).Task;
    private Task<JsonObject> Enqueue(string lane, Func<Task<JsonObject>> action)
    {
        lane = writeLaneAliases.GetValueOrDefault(lane) ?? lane;
        Task previous = writeLanes.GetValueOrDefault(lane) ?? Task.CompletedTask; pendingWrites++;
        async Task<JsonObject> Execute()
        {
            await Task.Yield(); try { try { await previous; } catch { } return await action(); }
            finally { pendingWrites--; if (pendingWrites == 0) { writesDrained?.TrySetResult(); writesDrained = null; foreach (var tid in historyCursor.Keys.Concat(historyRead).Distinct().ToArray()) EventLoop.Observe(LoadHistory(tid)); } }
        }
        var task = Execute(); writeLanes[lane] = task; EventLoop.Observe(RemoveLane(lane, task)); return task;
    }
    private void BindCreatedThread(string threadId, string creationLane)
    {
        writeLaneAliases["thread:" + threadId] = creationLane;
    }
    private async Task RemoveLane(string lane, Task task)
    {
        try { await task; } catch { }
        finally { if (writeLanes.GetValueOrDefault(lane) == task) { writeLanes.Remove(lane); foreach (var key in writeLaneAliases.Where(x => x.Value == lane).Select(x => x.Key).ToArray()) writeLaneAliases.Remove(key); } }
    }
    private static JsonObject Failure(string code, string message, bool retryable = true, bool uncertain = false) => J.O(("ok", false), ("retryable", retryable), ("uncertain", uncertain), ("code", code), ("message", message));
    private void LoadOperations()
    {
        var stored = Persistence.Read(StatePath("phone-operations.json"));
        foreach (var r in stored.Arr("messageRequests"))
        {
            if (r.S("requestId") == "" || r.S("clientUserMessageId") == "" || r.N("expiresAt") <= J.Now || r.S("status") is not ("accepted" or "pending" or "uncertain") || r.S("operation") is not ("send" or "edit") || r.S("payloadHash") == "") continue;
            if (r.S("status") == "accepted" && !r.G("result").B("ok")) continue;
            var entry = r.Obj(); entry["status"] = r.S("status") == "accepted" ? "accepted" : "uncertain"; requests[r.S("requestId")] = entry;
        }
        foreach (var item in stored.Arr("discardedPlanTurns")) if (item.S("threadId") != "" && item.S("turnId") != "") Messages.DiscardedPlans.Add((item.S("threadId"), item.S("turnId")));
        foreach (var title in stored.Arr("pendingThreadTitles")) if (title.S("threadId") != "" && title.S("prompt") != "") pendingTitles[title.S("threadId")] = title.Obj();
    }
    private void PersistOperations() => Persistence.Write(StatePath("phone-operations.json"), J.O(("version", 4), ("updatedAt", DateTimeOffset.UtcNow.ToString("O")), ("messageRequests", J.A(requests.Values.Where(r => r.N("expiresAt") > J.Now && r.S("status") != "new"))), ("pendingThreadTitles", J.A(pendingTitles.Values)), ("discardedPlanTurns", J.A(Messages.DiscardedPlans.Select(p => J.O(("threadId", p.Item1), ("turnId", p.Item2)))))));
    private static string PayloadHash(JsonNode message, string tid, bool edit)
    {
        if (edit) return J.Hash(J.Canonical(J.O(("operation", "edit"), ("threadId", J.Null(tid)), ("turnId", J.Null(message.S("turnId"))), ("text", message.S("text")), ("images", new JsonArray()))));
        return J.Hash(J.Canonical(J.O(("threadId", J.Null(message.S("threadId"))), ("text", message.S("text")), ("images", J.A(message.Arr("images").Select(x => J.O(("name", x.S("name")), ("type", x.S("type")), ("source", x.S("url", x.S("dataUrl", x.S("src")))))))))));
    }
    private Task<JsonObject> Journal(JsonObject message, string tid, bool edit, Func<JsonObject, Task<JsonObject>> submit)
    {
        string id = message.S("requestId"), hash = PayloadHash(message, tid, edit), operation = edit ? "edit" : "send";
        foreach (string old in requests.Where(x => !inflight.ContainsKey(x.Key) && x.Value.S("status") != "pending" && x.Value.N("expiresAt") <= J.Now).Select(x => x.Key).ToArray()) requests.Remove(old);
        if (requests.TryGetValue(id, out var entry))
        {
            if (entry.S("payloadHash") != hash || entry.S("operation") != operation || entry.S("threadId") != "" && entry.S("threadId") != tid) return Task.FromResult(Failure("request_id_conflict", "requestId 已用于另一条消息", false));
            if (entry.S("status") == "accepted" && entry.G("result") is JsonObject accepted) return Task.FromResult(accepted.Obj());
            if (inflight.TryGetValue(id, out var pending)) return pending;
        }
        else
        {
            if (requests.Count >= 1000) return Task.FromResult(Failure("request_queue_full", "发送队列繁忙，请稍后重试"));
            string cid = message.S("clientUserMessageId").Trim(); if (cid.Length == 0 || cid.Length > 200 || cid.Any(c => c < ' ' || c > '~')) cid = J.Id();
            entry = J.O(("requestId", id), ("status", "new"), ("threadId", J.Null(tid)), ("payloadHash", hash), ("operation", operation), ("clientUserMessageId", cid), ("editTurnId", message.S("turnId")), ("editMessageId", message.S("messageId")), ("editRollbackAttempted", false), ("editRollbackApplied", false), ("editRollbackTurnCount", 0), ("editRollbackLastTurnId", ""), ("createdAt", J.Now), ("expiresAt", J.Now + 300000), ("result", null)); requests[id] = entry;
        }
        var task = ExecuteJournal(entry, tid, submit); inflight[id] = task; return task;
    }
    private async Task<JsonObject> ExecuteJournal(JsonObject request, string tid, Func<JsonObject, Task<JsonObject>> submit)
    {
        await Task.Yield(); string id = request.S("requestId");
        try
        {
            if (request.S("status") == "uncertain")
            {
                var resolved = await Reconcile(request, tid);
                if (resolved.S("status") == "accepted") return Accept(request, resolved.G("result").Obj());
                if (resolved.S("status") == "error") return Failure(resolved.S("code"), resolved.S("message"), true, true);
            }
            request["status"] = "pending"; request["threadId"] = J.Null(tid != "" ? tid : request.S("threadId")); request["expiresAt"] = J.Now + 300000; PersistOperations();
            var response = await submit(request); return Accept(request, J.O(("ok", true), ("threadId", response.G("threadId")), ("turnId", response.G("turnId"))));
        }
        catch (Exception e)
        {
            var error = e as BridgeException; bool uncertain = error?.Uncertain == true; bool preserve = request.S("operation") == "edit" && (request.B("editRollbackAttempted") || request.B("editRollbackApplied"));
            if (error?.ThreadId is { Length: > 0 } errorThread) request["threadId"] = errorThread;
            if (uncertain || preserve) { request["status"] = "uncertain"; request["result"] = null; request["expiresAt"] = J.Now + 300000; } else requests.Remove(id);
            PersistOperations(); var result = Failure(ThreadNotFound(e) ? "thread_not_found" : error?.Code ?? "operation_failed", e.Message, error?.Retryable != false, uncertain); result.Set("threadId", request.G("threadId")); return result;
        }
        finally { inflight.Remove(id); Broadcast(); }
    }
    private JsonObject Accept(JsonObject request, JsonObject result)
    { request["status"] = "accepted"; request.Set("threadId", result.G("threadId")); request.Set("result", result); request["expiresAt"] = J.Now + 300000; PersistOperations(); return result; }
    private async Task<JsonObject> Reconcile(JsonObject request, string target)
    {
        string tid = request.S("threadId", target), cid = request.S("clientUserMessageId");
        JsonObject Error(string code = "uncertain_state_unavailable", string message = "发送结果未知，暂时无法核对会话状态") => J.O(("status", "error"), ("code", code), ("message", message));
        if (tid == "" || cid == "") return Error();
        try
        {
            var response = await ReadThreadFull(tid);
            var thread = response.G("thread"); if (thread.S("id") != tid || thread.G("turns") is not JsonArray) return Error();
            Hydrate(thread!, Messages.Revision, 0, true);
            var found = Messages.Values.FirstOrDefault(m => m.S("role") == "user" && MessageOrder.Thread(m) == tid && MessageStore.ClientId(m) == cid);
            if (found is not null) return J.O(("status", "accepted"), ("result", J.O(("ok", true), ("threadId", tid), ("turnId", MessageOrder.Turn(found)))));
            if (response.B("desktopSnapshot")) return Error("desktop_submission_unconfirmed", "桌面端尚未确认这条消息，已保留发送记录以避免重复提交");
            return J.O(("status", "not_found"));
        }
        catch { return Error(); }
    }
}
