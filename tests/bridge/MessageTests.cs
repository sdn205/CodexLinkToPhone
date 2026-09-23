using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    internal const string TestDiff = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n";
    internal static void RegisterMessageTests()
    {
        T.Add("message-store/canonical-user-identity-and-thread-isolation", f => {
            T.Equal(MessageStore.UserId("thread-a", "client-1"), "user-7fdec867c6a4ffce425860cb");
            var store = f.Bridge.Messages; var one = T.Message("upstream", "user", role: "user"); one.G("meta")!["clientUserMessageId"] = "client-1";
            var a = store.Upsert(one)!; one["id"] = "snapshot"; var again = store.Upsert(one)!;
            T.Equal(a.S("id"), MessageStore.UserId("a", "client-1")); T.Equal(a.S("id"), again.S("id")); T.Equal(store.Values.Count(), 1);
            one.G("meta")!["threadId"] = "b"; T.Is(store.Upsert(one)!.S("id") != a.S("id")); T.Equal(store.ForThread("a").Count, 1);
            one["text"] = "mutated after insertion"; T.Equal(store.ForThread("b")[0].S("text"), "user");
            var withoutClient = T.Message("unidentified-user", role: "user"); T.Equal(store.Upsert(withoutClient).S("id"), "unidentified-user");
            var assistant = T.Message("assistant"); assistant.G("meta")!["clientId"] = "client-1"; T.Equal(store.Upsert(assistant).S("id"), "assistant");
        });
        T.Add("message-store/same-text-distinct-identities-and-snapshot-alias", f => {
            var s = f.Bridge.Messages; s.Upsert(T.Message("one", "same")); s.Upsert(T.Message("two", "same")); T.Equal(s.ForThread("a").Count, 2);
            s.Upsert(T.Message("item-11", "unique")); s.Upsert(T.Message("real-id", "unique")); T.Equal(s.ForThread("a").Count, 3); T.Is(s.Get("item-11") is null); T.Is(s.Get("real-id") is not null);
            s.Upsert(T.Message("item-12", "unique")); T.Equal(s.ForThread("a").Count, 3);
        });
        T.Add("message-store/late-snapshot-keeps-new-content-and-remove", f => {
            var s = f.Bridge.Messages; s.Upsert(T.Message("one", "old")); long revision = s.Revision;
            s.Upsert(T.Message("one", "new accepted")); s.Upsert(T.Message("one", "old"), "snapshot", 0, revision);
            T.Equal(s.Get("one").S("text"), "new accepted");
            s.Upsert(T.Message("other", tid: "b")); s.RemoveWhere(m => MessageOrder.Thread(m) == "a"); T.Is(s.Get("one") is null); T.Is(s.Get("other") is not null);
            var withImage = T.Message("image", "text"); withImage.G("meta")!["images"] = new JsonArray(J.O(("url", "https://example.test/a.png"))); s.Upsert(withImage);
            s.Upsert(T.Message("image", "", stream: false)); T.Equal(s.Get("image").S("text"), "text"); T.Equal(s.Get("image").G("meta").Arr("images").Count(), 1); T.Is(!s.Get("image").B("streaming"));
            s.RemoveWhere(_ => true); T.Equal(s.Values.Count(), 0); T.Equal(s.Upsert(T.Message("fresh"))!.G("meta").N("canonicalOrdinal"), 0L);
        });
        T.Add("message-store/accepted-receipt-promotion-preserves-order", f => {
            var s = f.Bridge.Messages; var m = T.Message("receipt", "hello", role: "user"); m.G("meta")!["clientUserMessageId"] = "client"; m.G("meta")!["submissionState"] = "accepted"; m.G("meta")!["userMessageOrderAt"] = 1800000001000L;
            var receipt = s.Upsert(m)!; var actual = m.Obj(); actual["id"] = "upstream"; actual["createdAt"] = 1800000005000L; actual.G("meta")!.AsObject().Remove("submissionState");
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
