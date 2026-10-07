using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    private static JsonObject History(string item = "item") => J.O(("thread", J.O(("id", "a"), ("turns", new JsonArray(J.O(("id", "one"), ("status", "completed"), ("items", new JsonArray(J.O(("id", item), ("type", "agentMessage"), ("text", item))))))))));
    private static JsonObject Page(string item, string? next = null) => J.O(("data", History(item).G("thread").G("turns")), ("nextCursor", next));
    internal static void RegisterThreadTests()
    {
        T.Add("thread-catalog/normalization-preview-status-and-copy", f => {
            var b = f.Bridge; var original = T.Obj("{\"id\":\"a\",\"name\":\" Work \",\"status\":{\"type\":\"active\"},\"updatedAt\":1000,\"createdAt\":500,\"preview\":\"first prompt\"}");
            b.Remember(original); T.Equal(b.Threads["a"].S("name"), "Work"); T.Equal(b.Threads["a"].S("status"), "running"); T.Equal(b.Threads["a"].N("updatedAt"), 1000000L); T.Equal(b.Threads["a"].N("createdAt"), 500000L); T.Equal(original.S("name"), " Work ");
            T.Equal(b.Threads["a"].S("preview"), "first prompt"); T.Equal(Status(T.Obj("{\"type\":\"notLoaded\"}")), "not_loaded");
            b.Rename("a", "User title"); b.Remember(T.Obj("{\"id\":\"a\",\"name\":\"未命名会话\"}")); T.Equal(b.Threads["a"].S("name"), "User title"); T.Equal(b.Threads.Count, 1);
        });
        T.Add("thread-catalog/internal-subagent-filter-and-removal", f => {
            var b = f.Bridge; foreach (var json in new[] { "{\"id\":\"s\",\"ephemeral\":true}", "{\"id\":\"c\",\"parentThreadId\":\"a\"}", "{\"id\":\"d\",\"source\":{\"subAgent\":{}}}" }) b.Remember(T.Obj(json));
            T.Equal(b.Threads.Count, 0); b.Remember(T.Obj("{\"id\":\"a\",\"parentThreadId\":null}")); T.Equal(b.Threads.Count, 1);
            b.SetStatus("a", "running"); T.Equal(b.State().Arr("threads").Single().S("status"), "running"); b.Invalidate("a"); T.Equal(b.State().Arr("threads").Count(), 0);
        });
        T.Add("thread-history/completeness-follows-response-contract", f => {
            var b = f.Bridge; var empty = T.Obj("{\"thread\":{\"id\":\"a\",\"turns\":[]}}"); b.HydrateResponse(empty); T.Is(b.historyRead.Contains("a"));
            b.HydrateResponse(empty, authoritative: true); T.Is(!b.historyRead.Contains("a"));
            b.HydrateResponse(T.Obj("{\"thread\":{\"id\":\"a\"},\"initialTurnsPage\":{\"data\":[],\"nextCursor\":\"c1\"}}")); T.Equal(b.historyCursor["a"], "c1");
            b.HydrateResponse(T.Obj("{\"thread\":{\"id\":\"a\"},\"initialTurnsPage\":{\"data\":[],\"nextCursor\":null}}")); T.Is(!b.historyCursor.ContainsKey("a") && !b.historyRead.Contains("a"));
            b.HydrateResponse(T.Obj("{\"thread\":{\"id\":\"a\",\"turns\":[{\"id\":\"one\",\"itemsView\":\"summary\"}]}}")); T.Is(b.historyRead.Contains("a"));
        });
        T.Add("thread-history/pending-identity-keeps-cursor-and-recovers-without-open-failure", async f => {
            var b = f.Bridge; string path = Path.Combine(f.Directory, "pending-rollout.jsonl");
            JsonObject Row(string type, JsonObject payload) => J.O(("type", type), ("payload", payload));
            var rows = new[] { Row("session_meta", J.O(("id", "a"))),
                Row("event_msg", J.O(("type", "task_started"), ("turn_id", "one"))),
                Row("event_msg", J.O(("type", "agent_message"), ("message", "item-1"))) };
            File.WriteAllText(path, string.Join('\n', rows.Select(x => x.Wire())) + "\n", new System.Text.UTF8Encoding(false));
            var response = History("item-1"); response.G("thread")!["path"] = path;
            T.Is(!b.HydrateResponse(response, authoritative: true));
            T.Is(b.historyRead.Contains("a")); T.Is(!b.hydratedThreads.Contains("a")); T.Equal(b.Messages.ForThread("a").Count, 0);
            var peer = f.Peer("one", "a"); peer.Handler = m => Task.FromResult<JsonNode>(m.S("method") == "thread/read" ? response : Page("item-1"));
            b.historyCursor["a"] = "pending-page"; b.historyRetryAt.Remove("a"); await b.LoadHistory("a");
            T.Equal(b.historyCursor["a"], "pending-page"); T.Equal(peer.Calls.Count, 1);
            File.AppendAllText(path, Row("response_item", J.O(("type", "message"), ("role", "assistant"), ("id", "original"))).Wire() + "\n", new System.Text.UTF8Encoding(false));
            b.historyRetryAt.Remove("a"); await b.LoadHistory("a");
            T.Is(!b.historyCursor.ContainsKey("a") && !b.historyRead.Contains("a"));
            T.Equal(b.Messages.ForThread("a").Single().G("meta").S("sourceItemId"), "original");
        });
        T.Add("thread-history/concurrent-callers-share-authoritative-read", async f => {
            var b = f.Bridge; var peer = f.Peer("one", "a"); b.Router.Ready.Add("a"); var gate = new TaskCompletionSource<JsonNode>(); peer.Handler = m => m.S("method") == "thread/read" ? gate.Task : Task.FromResult<JsonNode>(Page("item"));
            var first = b.EnsureHydrated("a"); var second = b.EnsureHydrated("a"); T.Is(ReferenceEquals(first, second)); await T.Until(() => peer.Calls.Count == 1);
            gate.SetResult(History()); await Task.WhenAll(first, second); await b.EnsureHydrated("a"); T.Equal(peer.Calls.Count, 2); T.Is(T.Stored(b.Messages, "item") is not null);
        });
        T.Add("thread-history/initial-page-and-cursors-without-full-read", async f => {
            var b = f.Bridge; var peer = f.Peer("one", "a"); peer.Handler = m => Task.FromResult<JsonNode>(Page(m.G("params").S("cursor"), m.G("params").S("cursor") == "c1" ? "c2" : null));
            b.StartTurn("a", "running"); b.HydrateResponse(J.O(("thread", J.O(("id", "a"))), ("initialTurnsPage", Page("initial", "c1")))); T.Equal(peer.Calls.Count, 0);
            await T.Until(() => !b.paging.Contains("a")); T.Equal(peer.Calls.Count, 2); T.Is(peer.Calls.All(x => x.S("method") == "thread/turns/list"));
            foreach (string id in new[] { "initial", "c1", "c2" }) T.Is(T.Stored(b.Messages, id) is not null, id);
        });
        T.Add("thread-history/resume-plan-supersedes-pending-read", async f => {
            var b = f.Bridge; var peer = f.Peer("one", "a"); var gate = new TaskCompletionSource<JsonNode>(); peer.Handler = m => m.S("method") == "thread/read" ? gate.Task : Task.FromResult<JsonNode>(Page("page"));
            b.historyRead.Add("a"); var task = b.LoadHistory("a"); await T.Until(() => peer.Calls.Count > 0);
            b.HydrateResponse(J.O(("thread", J.O(("id", "a"))), ("initialTurnsPage", Page("new", "c1")))); gate.SetResult(History("stale")); await task;
            T.Is(T.Stored(b.Messages, "stale") is null); T.Is(T.Stored(b.Messages, "new") is not null && T.Stored(b.Messages, "page") is not null);
        });
        T.Add("thread-history/invalidation-rejects-late-read-and-resume", async f => {
            var b = f.Bridge; var peer = f.Peer("one", "a");
            foreach (string mode in new[] { "history", "hydrate", "resume" }) {
                var gate = new TaskCompletionSource<JsonNode>(); int count = peer.Calls.Count; peer.Handler = _ => gate.Task; b.Router.Ready.Add("a"); b.historyRead.Add("a");
                Task task = mode == "history" ? b.LoadHistory("a") : mode == "hydrate" ? b.EnsureHydrated("a", true) : b.Resume("a", true);
                await T.Until(() => peer.Calls.Count > count); b.Invalidate("a", true); gate.SetResult(History("removed")); await task;
                T.Is(!b.Threads.ContainsKey("a"), mode); T.Is(T.Stored(b.Messages, "removed") is null, mode); T.Is(!b.Router.Ready.Contains("a"), mode);
            }
        });
        T.Add("thread-history/lifecycle-preserves-cursor", async f => {
            var b = f.Bridge; var peer = f.Peer("one", "a"); var gate = new TaskCompletionSource<JsonNode>(); peer.Handler = _ => gate.Task;
            b.historyCursor["a"] = "c1"; var task = b.LoadHistory("a"); await T.Until(() => peer.Calls.Count > 0);
            b.HydrateResponse(T.Obj("{\"thread\":{\"id\":\"a\",\"turns\":[]}}"), authoritative: true); T.Equal(b.historyCursor["a"], "c1"); gate.SetResult(Page("old-page")); await task; T.Is(T.Stored(b.Messages, "old-page") is not null);
        });
        T.Add("thread-history/waits-for-writes-and-rejects-repeated-cursor", async f => {
            var b = f.Bridge; var peer = f.Peer("one", "a"); peer.Handler = _ => Task.FromResult<JsonNode>(Page("page", "c1"));
            var gate = Gate(); var write = b.Enqueue("thread:a", () => gate.Task); b.historyCursor["a"] = "c1"; var task = b.LoadHistory("a"); await Task.Delay(30); T.Equal(peer.Calls.Count, 0);
            gate.SetResult(new()); await Task.WhenAll(write, task); T.Equal(peer.Calls.Count, 1); T.Is(b.historyRetryAt["a"] > J.Now); T.Equal(b.historyCursor["a"], "c1");
        });
        T.Add("thread-history/malformed-full-read-keeps-recovery-pending", async f => {
            var b = f.Bridge; var peer = f.Peer("one", "a"); peer.Handler = _ => Task.FromResult<JsonNode>(T.Obj("{\"thread\":{\"id\":\"other\",\"turns\":[]}}"));
            b.historyRead.Add("a"); await b.LoadHistory("a"); T.Is(b.historyRead.Contains("a")); T.Is(!b.Threads.ContainsKey("other")); T.Is(b.historyRetryAt.ContainsKey("a"));
        });
        T.Add("thread-history/item-pagination-identity-and-cursor-validation", async f => {
            var b = f.Bridge; var peer = f.Peer("one", "a");
            peer.Handler = _ => Task.FromResult<JsonNode>(T.Obj("{\"data\":[{\"id\":\"one\",\"itemsView\":\"summary\",\"items\":[]}]}")); await T.Rejects(() => b.ReadFullTurns("a"), "内容不完整");
            peer.Handler = _ => Task.FromResult<JsonNode>(T.Obj("{\"data\":[],\"nextCursor\":\"same\"}")); await T.Rejects(() => b.ReadFullTurns("a"), "重复游标");
            peer.Handler = m => { T.Equal(m.S("method"), "thread/turns/list"); T.Equal(m.G("params").S("itemsView"), "full"); return Task.FromResult<JsonNode>(Page("complete")); };
            var complete = await b.ReadFullTurns("a"); T.Equal(complete.Single().Arr("items").Single().S("id"), "complete");
        });
        T.Add("thread-title/format-and-structured-validation", async f => {
            T.Equal(ProvisionalTitle("# Fix bridge\nmore"), "Fix bridge"); T.Equal(ProvisionalTitle(new string('x', 100)).Length, 36);
            var b = f.Bridge;
            foreach (var (json, expected) in new[] { ("{\"title\":\"title: \\\"Fix bridge?\\\"\",\"description\":\"phone   sync\"}", "Fix bridge"), ("not json", ""), ("{\"title\":\"\",\"description\":\"x\"}", "") }) {
                var waiter = new TitleWaiter { Turn = "turn" }; b.titleWaiters["title"] = waiter; waiter.Text = json;
                b.TitleNotification("turn/completed", T.Obj("{\"threadId\":\"title\",\"turn\":{\"id\":\"turn\",\"status\":\"completed\"}}")); var result = await waiter.Done.Task; T.Equal(result.S("title"), expected); if (expected != "") T.Equal(result.S("description"), "phone sync");
            }
        });
        T.Add("thread-title/prompt-bound-deduplicate-and-user-rename", async f => {
            var b = f.Bridge; var peer = f.Peer("one", "a"); peer.Handler = m => Task.FromResult<JsonNode>(m.S("method") == "thread/start" ? T.Obj("{\"thread\":{\"id\":\"title\"}}") : T.Obj("{\"turn\":{\"id\":\"turn\"}}"));
            b.Remember(T.Obj("{\"id\":\"a\",\"name\":\"Fix\"}")); b.pendingTitles["a"] = J.O(("threadId", "a"), ("provisionalName", "Fix"), ("prompt", "  " + new string('x', 2000) + "SHOULD_NOT_BE_SENT"));
            b.ScheduleTitle("a"); b.ScheduleTitle("a"); await T.Until(() => peer.Calls.Any(x => x.S("method") == "turn/start"));
            T.Equal(peer.Calls.Count(x => x.S("method") == "thread/start"), 1); string prompt = peer.Calls.First(x => x.S("method") == "turn/start").G("params").Arr("input").First().S("text"); T.Is(prompt.EndsWith(new string('x', 2000))); T.Is(!prompt.Contains("SHOULD_NOT_BE_SENT"));
            b.Rename("a", "User renamed"); b.FinishTestTitle(); await T.Until(() => !b.titleJobs.Contains("a")); T.Equal(b.Threads["a"].S("name"), "User renamed"); T.Is(!peer.Calls.Any(x => x.S("method") == "thread/name/set")); T.Is(!b.pendingTitles.ContainsKey("a"));
        });
        T.Add("thread-title/disconnected-job-retries-after-reconnect", async f => {
            var b = f.Bridge; b.Remember(T.Obj("{\"id\":\"a\",\"name\":\"Fix\"}")); b.pendingTitles["a"] = T.Obj("{\"threadId\":\"a\",\"provisionalName\":\"Fix\",\"prompt\":\"Fix\"}"); b.ScheduleTitle("a"); T.Is(b.pendingTitles.ContainsKey("a"));
            var peer = f.Peer("one", "a"); peer.Handler = m => Task.FromResult<JsonNode>(m.S("method") == "thread/start" ? T.Obj("{\"thread\":{\"id\":\"title\"}}") : T.Obj("{\"turn\":{\"id\":\"turn\"}}")); b.ScheduleTitle("a");
            await T.Until(() => peer.Calls.Any(x => x.S("method") == "turn/start")); b.FinishTestTitle(); await T.Until(() => !b.titleJobs.Contains("a")); T.Equal(b.Threads["a"].S("name"), "Generated"); T.Is(!b.pendingTitles.ContainsKey("a"));
        });
    }
    private void FinishTestTitle()
    {
        TitleNotification("turn/started", T.Obj("{\"threadId\":\"title\",\"turn\":{\"id\":\"turn\"}}"));
        TitleNotification("item/agentMessage/delta", J.O(("threadId", "title"), ("turnId", "turn"), ("delta", "{\"title\":\"Generated\",\"description\":\"bridge\"}")));
        TitleNotification("turn/completed", T.Obj("{\"threadId\":\"title\",\"turn\":{\"id\":\"turn\",\"status\":\"completed\"}}"));
    }
}
