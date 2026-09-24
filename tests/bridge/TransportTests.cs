using System.Collections;
using System.Reflection;
using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    private static JsonObject AckFrame(JsonObject frame, bool ok = true, int? offset = null) => J.O(("frameId", frame.G("frameId")), ("messageId", frame.G("messageId")), ("ok", ok), ("offset", offset ?? (int)frame.N("offset") + frame.S("delta").Length));
    internal static void RegisterTransportTests()
    {
        T.Add("message-details/content-identity-survives-compaction-and-metadata-refresh", async f => {
            var b = f.Bridge; var (phone, wire) = f.Phone();
            string text = new string('a', 6000) + "hidden-middle" + new string('z', 4000);
            var message = b.Messages.Upsert(T.Message("long-output", text, role: "tool", kind: "command"))!;
            var compact = b.Compact(message); T.Is(compact.B("textTruncated"));
            await b.HandlePhone(phone, J.O(("type", "message:detail"), ("id", "long-output"), ("requestId", "detail")));
            await T.Until(() => wire.Sent.Any(x => x.S("type") == "message:detail:result"));
            var full = wire.Sent.First(x => x.S("type") == "message:detail:result").G("message");
            T.Equal(full.S("text"), text); T.Is(!full.B("textTruncated"));
            T.Equal(full.S("textHash"), compact.S("textHash")); T.Equal(full.N("originalLength"), compact.N("originalLength"));
            b.Messages.Touch(message); T.Equal(b.Compact(message).S("textHash"), compact.S("textHash"));
            phone.SendState(true); await T.Until(() => wire.Sent.Any(x => x.S("type") == "state")); wire.Sent.Clear();
            message["text"] = text.Replace("hidden-middle", "HIDDEN-MIDDLE"); b.Messages.Touch(message);
            var updated = b.Compact(message); T.Equal(updated.S("text"), compact.S("text")); T.Is(updated.S("textHash") != compact.S("textHash"));
            phone.SendState(); await T.Until(() => wire.Sent.Any(x => x.S("type") == "state:patch"));
            var patch = wire.Sent.First(x => x.S("type") == "state:patch");
            T.Equal(patch.G("patch").G("messages").Arr("items").Single().S("textHash"), updated.S("textHash"));
        });
        T.Add("phone-state/js-baseline-history-and-content-contract", f => {
            var b = f.Bridge; var (phone, _) = f.Phone();
            T.Equal(b.Config.InitialLimit, 200); T.Equal(b.Config.PageSize, 500);
            var source = new List<JsonObject>();
            for (int i = 0; i < 1300; i++) source.Add(b.Messages.Upsert(T.Message("history-" + i, "line " + i))!);
            var first = phone.Window(b.Messages.ForThread("a")); T.Equal(first.Count, 200);
            phone.More(); var more = phone.Window(b.Messages.ForThread("a")); T.Equal(more.Count, 700);
            b.Messages.Upsert(T.Message("history-new", "new"));
            var updated = phone.Window(b.Messages.ForThread("a")); T.Equal(updated.Count, 701);
            T.Equal(updated.First().S("id"), more.First().S("id")); T.Equal(updated.Last().S("id"), "history-new");
            phone.More(); T.Equal(phone.Window(b.Messages.ForThread("a")).Count, 1201);
            phone.More(); T.Equal(phone.Window(b.Messages.ForThread("a")).Count, 1301);
            var inputs = new List<JsonObject> {
                T.Message("ordinary", new string('中', 10000)),
                T.Message("large-text", new string('文', 70000)),
                T.Message("live-long", new string('流', 70000), stream: true),
                T.Message("tool-long", new string('出', 12000), role: "tool", kind: "command")
            };
            var plan = T.Message("plan", "plan", kind: "plan");
            ((JsonObject)plan["meta"]!)["plan"] = J.A(Enumerable.Range(0, 100).Select(i => J.O(("step", new string('任', 100) + i), ("status", "pending")))); inputs.Add(plan);
            var diff = T.Message("diff", "diff", kind: "file");
            ((JsonObject)diff["meta"]!)["changes"] = J.A(Enumerable.Range(0, 100).Select(i => J.O(("path", "E:/" + new string('x', 80) + i + ".cs"), ("added", 3), ("deleted", 2), ("kind", "update"), ("status", "completed")))); inputs.Add(diff);
            var projected = inputs.Select(m => b.Compact(m)).ToArray();
            T.Equal(projected[0].S("text"), inputs[0].S("text")); T.Is(!projected[0].B("textTruncated"));
            T.Is(projected[1].B("textTruncated")); T.Equal(projected[2].S("text"), inputs[2].S("text"));
            T.Is(projected[3].B("textTruncated")); T.Equal(projected[4].G("meta").Arr("plan").Count(), 100); T.Equal(projected[5].G("meta").Arr("changes").Count(), 100);
            Persistence.Write(Path.Combine(f.Directory, "js-baseline-comparison.json"), J.O(("source", J.A(source)), ("inputs", J.A(inputs)), ("projected", J.A(projected)), ("firstIds", J.Strings(first.Select(m => m.S("id")))), ("moreIds", J.Strings(more.Select(m => m.S("id"))))));
        });
        T.Add("phone-stream/first-frame-coalescing-ack-and-background", async f => {
            var b = f.Bridge; var (phone, wire) = f.Phone(); phone.SendState(true); await T.Until(() => wire.Sent.Count == 1); wire.Sent.Clear();
            var m = b.Messages.Upsert(T.Message("stream", "abc", stream: true))!; phone.Publish(m); await T.Until(() => wire.Sent.Count == 1);
            var first = wire.Sent[0]; T.Equal(first.S("delta"), "abc"); T.Equal(first.N("offset"), 0L); T.Is(first.G("message").G("text") is null);
            m["text"] = "abcdef"; phone.Publish(m); m["text"] = "abcdefghi"; phone.Publish(m); await Task.Delay(20); T.Equal(wire.Sent.Count, 1);
            phone.Ack(AckFrame(first)); await T.Until(() => wire.Sent.Count == 2); var next = wire.Sent[1]; T.Equal(next.N("offset"), 3L); T.Equal(next.S("delta"), "defghi"); T.Is(next.G("message") is null);
            phone.Ack(AckFrame(next)); phone.FlushStreams(); await Task.Delay(20); T.Equal(wire.Sent.Count, 2);
            phone.Background = true; m["text"] = "background"; phone.Publish(m); phone.FlushStreams(); T.Equal(wire.Sent.Count, 2);
        });
        T.Add("phone-stream/global-congestion-and-snapshot-offset", async f => {
            var b = f.Bridge; var (phone, wire) = f.Phone(); phone.SendState(true); await T.Until(() => wire.Sent.Count == 1); wire.Sent.Clear();
            var one = b.Messages.Upsert(T.Message("one", "first", stream: true))!; var two = b.Messages.Upsert(T.Message("two", "second", stream: true))!;
            phone.Publish(one); phone.Publish(two); await T.Until(() => wire.Sent.Count > 0); await Task.Delay(20); T.Equal(wire.Sent.Count, 1);
            phone.Ack(AckFrame(wire.Sent[0])); await T.Until(() => wire.Sent.Count == 2); T.Equal(wire.Sent[1].S("messageId"), "two");
            phone.SendState(true); await T.Until(() => wire.Sent.Count == 3); one["text"] = "first-extra"; phone.Publish(one); await T.Until(() => wire.Sent.Count == 4);
            T.Equal(wire.Sent[^1].N("offset"), 5L); T.Equal(wire.Sent[^1].S("delta"), "-extra");
        });
        T.Add("phone-stream/nack-new-frame-and-completion-after-last-ack", async f => {
            var b = f.Bridge; var (phone, wire) = f.Phone(); phone.SendState(true); await T.Until(() => wire.Sent.Count == 1); wire.Sent.Clear();
            var m = b.Messages.Upsert(T.Message("one", "hello", stream: true))!; phone.Publish(m); await T.Until(() => wire.Sent.Count == 1); var rejected = wire.Sent[0];
            phone.Ack(AckFrame(rejected, false, 0)); await T.Until(() => wire.Sent.Count == 2); var resent = wire.Sent[1]; T.Is(resent.N("frameId") != rejected.N("frameId")); T.Equal(resent.S("delta"), "hello");
            m["streaming"] = false; phone.Complete(m); await Task.Delay(20); T.Equal(wire.Sent.Count, 2);
            phone.Ack(AckFrame(resent)); await T.Until(() => wire.Sent.Count == 3); var complete = wire.Sent[^1]; T.Equal(complete.S("type"), "stream:complete"); T.Equal(complete.N("offset"), 5L); T.Equal(complete.S("textHash"), J.TextHash("hello")); T.Is(complete.G("message").G("text") is null); T.Is(!complete.G("message").B("streaming"));
            phone.Complete(m); phone.Ack(AckFrame(resent)); await Task.Delay(20); T.Equal(wire.Sent.Count, 3);
        });
        T.Add("desktop-snapshot/patch-copy-array-order-and-unsafe-paths", _ => {
            var original = T.Obj("{\"id\":\"a\",\"items\":[{\"text\":\"old\"}]}"); var result = DesktopIpc.ApplyPatches(original, T.Obj("{\"patches\":[{\"op\":\"replace\",\"path\":[\"items\",0,\"text\"],\"value\":\"new\"},{\"op\":\"add\",\"path\":[\"items\",1],\"value\":{\"text\":\"second\"}}]}").Arr("patches"));
            T.Equal(original.Arr("items").Single().S("text"), "old"); T.Equal(result.Arr("items").First().S("text"), "new"); T.Equal(result.Arr("items").Count(), 2);
            foreach (string key in new[] { "__proto__", "prototype", "constructor" }) T.Throws(() => DesktopIpc.ApplyPatches(original, [J.O(("op", "add"), ("path", J.Strings([key, "unsafe"])), ("value", true))]));
            T.Throws(() => DesktopIpc.ApplyPatches(original, [T.Obj("{\"op\":\"remove\",\"path\":[]}")]));
        });
        T.Add("desktop-snapshot/canonical-island-order-and-identities", _ => {
            var result = DesktopIpc.ToResponse(T.Obj("{\"id\":\"a\",\"turnHistory\":{\"kind\":\"canonical\",\"history\":{\"islands\":[{\"entries\":[{\"value\":\"second\"},{\"value\":\"first\"}]}],\"entitiesByKey\":{\"first\":{\"turnId\":\"one\",\"items\":[{\"id\":\"m1\"}]},\"second\":{\"turnId\":\"two\",\"items\":[{\"id\":\"m2\"}]}}}}}"));
            T.Equal(result.G("thread").Arr("turns").First().S("id"), "two"); T.Equal(result.G("thread").Arr("turns").Last().Arr("items").Single().S("id"), "m1"); T.Is(result.B("desktopSnapshot"));
        });
        T.Add("desktop-snapshot/owner-duplicate-gap-and-version-guards", f => {
            using var ipc = new DesktopIpc(f.Cancel.Token); var type = typeof(DesktopIpc).GetNestedType("Follow", BindingFlags.NonPublic)!;
            var follow = Activator.CreateInstance(type, "owner")!; var followed = T.Field<IDictionary>(ipc, "followed"); followed.Add("a", follow); T.Set(ipc, "clientId", "phone");
            int snapshots = 0; ipc.Snapshot = _ => snapshots++;
            JsonObject Frame(string source, int version, JsonObject change) => J.O(("method", "thread-stream-state-changed"), ("version", version), ("sourceClientId", source), ("targetClientIds", J.Strings(["phone"])), ("params", J.O(("hostId", "local"), ("conversationId", "a"), ("change", change))));
            var snapshot = T.Obj("{\"type\":\"snapshot\",\"revision\":1,\"conversationState\":{\"id\":\"a\",\"turns\":[]}}"); T.Call(ipc, "Broadcast", Frame("foreign", 11, snapshot)); T.Equal(snapshots, 0);
            T.Call(ipc, "Broadcast", Frame("owner", 11, snapshot)); T.Equal(snapshots, 1);
            T.Call(ipc, "Broadcast", Frame("owner", 11, T.Obj("{\"type\":\"patches\",\"baseRevision\":0,\"revision\":1,\"patches\":[]}"))); T.Equal(snapshots, 1);
            type.GetField("Resync")!.SetValue(follow, J.Now); T.Call(ipc, "Broadcast", Frame("owner", 11, T.Obj("{\"type\":\"patches\",\"baseRevision\":4,\"revision\":5,\"patches\":[]}"))); T.Is(type.GetField("State")!.GetValue(follow) is null); T.Is(type.GetField("Error")!.GetValue(follow) is IOException);
            T.Call(ipc, "Broadcast", Frame("owner", 11, snapshot)); T.Equal(snapshots, 2); T.Call(ipc, "Broadcast", Frame("owner", 12, snapshot)); T.Is(type.GetField("State")!.GetValue(follow) is null); T.Is(type.GetField("Error")!.GetValue(follow) is IOException);
        });
        T.Add("proxy-runtime/multiple-owner-routing-events", async f => {
            var b = f.Bridge; var one = f.Peer("one", "a"); var two = f.Peer("two", "b");
            await b.Router.Request("turn/start", J.O(("threadId", "a"))); await b.Router.Request("turn/start", J.O(("threadId", "b"))); T.Equal(one.Calls.Count, 1); T.Equal(two.Calls.Count, 1);
            var notification = T.Obj("{\"type\":\"notification\",\"notification\":{\"method\":\"turn/started\",\"params\":{\"threadId\":\"a\",\"turn\":{\"id\":\"one\"}}}}");
            T.Call(b.Router, "Handle", two.Connection, notification, false); T.Is(!b.runtimes.ContainsKey("a")); T.Call(b.Router, "Handle", one.Connection, notification, false); T.Equal(b.Runtime("a").Turn, "one");
        });
        T.Add("proxy-runtime/write-timeout-uncertain-and-no-retry", async f => {
            var peer = f.Peer("one", "a"); var gate = new TaskCompletionSource<JsonNode>(); peer.Handler = _ => gate.Task;
            try { await f.Bridge.Router.Request("turn/start", J.O(("threadId", "a")), 40); throw new Exception("Expected timeout"); } catch (BridgeException e) { T.Is(e.Uncertain); }
            T.Equal(peer.Calls.Count, 1); gate.SetResult(new JsonObject());
        });
    }
}
