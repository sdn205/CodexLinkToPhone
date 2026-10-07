using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed class MessageStore
{
    private Dictionary<string, JsonObject> messages = [];
    private MessageOrder order = new();
    private readonly Dictionary<string, Dictionary<string, long>> eventHeads = [];
    private HashSet<string> completed = [];
    private readonly HashSet<(string, string)> completedTurns = [];
    public bool TurnCompleted(string tid, string turn) => completedTurns.Contains((tid, turn));
    public long Revision { get; private set; }
    public TurnFacts DiscardedPlans { get; } = new();
    public TurnFacts RolledBack { get; } = new();
    public Action<JsonObject> Changed { get; set; } = _ => { };
    public IEnumerable<JsonObject> Values => messages.Values;
    public JsonObject? Get(string id) => messages.GetValueOrDefault(id);
    public static string ItemId(string tid, string turn, string sourceId) => "message-" + J.Hash(J.Strings([tid, turn, sourceId]).Wire());
    public JsonObject? GetSource(string tid, string turn, string sourceId) => Get(ItemId(tid, turn, sourceId));
    public static string UserId(string tid, string cid) => "user-" + Convert.ToHexStringLower(SHA1.HashData(Encoding.UTF8.GetBytes(tid + ":" + cid)))[..24];
    public static string ClientId(JsonNode m) => m.G("meta").S("clientUserMessageId", m.G("meta").S("clientId"));
    public JsonObject CaptureSubmissionOrder(string tid, string turn)
    {
        var prior = ForThread(tid).Where(m => MessageOrder.Turn(m) == turn && !MessageOrder.Excluded(m)).ToArray();
        var fences = new JsonObject();
        foreach (var m in prior)
        {
            var meta = m.G("meta"); string source = meta.S("proxyEventSource");
            if (source != "") fences[source] = Math.Max(fences.N(source), meta.N("proxyEventSeq"));
        }
        return J.O(("submissionAfter", prior.LastOrDefault().G("meta").S("canonicalOrderKey")), ("submissionFences", fences));
    }
    private static bool HasContent(JsonNode m) => m.S("text").Trim() != "" || m.S("kind") is "file" or "turn_diff" || m.G("meta").Arr("images").Any() || m.G("meta").Arr("plan").Any();
    private bool IsNewEvent(string id, JsonNode meta)
    {
        string source = meta.S("proxyEventSource"); long seq = meta.N("proxyEventSeq");
        return source == "" || seq <= 0 || !eventHeads.TryGetValue(id, out var sources) || seq > sources.GetValueOrDefault(source);
    }
    private void CommitEvent(string id, JsonNode meta)
    {
        string source = meta.S("proxyEventSource"); long seq = meta.N("proxyEventSeq");
        if (source == "" || seq <= 0) return;
        if (!eventHeads.TryGetValue(id, out var sources)) eventHeads[id] = sources = [];
        sources[source] = Math.Max(sources.GetValueOrDefault(source), seq);
    }
    private JsonObject? ObserveOrder(JsonObject? old, JsonNode context)
    {
        if (old is null) return null;
        string source = context.S("proxyEventSource"); long seq = context.N("proxyEventSeq"); var previous = old.G("meta");
        if (source == "" || seq <= 0 || source == previous.S("proxyEventSource") && previous.N("proxyEventSeq") > 0 && seq >= previous.N("proxyEventSeq")) return old;
        var observed = old.Obj(); var meta = observed.G("meta").Obj();
        meta["proxyEventSource"] = source; meta["proxyEventSeq"] = seq; observed["meta"] = meta;
        order.Ensure(observed, Values); Touch(observed); messages[observed.S("id")] = observed; Changed(observed); return observed;
    }
    public JsonObject? Upsert(JsonObject incoming, string snapshot = "", int index = -1, long readRevision = long.MaxValue)
    {
        var m = incoming.Obj(); string tid = MessageOrder.Thread(m), turn = MessageOrder.Turn(m);
        if (tid == "" || RolledBack.Contains((tid, turn)) || m.S("kind") == "plan" && DiscardedPlans.Contains((tid, turn))) return null;
        string sourceId = m.G("meta").S("sourceItemId", m.S("id")); if (sourceId == "") return null;
        string cid = ClientId(m);
        string id = m.S("role") == "user" && cid != "" ? UserId(tid, cid) : ItemId(tid, turn, sourceId); m["id"] = id;
        var meta = m.G("meta").Obj(); meta.Remove("snapshotOrders"); meta.Remove("snapshotOrderKey"); meta.Remove("turnItemIndex"); m["meta"] = meta;
        meta["sourceItemId"] = sourceId;
        var old = Get(id);
        if (TurnCompleted(tid, turn) && m.B("streaming") && !meta.B("sourceCompleted")) return ObserveOrder(old, meta);
        bool liveEvent = snapshot == "" && meta.N("proxyEventSeq") > 0;
        if (liveEvent && !IsNewEvent(id, meta) && !(meta.B("sourceCompleted") && !old.G("meta").B("sourceCompleted"))) return ObserveOrder(old, meta);
        if (liveEvent && old is not null && completed.Contains(id) && m.B("streaming")) { CommitEvent(id, meta); return ObserveOrder(old, meta); }
        bool hasContent = HasContent(m);
        // Empty item/started is ordering evidence. It stays internal until content arrives.
        if (!hasContent && old is null && !(m.B("streaming") && liveEvent)) return null;
        if (old is not null)
        {
            if (meta.S("submissionState") == "accepted" && old.G("meta").S("submissionState") == "") return old;
            bool newer = snapshot != "" && old.N("revision") > readRevision;
            var oldMeta = old.G("meta");
            var merged = J.Merge(old, m); var combined = J.Merge(oldMeta, meta);
            if ((newer || snapshot != "" && old.B("streaming")) && !meta.B("sourceCompleted")) { merged.Set("text", old.G("text")); merged.Set("streaming", old.G("streaming")); combined = J.Merge(meta, oldMeta); }
            if (completed.Contains(id)) { merged["streaming"] = false; if (m.B("streaming")) merged.Set("text", old.G("text")); }
            if (!hasContent) merged.Set("text", old.G("text"));
            if (!meta.Arr("images").Any() && oldMeta.Arr("images").Any()) combined.Set("images", oldMeta.G("images"));
            if (oldMeta.N("proxyEventSeq") > 0 && (meta.S("proxyEventSource") == "" || meta.S("proxyEventSource") == oldMeta.S("proxyEventSource") && oldMeta.N("proxyEventSeq") < meta.N("proxyEventSeq")))
            { combined.Set("proxyEventSeq", oldMeta.G("proxyEventSeq")); combined.Set("proxyEventSource", oldMeta.G("proxyEventSource")); if (oldMeta.B("proxyEventReplay")) combined["proxyEventReplay"] = true; }
            if (oldMeta.S("submissionState") == "accepted" && meta.S("submissionState") == "") { combined.Remove("submissionState"); combined.Set("userMessageOrderAt", oldMeta.G("userMessageOrderAt")); }
            merged["meta"] = combined; merged.Set("createdAt", old.G("createdAt")); m = merged;
        }
        order.Ensure(m, Values, snapshot, index); Touch(m); messages[id] = m;
        if (liveEvent) CommitEvent(id, meta);
        if (meta.B("sourceCompleted")) { completed.Add(id); m["streaming"] = false; }
        Changed(m); return m;
    }
    public void Touch(JsonObject m) { m["revision"] = ++Revision; m["updatedAt"] = J.Now; }
    public void Commit(string tid, string turn, string snapshot) => order.Commit(tid, turn, snapshot, Values);
    public void ApplySnapshot(string tid, string turn, IReadOnlyList<JsonObject> items, string snapshot, long readRevision)
    {
        // Publish message contents and their ordering ledger as one transaction.
        var before = messages; var beforeOrder = order; var beforeCompleted = completed; long beforeRevision = Revision; var notify = Changed;
        messages = new(before);
        foreach (var m in before.Values.Where(m => MessageOrder.Thread(m) == tid && MessageOrder.Turn(m) == turn)) messages[m.S("id")] = m.Obj();
        order = order.Fork(); completed = new(completed); Changed = _ => { };
        try
        {
            var identities = new HashSet<string>();
            for (int i = 0; i < items.Count; i++)
            {
                var item = items[i];
                if (MessageOrder.Thread(item) != tid || MessageOrder.Turn(item) != turn) throw new BridgeException("历史消息不属于当前轮次", "message_identity_scope");
                var stored = Upsert(item, snapshot, i, readRevision);
                if (stored is not null && !identities.Add(stored.S("id"))) throw new BridgeException("历史快照包含重复消息身份", "message_identity_duplicate");
            }
            Commit(tid, turn, snapshot);
        }
        catch { messages = before; order = beforeOrder; completed = beforeCompleted; Revision = beforeRevision; throw; }
        finally { Changed = notify; }
        foreach (var m in Values.Where(m => MessageOrder.Thread(m) == tid && MessageOrder.Turn(m) == turn && m.N("revision") > beforeRevision)) Changed(m);
    }
    public void RemoveWhere(Func<JsonObject, bool> predicate) { foreach (var m in Values.Where(predicate).ToArray()) { order.Remove(m); string id = m.S("id"); messages.Remove(id); eventHeads.Remove(id); completed.Remove(id); } Revision++; }
    public void CompleteTurn(string tid, string turn)
    {
        if (tid != "" && turn != "") completedTurns.Add((tid, turn));
        foreach (var m in Values.Where(m => MessageOrder.Thread(m) == tid && MessageOrder.Turn(m) == turn)) completed.Add(m.S("id"));
    }
    private static long TurnTime(JsonNode m) => J.UuidTime(MessageOrder.Turn(m)) is > 0 and var t ? t : J.Epoch(m.G("meta").G("turnOrderAt")) is > 0 and var u ? u : J.Epoch(m.G("meta").G("turnStartedAt")) is > 0 and var v ? v : m.N("createdAt");
    public List<JsonObject> ForThread(string tid)
    {
        var source = Values.Where(m => MessageOrder.Thread(m) == tid && HasContent(m)).ToList();
        source.Sort((a, b) =>
        {
            string at = MessageOrder.Turn(a), bt = MessageOrder.Turn(b);
            if (at == bt && at != "")
            {
                int Rank(JsonObject m) => m.S("kind") == "turn_diff" ? m.G("meta").S("display") == "completed_card" ? 2 : m.G("meta").S("display") == "above_composer" ? 3 : 0 : 0;
                int rank = Rank(a).CompareTo(Rank(b)); if (rank != 0) return rank;
                int ordinal = a.G("meta").N("canonicalOrdinal").CompareTo(b.G("meta").N("canonicalOrdinal")); if (ordinal != 0) return ordinal;
            }
            else { int time = TurnTime(a).CompareTo(TurnTime(b)); if (time != 0) return time; int turn = string.CompareOrdinal(at, bt); if (turn != 0) return turn; }
            return a.N("createdAt") == b.N("createdAt") ? a.N("revision").CompareTo(b.N("revision")) : a.N("createdAt").CompareTo(b.N("createdAt"));
        }); return source;
    }
    public JsonObject? Delta(string id, string role, string delta, JsonObject context)
    {
        string canonical = ItemId(context.S("threadId"), context.S("turnId"), id); var old = Get(canonical);
        if (!IsNewEvent(canonical, context)) return ObserveOrder(old, context);
        if (completed.Contains(canonical) || TurnCompleted(context.S("threadId"), context.S("turnId"))) { CommitEvent(canonical, context); return ObserveOrder(old, context); }
        if (old is not null) { old["text"] = old.S("text") + delta; old["streaming"] = true; CommitEvent(canonical, context); Touch(old); Changed(old); return old; }
        return Upsert(J.O(("id", id), ("role", role is "assistant" or "plan" ? "assistant" : "tool"), ("kind", role == "assistant" ? "text" : role), ("text", delta), ("streaming", true), ("meta", context), ("createdAt", J.Now)));
    }
    public void Reasoning(JsonObject p)
    {
        string canonical = ItemId(p.S("threadId"), p.S("turnId"), p.S("itemId"));
        if (!IsNewEvent(canonical, p)) { ObserveOrder(Get(canonical), p); return; }
        if (completed.Contains(canonical) || TurnCompleted(p.S("threadId"), p.S("turnId"))) { CommitEvent(canonical, p); ObserveOrder(Get(canonical), p); return; }
        var old = Get(canonical); var meta = J.Merge(old.G("meta"), p); string key = p.G("summaryIndex") is not null ? "summaryParts" : "contentParts";
        int index = (int)p.N(key == "summaryParts" ? "summaryIndex" : "contentIndex"); if (index < 0 || index > 10000) return;
        var parts = J.A(meta.Arr(key)); while (parts.Count <= index) parts.AddNode(JsonValue.Create("")); parts[index] = parts[index].Text() + p.S("delta"); meta[key] = parts;
        string text = string.Join("\n\n", meta.Arr("summaryParts").Concat(meta.Arr("contentParts")).Select(x => x.Text()).Where(x => x != ""));
        Upsert(J.O(("id", p.G("itemId")), ("role", "assistant"), ("kind", "reasoning"), ("text", text), ("streaming", true), ("meta", meta), ("createdAt", old?.N("createdAt") ?? J.Now)));
    }
}

internal sealed class TurnFacts : IEnumerable<(string, string)>
{
    private readonly LinkedList<(string, string)> ordered = new();
    private readonly Dictionary<(string, string), LinkedListNode<(string, string)>> entries = [];
    public int Count => entries.Count;
    public bool Contains((string, string) key) => entries.ContainsKey(key);
    public bool Add((string, string) key)
    {
        if (key.Item1 == "" || key.Item2 == "" || entries.ContainsKey(key)) return false;
        entries[key] = ordered.AddLast(key);
        while (entries.Count > 500) Remove(ordered.First!.Value);
        return true;
    }
    public bool Remove((string, string) key) { if (!entries.Remove(key, out var node)) return false; ordered.Remove(node); return true; }
    public IEnumerator<(string, string)> GetEnumerator() => ordered.GetEnumerator();
    System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
}
