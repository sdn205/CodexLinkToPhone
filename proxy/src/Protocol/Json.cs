using System.Buffers;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace CodexPhoneProxy.Protocol;

// Keep protocol envelopes as UTF-8 JSON; unknown fields survive transformations.
internal static class Json
{
    public static readonly JsonElement Null = Parse("null"u8);
    public static readonly JsonElement EmptyObject = Parse("{}"u8);
    public static readonly JsonElement EmptyArray = Parse("[]"u8);
    public static JsonElement Parse(ReadOnlySpan<byte> bytes)
    {
        var reader = new Utf8JsonReader(bytes);
        using var document = JsonDocument.ParseValue(ref reader);
        if (reader.Read()) throw new JsonException("Trailing JSON data");
        return document.RootElement.Clone();
    }
    public static JsonElement Get(this JsonElement value, string key) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var result) ? result : default;
    public static string Text(this JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString() ?? "",
        JsonValueKind.Number => value.GetRawText(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        _ => ""
    };
    public static string Str(this JsonElement value, string key) => value.Get(key).Text();
    public static bool Has(this JsonElement value, string key) => value.Get(key).ValueKind != JsonValueKind.Undefined;
    public static bool True(this JsonElement value) => value.ValueKind == JsonValueKind.True;
    public static bool Present(this JsonElement value) => value.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined);
    public static long Number(this JsonElement value, long fallback = 0) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number) ? number :
        long.TryParse(value.Text(), out number) ? number : fallback;
    public static IEnumerable<JsonElement> Items(this JsonElement value) =>
        value.ValueKind == JsonValueKind.Array ? value.EnumerateArray() : [];

    public static byte[] Encode(JsonElement value)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = Writer(buffer)) Write(writer, value);
        return buffer.WrittenSpan.ToArray();
    }
    public static byte[] EncodeObject(params (string Key, object? Value)[] fields)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = Writer(buffer))
        {
            writer.WriteStartObject();
            foreach (var (key, value) in fields)
            {
                if (value is JsonElement { ValueKind: JsonValueKind.Undefined }) continue;
                writer.WritePropertyName(key);
                Write(writer, value);
            }
            writer.WriteEndObject();
        }
        return buffer.WrittenSpan.ToArray();
    }
    public static byte[] EncodeWithSequence(JsonElement value, long sequence)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = Writer(buffer))
        {
            writer.WriteStartObject();
            foreach (var property in value.EnumerateObject())
                if (property.Name != "seq") property.WriteTo(writer);
            writer.WriteNumber("seq", sequence);
            writer.WriteEndObject();
        }
        return buffer.WrittenSpan.ToArray();
    }
    public static JsonElement Obj(params (string Key, object? Value)[] fields) => Build(writer =>
    {
        writer.WriteStartObject();
        foreach (var (key, value) in fields)
        {
            if (value is JsonElement { ValueKind: JsonValueKind.Undefined }) continue;
            writer.WritePropertyName(key);
            Write(writer, value);
        }
        writer.WriteEndObject();
    });
    public static JsonElement With(JsonElement source, params (string Key, object? Value)[] fields) => Build(writer =>
    {
        writer.WriteStartObject();
        foreach (var property in source.EnumerateObject())
        {
            var replacement = System.Array.FindIndex(fields, field => field.Key == property.Name);
            if (replacement < 0) property.WriteTo(writer);
            else if (fields[replacement].Value is not JsonElement { ValueKind: JsonValueKind.Undefined })
            {
                writer.WritePropertyName(property.Name);
                Write(writer, fields[replacement].Value);
            }
        }
        foreach (var (key, value) in fields)
        {
            if (source.Has(key) || value is JsonElement { ValueKind: JsonValueKind.Undefined }) continue;
            writer.WritePropertyName(key);
            Write(writer, value);
        }
        writer.WriteEndObject();
    });
    public static JsonElement Array(IEnumerable<JsonElement> values) => Build(writer =>
    {
        writer.WriteStartArray();
        foreach (var value in values) Write(writer, value);
        writer.WriteEndArray();
    });
    public static JsonElement Build(Action<Utf8JsonWriter> action)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = Writer(buffer)) action(writer);
        return Parse(buffer.WrittenSpan);
    }
    private static Utf8JsonWriter Writer(IBufferWriter<byte> buffer) => new(buffer,
        new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
    private static void Write(Utf8JsonWriter writer, object? value)
    {
        switch (value)
        {
            case null: writer.WriteNullValue(); break;
            case JsonElement element:
                if (element.ValueKind == JsonValueKind.Undefined) writer.WriteNullValue(); else element.WriteTo(writer);
                break;
            case string text: writer.WriteStringValue(text); break;
            case bool boolean: writer.WriteBooleanValue(boolean); break;
            case int number: writer.WriteNumberValue(number); break;
            case long number: writer.WriteNumberValue(number); break;
            case IEnumerable<string> strings:
                writer.WriteStartArray(); foreach (var text in strings) writer.WriteStringValue(text); writer.WriteEndArray(); break;
            default: throw new ArgumentException($"Unsupported JSON value: {value.GetType().Name}");
        }
    }
}
