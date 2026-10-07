using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    private void ProxyEvent(ProxyConnection source, JsonNode envelope, bool replay)
    {
        try
        {
            string type = envelope.S("type");
            if (type == "hello")
            {
                var state = envelope.G("state"); Remember(state.G("lastThread")); var snapshot = state.G("lastThreadSnapshot");
                string tid = state.S("currentThreadId");
                if (Track(tid) && CurrentThread == "") SetCurrent(tid);
                if (snapshot.S("id") != "") Hydrate(snapshot!, Messages.Revision, 0);
                if (Track(tid))
                {
                    var r = Runtime(tid); if (state.B("busy")) StartTurn(tid, state.S("activeTurnId"), J.Epoch(state.G("activeTurnStartedAt")));
                    r.ReplyStarted = J.Epoch(state.G("activeTurnReplyStartedAt")); if (state.G("lastTurnTiming") is JsonObject timing) r.LastTiming = timing.Obj();
                }
                Broadcast(); return;
            }
            if (type is "history-replayed" or "history-gap")
            {
                if (type == "history-gap" || envelope.B("incomplete")) hydratedThreads.Clear();
                EventLoop.Observe(InitializeUpstream()); Broadcast(); return;
            }
            if (type == "stdio-response")
            {
                string method = envelope.S("method"); var result = envelope.G("result"); var thread = result.G("thread"); string tid = thread.S("id");
                if (tid != "" && Internal(thread)) { internalThreads.Add(tid); return; }
                if (tid != "" && SubAgent(thread)) { subAgents.Add(tid); return; }
                if (method is "thread/start" or "thread/resume" or "thread/read")
                {
                    if (tid == "") return; Remember(thread); ApplySettings(result, tid);
                    if (method != "thread/read" || CurrentThread == "") SetCurrent(tid);
                    if (method != "thread/read") Router.Ready.Add(tid);
                    HydrateResponse(result!, 0, 0); Broadcast(); return;
                }
                if (method == "thread/revert") { string target = tid != "" ? tid : envelope.G("requestParams").S("threadId"); string before = envelope.G("requestParams").S("beforeTurnId"); if (target != "" && before != "") Revert(target, before); return; }
                if (method == "thread/list") { foreach (var t in result.Arr("data")) Remember(t); Broadcast(); }
                return;
            }
            if (type != "notification") return;
            var n = envelope.G("notification"); var p = n.G("params").Obj();
            p["proxyEventSource"] = source.Id; if (envelope.N("seq") > 0) p["proxyEventSeq"] = envelope.N("seq"); if (replay) p["proxyEventReplay"] = true;
            HandleNotification(n.S("method"), p);
        }
        catch (Exception e) { Console.Error.WriteLine("处理代理事件失败：" + e); }
    }
    private void HandleNotification(string method, JsonObject p)
    {
        string tid = p.S("threadId", p.G("thread").S("id"));
        if (method == "thread/started" && Internal(p.G("thread"))) { internalThreads.Add(tid); return; }
        if (internalThreads.Contains(tid)) { TitleNotification(method, p); return; }
        if (method == "thread/started")
        {
            Remember(p.G("thread")); if (Track(tid) && CurrentThread == "" && !Clients.Any(c => c.PendingOptions is not null)) SetCurrent(tid); Broadcast(); return;
        }
        if (method == "proxy/threadReverted") { Revert(tid, p.S("beforeTurnId")); SetCurrent(tid); return; }
        if (!Track(tid)) return;
        var r = Runtime(tid); string turn = p.S("turnId", r.Turn);
        p["turnId"] = turn;
        switch (method)
        {
            case "thread/archived": case "thread/deleted": Invalidate(tid, method == "thread/deleted"); return;
            case "thread/closed": Router.Ready.Remove(tid); SetStatus(tid, "not_loaded"); break;
            case "thread/unarchived": EventLoop.Observe(RefreshThreads()); break;
            case "thread/name/updated": Rename(tid, p.S("threadName")); if (pendingTitles.TryGetValue(tid, out var title) && p.S("threadName") != title.S("provisionalName") && !GenericName(p.S("threadName"))) { pendingTitles.Remove(tid); PersistOperations(); } break;
            case "thread/settings/updated": ApplySettings(p.G("threadSettings"), tid); break;
            case "thread/tokenUsage/updated": if (p.G("tokenUsage") is JsonNode usage) TokenUsage[tid] = usage.DeepClone(); break;
            case "turn/started": StartTurn(tid, p.G("turn").S("id"), J.Epoch(p.G("turn").G("startedAt"))); Broadcast(true); return;
            case "turn/completed":
                long completed = J.Epoch(p.G("turn").G("completedAt")), started = J.Epoch(p.G("turn").G("startedAt"));
                if (started == 0 && completed > 0 && p.G("turn").N("durationMs") > 0) started = completed - p.G("turn").N("durationMs");
                FinishTurn(tid, p.G("turn").S("id"), started, completed, !p.B("proxyEventReplay")); return;
            case "turn/diff/updated": UpdateDiff(tid, turn, p.S("diff"), context: p); break;
            case "turn/plan/updated":
                var steps = MessageNormalizer.PlanSteps(p.G("plan")); var planMeta = J.Merge(p, J.O(("plan", steps), ("turnId", turn), ("turnStartedAt", r.Started)));
                Messages.Upsert(J.O(("id", turn + ":plan"), ("role", "assistant"), ("kind", "plan"), ("text", MessageNormalizer.PlanText(p.S("explanation"), steps)), ("streaming", true), ("meta", planMeta), ("createdAt", J.Now))); break;
            case "item/agentMessage/delta":
                if (r.ReplyStarted == 0) { r.ReplyStarted = J.Now; r.Revision++; Broadcast(); }
                p["turnStartedAt"] = r.Started; p["turnId"] = turn;
                var message = Messages.Delta(p.S("itemId"), "assistant", p.S("delta"), p);
                if (message is not null) foreach (var client in Clients) client.Publish(message); return;
            case "item/plan/delta": Messages.Delta(turn != "" ? turn + ":plan" : p.S("itemId"), "plan", p.S("delta"), p); break;
            case "item/commandExecution/outputDelta": case "item/fileChange/outputDelta": Messages.Delta(p.S("itemId"), method.StartsWith("item/command") ? "command" : "file", p.S("delta"), p); break;
            case "item/mcpToolCall/progress": Messages.Delta(p.S("itemId"), "tool", p.S("message"), p); break;
            case "item/reasoning/summaryTextDelta": case "item/reasoning/textDelta": case "item/reasoning/summaryPartAdded": Messages.Reasoning(p); break;
            case "item/fileChange/patchUpdated":
                var previous = Messages.GetSource(tid, turn, p.S("itemId")); var patch = Normalizer.Normalize(J.O(("id", p.G("itemId")), ("type", "fileChange"), ("status", previous.G("meta").S("status", "inProgress")), ("changes", p.G("changes"))), J.Merge(p, J.O(("createdAt", previous?.N("createdAt") ?? r.Started)))); if (patch is not null) Messages.Upsert(patch); break;
            case "item/started":
            case "item/completed":
                bool done = method == "item/completed";
                var item = Normalizer.Normalize(p.G("item") ?? new JsonObject(), J.Merge(p, J.O(("createdAt", done ? p.G("completedAtMs") : p.G("startedAtMs")), ("completedAt", done ? p.G("completedAtMs") : null), ("streaming", !done), ("sourceCompleted", done), ("turnOrderAt", r.Started))));
                if (item is not null)
                {
                    var stored = Messages.Upsert(item);
                    if (stored is not null && PhoneSession.AssistantText(stored)) { if (r.ReplyStarted == 0) r.ReplyStarted = J.Now; if (done) foreach (var client in Clients) client.Complete(stored, r.Busy && r.Turn == turn); }
                    Broadcast(item.S("role") == "user");
                }
                return;
            case "thread/status/changed":
                string status = Status(p.G("status"));
                if (status == "running") StartTurn(tid, r.Turn, r.Started);
                else if (status == "not_loaded") { Router.Ready.Remove(tid); SetStatus(tid, status); }
                else if (r.Busy || r.Turn != "") FinishTurn(tid, r.Turn, recover: !p.B("proxyEventReplay")); else SetStatus(tid, status); break;
            case "error": if (p.G("willRetry")?.ToString() == "false") { FinishTurn(tid, turn); SetStatus(tid, "error"); } Console.Error.WriteLine(p.G("error").S("message", "Codex 返回错误")); break;
        }
        Broadcast();
    }
}
