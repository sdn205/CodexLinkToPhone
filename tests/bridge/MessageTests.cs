using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    internal const string TestDiff = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n";
    private static void RegisterIdentityTests()
    {
        string? probe = Environment.GetEnvironmentVariable("BRIDGE_IDENTITY_SAMPLE");
        if (!string.IsNullOrEmpty(probe)) T.Add("history-identity/real-durable-history", f => {
            var sample = J.Parse(File.ReadAllText(probe, System.Text.Encoding.UTF8))!;
            var thread = sample.G("thread").Obj(); thread.Set("turns", sample.G("turns"));
            f.Bridge.Hydrate(thread);
            var first = f.Bridge.Messages.ForThread(thread.S("id"));
            var ids = first.Select(m => m.S("id")).ToArray();
            T.Equal(ids.Distinct().Count(), ids.Length);
            T.Equal(first.Count(m => m.S("kind") == "text" && m.S("role") == "assistant"), sample.Arr("turns").Sum(t => t.Arr("items").Count(i => i.S("type") == "agentMessage" && i.S("text") != "")));
            T.Is(first.Where(m => m.S("role") == "assistant" && m.S("kind") is "text" or "reasoning").All(m => !m.G("meta").S("sourceItemId").StartsWith("item-", StringComparison.Ordinal)));
            f.Bridge.Hydrate(thread);
            T.Is(ids.SequenceEqual(f.Bridge.Messages.ForThread(thread.S("id")).Select(m => m.S("id"))));
            var overlapped = new MessageStore(); long seq = 0;
            foreach (var final in first)
            {
                var partial = final.Obj();
                if (final.G("meta").B("sourceCompleted")) { partial["text"] = final.S("text")[..(final.S("text").Length / 2)]; partial["streaming"] = true; }
                partial.G("meta")!["sourceCompleted"] = false; partial.G("meta")!["proxyEventSource"] = "real-sample"; partial.G("meta")!["proxyEventSeq"] = ++seq;
                overlapped.Upsert(partial);
            }
            foreach (var turn in first.GroupBy(MessageOrder.Turn)) overlapped.ApplySnapshot(thread.S("id"), turn.Key, turn.ToArray(), "real-history", long.MaxValue);
            foreach (var final in first)
            {
                if (final.S("role") != "assistant" || final.S("kind") != "text" || !final.G("meta").B("sourceCompleted")) continue;
                var context = final.G("meta").Obj(); context["proxyEventSource"] = "real-sample"; context["proxyEventSeq"] = ++seq;
                overlapped.Delta(context.S("sourceItemId"), final.S("role"), "replayed late fragment", context);
            }
            var settled = overlapped.ForThread(thread.S("id"));
            T.Is(ids.SequenceEqual(settled.Select(m => m.S("id"))));
            T.Is(first.Select(m => m.S("text")).SequenceEqual(settled.Select(m => m.S("text"))));
            T.Is(first.Select(m => m.B("streaming")).SequenceEqual(settled.Select(m => m.B("streaming"))));
            Console.WriteLine("Verified durable history: " + ids.Length + " messages; live fragments, repeated hydration and late replay preserve identity, content and order");
        });
        static JsonObject Row(string type, JsonObject payload) => J.O(("type", type), ("payload", payload));
        static JsonObject Event(string type, params (string Key, object? Value)[] fields) => Row("event_msg", J.Merge(J.O(("type", type)), J.O(fields)));
        static JsonObject Reply(string id) => Row("response_item", J.O(("type", "message"), ("id", id), ("role", "assistant"), ("phase", "final_answer")));
        static JsonObject Snapshot(string id, string text) => J.O(("id", id), ("type", "agentMessage"), ("phase", "final_answer"), ("text", text));
        static string Write(Fixture f, params JsonObject[] rows)
        {
            string path = Path.Combine(f.Directory, "rollout.jsonl");
            File.WriteAllText(path, string.Join('\n', rows.Select(x => x.Wire())) + "\n", new System.Text.UTF8Encoding(false)); return path;
        }
        T.Add("history-identity/durable-occurrences-preserve-identical-replies", f => {
            var h = new HistoryIdentity();
            string path = Write(f, Row("session_meta", J.O(("id", "a"))), Event("task_started", ("turn_id", "turn-a")),
                Event("agent_message", ("message", "same"), ("phase", "final_answer")), Reply("msg-first"),
                Event("agent_message", ("message", "same"), ("phase", "final_answer")), Reply("msg-second"), Event("task_complete", ("turn_id", "turn-a")));
            h.Register("a", path); var items = h.Resolve("a", "turn-a", new[] { Snapshot("item-1", "same"), Snapshot("item-2", "same") });
            T.Equal(items[0].S("id"), "msg-first"); T.Equal(items[1].S("id"), "msg-second"); T.Is(items.All(x => x.B("sourceCompleted")));
            var normalized = items.Select(x => f.Bridge.Normalizer.Normalize(x, J.O(("threadId", "a"), ("turnId", "turn-a")))!).ToArray();
            f.Bridge.Messages.ApplySnapshot("a", "turn-a", normalized, "first", long.MaxValue);
            f.Bridge.Messages.ApplySnapshot("a", "turn-a", normalized, "second", long.MaxValue);
            T.Equal(f.Bridge.Messages.ForThread("a").Count, 2);
        });
        T.Add("history-identity/grouped-reasoning-retains-each-response-identity", f => {
            var h = new HistoryIdentity();
            JsonObject Reasoning(string id) => Row("response_item", J.O(("type", "reasoning"), ("id", id)));
            string path = Write(f, Row("session_meta", J.O(("id", "a"))), Event("task_started", ("turn_id", "turn-a")),
                Event("agent_reasoning", ("text", "one")), Reasoning("rs-one"),
                Event("agent_reasoning", ("text", "two")), Reasoning("rs-two"),
                Event("agent_reasoning", ("text", "part-a")), Event("agent_reasoning", ("text", "part-b")), Reasoning("rs-three"),
                Event("task_complete", ("turn_id", "turn-a")));
            h.Register("a", path);
            var resolved = h.Resolve("a", "turn-a", new[] { J.O(("id", "item-7"), ("type", "reasoning"), ("summary", J.Strings(["one", "two", "part-a", "part-b"])), ("content", new JsonArray())) });
            T.Is(resolved.Select(x => x.S("id")).SequenceEqual(new[] { "rs-one", "rs-two", "rs-three" }));
            T.Equal(resolved[2].Arr("summary").Count(), 2);
            var n = f.Bridge.Normalizer; var context = J.O(("threadId", "a"), ("turnId", "turn-a"));
            f.Bridge.Messages.ApplySnapshot("a", "turn-a", resolved.Select(i => n.Normalize(i, context)!).ToArray(), "reasoning", long.MaxValue);
            T.Equal(f.Bridge.Messages.ForThread("a").Count, 3);
        });
        T.Add("history-identity/partial-record-retries-without-publishing-an-alias", f => {
            var h = new HistoryIdentity();
            string path = Write(f, Row("session_meta", J.O(("id", "a"))), Event("task_started", ("turn_id", "turn-a")), Event("agent_message", ("message", "🙂中"), ("phase", "final_answer")));
            h.Register("a", path); var snapshot = new[] { Snapshot("item-1", "🙂中") };
            T.Throws(() => h.Resolve("a", "turn-a", snapshot), "awaiting");
            byte[] raw = System.Text.Encoding.UTF8.GetBytes(Reply("msg-original").Wire() + "\n");
            using (var file = new FileStream(path, FileMode.Append)) file.Write(raw.AsSpan(0, raw.Length - 3));
            T.Throws(() => h.Resolve("a", "turn-a", snapshot), "awaiting");
            using (var file = new FileStream(path, FileMode.Append)) file.Write(raw.AsSpan(raw.Length - 3));
            T.Equal(h.Resolve("a", "turn-a", snapshot).Single().S("id"), "msg-original");
            h.Register("wrong-thread", path); T.Throws(() => h.Resolve("wrong-thread", "turn-a", snapshot), "会话身份");
        });
        T.Add("message-store/snapshot-transaction-rolls-back-content-and-order", f => {
            var s = f.Bridge.Messages; s.Upsert(T.Message("one", "original")); long revision = s.Revision;
            string before = J.A(s.ForThread("a")).Wire();
            T.Throws(() => s.ApplySnapshot("a", "turn-a", new[] { T.Message("one", "changed"), T.Message("new", "new"), T.Message("new", "duplicate") }, "broken", long.MaxValue));
            T.Equal(s.Revision, revision); T.Equal(J.A(s.ForThread("a")).Wire(), before); T.Is(s.GetSource("a", "turn-a", "new") is null);
            s.Upsert(T.Message("after", "after")); T.Equal(s.ForThread("a")[1].S("text"), "after");
        });
        T.Add("message-store/durable-order-survives-late-completions-and-subsequences", f => {
            var random = new Random(3827);
            for (int run = 0; run < 80; run++)
            {
                var s = new MessageStore();
                var user = T.Message("user", "question", role: "user"); user.G("meta")!["proxyEventSeq"] = 20;
                var file = T.Message("file", "edit"); file.G("meta")!["proxyEventSeq"] = 10;
                var answer = T.Message("answer", "reply"); answer.G("meta")!["proxyEventSeq"] = 30;
                var snapshot = new[] { user.Obj(), file.Obj(), answer.Obj() };
                foreach (var m in snapshot) { m.G("meta")!.AsObject().Remove("proxyEventSeq"); m.G("meta")!["sourceCompleted"] = true; }
                Action[] operations = [() => s.Upsert(file), () => s.Upsert(user), () => s.Upsert(answer),
                    () => s.ApplySnapshot("a", "turn-a", snapshot, "full", long.MaxValue)];
                foreach (var operation in operations.OrderBy(_ => random.Next())) operation();
                s.ApplySnapshot("a", "turn-a", new[] { snapshot[0], snapshot[2] }, "subsequence", long.MaxValue);
                T.Is(s.ForThread("a").Select(m => m.G("meta").S("sourceItemId")).SequenceEqual(new[] { "user", "file", "answer" }), "permutation " + run);
            }
        });
        T.Add("message-store/arrival-permutations-converge-on-identity-and-order", f => {
            var h = new HistoryIdentity(); string path = Write(f, Row("session_meta", J.O(("id", "a"))), Event("task_started", ("turn_id", "turn-a")),
                Event("agent_message", ("message", "answer"), ("phase", "final_answer")), Reply("msg-a"), Event("task_complete", ("turn_id", "turn-a")));
            h.Register("a", path); var resolved = h.Resolve("a", "turn-a", new[] { Snapshot("item-19", "answer") });
            var normal = f.Bridge.Normalizer.Normalize(resolved.Single(), J.O(("threadId", "a"), ("turnId", "turn-a")))!;
            JsonObject Message(string id, string text, long seq, bool streaming, bool terminal = false)
            {
                var m = T.Message(id, text, stream: streaming); var meta = m.G("meta")!.AsObject(); meta["proxyEventSeq"] = seq; meta["sourceCompleted"] = terminal; return m;
            }
            var random = new Random(712913);
            for (int run = 0; run < 160; run++)
            {
                var s = new MessageStore(); s.Upsert(T.Message("item-19", "other thread", tid: "b"));
                Action[] operations = [
                    () => s.Upsert(Message("msg-a", "", 10, true)),
                    () => s.Delta("msg-a", "assistant", "ans", Message("msg-a", "", 11, true).G("meta").Obj()),
                    () => s.Upsert(Message("command", "tool", 12, false, true)),
                    () => s.Upsert(Message("msg-a", "answer", 13, false, true)),
                    () => s.ApplySnapshot("a", "turn-a", new[] { normal }, "snapshot", long.MaxValue),
                    () => s.Delta("msg-a", "assistant", "ans", Message("msg-a", "", 11, true).G("meta").Obj())
                ];
                foreach (int i in Enumerable.Range(0, operations.Length).OrderBy(_ => random.Next())) operations[i]();
                var list = s.ForThread("a"); T.Equal(list.Count, 2, "permutation " + run);
                T.Equal(list[0].G("meta").S("sourceItemId"), "msg-a", "permutation " + run);
                T.Equal(list[0].S("text"), "answer"); T.Is(!list[0].B("streaming")); T.Equal(s.ForThread("b").Single().S("text"), "other thread");
            }
        });
    }

    internal static void RegisterMessageTests()
    {
        RegisterIdentityTests();
        T.Add("message-store/source-identity-is-scoped-by-thread-and-turn", f => {
            var s = f.Bridge.Messages;
            var first = s.Upsert(T.Message("item-19", "old", tid: "a", turn: "one"))!;
            var second = s.Upsert(T.Message("item-19", "new", tid: "b", turn: "one"))!;
            var third = s.Upsert(T.Message("item-19", "next", tid: "b", turn: "two"))!;
            T.Equal(s.Values.Count(), 3);
            T.Equal(new[] { first.S("id"), second.S("id"), third.S("id") }.Distinct().Count(), 3);
            T.Equal(s.GetSource("a", "one", "item-19").S("text"), "old");
            T.Equal(s.GetSource("b", "two", "item-19").S("text"), "next");
        });
        T.Add("message-store/empty-start-reserves-order-before-first-delta", f => {
            var s = f.Bridge.Messages;
            var start = T.Message("first", "", stream: true); s.Upsert(start);
            s.Upsert(T.Message("second", "second"));
            var context = start.G("meta").Obj(); context["proxyEventSeq"] = context.N("proxyEventSeq") + 2;
            s.Delta("first", "assistant", "first", context);
            T.Equal(s.ForThread("a")[0].S("text"), "first");
        });
        T.Add("message-store/replayed-delta-and-late-start-cannot-reopen-completion", f => {
            var s = f.Bridge.Messages; var context = T.Message("stream").G("meta").Obj();
            s.Delta("stream", "assistant", "answer", context);
            s.Delta("stream", "assistant", "answer", context);
            T.Equal(s.GetSource("a", "turn-a", "stream").S("text"), "answer");
            var final = T.Message("stream", "answer"); final.G("meta")!["sourceCompleted"] = true; s.Upsert(final);
            var late = T.Message("stream", "", stream: true); s.Upsert(late);
            context["proxyEventSeq"] = late.G("meta").N("proxyEventSeq") + 1;
            s.Delta("stream", "assistant", "answer", context);
            var stored = s.GetSource("a", "turn-a", "stream")!;
            T.Equal(stored.S("text"), "answer"); T.Is(!stored.B("streaming"));
        });
        T.Add("message-store/canonical-user-identity-and-thread-isolation", f => {
            T.Equal(MessageStore.UserId("thread-a", "client-1"), "user-7fdec867c6a4ffce425860cb");
            var store = f.Bridge.Messages; var one = T.Message("upstream", "user", role: "user"); one.G("meta")!["clientUserMessageId"] = "client-1";
            var a = store.Upsert(one)!; one["id"] = "snapshot"; var again = store.Upsert(one)!;
            T.Equal(a.S("id"), MessageStore.UserId("a", "client-1")); T.Equal(a.S("id"), again.S("id")); T.Equal(store.Values.Count(), 1);
            one.G("meta")!["threadId"] = "b"; T.Is(store.Upsert(one)!.S("id") != a.S("id")); T.Equal(store.ForThread("a").Count, 1);
            one["text"] = "mutated after insertion"; T.Equal(store.ForThread("b")[0].S("text"), "user");
            var withoutClient = T.Message("unidentified-user", role: "user"); T.Equal(store.Upsert(withoutClient).G("meta").S("sourceItemId"), "unidentified-user");
            var assistant = T.Message("assistant"); assistant.G("meta")!["clientId"] = "client-1"; T.Equal(store.Upsert(assistant).G("meta").S("sourceItemId"), "assistant");
        });
        T.Add("message-store/text-is-not-an-identity", f => {
            var s = f.Bridge.Messages; s.Upsert(T.Message("one", "same")); s.Upsert(T.Message("two", "same")); T.Equal(s.ForThread("a").Count, 2);
            s.Upsert(T.Message("item-11", "unique")); s.Upsert(T.Message("real-id", "unique")); T.Equal(s.ForThread("a").Count, 4); T.Is(T.Stored(s, "item-11") is not null); T.Is(T.Stored(s, "real-id") is not null);
            s.Upsert(T.Message("item-12", "unique")); T.Equal(s.ForThread("a").Count, 5);
        });
        T.Add("message-store/late-snapshot-keeps-new-content-and-remove", f => {
            var s = f.Bridge.Messages; s.Upsert(T.Message("one", "old")); long revision = s.Revision;
            s.Upsert(T.Message("one", "new accepted")); s.Upsert(T.Message("one", "old"), "snapshot", 0, revision);
            T.Equal(T.Stored(s, "one").S("text"), "new accepted");
            s.Upsert(T.Message("other", tid: "b")); s.RemoveWhere(m => MessageOrder.Thread(m) == "a"); T.Is(T.Stored(s, "one") is null); T.Is(T.Stored(s, "other") is not null);
            var withImage = T.Message("image", "text"); withImage.G("meta")!["images"] = new JsonArray(J.O(("url", "https://example.test/a.png"))); s.Upsert(withImage);
            s.Upsert(T.Message("image", "", stream: false)); T.Equal(T.Stored(s, "image").S("text"), "text"); T.Equal(T.Stored(s, "image").G("meta").Arr("images").Count(), 1); T.Is(!T.Stored(s, "image").B("streaming"));
            s.RemoveWhere(_ => true); T.Equal(s.Values.Count(), 0); T.Equal(s.Upsert(T.Message("fresh"))!.G("meta").N("canonicalOrdinal"), 0L);
        });
        T.Add("message-store/accepted-receipt-promotion-preserves-order", f => {
            var s = f.Bridge.Messages; var m = T.Message("receipt", "hello", role: "user"); m.G("meta")!["clientUserMessageId"] = "client"; m.G("meta")!["submissionState"] = "accepted"; m.G("meta")!["userMessageOrderAt"] = 1800000001000L;
            var receipt = s.Upsert(m)!; var actual = m.Obj(); actual["id"] = "upstream"; actual["createdAt"] = 1800000005000L; actual.G("meta")!.AsObject().Remove("submissionState");
            actual.G("meta")!["proxyEventSeq"] = m.G("meta").N("proxyEventSeq") + 1;
            s.Upsert(actual); var stored = s.Get(receipt.S("id"))!; T.Is(stored.G("meta").G("submissionState") is null); T.Equal(stored.N("createdAt"), receipt.N("createdAt"));
            T.Equal(stored.G("meta").N("userMessageOrderAt"), 1800000001000L); s.Upsert(m); T.Is(s.Get(receipt.S("id"))!.G("meta").G("submissionState") is null);
        });
        T.Add("message-projection/user-images-and-required-identity", f => {
            var n = f.Bridge.Normalizer; var ctx = J.O(("threadId", "a"), ("turnId", "turn-a"), ("createdAt", 1800000000000L));
            var m = n.Normalize(T.Obj("{\"id\":\"upstream\",\"type\":\"userMessage\",\"clientId\":\"phone-a\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"},{\"type\":\"localImage\",\"path\":\"E:/project/image.png\"},{\"type\":\"localImage\",\"path\":\"E:/project/image.png\"}]}"), ctx)!;
            T.Equal(m.S("text"), "hello"); T.Equal(m.G("meta").S("clientUserMessageId"), "phone-a"); T.Equal(m.G("meta").Arr("images").Count(), 1); T.Is(m.G("meta").G("content") is null); T.Equal(m.N("createdAt"), 1800000000000L);
            T.Is(n.Normalize(T.Obj("{\"type\":\"agentMessage\",\"text\":\"ignored\"}"), ctx) is null);
            T.Is(n.Normalize(T.Obj("{\"id\":\"a\",\"type\":\"agentMessage\"}"), new()) is null);
            T.Is(n.Normalize(T.Obj("{\"id\":\"a\",\"type\":\"unsupported\"}"), ctx) is null);
        });
        T.Add("message-projection/commands-tools-reasoning-plans", f => {
            var n = f.Bridge.Normalizer; var c = J.O(("threadId", "a"), ("turnId", "turn-a"));
            var command = n.Normalize(T.Obj("{\"id\":\"c\",\"type\":\"commandExecution\",\"command\":\"git status\",\"status\":\"inProgress\",\"aggregatedOutput\":\"clean\"}"), c)!;
            T.Equal(command.S("kind"), "command"); T.Equal(command.S("text"), "git status\n\nclean"); T.Is(command.B("streaming"));
            var reasoning = n.Normalize(T.Obj("{\"id\":\"r\",\"type\":\"reasoning\",\"summary\":[\"summary\"],\"content\":[\"body\"]}"), c)!; T.Equal(reasoning.S("text"), "summary\n\nbody");
            var tool = n.Normalize(T.Obj("{\"id\":\"d\",\"type\":\"dynamicToolCall\",\"namespace\":\"tools\",\"tool\":\"lookup\",\"status\":\"completed\",\"contentItems\":[{\"type\":\"inputText\",\"text\":\"result\"},{\"type\":\"inputImage\",\"imageUrl\":\"https://example.test/i.png\"}]}"), c)!; T.Is(tool.S("text").Contains("tools.lookup")); T.Equal(tool.G("meta").Arr("images").Count(), 1);
            var plan = n.Normalize(T.Obj("{\"id\":\"p\",\"type\":\"plan\",\"plan\":[{\"step\":\"test\",\"status\":\"running\"}]}"), c)!; T.Equal(plan.S("id"), "turn-a:plan"); T.Equal(plan.G("meta").Arr("plan").First().S("status"), "in_progress");
            Persistence.Write(Path.Combine(T.Root, "tests/build/contracts/projection.json"), J.O(("command", command), ("tool", tool), ("plan", plan)));
        });
        T.Add("message-projection/diff-normalization-and-compact-preserves-full", f => {
            var changes = DiffData.Parse(TestDiff); T.Equal(changes.Count, 1); T.Equal(changes[0].S("path"), "a.js"); T.Equal(changes[0].N("added"), 1L); T.Equal(changes[0].N("deleted"), 1L);
            var n = f.Bridge.Normalizer.Normalize(J.O(("id", "file"), ("type", "fileChange"), ("changes", new JsonArray(J.O(("path", "a.js"), ("diff", TestDiff), ("kind", J.O(("type", "update"))))))), J.O(("threadId", "a"), ("turnId", "turn-a")))!;
            string before = n.Wire(); var compact = f.Bridge.Compact(n); T.Equal(n.Wire(), before); T.Equal(compact.G("meta").Arr("changes").First().N("added"), 1L);
        });
        T.Add("message-projection/image-validation-dedup-and-failed-batch-cleanup", f => {
            var store = f.Bridge.Images; const string url = "data:image/png;base64,aW1hZ2U=";
            var history = store.FromInput(J.O(("type", "image"), ("url", url)))!; T.Is(!history.B("unavailable")); T.Equal(store.FromInput(J.O(("type", "image"), ("url", url))).S("path"), history.S("path"));
            var upload = store.Normalize(new JsonArray(J.O(("url", url), ("name", "photo.png")))); T.Equal(upload[0].G("input").S("type"), "localImage"); T.Equal(upload[0].S("fingerprint"), history.S("fingerprint")); store.Cleanup(upload);
            T.Equal(Directory.GetFiles(f.Bridge.Config.UploadDir).Length, 1);
            T.Throws(() => store.Normalize(new JsonArray(J.O(("url", url)), J.O(("url", "file:///invalid.png")))));
            T.Equal(Directory.GetFiles(f.Bridge.Config.UploadDir).Length, 1);
            T.Throws(() => store.Normalize(new JsonArray(J.O(("url", "data:image/bmp;base64,aW1hZ2U=")))));
        });
        T.Add("response-annotations/protocol-projection-before-truncation", f => {
            var values = new JsonArray(J.O(("text", new string('引', 100000)), ("annotation", "保留完整引用")));
            string wire = "\n# Response annotations:\n\n<response-annotations>\n" + values.Wire() + "\n</response-annotations>\n\n## My request:\n短正文";
            var original = T.Message("user", wire, role: "user"); var compact = f.Bridge.Compact(original);
            T.Equal(compact.S("text"), "短正文"); T.Is(!compact.B("textTruncated")); T.Same(compact.G("meta").G("responseAnnotations"), values); T.Equal(original.S("text"), wire);
            foreach (var invalid in new[] { "ordinary", wire.TrimStart(), wire.Replace("<response-annotations>", "<broken>"), wire.Replace("\"text\"", "\"broken\"") }) T.Is(Annotations.Decode(invalid) is null);
        });
    }
}
