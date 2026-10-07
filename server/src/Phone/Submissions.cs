using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    private async Task<JsonObject> Submit(JsonObject message, string tid, PhoneSession client, JsonObject request, JsonObject options, long ingressRevision)
    {
        Ready(); string text = message.S("text"); if (Annotations.Decode(text) is null) text = text.Trim();
        var images = Images.Normalize(message.G("images")); bool accepted = false; long optimisticRevision = 0; bool oldBusy = false; string oldTurn = ""; long oldStart = 0;
        try
        {
            if (text == "" && images.Count == 0) throw new BridgeException("没有可发送的文字或受支持图片");
            bool created = false;
            if (tid == "")
            {
                string creationLane = client.Lane;
                client.Creating ??= StartThread(options); var thread = await client.Creating; tid = thread.S("id"); created = true;
                BindCreatedThread(tid, creationLane);
                if (client.ThreadId == "" && client.Revision == ingressRevision) { SetCurrent(tid); Select(client, tid, true); client.PendingOptions = null; }
                request["threadId"] = tid; PersistOperations();
            }
            var r = Runtime(tid);
            if (Threads.GetValueOrDefault(tid).S("status") == "unknown") throw new BridgeException("会话状态未知，请先重新打开会话", "unknown_thread_status");
            if (!r.Busy || r.Turn == "") await Resume(tid, select: true);
            r = Runtime(tid); oldBusy = r.Busy; oldTurn = r.Turn; oldStart = r.Started; long sent = J.Now;
            bool steer = r.Busy && r.Turn != "";
            var submissionOrder = Messages.CaptureSubmissionOrder(tid, steer ? r.Turn : "");
            if (!r.Busy || r.Started == 0) StartTurn(tid, r.Turn, sent); optimisticRevision = r.Revision;
            var input = new JsonArray(J.O(("type", "text"), ("text", text), ("text_elements", new JsonArray())));
            foreach (var image in images.Items()) input.Add(image.G("input")!.DeepClone());
            string cid = request.S("clientUserMessageId");
            var args = J.O(("threadId", tid), ("clientUserMessageId", cid), ("input", input));
            if (steer) args["expectedTurnId"] = r.Turn;
            else { var settings = Settings.GetValueOrDefault(tid) ?? DefaultSettings(); if (settings.S("model") != "") args.Set("model", settings.G("model")); if (settings.S("effort") != "") args.Set("effort", settings.G("effort")); }
            Task<JsonNode> submission = Router.Request(steer ? "turn/steer" : "turn/start", args, select: true);
            if (created && text != "")
            {
                string provisional = ProvisionalTitle(text); Rename(tid, provisional); pendingTitles[tid] = J.O(("threadId", tid), ("prompt", text), ("cwd", Threads.GetValueOrDefault(tid).S("cwd", Config.Cwd)), ("provisionalName", provisional), ("attempts", 0), ("updatedAt", J.Now)); PersistOperations();
                EventLoop.Observe(PersistName(tid, provisional)); ScheduleTitle(tid); Broadcast(true);
            }
            var response = await submission; string turn = steer ? response.S("turnId", response.G("turn").S("id", r.Turn)) : response.G("turn").S("id");
            accepted = true;
            if (turn == "") throw new BridgeException("消息提交回执缺少 turnId", "submission_incomplete", true);
            Messages.RolledBack.Remove((tid, turn));
            if (!r.Timings.ContainsKey(turn)) StartTurn(tid, turn, J.Epoch(response.G("turn").G("startedAt")) is > 0 and var started ? started : sent);
            // Start, steer and edited submissions all enter the same message store
            // when accepted. Item notifications enrich this identity later.
            var context = J.Merge(submissionOrder, J.O(("threadId", tid), ("turnId", turn), ("createdAt", sent), ("turnOrderAt", r.Started), ("userMessageOrderAt", sent), ("submissionState", "accepted")));
            var user = Normalizer.Normalize(J.O(("id", MessageStore.UserId(tid, cid)), ("type", "userMessage"), ("clientUserMessageId", cid), ("content", input)), context)!;
            RecordAcceptedUserMessage(user);
            Broadcast(true); return J.O(("threadId", tid), ("turnId", turn));
        }
        catch (Exception e)
        {
            bool uncertain = accepted || e is BridgeException { Uncertain: true };
            if (tid != "" && optimisticRevision > 0 && Runtime(tid).Revision == optimisticRevision) { var r = Runtime(tid); r.Busy = oldBusy; r.Turn = oldTurn; r.Started = oldStart; r.Revision++; SetStatus(tid, oldBusy ? "running" : "idle"); }
            if (!uncertain) Images.Cleanup(images);
            if (!accepted && e is BridgeException bridgeError) { bridgeError.ThreadId = tid; throw; }
            throw new BridgeException(e.Message, "submission_failed", uncertain) { ThreadId = tid };
        }
    }
    private async Task<JsonObject> Edit(JsonObject message, string tid, PhoneSession client, JsonObject request, long revision)
    {
        string text = message.S("text"); if (Annotations.Decode(text) is null) text = text.Trim(); string turn = message.S("turnId");
        if (turn == "" || tid == "") throw new BridgeException("缺少要编辑的消息信息", "invalid_edit_target", false, false);
        if (text == "") throw new BridgeException("修改后的消息不能为空", "empty_edit_message", false, false);
        var r = Runtime(tid); if (r.Busy || r.Turn != "") throw new BridgeException("当前会话仍在运行，停止后才能编辑", "thread_busy");
        var read = await ReadThreadFull(tid); var thread = read.G("thread");
        if (thread.S("id") != tid || thread.G("turns") is not JsonArray) throw new BridgeException("无法读取完整会话，暂时不能编辑", "edit_thread_unavailable");
        var turns = thread.Arr("turns").ToArray(); int index = Array.FindIndex(turns, t => t.S("id") == turn);
        if (request.B("editRollbackApplied"))
        {
            if (index >= 0) throw new BridgeException("会话回滚状态尚未同步，请稍后重试", "edit_rollback_not_visible");
            int count = (int)request.N("editRollbackTurnCount");
            if (turns.Length > count)
            {
                var user = turns[^1].Arr("items").LastOrDefault(x => x.S("type") == "userMessage"); var parsed = Normalizer.UserContent(user.G("content"));
                if (parsed.Text.Trim() == text.Trim() && parsed.Images.Count == 0) return J.O(("threadId", tid), ("turnId", turns[^1].G("id")));
                throw new BridgeException("会话已有新的回复，不能继续这次编辑", "edit_thread_advanced", false, false);
            }
            if (turns.Length < count) throw new BridgeException("会话历史已再次变化，不能继续这次编辑", "edit_thread_changed", false, false);
            Revert(tid, turn, thread);
        }
        else if (index == turns.Length - 1 && index >= 0)
        {
            if (thread.G("status").S("type") == "active" || turns[^1].S("status") == "inProgress") throw new BridgeException("当前会话仍在运行，停止后才能编辑", "thread_busy");
            request["editRollbackAttempted"] = true; PersistOperations();
            var response = await Router.Request("thread/revert", J.O(("threadId", tid), ("beforeTurnId", turn)), select: true);
            if (response.G("thread").S("id") != tid) throw new BridgeException("会话回退结果不完整", "edit_revert_incomplete", true);
            var retained = J.Merge(thread, response.G("thread")); retained["turns"] = J.A(turns.Take(index)); Revert(tid, turn, retained);
            request["editRollbackApplied"] = true; request["editRollbackTurnCount"] = index; request["editRollbackLastTurnId"] = index > 0 ? turns[index - 1].S("id") : ""; PersistOperations();
        }
        else if (request.B("editRollbackAttempted") && index < 0)
        { Revert(tid, turn, thread); request["editRollbackApplied"] = true; request["editRollbackTurnCount"] = turns.Length; request["editRollbackLastTurnId"] = turns.LastOrDefault().S("id"); PersistOperations(); }
        else throw new BridgeException("只能编辑最后一轮消息", "edit_not_latest_turn", false, false);
        var edited = message.Obj(); edited["text"] = text; edited["images"] = new JsonArray(); return await Submit(edited, tid, client, request, new(), revision);
    }
}
