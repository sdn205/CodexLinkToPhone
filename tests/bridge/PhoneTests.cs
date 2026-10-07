using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    private static JsonObject RequestMessage(string id = "req", string text = "hello") => J.O(("requestId", id), ("clientUserMessageId", "client"), ("threadId", "a"), ("text", text));
    private static JsonObject Accepted() => J.O(("threadId", "a"), ("turnId", "one"));
    private static TaskCompletionSource<JsonObject> Gate() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal static void RegisterPhoneTests()
    {
        T.Add("submission/accepted-content-precedes-events-and-survives-restart", async f => {
            var b = f.Bridge; var peer = f.Peer("one", "a"); var phone = f.Phone("a").Client;
            b.Router.Ready.Add("a");
            // A successful submission and an item notification are independent.
            // Other work can arrive first; history can still be empty on restart.
            peer.Handler = call => {
                string method = call.S("method");
                T.Is(method is "turn/start" or "turn/steer");
                b.HandleNotification("turn/started", J.O(("threadId", "a"), ("turn", J.O(("id", "one")))));
                b.HandleNotification("item/completed", J.O(("threadId", "a"), ("turnId", "one"), ("proxyEventSource", "test"), ("proxyEventSeq", method == "turn/start" ? 1 : 2),
                    ("item", J.O(("id", method), ("type", "agentMessage"), ("text", "work before receipt")))));
                return Task.FromResult<JsonNode>(J.O(("turn", J.O(("id", "one"))), ("turnId", "one")));
            };
            foreach (string cid in new[] { "initial", "steered" }) {
                var input = RequestMessage(cid, "same text"); input["clientUserMessageId"] = cid;
                var result = await b.Journal(input, "a", false, request => b.Submit(input, "a", phone, request, new(), 0));
                T.Is(result.B("ok"));
                T.Equal(b.Messages.ForThread("a").Count(m => m.S("role") == "user"), cid == "initial" ? 1 : 2);
            }
            T.Is(b.Messages.ForThread("a").Select(m => m.S("role")).SequenceEqual(new[] { "user", "assistant", "user", "assistant" }));
            foreach (var request in b.requests.Values) request["expiresAt"] = 1;
            b.PersistOperations();
            var restored = new BridgeRuntime(b.Config, f.Cancel.Token);
            try {
                T.Equal(restored.requests.Count, 0);
                T.Equal(restored.Messages.ForThread("a").Count(m => m.S("role") == "user"), 2);
                restored.Hydrate(T.Obj("{\"id\":\"a\",\"turns\":[{\"id\":\"one\",\"status\":\"completed\",\"items\":[]}]}"));
                T.Equal(restored.Messages.ForThread("a").Count(m => m.S("role") == "user"), 2);
                // Late history promotes the same identities; equal text is not deduplicated.
                var items = new JsonArray();
                foreach (string cid in new[] { "initial", "steered" }) items.Add(J.O(("id", "source-" + cid), ("type", "userMessage"), ("clientId", cid), ("content", new JsonArray(J.O(("type", "text"), ("text", "same text"))))));
                restored.Hydrate(J.O(("id", "a"), ("turns", new JsonArray(J.O(("id", "one"), ("status", "completed"), ("items", items))))));
                T.Equal(restored.Messages.ForThread("a").Count(m => m.S("role") == "user"), 2);
                T.Is(restored.Messages.ForThread("a").All(m => m.G("meta").S("submissionState") == ""));
                restored.Revert("a", "one");
                var afterRevert = new BridgeRuntime(b.Config, f.Cancel.Token);
                try { T.Equal(afterRevert.Messages.ForThread("a").Count, 0); } finally { afterRevert.Router.Close(); }
            } finally { restored.Router.Close(); }
        });
        T.Add("phone/native-permission-requests-do-not-create-phone-state-or-responses", async f => {
            var b = f.Bridge; var peer = f.Peer("one", "a"); var (phone, wire) = f.Phone("a");
            int id = 0;
            foreach (string method in new[] { "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval" })
            {
                b.ProxyEvent(peer.Connection, J.O(("type", "server-request"), ("request", J.O(("id", ++id), ("method", method), ("params", J.O(("threadId", "a")))))), false);
            }
            T.Is(b.State(phone).G("approvals") is null);
            await b.HandlePhone(phone, J.O(("type", "approval:resolve"), ("approvalId", "removed"), ("decision", "accept")));
            await T.Until(() => wire.Sent.Any(m => m.S("type") == "error"));
            T.Equal(peer.Wire.Sent.Count, 0);
        });
        T.Add("phone/new-thread-always-uses-no-approval-policy", async f => {
            var peer = f.Peer(); peer.Handler = _ => Task.FromResult<JsonNode>(T.Obj("{\"thread\":{\"id\":\"new-thread\"}}"));
            await f.Bridge.StartThread(J.O(("cwd", f.Directory), ("approvalPolicy", "on-request")));
            T.Equal(peer.Calls.Single().G("params").S("approvalPolicy"), "never");
        });
        T.Add("write-scheduler/serial-same-thread-independent-other-thread", async f => {
            var b = f.Bridge; var gate = Gate(); var calls = new List<string>();
            var first = b.Enqueue("thread:a", () => { calls.Add("first"); return gate.Task; });
            var second = b.Enqueue("thread:a", () => { calls.Add("second"); return Task.FromResult(new JsonObject()); });
            var other = b.Enqueue("thread:b", () => { calls.Add("other"); return Task.FromResult(new JsonObject()); });
            await other; T.Is(calls.Contains("first") && !calls.Contains("second")); gate.SetResult(new()); await Task.WhenAll(first, second); T.Equal(calls[^1], "second");
        });
        T.Add("write-scheduler/failure-does-not-poison-lane", async f => {
            var failed = f.Bridge.Enqueue("thread:a", () => throw new IOException("rejected"));
            var later = f.Bridge.Enqueue("thread:a", () => Task.FromResult(J.O(("ok", true)))); await T.Rejects(() => failed, "rejected"); T.Is((await later).B("ok")); await f.Bridge.WaitWrites(); T.Equal(f.Bridge.pendingWrites, 0);
        });
        T.Add("write-scheduler/new-thread-bind-and-independent-clients", async f => {
            var b = f.Bridge; var gate = Gate(); var p1 = f.Phone("").Client; var p2 = f.Phone("").Client; T.Is(p1.Lane != p2.Lane);
            var first = b.Enqueue(p1.Lane, () => { b.BindCreatedThread("a", p1.Lane); return gate.Task; }); await T.Until(() => b.writeLaneAliases.ContainsKey("thread:a"));
            bool secondRan = false; var second = b.Enqueue("thread:a", () => { secondRan = true; return Task.FromResult(new JsonObject()); });
            await b.Enqueue(p2.Lane, () => Task.FromResult(new JsonObject())); T.Is(!secondRan); gate.SetResult(new()); await Task.WhenAll(first, second); await Task.Yield();
            T.Is(!b.writeLaneAliases.ContainsKey("thread:a"), "Creation alias must be released after its lane drains");
        });
        T.Add("request-journal/concurrent-duplicates-and-accepted-cache", async f => {
            var b = f.Bridge; int count = 0; var gate = Gate(); Task<JsonObject> Submit(JsonObject _) { count++; return gate.Task; }
            var first = b.Journal(RequestMessage(), "a", false, Submit); var second = b.Journal(RequestMessage(), "a", false, Submit); T.Is(ReferenceEquals(first, second));
            await T.Until(() => count == 1); gate.SetResult(Accepted()); T.Same(await first, await second); T.Same(await b.Journal(RequestMessage(), "a", false, Submit), await first); T.Equal(count, 1);
        });
        T.Add("request-journal/payload-conflicts-and-client-id-validation", async f => {
            var b = f.Bridge; await b.Journal(RequestMessage(), "a", false, _ => Task.FromResult(Accepted()));
            var conflict = await b.Journal(RequestMessage(text: "changed"), "a", false, _ => throw new Exception("must not submit")); T.Equal(conflict.S("code"), "request_id_conflict");
            int n = 0; foreach (var cid in new[] { " client-ok ", "", "  ", new string('x', 201), "中文-id" }) {
                var m = RequestMessage("cid-" + n++); m["clientUserMessageId"] = cid;
                await b.Journal(m, "a", false, r => { string actual = r.S("clientUserMessageId"); T.Is(actual.Length is > 0 and <= 200 && actual.All(c => c >= ' ' && c <= '~')); if (cid.Contains("client-ok")) T.Equal(actual, "client-ok"); return Task.FromResult(Accepted()); });
            }
        });
        T.Add("request-journal/concurrent-uncertain-retries-share-read-and-submit", async f => {
            var b = f.Bridge; var peer = f.Peer("one", "a"); int submits = 0; var read = new TaskCompletionSource<JsonNode>();
            await b.Journal(RequestMessage(), "a", false, _ => throw new BridgeException("lost response", "timeout", true));
            peer.Handler = m => m.S("method") == "thread/read" ? read.Task : Task.FromResult<JsonNode>(J.O(("data", new JsonArray()))); Task<JsonObject> Submit(JsonObject _) { submits++; return Task.FromResult(Accepted()); }
            var one = b.Journal(RequestMessage(), "a", false, Submit); var two = b.Journal(RequestMessage(), "a", false, Submit);
            await T.Until(() => peer.Calls.Count > 0); T.Equal(peer.Calls.Count, 1); read.SetResult(T.Obj("{\"thread\":{\"id\":\"a\",\"turns\":[]}}"));
            T.Is((await one).B("ok")); T.Same(await one, await two); T.Equal(submits, 1);
        });
        T.Add("request-journal/upstream-acceptance-no-resubmit", async f => {
            var b = f.Bridge; var peer = f.Peer("one", "a"); await b.Journal(RequestMessage(), "a", false, _ => throw new BridgeException("lost", "timeout", true));
            var acceptedHistory = T.Obj("{\"thread\":{\"id\":\"a\",\"turns\":[{\"id\":\"one\",\"status\":\"completed\",\"items\":[{\"id\":\"user\",\"type\":\"userMessage\",\"clientId\":\"client\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}]}]}}");
            peer.Handler = m => Task.FromResult<JsonNode>(m.S("method") == "thread/read" ? J.O(("thread", J.O(("id", "a")))) : J.O(("data", acceptedHistory.G("thread").G("turns"))));
            var result = await b.Journal(RequestMessage(), "a", false, _ => throw new Exception("duplicate submission")); T.Is(result.B("ok")); T.Equal(result.S("turnId"), "one");
        });
        T.Add("request-journal/restart-accepted-and-pending-recovery", async f => {
            var b = f.Bridge; await b.Journal(RequestMessage("accepted"), "a", false, _ => Task.FromResult(Accepted()));
            var gate = Gate(); var pending = b.Journal(RequestMessage("pending"), "a", false, _ => gate.Task); await T.Until(() => b.requests["pending"].S("status") == "pending");
            var restored = new BridgeRuntime(b.Config, f.Cancel.Token); T.Equal(restored.requests["accepted"].S("status"), "accepted"); T.Equal(restored.requests["pending"].S("status"), "uncertain");
            T.Is((await restored.Journal(RequestMessage("accepted"), "a", false, _ => throw new Exception("resubmitted"))).B("ok")); gate.SetResult(Accepted()); await pending; restored.Router.Close();
        });
        T.Add("request-journal/edit-checkpoint-and-definite-rejection", async f => {
            var b = f.Bridge; var result = await b.Journal(RequestMessage("edit"), "a", true, r => { r["editRollbackAttempted"] = true; r["editRollbackApplied"] = true; r["editRollbackTurnCount"] = 3; throw new IOException("resubmit failed"); });
            T.Is(!result.B("ok")); T.Equal(b.requests["edit"].S("status"), "uncertain"); T.Is(b.requests["edit"].B("editRollbackApplied")); T.Equal(b.requests["edit"].N("editRollbackTurnCount"), 3L);
            var restored = new BridgeRuntime(b.Config, f.Cancel.Token); T.Is(restored.requests["edit"].B("editRollbackApplied")); restored.Router.Close();
            await b.Journal(RequestMessage("rejected"), "a", false, _ => throw new BridgeException("rejected")); T.Is(!b.requests.ContainsKey("rejected"));
        });
        T.Add("phone-persistence/all-categories-and-invalid-title-isolation", async f => {
            var b = f.Bridge; b.Unread.Add("a"); b.PersistUnread(); b.Select(f.Phone().Client, "a", true); b.DiscardPlan("a", "old");
            b.pendingTitles["a"] = J.O(("threadId", "a"), ("prompt", "hello")); b.pendingTitles["invalid"] = J.O(("threadId", "invalid"));
            await b.Journal(RequestMessage(), "a", false, _ => Task.FromResult(Accepted()));
            var restored = new BridgeRuntime(b.Config, f.Cancel.Token); T.Is(restored.Unread.Contains("a")); T.Is(restored.selectionSaved); T.Equal(restored.selection, "a");
            T.Is(restored.Messages.DiscardedPlans.Contains(("a", "old"))); T.Is(restored.pendingTitles.ContainsKey("a")); T.Is(!restored.pendingTitles.ContainsKey("invalid")); T.Equal(restored.requests["req"].S("status"), "accepted"); restored.Router.Close();
        });
        T.Add("unread/completion-selected-background-and-explicit-clear", async f => {
            var b = f.Bridge; var phone = f.Phone("a", true).Client;
            b.StartTurn("a", "one"); b.FinishTurn("a", "one", recover: false); T.Is(!b.Unread.Contains("a"));
            phone.Background = true; b.StartTurn("a", "two"); b.FinishTurn("a", "two", recover: false); T.Is(b.Unread.Contains("a"));
            b.StartTurn("b", "one"); b.FinishTurn("b", "one", recover: false); T.Is(b.Unread.Contains("b"));
            await b.HandlePhone(phone, J.O(("type", "thread:read"), ("threadId", "a"))); T.Is(!b.Unread.Contains("a") && b.Unread.Contains("b"));
            await b.HandlePhone(phone, J.O(("type", "threads:mark-all-read"))); T.Equal(b.Unread.Count, 0); T.Equal(Persistence.Read(b.StatePath("state.json")).Arr("unreadThreads").Count(), 0);
        });
    }
}
