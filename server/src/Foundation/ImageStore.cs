using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodexPhoneBridge;

internal sealed class ImageStore(Configuration config)
{
    public string LocalUrl(string path) => "/local-image?token=" + Uri.EscapeDataString(config.Token) + "&path=" + Uri.EscapeDataString(path);
    public static bool Supported(string path) => Regex.IsMatch(path, "\\.(png|jpe?g|webp|gif|svg)$", RegexOptions.IgnoreCase);
    private static string SafeName(string name) { string s = Regex.Replace(name, "[<>:\"/\\\\|?*\\x00-\\x1f\\s]+", "-"); s = s[..Math.Min(s.Length, 60)]; return Regex.Replace(s, "\\.[a-z0-9]+$", "", RegexOptions.IgnoreCase); }
    private JsonObject Store(string url, string name, bool canonical)
    {
        int max = Configuration.Int("PHONE_IMAGE_MAX_BYTES", 8 * 1024 * 1024, 1);
        if (url.Length > max * 2) throw new BridgeException("图片过大");
        var match = Regex.Match(url, "^data:(image/[a-z0-9.+-]+);base64,([a-z0-9+/=\\r\\n]+)$", RegexOptions.IgnoreCase);
        if (!match.Success) throw new BridgeException("图片数据格式不正确");
        string type = match.Groups[1].Value.ToLowerInvariant();
        string ext = type switch { "image/png" => ".png", "image/jpeg" or "image/jpg" => ".jpg", "image/gif" => ".gif", "image/webp" => ".webp", "image/svg+xml" => ".svg", _ => throw new BridgeException("暂不支持的图片类型：" + type) };
        byte[] data = Convert.FromBase64String(match.Groups[2].Value); if (data.Length > max) throw new BridgeException("图片过大");
        string fingerprint = Convert.ToHexStringLower(SHA256.HashData(data));
        string file = Path.Combine(config.UploadDir, (canonical ? "canonical-" + fingerprint : J.Now + "-" + J.Id() + "-" + SafeName(name)) + ext);
        if (!File.Exists(file)) File.WriteAllBytes(file, data);
        return J.O(("name", name), ("type", type), ("path", file), ("fingerprint", fingerprint), ("url", LocalUrl(file)), ("input", J.O(("type", "localImage"), ("path", file))));
    }
    public JsonArray Normalize(JsonNode? images)
    {
        var source = images.Items().ToArray(); if (source.Length > Configuration.Int("PHONE_IMAGE_LIMIT", 6, 1)) throw new BridgeException("一次发送的图片数量过多");
        var output = new JsonArray();
        try
        {
            foreach (var image in source)
            {
                string url = image.S("url", image.S("dataUrl", image.S("src"))).Trim(); string name = SafeName(image.S("name", "phone-image"));
                if (url.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase)) output.AddNode(Store(url, name, false));
                else if (Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https") output.AddNode(J.O(("name", name), ("type", image.S("type", "image/*")), ("url", url), ("fingerprint", url), ("input", J.O(("type", "image"), ("url", url)))));
                else throw new BridgeException("图片地址必须是 data 或 http(s) URL");
            }
        }
        catch { Cleanup(output); throw; }
        return output;
    }
    public void Cleanup(JsonArray images)
    {
        foreach (var image in images) { string p = image.S("path"); if (p != "" && Path.GetFullPath(p).StartsWith(Path.GetFullPath(config.UploadDir) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) try { File.Delete(p); } catch (IOException) { } }
    }
    public JsonObject? FromInput(JsonNode input)
    {
        string type = input.S("type"), url = input.S("url"), path = input.S("path");
        if (type == "localImage" && path != "") return J.O(("url", LocalUrl(path)), ("path", path), ("name", input.S("name", Path.GetFileName(path))), ("fingerprint", input.S("fingerprint", path)));
        if (type != "image" || url == "") return null;
        if (!url.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase)) return J.O(("url", url), ("name", input.S("name", "图片")), ("fingerprint", input.S("fingerprint", url)));
        try { var stored = Store(url, input.S("name", "图片"), true); stored.Remove("input"); return stored; }
        catch (Exception e) when (e is FormatException or IOException or BridgeException) { return J.O(("url", ""), ("name", "图片"), ("fingerprint", J.Hash(url)), ("unavailable", true)); }
    }
}
