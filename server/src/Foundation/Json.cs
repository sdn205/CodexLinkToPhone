using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal static class J
{
    public static readonly JsonSerializerOptions Options = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    public static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public static string Id() => Guid.NewGuid().ToString();
    public static JsonNode? V(object? value) => value switch
    {
        null => null,
        JsonNode node => node.DeepClone(),
        string x => JsonValue.Create(x),
        bool x => JsonValue.Create(x),
        int x => JsonValue.Create(x),
        long x => JsonValue.Create(x),
        double x => JsonValue.Create(x),
        uint x => JsonValue.Create(x),
        _ => throw new ArgumentException($"Unsupported JSON value: {value.GetType()}")
    };
    public static JsonObject O(params (string Key, object? Value)[] fields)
    {
        var result = new JsonObject();
        foreach (var (key, value) in fields) result[key] = V(value);
        return result;
    }
    public static JsonArray A(IEnumerable<JsonNode?> items) => new(items.Select(x => x?.DeepClone()).ToArray());
    public static JsonArray Strings(IEnumerable<string> items) => new(items.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray());
    public static void AddNode(this JsonArray array, JsonNode? node) => array.Add(node);
    public static JsonNode? G(this JsonNode? n, string name) => n is JsonObject o ? o[name] : null;
    public static string S(this JsonNode? n, string name, string fallback = "") => n.G(name).Text(fallback);
    public static string Text(this JsonNode? n, string fallback = "") => n is JsonValue v ? v.ToString() : fallback;
    public static long N(this JsonNode? n, string name, long fallback = 0) => n.G(name).Number(fallback);
    public static long Number(this JsonNode? n, long fallback = 0) => double.TryParse(n.Text(), CultureInfo.InvariantCulture, out var x) && double.IsFinite(x) ? (long)x : fallback;
    public static bool B(this JsonNode? n, string name) => n.G(name)?.ToString() == "true";
    public static IEnumerable<JsonNode> Items(this JsonNode? n) => n is JsonArray a ? a.OfType<JsonNode>() : [];
    public static IEnumerable<JsonNode> Arr(this JsonNode? n, string key) => n.G(key).Items();
    public static JsonObject Obj(this JsonNode? n) => n is JsonObject o ? (JsonObject)o.DeepClone() : new();
    public static void Set(this JsonObject o, string name, object? value) => o[name] = V(value);
    public static JsonObject Merge(params JsonNode?[] nodes)
    {
        var result = new JsonObject();
        foreach (var node in nodes.OfType<JsonObject>()) foreach (var (key, value) in node) result.Set(key, value);
        return result;
    }
    public static string Wire(this JsonNode n) => n.ToJsonString(Options);
    public static byte[] Bytes(this JsonNode n) => Encoding.UTF8.GetBytes(n.Wire());
    public static JsonNode? Parse(string text) => JsonNode.Parse(text.TrimStart('\uFEFF'));
    public static long Epoch(JsonNode? n)
    {
        var number = n.Number();
        if (number > 0) return number < 100_000_000_000 ? number * 1000 : number;
        return DateTimeOffset.TryParse(n.Text(), out var t) ? t.ToUnixTimeMilliseconds() : 0;
    }
    public static long UuidTime(string id) => id.Length >= 15 && id[14] == '7' && long.TryParse(id[..8] + id.Substring(9, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var x) ? x : 0;
    public static string Canonical(JsonNode? n) => n switch
    {
        JsonObject o => "{" + string.Join(',', o.OrderBy(x => x.Key, StringComparer.Ordinal).Select(x => JsonValue.Create(x.Key)!.ToJsonString(Options) + ":" + Canonical(x.Value))) + "}",
        JsonArray a => "[" + string.Join(',', a.Select(Canonical)) + "]",
        _ => n?.ToJsonString(Options) ?? "null"
    };
    public static string Hash(string s) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(s)));
    public static string TextHash(string s) { uint h = 0x811c9dc5; foreach (char c in s) h = unchecked((h ^ c) * 0x01000193); return h.ToString("x8"); }
    public static string? Null(string? s) => string.IsNullOrEmpty(s) ? null : s;
}

internal sealed class BridgeException(string message, string code = "", bool uncertain = false, bool retryable = true) : Exception(message)
{
    public string Code { get; } = code;
    public bool Uncertain { get; } = uncertain;
    public bool Retryable { get; } = retryable;
    public string? ThreadId { get; set; }
}
