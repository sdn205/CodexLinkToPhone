using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    private Task? refreshing;
    private long lastInitialization;
    private readonly Dictionary<string, string> historyCursor = [];
    private readonly HashSet<string> historyRead = [];
    private readonly Dictionary<string, long> historyRetryAt = [];
    private readonly Dictionary<string, long> localCreation = [];
    // Invalidation and replacement plans make earlier asynchronous reads obsolete.
    private readonly Dictionary<string, long> threadGenerations = [], historyPlans = [];
    private static bool GenericName(string name) => new[] { "", "未命名会话", "当前会话", "新会话", "新对话", "new thread", "new conversation", "untitled", "untitled thread", "unnamed thread" }.Contains(name.Trim().ToLowerInvariant());
    private static string Status(JsonNode? value) => value.S("type") switch { "active" => "running", "systemError" => "error", "notLoaded" => "not_loaded", "idle" => "idle", _ => "unknown" };
    private void Remember(JsonNode? thread)
    {
        string id = thread.S("id"); if (id == "") return;
        if (Internal(thread)) { internalThreads.Add(id); return; }
        if (SubAgent(thread)) { subAgents.Add(id); return; }
        Threads.TryGetValue(id, out var previous);
        long recent = J.Epoch(thread.G("recencyAt")); if (recent == 0) recent = J.Epoch(thread.G("updatedAt"));
        string name = thread.S("name").Trim(); if (GenericName(name) && previous is not null) name = previous.S("name"); if (name == "") name = "未命名会话";
        var summary = J.Merge(previous, J.O(("id", id), ("name", name), ("cwd", thread.G("cwd") ?? previous.G("cwd")), ("source", thread.G("source") ?? previous.G("source")), ("parentThreadId", thread.G("parentThreadId")), ("status", thread.G("status") is not null ? Status(thread.G("status")) : previous.S("status", "unknown")), ("recencyAt", recent > 0 ? recent : previous.N("recencyAt")), ("updatedAt", recent > 0 ? recent : previous.N("updatedAt")), ("createdAt", J.Epoch(thread.G("createdAt")) is > 0 and var created ? created : previous.N("createdAt", recent))));
        if (thread.S("preview") != "") summary["preview"] = thread.S("preview"); Threads[id] = summary;
        if (!runtimes.ContainsKey(id) && summary.S("status") == "running") { var runtime = Runtime(id); runtime.Busy = true; runtime.Started = J.Now; runtime.Revision++; }
    }
    public JsonObject DefaultSettings()
    {
        var model = Models.Items().FirstOrDefault(x => x.B("isDefault")) ?? Models.Items().FirstOrDefault();
        return J.O(("model", Config.Model != "" ? Config.Model : model.S("model")), ("effort", model.S("defaultReasoningEffort", model.Arr("supportedReasoningEfforts").FirstOrDefault().S("reasoningEffort"))));
    }
    private void ApplySettings(JsonNode? response, string tid)
    {
        if (tid == "") return; var settings = Settings.GetValueOrDefault(tid)?.Obj() ?? DefaultSettings();
        string model = response.S("model", response.G("thread").S("model")), effort = response.S("reasoningEffort", response.S("effort", response.G("thread").S("reasoningEffort")));
        if (model != "") settings["model"] = model; if (effort != "") settings["effort"] = effort; Settings[tid] = settings;
    }
    private async Task InitializeUpstream()
    {
        if (initializing || J.Now - lastInitialization < 500) return; initializing = true; lastInitialization = J.Now;
        try
        {
            await Task.Delay(70, Cancellation);
            var models = await Router.Request("model/list", J.O(("cursor", null), ("limit", 100), ("includeHidden", false)));
            Models = J.A(models.Arr("data").Where(m => m.S("model", m.S("id")) != "").Select(m =>
            {
                string id = m.S("model", m.S("id"));
                var efforts = J.A(m.Arr("supportedReasoningEfforts").Select(e =>
                    J.O(("reasoningEffort", e.S("reasoningEffort", e.S("effort"))),
                        ("label", e.S("label", e.S("reasoningEffort", e.S("effort")))))));
                return J.O(("model", id), ("displayName", m.S("displayName", m.S("name", id))),
                    ("description", m.S("description")), ("isDefault", m.B("isDefault") || m.B("default")),
                    ("defaultReasoningEffort", m.S("defaultReasoningEffort", m.S("defaultEffort"))),
                    ("supportedReasoningEfforts", efforts));
            }));
            await RefreshThreads();
            foreach (var tid in Clients.Select(c => c.ThreadId).Append(CurrentThread).Where(x => x != "").Distinct().ToArray())
                try { await Resume(tid); } catch (Exception e) { Console.Error.WriteLine("恢复会话失败：" + e.Message); }
            foreach (var id in pendingTitles.Keys.ToArray()) ScheduleTitle(id);
        }
        catch (Exception e) { Console.Error.WriteLine("初始化手机桥连接失败：" + e.Message); }
        finally { initializing = false; Broadcast(); }
    }
    public Task RefreshThreads() => refreshing ??= RefreshThreadsCore();
    private async Task RefreshThreadsCore()
    {
        await Task.Yield();
        try
        {
            Ready(); long requested = J.Now; var revisions = runtimes.ToDictionary(x => x.Key, x => x.Value.Revision); var seen = new HashSet<string>(); string? cursor = null;
            for (int page = 0; page < 10; page++)
            {
                await WaitWrites();
                var response = await Router.Request("thread/list", J.O(("cursor", cursor), ("limit", 100), ("sortKey", "recency_at"), ("sortDirection", "desc"), ("archived", false), ("sourceKinds", J.Strings(["cli", "vscode", "appServer", "exec", "unknown"]))));
                foreach (var thread in response.Arr("data"))
                {
                    string tid = thread.S("id"); Remember(thread); seen.Add(tid); var r = Runtime(tid);
                    if (r.Revision != revisions.GetValueOrDefault(tid)) continue;
                    bool busy = Status(thread.G("status")) == "running";
                    if (busy != r.Busy && (busy || r.Turn == "")) { r.Busy = busy; r.Started = busy ? (r.Started > 0 ? r.Started : J.Now) : 0; r.Revision++; if (busy && r.Turn == "") EventLoop.Observe(EnsureHydrated(tid, true)); }
                }
                string next = response.S("nextCursor"); if (next == "" || next == cursor) break; cursor = next;
            }
            foreach (string tid in Threads.Keys.ToArray()) if (!seen.Contains(tid) && tid != CurrentThread && !Clients.Any(x => x.ThreadId == tid) && !pendingTitles.ContainsKey(tid) && Threads[tid].N("updatedAt") < requested && requested - localCreation.GetValueOrDefault(tid) > 60000) Threads.Remove(tid);
            Broadcast();
        }
        finally { refreshing = null; }
    }
    public Task<JsonNode> Resume(string tid, bool force = false, bool select = false)
    {
        Ready(); if (tid == "") throw new BridgeException("缺少 threadId");
        if (Router.Resuming.TryGetValue(tid, out var task)) return task;
        if (!force && Router.Ready.Contains(tid)) return Task.FromResult<JsonNode>(new JsonObject());
        var next = ResumeCore(tid, select); Router.Resuming[tid] = next; return next;
    }
    private async Task<JsonNode> ResumeCore(string tid, bool select)
    {
        long generation = threadGenerations.GetValueOrDefault(tid);
        await Task.Yield();
        long messageRevision = Messages.Revision, runtimeRevision = Runtime(tid).Revision;
        try
        {
            var args = J.O(("threadId", tid), ("excludeTurns", true), ("initialTurnsPage", J.O(("limit", 20), ("itemsView", "summary"), ("sortDirection", "desc")))); if (Threads.GetValueOrDefault(tid).S("cwd") != "") args["cwd"] = Threads[tid].S("cwd");
            var result = await Router.Request("thread/resume", args, select: select);
            if (threadGenerations.GetValueOrDefault(tid) != generation) return result;
            Router.Ready.Add(tid); ApplySettings(result, tid); HydrateResponse(result, messageRevision, runtimeRevision); return result;
        }
        catch (Exception e) { Router.Ready.Remove(tid); if (ThreadNotFound(e)) Invalidate(tid); throw; }
        finally { Router.Resuming.Remove(tid); }
    }
    public Task<JsonNode> EnsureHydrated(string tid, bool force = false)
    {
        if (tid == "" || !Router.Connected) return Task.FromResult<JsonNode>(new JsonObject());
        if (hydration.TryGetValue(tid, out var task)) return task;
        if (!force && Messages.ForThread(tid).Count > 0 && J.Now - lastHydration.GetValueOrDefault(tid) < 5000) return Task.FromResult<JsonNode>(new JsonObject());
        var work = HydrateCore(tid); hydration[tid] = work; return work;
    }
    private async Task<JsonNode> HydrateCore(string tid)
    {
        long generation = threadGenerations.GetValueOrDefault(tid), plan = historyPlans.GetValueOrDefault(tid);
        await Task.Yield();
        try
        {
            if (Runtime(tid).Busy && Router.Ready.Contains(tid) && localCreation.ContainsKey(tid)) return new JsonObject();
            if (Runtime(tid).Busy || !Router.Ready.Contains(tid)) return await Resume(tid, true);
            await WaitWrites(); if (threadGenerations.GetValueOrDefault(tid) != generation) return new JsonObject();
            long revision = Messages.Revision, runtimeRevision = Runtime(tid).Revision;
            var result = await ReadThreadFull(tid);
            if (threadGenerations.GetValueOrDefault(tid) != generation || historyPlans.GetValueOrDefault(tid) != plan) return result;
            HydrateResponse(result, revision, runtimeRevision, authoritative: true); return result;
        }
        catch (Exception e) { if (ThreadNotFound(e)) Invalidate(tid); throw; }
        finally { if (threadGenerations.GetValueOrDefault(tid) == generation) lastHydration[tid] = J.Now; hydration.Remove(tid); Broadcast(); }
    }
    private void HydrateResponse(JsonNode response, long revision = long.MaxValue, long runtimeRevision = 0, bool authoritative = false)
    {
        var thread = response.G("thread"); if (thread.S("id") == "") return; string tid = thread.S("id"); ApplySettings(response, tid); Hydrate(thread!, revision, runtimeRevision);
        if (response.G("initialTurnsPage").G("data") is JsonArray page)
        {
            historyPlans[tid] = historyPlans.GetValueOrDefault(tid) + 1;
            TrackSummaryTurns(tid, page);
            var paged = thread.Obj(); paged.Set("turns", page); Hydrate(paged, revision, 0, true); string cursor = response.G("initialTurnsPage").S("nextCursor");
            historyRead.Remove(tid); if (cursor != "") historyCursor[tid] = cursor; else historyCursor.Remove(tid);
        }
        else if (!historyCursor.ContainsKey(tid))
        {
            historyPlans[tid] = historyPlans.GetValueOrDefault(tid) + 1;
            if (!authoritative && (!thread.Arr("turns").Any() || thread.G("turns") is not JsonArray || thread.G("status").S("type") == "notLoaded" || thread.Arr("turns").Any(t => t.S("itemsView") == "summary"))) historyRead.Add(tid);
            else historyRead.Remove(tid);
        }
        EventLoop.Observe(LoadHistory(tid));
    }
    private void Hydrate(JsonNode thread, long revision = long.MaxValue, long runtimeRevision = 0, bool skipRuntime = false)
    {
        string tid = thread.S("id"); if (tid == "" || Internal(thread) || SubAgent(thread)) return; Remember(thread);
        string snapshot = Epoch + ":" + (++snapshotSequence); JsonNode? active = null; bool rolled = false;
        foreach (var turn in thread.Arr("turns"))
        {
            string turnId = turn.S("id"); if (Messages.RolledBack.Contains((tid, turnId))) { rolled = true; continue; }
            bool running = turn.S("status") == "inProgress"; if (running) active = turn;
            long start = J.Epoch(turn.G("startedAt")), end = J.Epoch(turn.G("completedAt"));
            RememberTiming(tid, turnId, start, end);
            int i = 0; foreach (var item in turn.Arr("items"))
            {
                if (item.S("type") == "plan" && !running) { i++; continue; }
                var message = Normalizer.Normalize(item, J.O(("threadId", tid), ("turnId", turnId), ("createdAt", start), ("completedAt", end), ("turnOrderAt", J.UuidTime(turnId) is > 0 and var stamp ? stamp : start), ("streaming", running && (item.S("status") == "inProgress" || item.S("type") == "plan"))));
                if (message is not null) Messages.Upsert(message, snapshot, i, revision); i++;
            }
            Messages.Commit(tid, turnId, snapshot);
            if (running && turn.S("diff") != "") UpdateDiff(tid, turnId, turn.S("diff"), true);
            if (running && turn.S("diff") == "") RestoreLiveDiff(tid, turnId, start);
            if (!running) CompleteDiff(tid, turnId, start, end);
        }
        var r = Runtime(tid);
        if (!skipRuntime && !rolled && r.Revision <= runtimeRevision)
        {
            bool busy = active is not null || thread.G("status").S("type") == "active";
            if (busy) { r.Busy = true; r.Turn = active.S("id", r.Turn); r.Started = J.Epoch(active.G("startedAt")) is > 0 and var start ? start : r.Started > 0 ? r.Started : J.Now; }
            else { r.Busy = false; r.Turn = ""; r.Started = 0; r.ReplyStarted = 0; }
            r.Revision++; SetStatus(tid, busy ? "running" : "idle");
        }
        Broadcast();
    }
    private async Task LoadHistory(string tid)
    {
        if (Runtime(tid).Busy || !Router.Connected || paging.Contains(tid) || J.Now < historyRetryAt.GetValueOrDefault(tid) || !historyCursor.ContainsKey(tid) && !historyRead.Contains(tid) && !summaryTurns.ContainsKey(tid)) return;
        paging.Add(tid); long generation = threadGenerations.GetValueOrDefault(tid);
        try
        {
            var cursors = new HashSet<string>();
            while (!Runtime(tid).Busy && Router.Connected)
            {
                await WaitWrites(); if (threadGenerations.GetValueOrDefault(tid) != generation) return;
                long revision = Messages.Revision, plan = historyPlans.GetValueOrDefault(tid);
                if (historyCursor.TryGetValue(tid, out var cursor))
                {
                    if (!cursors.Add(cursor)) throw new IOException("thread/turns/list 返回重复游标");
                    var args = J.O(("threadId", tid), ("cursor", cursor), ("limit", 20), ("sortDirection", "desc"), ("itemsView", pagedThreads.Contains(tid) ? "summary" : "full"));
                    var page = await Router.Request("thread/turns/list", args);
                    if (threadGenerations.GetValueOrDefault(tid) != generation) return;
                    if (historyPlans.GetValueOrDefault(tid) != plan) { cursors.Clear(); continue; }
                    if (historyCursor.GetValueOrDefault(tid) != cursor) continue;
                    if (page.G("data") is not JsonArray) throw new IOException("历史分页缺少 data");
                    TrackSummaryTurns(tid, page.G("data"));
                    Hydrate(J.O(("id", tid), ("turns", page.G("data"))), revision, 0, true);
                    string next = page.S("nextCursor"); if (next == "") historyCursor.Remove(tid); else historyCursor[tid] = next;
                }
                else if (historyRead.Contains(tid))
                {
                    var response = await ReadThreadFull(tid);
                    if (threadGenerations.GetValueOrDefault(tid) != generation) return;
                    if (historyPlans.GetValueOrDefault(tid) != plan) { cursors.Clear(); continue; }
                    if (response.G("thread").S("id") != tid || response.G("thread").G("turns") is not JsonArray) throw new IOException("无法读取完整会话历史");
                    Hydrate(response.G("thread")!, revision, 0, true);
                    historyRead.Remove(tid);
                }
                else if (summaryTurns.TryGetValue(tid, out var summaries) && summaries.Count > 0)
                {
                    var summary = summaries.Values.First();
                    var complete = await ReadTurnItems(tid, summary);
                    if (threadGenerations.GetValueOrDefault(tid) != generation) return;
                    if (historyPlans.GetValueOrDefault(tid) != plan) { cursors.Clear(); continue; }
                    Hydrate(J.O(("id", tid), ("turns", new JsonArray(complete))), revision, 0, true);
                    summaries.Remove(summary.S("id"));
                    if (summaries.Count == 0) summaryTurns.Remove(tid);
                }
                else break;
            }
        }
        catch (Exception e) { if (ThreadNotFound(e)) Invalidate(tid); else { historyRetryAt[tid] = J.Now + 3000; Console.Error.WriteLine("历史加载失败：" + e.Message); } }
        finally { paging.Remove(tid); Broadcast(); }
    }
    private void SetStatus(string tid, string status) { if (Threads.TryGetValue(tid, out var t)) t["status"] = status; }
    private void Rename(string tid, string name) { if (Threads.TryGetValue(tid, out var t) && name.Trim() != "") t["name"] = name.Trim(); }
    private void Invalidate(string tid, bool remove = false)
    {
        threadGenerations[tid] = threadGenerations.GetValueOrDefault(tid) + 1;
        Threads.Remove(tid); Settings.Remove(tid); TokenUsage.Remove(tid); Unread.Remove(tid); runtimes.Remove(tid); Router.Ready.Remove(tid); historyCursor.Remove(tid); historyRead.Remove(tid); summaryTurns.Remove(tid); pagedThreads.Remove(tid); historyRetryAt.Remove(tid); writeLaneAliases.Remove("thread:" + tid);
        if (remove) Messages.RemoveWhere(m => MessageOrder.Thread(m) == tid);
        foreach (var c in Clients.Where(c => c.ThreadId == tid).ToArray()) Select(c, "", true);
        if (CurrentThread == tid) SetCurrent(""); PersistUnread(); Broadcast();
    }
    private async Task<JsonObject> StartThread(JsonObject options)
    {
        var defaults = DefaultSettings(); string cwd = options.S("cwd");
        if (cwd == "")
        {
            var stored = Persistence.Read(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Trae CN/User/globalStorage/storage.json"));
            string folder = Uri.UnescapeDataString(stored.G("windowsState").G("lastActiveWindow").S("folder")); if (Uri.TryCreate(folder, UriKind.Absolute, out var uri) && uri.IsFile) cwd = uri.LocalPath;
        }
        if (cwd == "") throw new BridgeException("无法确定 Trae 当前工作区", "workspace_unavailable", false, false);
        var p = J.O(("cwd", Path.GetFullPath(cwd)), ("approvalPolicy", options.S("approvalPolicy", Config.Approval)), ("sandbox", options.S("sandbox", Config.Sandbox)), ("ephemeral", false));
        string model = options.S("model", defaults.S("model")), effort = options.S("effort", defaults.S("effort"));
        if (model != "") p["model"] = model; if (effort != "") p["config"] = J.O(("model_reasoning_effort", effort));
        var response = await Router.Request("thread/start", p, select: true, instance: options.S("proxyInstanceId"));
        var thread = response.G("thread").Obj(); if (thread.S("id") == "") throw new BridgeException("新会话创建回执不完整", "thread_create_failed", true);
        string id = thread.S("id"); Router.Ready.Add(id); localCreation[id] = J.Now; Remember(thread); ApplySettings(response, id); return thread;
    }
}
