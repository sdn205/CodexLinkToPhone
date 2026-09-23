using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodexPhoneBridge;

internal sealed class MessageStore
{
    private readonly Dictionary<string, JsonObject> messages = [];
    private readonly MessageOrder order = new();
    public long Revision { get; private set; }
    public TurnFacts DiscardedPlans { get; } = new();
    public TurnFacts RolledBack { get; } = new();
    public Action<JsonObject> Changed { get; set; } = _ => { };
    public IEnumerable<JsonObject> Values => messages.Values;
    public JsonObject? Get(string id) => messages.GetValueOrDefault(id);
    public static string UserId(string tid, string cid) => "user-" + Convert.ToHexStringLower(SHA1.HashData(Encoding.UTF8.GetBytes(tid + ":" + cid)))[..24];
    public static string ClientId(JsonNode m) => m.G("meta").S("clientUserMessageId", m.G("meta").S("clientId"));
    private static bool SnapshotId(string id) => Regex.IsMatch(id, "^item-\\d+$");
    public JsonObject? Upsert(JsonObject incoming, string snapshot = "", int index = -1, long readRevision = long.MaxValue)
    {
        var m = incoming.Obj(); string tid = MessageOrder.Thread(m), turn = MessageOrder.Turn(m);
        if (tid == "" || RolledBack.Contains((tid, turn)) || m.S("kind") == "plan" && DiscardedPlans.Contains((tid, turn))) return null;
        string cid = ClientId(m); if (m.S("role") == "user" && cid != "") m["id"] = UserId(tid, cid);
        string id = m.S("id"); if (id == "") return null;
        var meta = m.G("meta").Obj(); meta.Remove("snapshotOrders"); meta.Remove("snapshotOrderKey"); meta.Remove("turnItemIndex"); m["meta"] = meta;
        var old = Get(id);
        if (old is null && m.S("role") == "assistant" && m.S("kind") == "text" && m.S("text") != "")
        {
            var aliases = Values.Where(x => MessageOrder.Thread(x) == tid && MessageOrder.Turn(x) == turn && x.S("role") == "assistant" && x.S("kind") == "text" && x.S("text") == m.S("text") && SnapshotId(x.S("id")) != SnapshotId(id)).ToArray();
            if (aliases.Length == 1)
            {
                old = aliases[0];
                if (SnapshotId(id)) { id = old.S("id"); m["id"] = id; }
                else messages.Remove(old.S("id"));
            }
        }
        bool hasContent = m.S("text").Trim() != "" || m.S("kind") is "file" or "turn_diff" || meta.Arr("images").Any() || meta.Arr("plan").Any();
        if (!hasContent && old is null) return null;
        if (old is not null)
        {
            if (meta.S("submissionState") == "accepted" && old.G("meta").S("submissionState") == "") return old;
            bool newer = snapshot != "" && old.N("revision") > readRevision;
            var oldMeta = old.G("meta");
            var merged = J.Merge(old, m); var combined = J.Merge(oldMeta, meta);
            if (newer || snapshot != "" && old.B("streaming") && old.S("text").Length >= m.S("text").Length) { merged.Set("text", old.G("text")); merged.Set("streaming", old.G("streaming")); combined = J.Merge(meta, oldMeta); }
            if (!hasContent) merged.Set("text", old.G("text"));
            if (!meta.Arr("images").Any() && oldMeta.Arr("images").Any()) combined.Set("images", oldMeta.G("images"));
            if (oldMeta.N("proxyEventSeq") > 0 && (meta.S("proxyEventSource") == "" || meta.S("proxyEventSource") == oldMeta.S("proxyEventSource") && oldMeta.N("proxyEventSeq") < meta.N("proxyEventSeq")))
            { combined.Set("proxyEventSeq", oldMeta.G("proxyEventSeq")); combined.Set("proxyEventSource", oldMeta.G("proxyEventSource")); if (oldMeta.B("proxyEventReplay")) combined["proxyEventReplay"] = true; }
            if (oldMeta.S("submissionState") == "accepted" && meta.S("submissionState") == "") { combined.Remove("submissionState"); combined.Set("userMessageOrderAt", oldMeta.G("userMessageOrderAt")); }
            merged["meta"] = combined; merged.Set("createdAt", old.G("createdAt")); m = merged;
        }
        order.Ensure(m, Values, snapshot, index); Touch(m); messages[id] = m; Changed(m); return m;
    }
    public void Touch(JsonObject m) { m["revision"] = ++Revision; m["updatedAt"] = J.Now; }
    public void Commit(string tid, string turn, string snapshot) => order.Commit(tid, turn, snapshot, Values);
    public void RemoveWhere(Func<JsonObject, bool> predicate) { foreach (var m in Values.Where(predicate).ToArray()) { order.Remove(m); messages.Remove(m.S("id")); } Revision++; }
    private static long TurnTime(JsonNode m) => J.UuidTime(MessageOrder.Turn(m)) is > 0 and var t ? t : J.Epoch(m.G("meta").G("turnOrderAt")) is > 0 and var u ? u : J.Epoch(m.G("meta").G("turnStartedAt")) is > 0 and var v ? v : m.N("createdAt");
    public List<JsonObject> ForThread(string tid)
    {
        var source = Values.Where(m => MessageOrder.Thread(m) == tid).ToList();
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
        var old = Get(id);
        if (old is not null) { old["text"] = old.S("text") + delta; old["streaming"] = true; Touch(old); Changed(old); return old; }
        return Upsert(J.O(("id", id), ("role", role is "assistant" or "plan" ? "assistant" : "tool"), ("kind", role == "assistant" ? "text" : role), ("text", delta), ("streaming", true), ("meta", context), ("createdAt", J.Now)));
    }
    public void Reasoning(JsonObject p)
    {
        var old = Get(p.S("itemId")); var meta = J.Merge(old.G("meta"), p); string key = p.G("summaryIndex") is not null ? "summaryParts" : "contentParts";
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
