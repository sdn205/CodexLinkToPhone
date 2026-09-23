using System.Security.Cryptography;
using System.Text.Json;
using CodexPhoneProxy.Protocol;

namespace CodexPhoneProxy.Proxy;

// Deterministic desktop presentation only; canonical upstream messages stay intact.
internal sealed class ForwardProjection(int byteLimit)
{
    private sealed class Request(string method, string threadId, string clientId, JsonElement input, string turnId)
    {
        public string Method = method, ThreadId = threadId, ClientId = clientId, TurnId = turnId;
        public JsonElement Input = input.Clone();
        public byte[] InputKey = ContentKey(input);
        public int Bytes = Json.Encode(input).Length;
        public bool DisplayInjected;
    }
    private readonly Dictionary<string, Request> requests = new();
    private readonly LinkedList<string> order = new();
    private long bytes;
    private static byte[] ContentKey(JsonElement input) => SHA1.HashData(Json.Encode(input.Present() ? input : Json.Null));
    private static string ClientId(JsonElement item) => First(item.Str("clientId"), item.Str("clientUserMessageId")).Trim();
    private static string Key(string thread, string client) => thread + "\n" + client;
    private static string First(string a, string b) => a.Length > 0 ? a : b;

    public void Remember(string method, JsonElement parameters)
    {
        if (method is not ("turn/start" or "turn/steer")) return;
        var threadId = parameters.Str("threadId").Trim();
        var clientId = parameters.Str("clientUserMessageId").Trim();
        var input = parameters.Get("input");
        if (threadId.Length == 0 || clientId.Length == 0 || input.ValueKind != JsonValueKind.Array) return;
        var key = Key(threadId, clientId);
        Remove(key);
        var request = new Request(method, threadId, clientId, input, parameters.Str("expectedTurnId"));
        requests[key] = request;
        order.AddLast(key);
        bytes += request.Bytes;
        while (requests.Count > 1000 || (bytes > byteLimit && requests.Count > 1)) Remove(order.First!.Value);
    }
    public void ObserveResponse(JsonElement parameters, JsonElement response)
    {
        var key = Key(parameters.Str("threadId"), parameters.Str("clientUserMessageId"));
        if (!requests.TryGetValue(key, out var request)) return;
        if (response.Get("error").Present()) { Remove(key); return; }
        request.TurnId = First(response.Get("result").Get("turn").Str("id"), First(response.Get("result").Str("turnId"), request.TurnId));
    }
    private void Remove(string key)
    {
        if (!requests.Remove(key, out var request)) return;
        bytes -= request.Bytes;
        order.Remove(key);
    }
    public JsonElement LiveProjection(JsonElement notification)
    {
        var method = notification.Str("method");
        if (method is not ("item/started" or "item/completed")) return default;
        var parameters = notification.Get("params");
        var item = parameters.Get("item");
        if (item.Str("type") is not ("userMessage" or "steeringUserMessage")) return default;
        var key = Key(parameters.Str("threadId"), ClientId(item));
        if (!requests.TryGetValue(key, out var request)) return default;
        var turn = parameters.Str("turnId");
        if (turn.Length > 0 && request.TurnId.Length > 0 && turn != request.TurnId) return default;
        var content = item.Has("content") ? item.Get("content") : item.Get("input");
        if (!ContentKey(content).AsSpan().SequenceEqual(request.InputKey)) return default;
        if (item.Str("type") == "steeringUserMessage") { request.DisplayInjected = true; return default; }
        if (request.TurnId.Length == 0) request.TurnId = turn;
        JsonElement projection = default;
        if (request.Method == "turn/steer" && !request.DisplayInjected)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var steering = Steering(request.ThreadId, First(turn, request.TurnId), request.ClientId, request.Input, item,
                method == "item/started" ? item.Get("userMessageOrderAt").Number(now) : now, "pending");
            projection = Json.Obj(("method", "item/started"), ("params", Json.Obj(("threadId", request.ThreadId),
                ("turnId", First(turn, request.TurnId)), ("startedAtMs", now), ("item", steering))));
            request.DisplayInjected = true;
        }
        if (method == "item/completed") Remove(key);
        return projection;
    }
    private static JsonElement Steering(string threadId, string turnId, string clientId, JsonElement input,
        JsonElement source, long createdAt, string status)
    {
        var identity = First(clientId, source.Str("id"));
        if (identity.Length == 0) return default;
        var id = "phone-steering-" + identity;
        if (input.ValueKind != JsonValueKind.Array) input = Json.EmptyArray;
        var contents = input.Items().ToArray();
        return Json.Obj(("id", id), ("type", "steeringUserMessage"), ("targetTurnId", turnId.Length > 0 ? turnId : null),
            ("targetTurnStartedAtMs", null), ("status", status), ("clientUserMessageId", clientId.Length > 0 ? clientId : null),
            ("input", input), ("attachments", source.Get("attachments").ValueKind == JsonValueKind.Array ? source.Get("attachments") : Json.EmptyArray),
            ("restoreMessage", Json.Obj(("id", id), ("createdAt", createdAt > 0 ? createdAt : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
                ("context", Json.Obj(("commentAttachments", source.Get("commentAttachments").ValueKind == JsonValueKind.Array ? source.Get("commentAttachments") : Json.EmptyArray))))),
            ("compareKey", Json.Obj(("rawText", string.Join("\n", contents.Where(entry => entry.Str("type") == "text").Select(entry => entry.Str("text")))),
                ("imageCount", contents.Count(entry => entry.Str("type") is "image" or "localImage")))),
            ("threadId", threadId.Length > 0 ? (object)threadId : default(JsonElement)));
    }
    public JsonElement DecorateResponse(string method, JsonElement response)
    {
        var result = response.Get("result");
        if (response.Get("error").Present() || result.ValueKind != JsonValueKind.Object) return response;
        var decorated = result;
        if (result.Get("thread").ValueKind == JsonValueKind.Object)
        {
            var thread = result.Get("thread");
            var turns = DecorateTurns(thread.Get("turns"));
            if (turns.Present()) decorated = Json.With(decorated, ("thread", Json.With(thread, ("turns", turns))));
        }
        var page = result.Get("initialTurnsPage");
        if (page.ValueKind == JsonValueKind.Object)
        {
            var turns = DecorateTurns(page.Get("data"));
            if (turns.Present()) decorated = Json.With(decorated, ("initialTurnsPage", Json.With(page, ("data", turns))));
        }
        if (method == "thread/turns/list")
        {
            var turns = DecorateTurns(result.Get("data"));
            if (turns.Present()) decorated = Json.With(decorated, ("data", turns));
        }
        return decorated.Equals(result) ? response : Json.With(response, ("result", decorated));
    }
    private static JsonElement DecorateTurns(JsonElement turns)
    {
        if (turns.ValueKind != JsonValueKind.Array) return default;
        var changed = false;
        var output = new List<JsonElement>();
        foreach (var turn in turns.EnumerateArray())
        {
            var decorated = DecorateTurn(turn);
            changed |= !decorated.Equals(turn);
            output.Add(decorated);
        }
        return changed ? Json.Array(output) : default;
    }
    private static JsonElement DecorateTurn(JsonElement turn)
    {
        if (turn.Get("items").ValueKind != JsonValueKind.Array) return turn;
        var items = new List<JsonElement>();
        var matched = new HashSet<int>();
        var initialConsumed = false;
        var priorWork = false;
        var changed = false;
        foreach (var item in turn.Get("items").EnumerateArray())
        {
            var type = item.Str("type");
            if (type == "userMessage")
            {
                var initial = !initialConsumed && !priorWork;
                if (initial) initialConsumed = true;
                var projectionIndex = -1;
                if (!initial)
                {
                    for (var index = items.Count - 1; index >= 0; index--)
                        if (!matched.Contains(index) && items[index].Str("type") == "steeringUserMessage" &&
                            ClientId(item).Length > 0 && items[index].Str("clientUserMessageId") == ClientId(item))
                        { projectionIndex = index; break; }
                    if (projectionIndex < 0)
                    {
                        var projection = Steering(turn.Str("threadId"), turn.Str("id"), ClientId(item), item.Get("content"), item,
                            item.Get("userMessageOrderAt").Number(), "accepted");
                        if (projection.Present()) { projectionIndex = items.Count; items.Add(projection); changed = true; }
                    }
                    if (projectionIndex >= 0) matched.Add(projectionIndex);
                }
            }
            items.Add(item);
            if (type is not ("userMessage" or "steeringUserMessage" or "automaticApprovalReview" or "forkedFromConversation" or
                "modelChanged" or "modelRerouted" or "personalityChanged" or "remoteTaskCreated" or "worktreeInit")) priorWork = true;
        }
        return changed ? Json.With(turn, ("items", Json.Array(items))) : turn;
    }
}
