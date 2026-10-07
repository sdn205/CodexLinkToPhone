using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodexPhoneBridge;

// thread/turns/list reconstructs agent/reasoning items with positional item-N IDs.
// The rollout pairs each display event with its original response_item. Resolve that
// durable relationship here, before any snapshot enters the live message store.
// Text is an integrity check of two persisted views, never a live-message identity.
internal sealed class HistoryIdentity
{
    private sealed class Entry(string kind, string text, string phase, long position)
    {
        public string Kind = kind, Text = text, Phase = phase, SourceId = "";
        public long Position = position;
        public bool Response;
    }
    private sealed class Turn
    {
        public List<Entry> Items = [];
        public bool Completed;
    }
    private sealed class Index(string path)
    {
        public string Path = path, Session = "", CurrentTurn = "";
        public long Offset;
        public DateTime Created;
        public Dictionary<string, Turn> Turns = [];
        public List<string> Order = [];
        public void Reset() { Offset = 0; Session = ""; CurrentTurn = ""; Turns.Clear(); Order.Clear(); }
        private Turn Current()
        {
            if (!Turns.TryGetValue(CurrentTurn, out var turn)) { Turns[CurrentTurn] = turn = new(); Order.Add(CurrentTurn); }
            return turn;
        }
        public void Consume(JsonNode row, long position)
        {
            var p = row.G("payload"); string type = p.S("type");
            if (row.S("type") == "session_meta") { Session = p.S("id"); return; }
            if (row.S("type") == "turn_context" && p.S("turn_id") != "") { CurrentTurn = p.S("turn_id"); return; }
            if (row.S("type") == "event_msg")
            {
                if (type == "task_started") { CurrentTurn = p.S("turn_id"); if (CurrentTurn != "") Current().Completed = false; return; }
                if (type == "thread_rolled_back")
                {
                    int count = Math.Clamp((int)p.N("num_turns"), 0, Order.Count);
                    foreach (string id in Order.TakeLast(count).ToArray()) Turns.Remove(id);
                    Order.RemoveRange(Order.Count - count, count); CurrentTurn = ""; return;
                }
                if (CurrentTurn == "") return;
                if (type is "task_complete" or "turn_aborted") { Current().Completed = true; return; }
                if (type == "agent_message") Current().Items.Add(new("agentMessage", p.S("message"), p.S("phase"), position));
                if (type == "agent_reasoning") Current().Items.Add(new("reasoning", p.S("text"), "", position));
                return;
            }
            if (row.S("type") != "response_item" || CurrentTurn == "") return;
            string kind = type == "message" && p.S("role") == "assistant" ? "agentMessage" : type == "reasoning" ? "reasoning" : "";
            if (kind == "") return;
            // Empty encrypted reasoning has no display event and no historical item.
            var entries = Current().Items.Where(x => x.Kind == kind && !x.Response).ToArray();
            if (entries.Length == 0) return;
            // One reasoning response may contain several display summary parts.
            // Conversely, history may combine consecutive responses into one item.
            foreach (var entry in kind == "reasoning" ? entries : entries.TakeLast(1))
            {
                if (kind == "agentMessage" && entry.Phase != p.S("phase")) throw Pending("response phase differs from its display event");
                entry.SourceId = p.S("id"); entry.Response = true;
            }
        }
        public void Refresh()
        {
            var info = new FileInfo(Path);
            if (!info.Exists) throw Pending("rollout is not available");
            if (Offset > info.Length || Created != default && Created != info.CreationTimeUtc) Reset();
            Created = info.CreationTimeUtc;
            using var stream = new FileStream(Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            stream.Position = Offset;
            using var line = new MemoryStream();
            byte[] buffer = new byte[65536]; long position = Offset, lineStart = Offset;
            int size;
            while ((size = stream.Read(buffer)) > 0)
            {
                for (int i = 0; i < size; i++)
                {
                    position++;
                    if (buffer[i] != (byte)'\n') { line.WriteByte(buffer[i]); continue; }
                    string text = Encoding.UTF8.GetString(line.GetBuffer(), 0, checked((int)line.Length)).TrimEnd('\r');
                    if (text.Length != 0) Consume(J.Parse(text) ?? throw Pending("empty rollout record"), lineStart);
                    line.SetLength(0); Offset = position; lineStart = position;
                }
            }
            // A writer can be between the display event and response_item or halfway
            // through a UTF-8 line. Only newline-committed records advance the cursor.
        }
    }
    private readonly Dictionary<string, Index> indexes = [];
    public void Register(string tid, string path)
    {
        if (tid == "" || path == "") return;
        path = System.IO.Path.GetFullPath(path);
        if (!indexes.TryGetValue(tid, out var index) || !string.Equals(index.Path, path, StringComparison.OrdinalIgnoreCase)) indexes[tid] = new(path);
    }
    public void Forget(string tid) => indexes.Remove(tid);
    private static bool Generated(string id) => Regex.IsMatch(id, "^item-\\d+$", RegexOptions.CultureInvariant);
    private static BridgeException Pending(string detail) => new("历史消息身份尚未就绪：" + detail, "history_identity_pending");
    public IReadOnlyList<JsonObject> Resolve(string tid, string turnId, IEnumerable<JsonNode> source)
    {
        var items = source.Select(x => x.Obj()).ToArray();
        bool requiresIndex = items.Any(x => x.S("type") is "agentMessage" or "reasoning" && Generated(x.S("id")));
        if (!requiresIndex) return items;
        if (!indexes.TryGetValue(tid, out var index)) throw Pending("thread has no rollout path");
        index.Refresh();
        if (index.Session != tid) throw new BridgeException("历史文件的会话身份不一致", "history_identity_scope");
        if (!index.Turns.TryGetValue(turnId, out var turn)) throw Pending("turn has not been committed");
        var offsets = new Dictionary<string, int>(); var resolved = new List<JsonObject>();
        foreach (var item in items)
        {
            string kind = item.S("type");
            if (kind is not ("agentMessage" or "reasoning")) { resolved.Add(item); continue; }
            var parts = kind == "reasoning"
                ? item.Arr("summary").Select(x => (Text: x.Text(), Field: "summary")).Concat(item.Arr("content").Select(x => (Text: x.Text(), Field: "content"))).ToArray()
                : new[] { (Text: item.S("text"), Field: "text") };
            int slot = offsets.GetValueOrDefault(kind); offsets[kind] = slot + parts.Length;
            if (!Generated(item.S("id"))) { resolved.Add(item); continue; }
            var occurrences = turn.Items.Where(x => x.Kind == kind).Skip(slot).Take(parts.Length).ToArray();
            if (occurrences.Length != parts.Length || occurrences.Any(x => !x.Response && !turn.Completed)) throw Pending("display event is awaiting its original identity");
            JsonObject? current = null;
            for (int part = 0; part < parts.Length; part++)
            {
                var entry = occurrences[part];
                if (parts[part].Text != entry.Text || kind == "agentMessage" && item.S("phase") != entry.Phase)
                    throw new BridgeException($"历史消息记录不一致：{tid}/{turnId}/{kind}/{slot + part}", "history_identity_conflict");
                // ID-less old durable records have a stable, scoped record address.
                string sourceId = entry.SourceId != "" ? entry.SourceId : "rollout:" + entry.Position;
                if (current is null || current.S("id") != sourceId)
                {
                    current = item.Obj(); current["historyItemId"] = item.S("id"); current["id"] = sourceId;
                    current["sourceCompleted"] = true; current["historyRecordPosition"] = entry.Position;
                    if (kind == "reasoning") { current["summary"] = new JsonArray(); current["content"] = new JsonArray(); }
                    resolved.Add(current);
                }
                if (kind == "reasoning") current.G(parts[part].Field)!.AsArray().AddNode(JsonValue.Create(parts[part].Text));
            }
        }
        return resolved;
    }
}
