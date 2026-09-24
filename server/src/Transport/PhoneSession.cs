using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

// One committed baseline per selection. Changes received during delivery are
// coalesced in the store and projected only after the previous delivery commits.
internal sealed class PhoneSession(BridgeRuntime bridge, JsonSocket socket)
{
    private readonly Dictionary<string, int> limits = [];
    private readonly Dictionary<string, string> anchors = [];
    private readonly HashSet<string> expanded = [];
    private CancellationTokenSource selection = new();
    private JsonObject? delivered;
    private bool dirty, sending, catalogSending, fullRequested;
    private string catalogKey = "";
    private long nextFrame;
    public string ThreadId = "", Lane = "new:" + J.Id();
    public bool FollowDesktop = true, Background;
    public long Revision, LastActivity = J.Now, LastSequence, OpenSequence;
    public JsonObject? PendingOptions;
    public Task<JsonObject>? Creating;
    public bool Open => socket.Open;
    public void Close() { selection.Cancel(); socket.Dispose(); }
    public Task<bool> SendResult(JsonObject value) => socket.SendReliable(value);
    public void Reset()
    {
        selection.Cancel(); selection.Dispose(); selection = new(); delivered = null; dirty = true;
    }
    public void Pump() { if (dirty) SendState(); }
    public bool SendState(bool full = false)
    {
        if (!Open) return false;
        dirty = true;
        fullRequested |= full;
        if (!catalogSending) EventLoop.Observe(SendCatalog());
        if (!Background && !sending) EventLoop.Observe(DeliverState());
        return true;
    }
    private async Task SendCatalog()
    {
        catalogSending = true;
        try
        {
            while (Open)
            {
                var catalog = bridge.Catalog(); string key = J.Canonical(catalog);
                if (key == catalogKey) break;
                if (!await socket.SendReliable(J.O(("type", "state:catalog"), ("state", catalog)))) break;
                catalogKey = key;
            }
        }
        finally { catalogSending = false; }
    }
    private async Task DeliverState()
    {
        sending = true;
        try
        {
            await Task.Yield();
            while (Open && !Background && dirty)
            {
                dirty = false; long revision = Revision; var token = selection.Token;
                bool snapshot = fullRequested || delivered is null; fullRequested = false;
                var next = bridge.State(this);
                if (delivered is not null)
                {
                    var received = delivered.Arr("messages").ToDictionary(m => m.S("id"));
                    foreach (var m in next.Arr("messages").OfType<JsonObject>())
                    {
                        var before = received.GetValueOrDefault(m.S("id"));
                        if (before is null || before.B("textTruncated") || !m.B("textTruncated")) continue;
                        string text = bridge.Messages.Get(m.S("id")).S("text");
                        if (before.S("textHash") == m.S("textHash") || StreamingText(before) && text.StartsWith(before.S("text"), StringComparison.Ordinal))
                        { m["text"] = text; m["textTruncated"] = false; }
                    }
                }
                var frames = snapshot ? new List<JsonObject> { J.O(("type", "state"), ("state", next)) } : Changes(delivered!, next);
                bool complete = true;
                foreach (var frame in frames)
                    if (!await socket.Deliver(frame, token)) { complete = false; break; }
                if (complete && revision == Revision && !token.IsCancellationRequested) delivered = next;
            }
        }
        finally { sending = false; }
    }
    private static string Signature(JsonNode? value)
    {
        var copy = value.Obj(); copy.Remove("revision"); copy.Remove("updatedAt"); return J.Canonical(copy);
    }
    private static string StreamMetadata(JsonNode value)
    {
        var copy = value.Obj();
        foreach (var key in new[] { "text", "textHash", "originalLength", "textTruncated", "revision", "updatedAt", "streaming" }) copy.Remove(key);
        return J.Canonical(copy);
    }
    private List<JsonObject> Changes(JsonObject previous, JsonObject next)
    {
        var frames = new List<JsonObject>(); var items = new JsonArray(); var streams = new List<JsonObject>();
        var oldMessages = previous.Arr("messages").ToDictionary(m => m.S("id"));
        var messages = next.Arr("messages").OfType<JsonObject>().ToArray();
        foreach (var message in messages)
        {
            string id = message.S("id"); var old = oldMessages.GetValueOrDefault(id);
            if (old is not null && !old.B("textTruncated") && message.B("textTruncated") && old.S("textHash") == message.S("textHash"))
            {
                message["text"] = old.S("text"); message["textTruncated"] = false;
            }
            if (old is not null && AssistantText(message) && old.B("streaming"))
            {
                // A completed compact projection must not replace text that this
                // client already received while the answer was streaming.
                var raw = bridge.Messages.Get(id); string text = raw.S("text"), before = old.S("text");
                if (text.StartsWith(before, StringComparison.Ordinal))
                {
                    message["text"] = text; message["textTruncated"] = false;
                    message["originalLength"] = text.Length; message["textHash"] = J.TextHash(text);
                    if (message.B("streaming") && StreamMetadata(old) != StreamMetadata(message))
                    {
                        items.Add(message.DeepClone()); continue;
                    }
                    if (text.Length > before.Length)
                        streams.Add(J.O(("type", "stream:append"), ("threadId", ThreadId), ("turnId", MessageOrder.Turn(message)),
                            ("messageId", id), ("frameId", ++nextFrame), ("revision", message.N("revision")),
                            ("offset", before.Length), ("delta", text[before.Length..])));
                    if (!message.B("streaming"))
                    {
                        var metadata = message.Obj(); metadata.Remove("text");
                        streams.Add(J.O(("type", "stream:complete"), ("threadId", ThreadId), ("turnId", MessageOrder.Turn(message)),
                            ("messageId", id), ("revision", message.N("revision")), ("offset", text.Length), ("textHash", J.TextHash(text)), ("message", metadata)));
                    }
                    continue;
                }
            }
            if (old is null || Signature(old) != Signature(message))
            {
                var update = message.Obj();
                if (old is not null && old.S("text") == message.S("text")) update.Remove("text");
                items.AddNode(update);
            }
        }
        var ids = messages.Select(m => m.S("id")).ToArray();
        var delta = new JsonObject();
        if (!previous.Arr("messages").Select(m => m.S("id")).SequenceEqual(ids)) delta["ids"] = J.Strings(ids);
        if (items.Count > 0) delta["items"] = items;
        var fields = new JsonObject();
        foreach (var (key, value) in next.Where(p => p.Key != "messages"))
            if (J.Canonical(previous.G(key)) != J.Canonical(value)) fields.Set(key, value);
        if (delta.Count > 0) fields["messages"] = delta;
        if (fields.Count > 0) frames.Add(J.O(("type", "state:patch"), ("patch", fields)));
        frames.AddRange(streams);
        return frames;
    }
    public static bool AssistantText(JsonNode m) => m.S("role") == "assistant" && m.S("kind") == "text";
    public static bool StreamingText(JsonNode m) => AssistantText(m) && m.B("streaming");
    public void Publish(JsonObject message) { if (MessageOrder.Thread(message) == ThreadId) SendState(); }
    public void Complete(JsonObject message, bool allowNew = false) { if (MessageOrder.Thread(message) == ThreadId) SendState(); }
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
}
