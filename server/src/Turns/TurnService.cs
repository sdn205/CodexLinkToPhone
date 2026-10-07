using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    private void StartTurn(string tid, string turn, long start = 0)
    {
        if (tid == "" || Messages.TurnCompleted(tid, turn) || Messages.RolledBack.Contains((tid, turn))) return; var r = Runtime(tid);
        if (turn != "" && r.Turn != turn && !(r.Busy && r.Turn == "" && r.Started > 0)) { r.ReplyStarted = 0; r.Started = start > 0 ? start : J.UuidTime(turn) is > 0 and var stamp ? stamp : J.Now; }
        r.LastTiming = null;
        if (turn != "") r.Turn = turn; if (r.Started == 0) r.Started = start > 0 ? start : J.Now; r.Busy = true; r.Revision++; SetStatus(tid, "running");
    }
    private void RememberTiming(string tid, string turn, long start, long end, long reply = 0)
    {
        if (tid == "" || turn == "" || start <= 0 || end < start || Messages.RolledBack.Contains((tid, turn))) return;
        var r = Runtime(tid); r.Timings[turn] = J.O(("threadId", tid), ("turnId", turn), ("startedAt", start), ("replyStartedAt", reply > 0 ? reply : null), ("completedAt", end));
        while (r.Timings.Count > 160) r.Timings.Remove(r.Timings.Keys.First());
    }
    private void FinishTurn(string tid, string turn = "", long started = 0, long completed = 0, bool recover = true)
    {
        if (!Track(tid)) return; var r = Runtime(tid); if (turn == "") turn = r.Turn;
        if (turn == "") turn = Messages.ForThread(tid).LastOrDefault() is { } latest ? MessageOrder.Turn(latest) : "";
        if (completed == 0) completed = J.Now; if (started == 0) started = r.Started;
        RememberTiming(tid, turn, started, completed, r.ReplyStarted);
        Messages.CompleteTurn(tid, turn);
        foreach (var m in Messages.Values.Where(m => MessageOrder.Thread(m) == tid && MessageOrder.Turn(m) == turn && m.S("kind") != "plan").ToArray())
        {
            if (m.B("streaming") || m.G("meta").S("status") is "inProgress" or "in_progress" or "running" or "pending")
            {
                m["streaming"] = false; if (m.G("meta") is JsonObject meta && meta.G("status") is not null) meta["status"] = "completed"; Messages.Touch(m);
                if (PhoneSession.AssistantText(m)) foreach (var c in Clients) c.Complete(m);
            }
        }
        if (turn != "") DiscardPlan(tid, turn);
        CompleteDiff(tid, turn, started, completed);
        if (r.Turn != "" && turn != "" && r.Turn != turn) { Broadcast(); return; }
        bool hadRun = r.Busy || r.Turn != "";
        localCreation.Remove(tid);
        r.Busy = false; r.Turn = ""; r.Started = 0; r.ReplyStarted = 0; r.Revision++; r.LastTiming = r.Timings.GetValueOrDefault(turn)?.Obj(); SetStatus(tid, "idle");
        if (hadRun && !Clients.Any(c => c.Open && !c.Background && c.ThreadId == tid)) { Unread.Add(tid); PersistUnread(); }
        Broadcast();
        if (recover) { EventLoop.Observe(RecoverCompleted(tid)); ScheduleTitle(tid); }
    }
    private async Task RecoverCompleted(string tid)
    {
        try { await EnsureHydrated(tid, true); await LoadHistory(tid); } catch (Exception e) { Console.Error.WriteLine("完成后恢复历史失败：" + e.Message); } finally { Broadcast(); }
    }
    private void DiscardPlan(string tid, string turn)
    {
        Messages.DiscardedPlans.Add((tid, turn)); Messages.RemoveWhere(m => MessageOrder.Thread(m) == tid && MessageOrder.Turn(m) == turn && m.S("kind") == "plan"); PersistOperations();
    }
    private void UpdateDiff(string tid, string turn, string diff, bool? running = null, JsonObject? context = null)
    {
        var changes = DiffData.Parse(diff); if (turn == "" || changes.Count == 0) return;
        var r = Runtime(tid); bool active = running ?? (r.Busy && r.Turn == turn); string id = tid + ":" + turn + ":turn-diff-live";
        var meta = J.Merge(context, J.O(("changes", changes), ("state", active ? "in_progress" : "completed"), ("display", "above_composer"), ("source", "turnDiff"), ("threadId", tid), ("turnId", turn), ("turnStartedAt", r.Started > 0 ? r.Started : null)));
        Messages.Upsert(J.O(("id", id), ("role", "assistant"), ("kind", "turn_diff"), ("streaming", active), ("text", changes.Count + " 个文件" + (active ? "正在更改" : "已更改")), ("unifiedDiff", diff), ("meta", meta), ("createdAt", Messages.GetSource(tid, turn, id)?.N("createdAt") ?? J.Now)));
        if (!active) CompleteDiff(tid, turn, r.Started, J.Now);
    }
    private void RestoreLiveDiff(string tid, string turn, long started)
    {
        string id = tid + ":" + turn + ":turn-diff-live";
        if (Messages.GetSource(tid, turn, id) is not null || Messages.DiscardedPlans.Contains((tid, turn))) return;
        var changes = DiffData.Aggregate(Messages.Values.Where(m => MessageOrder.Thread(m) == tid && MessageOrder.Turn(m) == turn && m.S("kind") == "file").SelectMany(m => m.G("meta").Arr("changes")));
        if (changes.Count == 0) return;
        Messages.Upsert(J.O(("id", id), ("role", "assistant"), ("kind", "turn_diff"), ("streaming", true), ("text", changes.Count + " 个文件正在更改"), ("unifiedDiff", ""), ("createdAt", started > 0 ? started : J.Now),
            ("meta", J.O(("changes", changes), ("state", "in_progress"), ("display", "above_composer"), ("source", "fileChange"), ("threadId", tid), ("turnId", turn), ("turnStartedAt", started)))));
    }
    private void CompleteDiff(string tid, string turn, long started, long completed)
    {
        if (turn == "" || Messages.RolledBack.Contains((tid, turn))) return;
        var all = Messages.ForThread(tid).Where(m => MessageOrder.Turn(m) == turn).ToArray();
        var live = all.LastOrDefault(m => m.S("kind") == "turn_diff" && m.G("meta").S("display") == "above_composer");
        var existing = all.LastOrDefault(m => m.S("kind") == "turn_diff" && m.G("meta").S("display") == "completed_card");
        string diff = live?.S("unifiedDiff") ?? existing?.S("unifiedDiff") ?? "";
        var changes = diff != "" ? DiffData.Parse(diff) : DiffData.Aggregate(all.Where(m => m.S("kind") == "file").SelectMany(m => m.G("meta").Arr("changes")));
        if (changes.Count == 0) return;
        Messages.RemoveWhere(m => MessageOrder.Thread(m) == tid && MessageOrder.Turn(m) == turn && m.S("kind") == "turn_diff" && m.G("meta").S("display") == "above_composer");
        long created = all.Where(m => m.S("kind") != "turn_diff").Select(m => Math.Max(m.N("createdAt"), J.Epoch(m.G("meta").G("turnCompletedAt")))).DefaultIfEmpty(J.Now).Max() + 1;
        Messages.Upsert(J.O(("id", tid + ":" + turn + ":turn-diff"), ("role", "assistant"), ("kind", "turn_diff"), ("streaming", false), ("text", changes.Count + " 个文件已更改"), ("unifiedDiff", diff),
            ("meta", J.O(("changes", changes), ("state", "completed"), ("display", "completed_card"), ("source", diff != "" ? "turnDiff" : "fileChange"), ("threadId", tid), ("turnId", turn), ("turnStartedAt", started > 0 ? started : null), ("turnCompletedAt", completed > 0 ? completed : null), ("turnOrderAt", J.UuidTime(turn) is > 0 and var stamp ? stamp : started))), ("createdAt", created)));
    }
    private void Revert(string tid, string before, JsonNode? retained = null)
    {
        var ordered = Messages.ForThread(tid); var turns = ordered.Select(MessageOrder.Turn).Where(x => x != "").Distinct().ToArray(); int index = Array.IndexOf(turns, before);
        var removed = index >= 0 ? turns[index..].ToHashSet() : new HashSet<string> { before };
        if (retained is not null) { var kept = retained.Arr("turns").Select(x => x.S("id")).ToHashSet(); foreach (string t in turns) if (!kept.Contains(t)) removed.Add(t); }
        foreach (string turn in removed) { Messages.RolledBack.Add((tid, turn)); Runtime(tid).Timings.Remove(turn); Messages.DiscardedPlans.Remove((tid, turn)); }
        Messages.RemoveWhere(m => MessageOrder.Thread(m) == tid && removed.Contains(MessageOrder.Turn(m)));
        RemoveAcceptedUserMessages(m => MessageOrder.Thread(m) == tid && removed.Contains(MessageOrder.Turn(m)));
        var r = Runtime(tid); r.Busy = false; r.Turn = ""; r.Started = 0; r.ReplyStarted = 0; r.Revision++; r.LastTiming = null; SetStatus(tid, "idle"); Unread.Remove(tid);
        if (retained is not null) Hydrate(retained, Messages.Revision, r.Revision); PersistOperations(); Broadcast();
    }
    private void PersistUnread() => PersistState();
}
