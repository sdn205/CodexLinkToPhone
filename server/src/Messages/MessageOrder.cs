using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed class MessageOrder
{
    private sealed class Entry(string key, string origin, int observed)
    {
        public string Key = key, Origin = origin; public int Observed = observed;
        public Dictionary<string, long> Events = []; public Dictionary<string, int> Snapshots = [];
        public bool SnapshotObserved; public string? Boundary; public Dictionary<string, long> Fences = [];
        public Entry Clone() => new(Key, Origin, Observed) { Events = new(Events), Snapshots = new(Snapshots), SnapshotObserved = SnapshotObserved, Boundary = Boundary, Fences = new(Fences) };
    }
    private sealed class Ledger
    {
        public List<Entry> Entries = []; public HashSet<(string, string)> Edges = []; public string Snapshot = ""; public int Next;
        public Ledger Clone() => new() { Entries = Entries.Select(x => x.Clone()).ToList(), Edges = new(Edges), Snapshot = Snapshot, Next = Next };
    }
    private readonly Dictionary<(string, string), Ledger> ledgers = [];
    private readonly Dictionary<(string, string), Ledger> snapshots = [];
    private static string Key(JsonNode m) => m.S("role") == "user" && m.G("meta").S("clientUserMessageId", m.G("meta").S("clientId")) is { Length: > 0 } cid ? "user:" + cid : "item:" + m.S("id");
    public static string Thread(JsonNode m) => m.G("meta").S("threadId");
    public static string Turn(JsonNode m) => m.G("meta").S("turnId");
    public static bool Excluded(JsonNode m) => m.S("kind") == "turn_diff" && m.G("meta").S("display") is "above_composer" or "completed_card";
    public void Ensure(JsonObject message, IEnumerable<JsonObject> messages, string snapshot = "", int index = -1)
    {
        string tid = Thread(message), turn = Turn(message); if (tid == "" || turn == "" || Excluded(message)) return;
        var threadTurn = (tid, turn);
        var ledger = snapshot != "" && snapshots.TryGetValue(threadTurn, out var staged) && staged.Snapshot == snapshot
            ? staged : ledgers.GetValueOrDefault(threadTurn)?.Clone() ?? new();
        string key = Key(message); var meta = message.G("meta").Obj();
        if (snapshot != "" && ledger.Snapshot != snapshot) { ledger.Snapshot = snapshot; ledger.Edges.Clear(); }
        string oldKey = meta.S("canonicalOrderKey");
        if (oldKey != "" && oldKey != key)
        {
            var previous = ledger.Entries.Find(x => x.Key == oldKey); var existing = ledger.Entries.Find(x => x.Key == key);
            if (previous is not null)
            {
                if (existing is null) previous.Key = key;
                else { foreach (var (s, eventSequence) in previous.Events) existing.Events[s] = Math.Min(existing.Events.GetValueOrDefault(s, long.MaxValue), eventSequence); foreach (var (s, i) in previous.Snapshots) existing.Snapshots[s] = i; existing.SnapshotObserved |= previous.SnapshotObserved; ledger.Entries.Remove(previous); }
                ledger.Edges = ledger.Edges.Select(e => (e.Item1 == oldKey ? key : e.Item1, e.Item2 == oldKey ? key : e.Item2)).Where(e => e.Item1 != e.Item2).ToHashSet();
                foreach (var candidate in ledger.Entries) if (candidate.Boundary == oldKey) candidate.Boundary = key;
            }
        }
        var entry = ledger.Entries.Find(x => x.Key == key); bool created = entry is null;
        entry ??= new(key, "unknown", ledger.Next++);
        string source = meta.S("proxyEventSource"); long seq = meta.N("proxyEventSeq");
        if (source != "" && seq > 0) { entry.Events[source] = Math.Min(entry.Events.GetValueOrDefault(source, long.MaxValue), seq); if (meta.B("proxyEventReplay") && entry.Origin == "snapshot") entry.Origin = "event"; entry.Boundary = null; }
        if (snapshot != "" && index >= 0)
        {
            if (entry.Snapshots.TryGetValue(snapshot, out int previous) && previous != index) throw Error("duplicate_snapshot_item", key);
            entry.Snapshots[snapshot] = index; entry.SnapshotObserved = true; entry.Boundary = null;
        }
        if (created)
        {
            if (entry.Events.Count == 0 && !entry.SnapshotObserved && message.S("role") == "user" && (meta.S("submissionState") == "accepted" || meta.S("source") == "desktop"))
            {
                entry.Boundary = ledger.Entries.LastOrDefault()?.Key ?? "";
                foreach (var e in ledger.Entries) foreach (var (s, n) in e.Events) entry.Fences[s] = Math.Max(entry.Fences.GetValueOrDefault(s), n);
            }
            entry.Origin = entry.Events.Count > 0 ? "event" : entry.SnapshotObserved ? "snapshot" : entry.Boundary is not null ? "local" : "unknown";
            ledger.Entries.Add(entry);
        }
        if (snapshot != "") snapshots[threadTurn] = ledger;
        else { Materialize(ledger); ledgers[threadTurn] = ledger; Sync(ledger, tid, turn, messages.Append(message)); }
    }
    private static BridgeException Error(string code, string detail) => new("消息顺序证据冲突：" + detail, "message_order_" + code);
    private static int CompareEvents(Entry a, Entry b)
    {
        if (a.Origin != "event" || b.Origin != "event") return 0; int comparison = 0;
        foreach (var (s, n) in a.Events) if (b.Events.TryGetValue(s, out long other))
        { int c = Math.Sign(n - other); if (c == 0) throw Error("duplicate_event_seq", a.Key + " / " + b.Key); if (comparison != 0 && comparison != c) throw Error("event_conflict", s); comparison = c; }
        return comparison;
    }
    private static void Materialize(Ledger l)
    {
        var byKey = l.Entries.ToDictionary(e => e.Key); var edges = l.Entries.ToDictionary(e => e.Key, _ => new HashSet<string>()); var degree = l.Entries.ToDictionary(e => e.Key, _ => 0);
        void Edge(string? a, string? b) { if (a is null || b is null || a == b || !byKey.ContainsKey(a) || !byKey.ContainsKey(b)) return; if (edges[a].Add(b)) degree[b]++; }
        foreach (var e in l.Entries) if (e.Events.Count == 0 && !e.SnapshotObserved && e.Boundary is null) throw Error("missing_evidence", e.Key);
        var eventGroups = l.Entries.Where(e => e.Origin == "event").SelectMany(e => e.Events.Select(p => (Entry: e, Source: p.Key, Seq: p.Value))).GroupBy(x => x.Source).ToDictionary(x => x.Key, x => x.OrderBy(v => v.Seq).ToArray());
        foreach (var group in eventGroups.Values) for (int i = 1; i < group.Length; i++) { if (group[i - 1].Seq == group[i].Seq) throw Error("duplicate_event_seq", group[i].Source); Edge(group[i - 1].Entry.Key, group[i].Entry.Key); }
        foreach (var group in l.Entries.SelectMany(e => e.Snapshots.Select(p => (Entry: e, Source: p.Key, Index: p.Value))).GroupBy(x => x.Source))
        { var items = group.OrderBy(x => x.Index).ToArray(); for (int i = 1; i < items.Length; i++) { if (items[i - 1].Index == items[i].Index) throw Error("duplicate_snapshot_index", group.Key); if (CompareEvents(items[i - 1].Entry, items[i].Entry) == 0) Edge(items[i - 1].Entry.Key, items[i].Entry.Key); } }
        foreach (var (a, b) in l.Edges) if (byKey.TryGetValue(a, out var x) && byKey.TryGetValue(b, out var y) && CompareEvents(x, y) == 0) Edge(a, b);
        foreach (var e in l.Entries.Where(x => x.Boundary is not null))
        {
            Edge(e.Boundary, e.Key);
            foreach (var (s, fence) in e.Fences) if (eventGroups.TryGetValue(s, out var group))
            { Edge(group.LastOrDefault(x => x.Entry != e && x.Seq <= fence).Entry?.Key, e.Key); Edge(e.Key, group.FirstOrDefault(x => x.Entry != e && x.Seq > fence).Entry?.Key); }
        }
        var prior = l.Entries.Select((e, i) => (e.Key, i)).ToDictionary(x => x.Key, x => x.i); var ready = new PriorityQueue<Entry, int>();
        foreach (var e in l.Entries) if (degree[e.Key] == 0) ready.Enqueue(e, prior[e.Key]);
        var ordered = new List<Entry>(); while (ready.TryDequeue(out var e, out _)) { ordered.Add(e); foreach (var key in edges[e.Key]) if (--degree[key] == 0) ready.Enqueue(byKey[key], prior[key]); }
        if (ordered.Count != l.Entries.Count) throw Error("cycle", string.Join(',', degree.Where(x => x.Value > 0).Select(x => x.Key)));
        l.Entries = ordered;
    }
    private static void Sync(Ledger l, string tid, string turn, IEnumerable<JsonObject> messages)
    {
        var entries = l.Entries.Select((e, i) => (Entry: e, Index: i)).ToDictionary(x => x.Entry.Key);
        foreach (var m in messages) if (Thread(m) == tid && Turn(m) == turn && entries.TryGetValue(Key(m), out var e))
        { var meta = m.G("meta") as JsonObject; if (meta is null) m["meta"] = meta = new(); meta["canonicalOrderKey"] = e.Entry.Key; meta["canonicalOrdinal"] = e.Index; meta["canonicalOrderOrigin"] = e.Entry.Origin; }
    }
    public void Commit(string tid, string turn, string snapshot, IEnumerable<JsonObject> messages)
    {
        if (!snapshots.Remove((tid, turn), out var l)) { if (!ledgers.TryGetValue((tid, turn), out l)) return; l = l.Clone(); }
        var group = l.Entries.Where(e => e.Snapshots.ContainsKey(snapshot)).OrderBy(e => e.Snapshots[snapshot]).ToArray();
        l.Edges.Clear(); for (int i = 1; i < group.Length; i++) l.Edges.Add((group[i - 1].Key, group[i].Key));
        foreach (var e in l.Entries) e.Snapshots.Remove(snapshot);
        Materialize(l); ledgers[(tid, turn)] = l; Sync(l, tid, turn, messages);
    }
    public void Remove(JsonObject m)
    {
        var k = (Thread(m), Turn(m)); if (!ledgers.TryGetValue(k, out var l)) return; string key = Key(m);
        var before = l.Edges.Where(x => x.Item2 == key).Select(x => x.Item1).ToArray(); var after = l.Edges.Where(x => x.Item1 == key).Select(x => x.Item2).ToArray();
        l.Entries.RemoveAll(x => x.Key == key); l.Edges.RemoveWhere(x => x.Item1 == key || x.Item2 == key);
        foreach (var a in before) foreach (var b in after) if (a != b) l.Edges.Add((a, b));
        if (l.Entries.Count == 0) ledgers.Remove(k);
    }
}
