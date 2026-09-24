using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    public async Task HandlePhone(PhoneSession client, JsonNode input)
    {
        var message = input.Obj(); string operation = message.S("type"), requestId = message.S("requestId").Trim();
        client.LastActivity = J.Now; long seq = message.N("seq"); if (seq > 0) client.LastSequence = Math.Max(client.LastSequence, seq);
        if (operation == "phone:background") { if (seq <= 0 || seq >= client.LastSequence) client.Background = true; return; }
        if (operation != "stream:ack" && operation != "" && client.Background) { client.Background = false; client.NeedsFull = true; }
        if (operation == "phone:foreground") { if (client.NeedsFull) client.SendState(true); return; }
        string tid = client.ThreadId; long revision = client.Revision;
        string lane = tid != "" ? "thread:" + tid : client.Lane;
        JsonObject Result(JsonObject data) => J.Merge(J.O(("type", operation + ":result"), ("operation", operation), ("requestId", requestId)), data);
        bool Stale() => message.S("threadId") != tid || message.G("threadRevision") is null || message.N("threadRevision", -1) != revision;
        try
        {
            switch (operation)
            {
                case "stream:ack": client.Ack(message); return;
                case "state:request": client.SendState(true); if (tid != "") EventLoop.Observe(HydrateClient(client, tid)); return;
                case "message:send:result:query":
                    foreach (string id in message.Arr("requestIds").Select(x => x.Text()).Append(requestId).Where(x => x != "").Distinct())
                        if (requests.TryGetValue(id, out var request) && request.S("status") == "accepted" && request.N("expiresAt") > J.Now) client.Send(J.Merge(J.O(("type", "message:send:result"), ("operation", "message:send"), ("requestId", id)), request.G("result")));
                    return;
                case "messages:more":
                    if (message.S("threadId") != "" && message.S("threadId") != tid) { client.Send(Result(Failure("stale_thread", "会话已切换"))); return; }
                    if (message.G("threadRevision") is not null && message.N("threadRevision") != revision) { client.Send(Result(Failure("stale_thread_revision", "会话状态已更新"))); return; }
                    client.More(); bool sent = client.SendState(true); client.Send(Result(J.O(("ok", sent), ("retryable", !sent), ("threadId", J.Null(tid)), ("threadRevision", revision), ("omittedMessages", State(client).G("sync").N("omittedMessages"))))); return;
                case "message:detail":
                    var full = Messages.Get(message.S("id")); if (full is null) { client.Send(Result(Failure("not_found", "消息不存在或已过期，请刷新后重试"))); return; }
                    if (tid != "" && MessageOrder.Thread(full) != tid) { client.Send(Result(Failure("stale_thread", "消息已不在当前会话"))); return; }
                    client.Send(Result(J.O(("ok", true), ("message", FullMessage(full))))); return;
                case "threads:refresh":
                    try { await RefreshThreads(); if (tid != "") { if (hydration.TryGetValue(tid, out var pendingHydration)) await pendingHydration; await EnsureHydrated(tid, true); } if (client.ThreadId == tid && client.Revision == revision) client.SendState(true); client.Send(Result(J.O(("ok", true)))); }
                    catch (Exception e) { client.Send(Result(J.O(("ok", false), ("message", e.Message)))); }
                    return;
                case "thread:new":
                    Ready(); client.PendingOptions = J.Merge(Settings.GetValueOrDefault(tid) ?? DefaultSettings(), message.G("options"), J.O(("proxyInstanceId", Router.CreationTarget(tid)))); client.Creating = null; client.Lane = "new:" + J.Id();
                    Select(client, "", true, true); client.SendState(true); client.Send(Result(J.O(("ok", true), ("deferred", true), ("threadId", null)))); return;
                case "thread:open":
                    Ready(); string open = message.S("threadId"); if (open == "") throw new BridgeException("缺少 threadId");
                    client.PendingOptions = null; client.Creating = null; client.OpenSequence++; long opening = client.OpenSequence;
                    Unread.Remove(open); PersistUnread(); Select(client, open, true); SetCurrent(open); Broadcast(true); client.Send(Result(J.O(("ok", true), ("threadId", open))));
                    EventLoop.Observe(OpenThread(client, open, opening, requestId)); return;
                case "thread:read": Unread.Remove(message.S("threadId", tid)); PersistUnread(); Broadcast(); return;
                case "threads:mark-all-read": Unread.Clear(); PersistUnread(); client.Send(Result(J.O(("ok", true)))); Broadcast(); return;
                case "thread:compact":
                    if (tid == "") throw new BridgeException("当前没有可压缩的会话");
                    await Enqueue(lane, async () => { await Router.Request("thread/compact/start", J.O(("threadId", tid)), 120000); return new(); }); TokenUsage.Remove(tid); client.Send(Result(J.O(("ok", true), ("threadId", tid)))); Broadcast(); return;
                case "thread:rename":
                case "thread:archive":
                    string target = message.S("threadId", tid).Trim(); if (target == "") throw new BridgeException("缺少会话标识"); string name = message.S("name").Trim();
                    if (operation == "thread:rename" && name == "") throw new BridgeException("会话名称不能为空");
                    await Enqueue("thread:" + target, async () => { await Router.Request(operation == "thread:rename" ? "thread/name/set" : "thread/archive", operation == "thread:rename" ? J.O(("threadId", target), ("name", name)) : J.O(("threadId", target)), 30000); return new(); });
                    client.Send(Result(J.O(("ok", true), ("threadId", target), ("name", name)))); if (operation == "thread:archive") Invalidate(target); else Rename(target, name); Broadcast(); return;
                case "message:send":
                case "message:edit":
                    bool edit = operation == "message:edit"; if (requestId == "") { requestId = J.Id(); message["requestId"] = requestId; }
                    var options = client.PendingOptions?.Obj() ?? new JsonObject();
                    var response = await Enqueue(lane, async () =>
                    {
                        if (message.S("threadId") != tid || edit && tid == "") return Failure("stale_thread", "会话已切换，请在当前会话重新发送");
                        if (message.G("threadRevision") is null || message.N("threadRevision", -1) != revision) return Failure("stale_thread_revision", "会话状态已更新，请重新发送");
                        string targetThread = tid;
                        if (targetThread == "" && client.Creating is not null)
                        {
                            var created = await client.Creating; targetThread = created.S("id");
                            if (client.Revision != revision && client.ThreadId != targetThread) return Failure("stale_thread", "会话已切换，请在当前会话重新发送");
                        }
                        return await Journal(message, targetThread, edit, request => edit ? Edit(message, targetThread, client, request, revision) : Submit(message, targetThread, client, request, options, revision));
                    });
                    client.Send(Result(response)); return;
                case "turn:interrupt":
                    var runtime = Runtime(tid); string turn = runtime.Turn; if (tid == "" || turn == "") throw new BridgeException("缺少正在运行的 turnId，无法停止");
                    client.Send(Result(J.O(("ok", true), ("threadId", tid)))); runtime.Busy = false; runtime.Revision++; Broadcast();
                    EventLoop.Observe(Interrupt(tid, turn, lane)); return;
                case "approval:resolve": ResolveApproval(message.S("approvalId"), message.S("decision")); return;
                case "settings:update":
                    if (Stale()) throw new BridgeException("会话状态已更新，请重新选择设置", "stale_thread_revision");
                    string model = message.S("model").Trim(), effort = message.S("effort").Trim();
                    var selected = Models.Items().FirstOrDefault(m => m.S("model") == model); if (selected is null) throw new BridgeException("所选模型不在当前模型列表中", "invalid_model");
                    var efforts = selected.Arr("supportedReasoningEfforts").ToArray(); if (effort != "" && !efforts.Any(e => e.S("reasoningEffort") == effort)) throw new BridgeException("所选推理强度不受当前模型支持", "invalid_reasoning_effort");
                    if (effort == "") effort = selected.S("defaultReasoningEffort", efforts.FirstOrDefault().S("reasoningEffort"));
                    var setting = J.O(("model", model), ("effort", effort));
                    await Enqueue(lane, () => { if (tid == "") client.PendingOptions = J.Merge(client.PendingOptions, setting); else Settings[tid] = setting; return Task.FromResult(setting); });
                    client.Send(Result(J.Merge(J.O(("ok", true), ("threadId", J.Null(tid))), setting))); Broadcast(); return;
                default: throw new BridgeException(operation == "invalid-json" ? "手机端消息不是合法 JSON" : "未知消息类型：" + operation);
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"手机操作失败 operation={operation}: {e.Message}"); var error = e as BridgeException;
            var result = Failure(error?.Code ?? "operation_failed", error?.Code.StartsWith("message_order_", StringComparison.Ordinal) == true ? "会话同步失败，请重试" : e.Message, error?.Retryable != false, error?.Uncertain == true);
            if (operation is "message:send" or "message:edit" or "messages:more") client.Send(Result(result));
            else client.Send(J.Merge(result, J.O(("type", "error"), ("operation", operation), ("requestId", requestId)))); Broadcast();
        }
    }
    private async Task OpenThread(PhoneSession client, string tid, long sequence, string requestId)
    {
        try { await Resume(tid, true, true); if (client.ThreadId == tid && client.OpenSequence == sequence) client.SendState(true); }
        catch (Exception e) { if (client.Open && client.OpenSequence == sequence) client.Send(J.Merge(Failure((e as BridgeException)?.Code ?? "open_failed", e.Message), J.O(("type", "thread:open:result"), ("operation", "thread:open"), ("requestId", requestId)))); }
    }
    private async Task Interrupt(string tid, string turn, string lane)
    {
        try { await Enqueue(lane, async () => { await Router.Request("turn/interrupt", J.O(("threadId", tid), ("turnId", turn)), 15000); return new(); }); }
        catch (Exception e) { Console.Error.WriteLine("停止会话失败：" + e.Message); }
        finally { DiscardPlan(tid, turn); if (Runtime(tid).Turn == turn) FinishTurn(tid, turn); }
    }
}
