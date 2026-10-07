using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    internal static void RegisterTurnTests()
    {
        T.Add("thread-runtime/unknown-read-and-detached-snapshots", f => {
            var b = f.Bridge; var (phone, _) = f.Phone("unknown"); b.State(phone); b.State(); T.Equal(b.runtimes.Count, 0);
            b.StartTurn("a", "one", 1800000000000); phone.ThreadId = "a"; var saved = b.State(phone);
            b.StartTurn("b", "two", 1800000001000); b.Runtime("a").ReplyStarted = 1800000000500;
            T.Equal(saved.N("activeTurnStartedAt"), 1800000000000L); T.Is(saved.G("activeTurnReplyStartedAt") is null);
            T.Equal(b.Runtime("a").Turn, "one"); T.Equal(b.Runtime("b").Turn, "two");
        });
        T.Add("thread-runtime/same-turn-and-first-acceptance-preserve-clock", f => {
            var b = f.Bridge; b.StartTurn("a", "", 1800000000000); var r = b.Runtime("a"); r.ReplyStarted = 1800000000100;
            b.StartTurn("a", "one", 1800000000900); T.Equal(r.Started, 1800000000000L); T.Equal(r.ReplyStarted, 1800000000100L);
            b.StartTurn("a", "one", 1800000001900); T.Equal(r.Started, 1800000000000L); T.Equal(r.ReplyStarted, 1800000000100L);
        });
        T.Add("thread-runtime/completed-turn-rejects-late-start-and-unknown-delta", f => {
            var b = f.Bridge; b.StartTurn("a", "one", 1800000000000);
            b.FinishTurn("a", "one", 1800000000000, 1800000001000, false);
            b.StartTurn("a", "one", 1800000000000); T.Is(!b.Runtime("a").Busy);
            var m = T.Message("unknown", turn: "one", stream: true);
            T.Is(b.Messages.Delta("unknown", "assistant", "late", m.G("meta").Obj()) is null);
            T.Is(b.Messages.Upsert(m) is null);
            m["streaming"] = false; m["text"] = "complete"; m.G("meta")!["sourceCompleted"] = true;
            T.Equal(b.Messages.Upsert(m).S("text"), "complete");
            b.StartTurn("a", "two", 1800000002000);
            b.StartTurn("a", "one", 1800000000000); T.Equal(b.Runtime("a").Turn, "two");
        });
        T.Add("thread-runtime/new-turn-and-delayed-completion", f => {
            var b = f.Bridge; b.StartTurn("a", "one", 1800000000000); b.Runtime("a").ReplyStarted = 1800000000100;
            b.Runtime("a").LastTiming = J.O(("turnId", "old")); b.StartTurn("a", "two", 1800000001000);
            var r = b.Runtime("a"); long rev = r.Revision; T.Equal(r.ReplyStarted, 0L); T.Is(r.LastTiming is null);
            b.FinishTurn("a", "one", 1800000000000, 1800000000900, false); T.Is(r.Busy); T.Equal(r.Turn, "two"); T.Equal(r.Revision, rev);
        });
        T.Add("thread-runtime/completion-timing-isolation-and-copy", f => {
            var b = f.Bridge; b.StartTurn("a", "one", 1800000000000); b.StartTurn("b", "two", 1800000000200);
            b.FinishTurn("a", "one", 1800000000300, 1800000001900, false);
            var (phone, _) = f.Phone(); var state = b.State(phone); T.Equal(state.G("lastTurnTiming").N("startedAt"), 1800000000300L);
            T.Equal(state.G("lastTurnTiming").N("completedAt"), 1800000001900L); T.Is(b.Runtime("b").Busy);
            state.G("lastTurnTiming")!["completedAt"] = 1; T.Equal(b.Runtime("a").LastTiming.N("completedAt"), 1800000001900L);
            long revision = b.Runtime("a").Revision; b.Revert("a", "one"); T.Is(b.Runtime("a").Revision > revision); T.Is(b.Runtime("a").LastTiming is null); T.Is(b.Runtime("b").Busy);
            b.Invalidate("a", true); T.Is(!b.runtimes.ContainsKey("a")); T.Is(b.Runtime("b").Busy);
        });
        T.Add("thread-runtime/duration-without-start-and-idle-without-identity", f => {
            var b = f.Bridge; b.HandleNotification("turn/completed", T.Obj("{\"threadId\":\"a\",\"proxyEventReplay\":true,\"turn\":{\"id\":\"one\",\"completedAt\":1800000002,\"durationMs\":1500}}"));
            T.Equal(b.Runtime("a").LastTiming.N("startedAt"), 1800000000500L); T.Equal(b.Runtime("a").LastTiming.N("completedAt"), 1800000002000L);
            b.FinishTurn("empty", recover: false); T.Is(b.Runtime("empty").LastTiming is null); T.Equal(b.Runtime("empty").Timings.Count, 0);
        });
        T.Add("turn-state/rollback-and-plan-facts-independent", f => {
            var b = f.Bridge; b.Messages.RolledBack.Add(("a", "one")); b.DiscardPlan("a", "one");
            b.Messages.RolledBack.Remove(("a", "one")); T.Is(b.Messages.DiscardedPlans.Contains(("a", "one")));
            T.Is(b.Messages.Upsert(T.Message("one:plan", turn: "one", kind: "plan")) is null);
            b.Messages.RolledBack.Add(("a", "two")); T.Is(b.Messages.Upsert(T.Message("rolled", turn: "two")) is null);
            T.Is(b.Messages.Upsert(T.Message("other", tid: "b", turn: "two")) is not null);
        });
        T.Add("turn-state/discarded-plans-bounded-and-serialized", f => {
            var b = f.Bridge; for (int i = 0; i < 1005; i++) b.DiscardPlan("a", "turn-" + i);
            T.Equal(b.Messages.DiscardedPlans.Count, 500); var entries = Persistence.Read(b.StatePath("operations.json")).Arr("discardedPlanTurns").ToArray();
            T.Equal(entries.Length, b.Messages.DiscardedPlans.Count); T.Equal(entries[^1].S("turnId"), "turn-1004");
        });
        T.Add("turn-diff/deterministic-id-and-scoped-removal", f => {
            var b = f.Bridge; b.StartTurn("a", "one"); b.StartTurn("b", "two");
            b.UpdateDiff("a", "one", TestDiff); b.UpdateDiff("a", "one", TestDiff); b.UpdateDiff("b", "two", TestDiff);
            T.Equal(b.Messages.ForThread("a").Count, 1); T.Equal(b.Messages.ForThread("a")[0].G("meta").S("sourceItemId"), "a:one:turn-diff-live");
            T.Equal(b.Messages.ForThread("a")[0].G("meta").S("display"), "above_composer");
            b.CompleteDiff("a", "one", 0, 0); T.Is(T.Stored(b.Messages, "a:one:turn-diff-live") is null); T.Is(T.Stored(b.Messages, "b:two:turn-diff-live") is not null);
            T.Equal(T.Stored(b.Messages, "a:one:turn-diff").G("meta").S("display"), "completed_card");
        });
        T.Add("turn-artifacts/plan-live-and-timeline-restore-independently", f => {
            var b = f.Bridge; var snapshot = J.O(("id", "a"), ("turns", new JsonArray(J.O(("id", "one"), ("status", "inProgress"), ("startedAt", 1800000000), ("items", new JsonArray(T.Obj("{\"id\":\"p\",\"type\":\"plan\",\"plan\":[{\"step\":\"test\",\"status\":\"pending\"}]}"), J.O(("id", "file"), ("type", "fileChange"), ("changes", new JsonArray(J.O(("path", "a.js"), ("diff", TestDiff)))))))))));
            b.Hydrate(snapshot); b.Hydrate(snapshot);
            T.Equal(b.Messages.ForThread("a").Count(x => x.S("kind") == "plan"), 1); T.Equal(b.Messages.ForThread("a").Count(x => x.S("kind") == "file"), 1);
            T.Equal(b.Messages.ForThread("a").Count(x => x.S("kind") == "turn_diff"), 1); b.DiscardPlan("a", "one"); T.Is(T.Stored(b.Messages, "a:one:turn-diff-live") is not null);
            b.CompleteDiff("a", "one", 0, 0); T.Is(T.Stored(b.Messages, "file") is not null);
        });
        T.Add("turn-artifacts/completed-card-after-final-and-not-overlaid", f => {
            var b = f.Bridge; b.StartTurn("a", "one", 1800000000000); b.UpdateDiff("a", "one", TestDiff);
            b.Messages.Upsert(T.Message("final", "done", turn: "one")); b.CompleteDiff("a", "one", 1800000000000, 1800000001000);
            var list = b.Messages.ForThread("a"); T.Equal(list[^1].G("meta").S("sourceItemId"), "a:one:turn-diff"); T.Equal(list[^2].G("meta").S("sourceItemId"), "final");
            string diff = T.Stored(b.Messages, "a:one:turn-diff").S("unifiedDiff"); b.RestoreLiveDiff("a", "one", 0); b.CompleteDiff("a", "one", 0, 0); T.Equal(T.Stored(b.Messages, "a:one:turn-diff").S("unifiedDiff"), diff);
            var (phone, _) = f.Phone(); var copy = b.State(phone); copy.Arr("messages").Last()["text"] = "changed"; T.Is(T.Stored(b.Messages, "a:one:turn-diff").S("text") != "changed");
        });
        T.Add("turn-artifacts/window-bounds-pin-live-diff-and-ignore-ordinary", f => {
            var b = f.Bridge; b.StartTurn("a", "one"); b.UpdateDiff("a", "one", TestDiff);
            b.Messages.Upsert(T.Message("plan", turn: "one", kind: "plan"));
            for (int i = 0; i < 400; i++) b.Messages.Upsert(T.Message("m" + i, turn: "one"));
            var (phone, _) = f.Phone(); var visible = phone.Window(b.Messages.ForThread("a"));
            T.Is(visible.Count <= b.Config.InitialLimit + 2); T.Is(visible.Any(x => x.G("meta").S("sourceItemId") == "a:one:turn-diff-live"));
            T.Is(visible.Any(x => x.G("meta").S("sourceItemId") == "plan")); T.Is(!visible.Any(x => x.G("meta").S("sourceItemId") == "m0"));
            b.Messages.Upsert(T.Message("plain", tid: "b")); b.RestoreLiveDiff("b", "turn-a", 0); T.Equal(b.Messages.ForThread("b").Count, 1);
        });
        T.Add("turn-artifacts/removal-respects-display-exception-and-thread", f => {
            var b = f.Bridge;
            foreach (var (id, display, tid) in new[] { ("keep", "above_composer", "a"), ("remove", "above_composer", "a"), ("done", "completed_card", "a"), ("timeline", "timeline_rows", "a"), ("other", "above_composer", "b") }) {
                var m = T.Message(id, tid: tid, kind: "turn_diff"); m.G("meta")!["display"] = display; b.Messages.Upsert(m);
            }
            b.Messages.RemoveWhere(m => MessageOrder.Thread(m) == "a" && MessageOrder.Turn(m) == "turn-a" && m.S("kind") == "turn_diff" && m.G("meta").S("display") == "above_composer" && m.G("meta").S("sourceItemId") != "keep");
            T.Is(T.Stored(b.Messages, "remove") is null); foreach (var id in new[] { "keep", "done", "timeline", "other" }) T.Is(T.Stored(b.Messages, id) is not null);
        });
    }
}
