using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed class PhoneSession(BridgeRuntime bridge, JsonSocket socket)
{
    private sealed record Frame(string Message, int Offset, long SentAt);
    private readonly Dictionary<string, int> offsets = [], sentOffsets = [];
    private readonly Dictionary<long, Frame> frames = [];
    private readonly HashSet<string> completing = [], completed = [];
    private readonly List<string> pending = [];
    private readonly Dictionary<string, int> limits = [];
    private readonly Dictionary<string, string> anchors = [];
    private readonly HashSet<string> expanded = [];
    private readonly Dictionary<string, long> toolThrottle = [];
    private readonly Dictionary<string, string> messageKeys = [];
    private readonly Dictionary<string, string> fieldKeys = [];
    private List<string> sentIds = [];
    private long sentRevision = -1, nextFrame = 1;
    private int windowSize = 1, fastAcks;
    private bool stateAfterStream;
    public string ThreadId = "", Lane = "new:" + J.Id();
    public bool FollowDesktop = true, Background, NeedsFull, HasState;
    public long Revision, LastActivity = J.Now, LastSequence, OpenSequence;
    public JsonObject? PendingOptions;
    public Task<JsonObject>? Creating;
    public bool Open => socket.Open;
    public void Close() => socket.Dispose();
    public bool Send(JsonObject value)
    {
        if (!Open) return false;
        string type = value.S("type"); bool priority = type == "error" || type.StartsWith("stream:", StringComparison.Ordinal) || type.EndsWith(":result", StringComparison.Ordinal);
        if (!priority && socket.QueuedBytes > Configuration.Int("CODEX_PHONE_WS_CONGESTION_BYTES", 512 * 1024, 128 * 1024)) { NeedsFull = true; return false; }
        return socket.Send(value);
    }
    public void Reset() { HasState = false; messageKeys.Clear(); fieldKeys.Clear(); sentIds.Clear(); ResetStreams([]); }
    public List<JsonObject> Window(List<JsonObject> source)
    {
        bool more = expanded.Contains(ThreadId); int start = more && anchors.TryGetValue(ThreadId, out var anchor) ? source.FindIndex(x => x.S("id") == anchor) : -1;
        int requested = more ? Math.Min(bridge.Config.MaxMessages, Math.Max(bridge.Config.InitialLimit, limits.GetValueOrDefault(ThreadId))) : bridge.Config.InitialLimit;
        if (start < 0) start = Math.Max(0, source.Count - requested); else start = Math.Max(start, source.Count - bridge.Config.MaxMessages);
        if (start < source.Count) anchors[ThreadId] = source[start].S("id"); limits[ThreadId] = more ? Math.Max(requested, source.Count - start) : bridge.Config.InitialLimit;
        var pinned = source.Skip(start).Select(MessageOrder.Turn).Where(t => t != "").ToHashSet(); if (source.Count > 0) pinned.Add(MessageOrder.Turn(source[^1])); pinned.Add(bridge.ReadRuntime(ThreadId).Turn);
        return source.Where((m, i) => i >= start || m.S("kind") is "plan" or "turn_diff" && pinned.Contains(MessageOrder.Turn(m))).ToList();
    }
    public void More()
    {
        var source = bridge.Messages.ForThread(ThreadId); Window(source); int start = anchors.TryGetValue(ThreadId, out var id) ? source.FindIndex(m => m.S("id") == id) : source.Count;
        start = Math.Max(0, start - bridge.Config.PageSize); expanded.Add(ThreadId); if (start < source.Count) anchors[ThreadId] = source[start].S("id"); limits[ThreadId] = Math.Min(bridge.Config.MaxMessages, Math.Max(bridge.Config.InitialLimit, limits.GetValueOrDefault(ThreadId)) + bridge.Config.PageSize);
    }
    private static string Signature(JsonObject m) { var copy = m.Obj(); copy.Remove("revision"); copy.Remove("updatedAt"); copy.Remove("textHash"); return J.Canonical(copy); }
    public bool SendState(bool full = false)
    {
        if (!Open) return false; if (Background) { NeedsFull = true; return false; }
        full |= NeedsFull || !HasState;
        if (!full && socket.QueuedBytes > 512 * 1024) { NeedsFull = true; return false; }
        if (!full && completing.Count > 0 && sentRevision != Revision) { stateAfterStream = true; return false; }
        var state = bridge.State(this); var messages = state.Arr("messages").OfType<JsonObject>().ToArray();
        if (full || sentRevision != Revision)
        {
            if (!Send(J.O(("type", "state"), ("state", state)))) { NeedsFull = true; return false; }
            NeedsFull = false; HasState = true; sentRevision = Revision; RememberState(state, messages); ResetStreams(messages); return true;
        }
        var patch = new JsonObject();
        foreach (var (k, v) in state.Where(x => x.Key != "messages")) { string key = J.Canonical(v); if (fieldKeys.GetValueOrDefault(k) != key) { patch.Set(k, v); fieldKeys[k] = key; } }
        var known = messages.Where(m => (!StreamingText(m) && !completing.Contains(m.S("id"))) || messageKeys.ContainsKey(m.S("id"))).ToArray();
        var ids = known.Select(m => m.S("id")).ToList(); var items = new JsonArray();
        foreach (var m in known)
        {
            string id = m.S("id"), signature = Signature(m);
            if (completing.Contains(id) || StreamingText(m) || completed.Contains(id) && AssistantText(m)) continue;
            if (messageKeys.GetValueOrDefault(id) == signature) continue;
            if (m.B("streaming") && m.S("role") == "tool") { if (toolThrottle.GetValueOrDefault(id) > J.Now) continue; toolThrottle[id] = J.Now + 500; }
            items.Add(m.DeepClone()); messageKeys[id] = signature;
        }
        var delta = new JsonObject(); if (!sentIds.SequenceEqual(ids)) delta["ids"] = J.Strings(ids); if (items.Count > 0) delta["items"] = items;
        if (delta.Count > 0) patch["messages"] = delta;
        if (patch.Count == 0) return true;
        if (!Send(J.O(("type", "state:patch"), ("patch", patch)))) { NeedsFull = true; return false; }
        sentIds = ids; foreach (string key in messageKeys.Keys.Where(k => !ids.Contains(k)).ToArray()) messageKeys.Remove(key); return true;
    }
    private void RememberState(JsonObject state, IEnumerable<JsonObject> messages)
    {
        fieldKeys.Clear(); foreach (var (k, v) in state.Where(x => x.Key != "messages")) fieldKeys[k] = J.Canonical(v);
        messageKeys.Clear(); foreach (var m in messages) messageKeys[m.S("id")] = Signature(m); sentIds = messages.Select(m => m.S("id")).ToList();
    }
    private void ResetStreams(IEnumerable<JsonObject> messages)
    {
        offsets.Clear(); sentOffsets.Clear(); frames.Clear(); pending.Clear(); completing.Clear(); completed.Clear(); windowSize = 1; fastAcks = 0; stateAfterStream = false;
        foreach (var m in messages) if (StreamingText(m)) { offsets[m.S("id")] = m.S("text").Length; sentOffsets[m.S("id")] = m.S("text").Length; } else if (AssistantText(m)) completed.Add(m.S("id"));
    }
    public static bool AssistantText(JsonNode m) => m.S("role") == "assistant" && m.S("kind") == "text";
    public static bool StreamingText(JsonNode m) => AssistantText(m) && m.B("streaming");
    private bool CanStream(JsonNode m) => Open && HasState && !Background && MessageOrder.Thread(m) == ThreadId;
    public void Publish(JsonObject m)
    {
        if (!StreamingText(m) || !CanStream(m)) return; string id = m.S("id"); completed.Remove(id); Enqueue(id); FlushStreams();
    }
    public void Complete(JsonObject m, bool allowNew = false)
    {
        string id = m.S("id"); if (!CanStream(m) || !AssistantText(m) || completed.Contains(id)) return;
        if (!allowNew && !offsets.ContainsKey(id) && !frames.Values.Any(x => x.Message == id) && !pending.Contains(id)) return;
        completing.Add(id); Enqueue(id); FlushStreams();
    }
    private void Enqueue(string id) { if (!pending.Contains(id)) pending.Add(id); }
    public void Ack(JsonNode ack)
    {
        long frameId = ack.N("frameId"); string id = ack.S("messageId"); int offset = (int)ack.N("offset", -1);
        if (!frames.TryGetValue(frameId, out var frame) || frame.Message != id || offset < 0) return;
        var m = bridge.Messages.Get(id); if (m is null || offset > m.S("text").Length) return;
        if (ack.G("ok")?.ToString() == "false")
        { offsets[id] = offset; sentOffsets[id] = offset; windowSize = 1; fastAcks = 0; foreach (var key in frames.Where(x => x.Value.Message == id).Select(x => x.Key).ToArray()) frames.Remove(key); }
        else if (offset == frame.Offset) { offsets[id] = Math.Max(offsets.GetValueOrDefault(id), offset); fastAcks = J.Now - frame.SentAt <= 150 ? fastAcks + 1 : 0; if (fastAcks >= 2) windowSize = 4; }
        else return;
        frames.Remove(frameId);
        if (CanStream(m) && (StreamingText(m) || completing.Contains(id)))
        { if (offset < m.S("text").Length || frames.Values.Any(x => x.Message == id)) Enqueue(id); else if (completing.Contains(id)) FinishStream(m); }
        FlushStreams();
    }
    public void FlushStreams()
    {
        if (!Open || Background || !HasState) return;
        if (frames.Values.Any(f => J.Now - f.SentAt > 15000)) { NeedsFull = true; SendState(true); return; }
        while (pending.Count > 0 && frames.Count < windowSize)
        {
            string id = pending[0]; pending.RemoveAt(0); var m = bridge.Messages.Get(id);
            if (m is null || !CanStream(m) || !StreamingText(m) && !completing.Contains(id)) { offsets.Remove(id); completing.Remove(id); continue; }
            string text = m.S("text"); int offset = Math.Max(offsets.GetValueOrDefault(id), sentOffsets.GetValueOrDefault(id)); if (offset > text.Length) offset = 0;
            if (offset == text.Length) { if (completing.Contains(id) && !frames.Values.Any(x => x.Message == id)) FinishStream(m); continue; }
            int length = Math.Min(16384, text.Length - offset); if (length > 1 && offset + length < text.Length && char.IsHighSurrogate(text[offset + length - 1])) length--;
            long fid = nextFrame++; var value = J.O(("type", "stream:append"), ("threadId", ThreadId), ("turnId", MessageOrder.Turn(m)), ("messageId", id), ("frameId", fid), ("revision", m.N("revision")), ("offset", offset), ("delta", text.Substring(offset, length)));
            if (offset == 0)
            {
                var source = bridge.Messages.ForThread(ThreadId); int index = source.FindIndex(x => x.S("id") == id); string after = source.Take(Math.Max(0, index)).LastOrDefault(x => sentIds.Contains(x.S("id")))?.S("id") ?? ""; string before = source.Skip(index + 1).FirstOrDefault(x => sentIds.Contains(x.S("id")))?.S("id") ?? "";
                value["afterId"] = after; value["beforeId"] = before; value["message"] = bridge.Compact(m, true);
                if (!sentIds.Contains(id)) { int at = before != "" ? sentIds.IndexOf(before) : after != "" ? sentIds.IndexOf(after) + 1 : sentIds.Count; sentIds.Insert(at, id); }
                messageKeys[id] = Signature(bridge.Compact(m));
            }
            if (!Send(value)) { Enqueue(id); return; }
            sentOffsets[id] = offset + length; frames[fid] = new(id, offset + length, J.Now);
            if (offset + length < text.Length) Enqueue(id);
        }
    }
    private void FinishStream(JsonObject m)
    {
        string id = m.S("id"); if (!completing.Contains(id)) return;
        if (!Send(J.O(("type", "stream:complete"), ("threadId", ThreadId), ("turnId", MessageOrder.Turn(m)), ("messageId", id), ("revision", m.N("revision")), ("offset", m.S("text").Length), ("textHash", J.TextHash(m.S("text"))), ("message", bridge.Compact(m, true))))) return;
        completing.Remove(id); completed.Add(id); offsets.Remove(id); sentOffsets.Remove(id); pending.Remove(id); messageKeys[id] = Signature(bridge.Compact(m));
        if (completing.Count == 0 && stateAfterStream) { stateAfterStream = false; SendState(); }
    }
}
