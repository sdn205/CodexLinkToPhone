using System.Text.Json;
using CodexPhoneProxy.Protocol;

namespace CodexPhoneProxy.Proxy;

internal sealed class ReplayHistory(int maxCount, int maxBytes)
{
    private sealed record Entry(long Sequence, byte[] Data, bool Replayable);
    private readonly Queue<Entry> entries = new();
    private long totalBytes;
    private long droppedBefore;
    public long Sequence { get; private set; }
    public byte[] Record(JsonElement payload)
    {
        var sequence = ++Sequence;
        var data = Json.EncodeWithSequence(payload, sequence);
        Store(sequence, data, payload.Str("type"));
        return data;
    }
    public byte[] RecordNotification(JsonElement notification)
    {
        var sequence = ++Sequence;
        var data = Json.EncodeObject(("type", "notification"), ("notification", notification), ("seq", sequence));
        Store(sequence, data, "notification");
        return data;
    }
    private void Store(long sequence, byte[] data, string type)
    {
        if (data.Length > maxBytes) { droppedBefore = Math.Max(droppedBefore, sequence); return; }
        entries.Enqueue(new(sequence, data, type is "notification" or "stdio-request" or "stdio-response" or "server-request"));
        totalBytes += data.Length;
        while (entries.Count > maxCount || totalBytes > maxBytes)
        {
            var removed = entries.Dequeue();
            totalBytes -= removed.Data.Length;
            droppedBefore = Math.Max(droppedBefore, removed.Sequence);
        }
    }
    public JsonElement Snapshot(JsonElement request, IEnumerable<(long Sequence, JsonElement Request)> pending)
    {
        var after = request.Get("afterSeq");
        var hasAfter = after.ValueKind is JsonValueKind.Number or JsonValueKind.String && after.Number(-1) >= 0;
        var cursor = after.Number();
        var oldest = entries.TryPeek(out var first) ? first.Sequence : Sequence + 1;
        var dropped = Math.Max(oldest - 1, droppedBefore);
        var selected = entries.Where(entry => entry.Replayable && (!hasAfter || entry.Sequence > cursor))
            .Select(entry => (entry.Sequence, entry.Data)).ToList();
        var included = selected.Select(entry => entry.Sequence).ToHashSet();
        foreach (var entry in pending)
            if ((!hasAfter || entry.Sequence == 0 || entry.Sequence > cursor) && !included.Contains(entry.Sequence))
                selected.Add((entry.Sequence, Json.Encode(Json.Obj(("type", "server-request"), ("request", entry.Request), ("seq", entry.Sequence)))));
        selected.Sort((a, b) => a.Sequence.CompareTo(b.Sequence));
        var events = Json.Build(writer =>
        {
            writer.WriteStartArray();
            foreach (var entry in selected) writer.WriteRawValue(entry.Data, skipInputValidation: true);
            writer.WriteEndArray();
        });
        return Json.Obj(("type", "history"), ("events", events), ("requestedAfterSeq", hasAfter ? cursor : null),
            ("oldestAvailableSeq", oldest <= Sequence ? oldest : null), ("newestAvailableSeq", Sequence),
            ("droppedBeforeSeq", dropped), ("truncated", (hasAfter ? cursor : 0) < dropped), ("complete", true));
    }
}
