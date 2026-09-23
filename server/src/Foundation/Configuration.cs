using System.Text;
using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed class Configuration
{
    public static string Env(string name, string fallback = "") => Environment.GetEnvironmentVariable(name) is { Length: > 0 } x ? x : fallback;
    public static bool Flag(string name) => new[] { "1", "true", "yes" }.Contains(Env(name).ToLowerInvariant());
    public static int Int(string name, int fallback, int min = 0) => int.TryParse(Env(name), out var x) ? Math.Max(min, x) : fallback;
    public string Root { get; }
    public string StateDir { get; }
    public string PublicDir { get; }
    public string UploadDir => Path.Combine(StateDir, "uploads");
    public string ProxyState { get; }
    public string Host { get; }
    public int Port { get; }
    public string Cwd { get; }
    public string Model { get; }
    public string Approval => Env("CODEX_APPROVAL", "never");
    public string Sandbox => Env("CODEX_SANDBOX", "danger-full-access");
    public string Token { get; }
    public string Mode { get; }
    public string LocalHost { get; }
    public string RelayServer { get; }
    public string RelaySecret { get; }
    public int AgentPort { get; }
    public int PublicPort { get; }
    public int ReconnectDelay { get; }
    public bool RelayEnabled { get; }
    public string ConfiguredUrl { get; }
    public string Fingerprint { get; }
    public bool AutoLifecycle => Flag("CODEX_PHONE_AUTO_LIFECYCLE");
    public int GraceMs => Int("CODEX_PHONE_PROXY_GRACE_MS", 15000, 5000);
    public int InitialLimit => Int("PHONE_INITIAL_MESSAGE_LIMIT", 200, 20);
    public int PageSize => Int("PHONE_MESSAGE_PAGE_SIZE", 500, 20);
    public int MaxMessages => Int("PHONE_MAX_MESSAGE_LIMIT", 1_000_000_000, InitialLimit);
    public int TextLimit => Int("PHONE_TEXT_LIMIT", 65536, 65536);
    public int ToolTextLimit => Int("PHONE_TOOL_TEXT_LIMIT", 8192, 4096);
    public Configuration()
    {
        Root = Path.GetFullPath(Env("CODEX_PHONE_REPO_ROOT", FindRoot()));
        StateDir = Path.GetFullPath(Env("CODEX_PHONE_STATE_DIR", Path.Combine(Root, ".state")));
        PublicDir = Path.Combine(Root, "public");
        ProxyState = Path.GetFullPath(Env("CODEX_PROXY_STATE", Path.Combine(StateDir, "trae-proxy.json")));
        Cwd = Path.GetFullPath(Env("CODEX_CWD", Root)); Model = Env("CODEX_MODEL"); Host = Env("HOST", "0.0.0.0");
        var ini = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string section = "";
        foreach (string raw in File.ReadLines(Env("CODEX_PHONE_MODE_CONFIG", Path.Combine(Root, "config/phone-mode.ini")), Encoding.UTF8))
        {
            string line = raw.Trim().TrimStart('\uFEFF');
            if (line.Length == 0 || line[0] is '#' or ';') continue;
            if (line.StartsWith('[') && line.EndsWith(']')) { section = line[1..^1].Trim(); continue; }
            int eq = line.IndexOf('='); if (eq > 0) ini[section + "." + line[..eq].Trim()] = line[(eq + 1)..].Trim();
        }
        string Required(string name) => ini.TryGetValue(name, out var v) && v.Length > 0 ? v : throw new InvalidDataException(name + " 未配置");
        int Number(string name, int min, int max) => int.TryParse(Required(name), out var v) && v >= min && v <= max ? v : throw new InvalidDataException(name + " 超出有效范围");
        Mode = Required("phone.mode").ToLowerInvariant();
        if (Mode != "relay") throw new InvalidDataException("phone.mode 必须是 relay");
        LocalHost = Required("phone.local_host"); Port = Int("PORT", Number("phone.local_port", 1, 65535), 1);
        Token = Env("CODEX_PHONE_TOKEN", Required("phone.token"));
        RelayServer = Required("relay.server");
        RelaySecret = Env("CODEX_PHONE_RELAY_SECRET", Required("relay.secret"));
        AgentPort = Number("relay.agent_port", 1, 65535);
        PublicPort = Number("relay.public_port", 1, 65535);
        ReconnectDelay = Number("relay.reconnect_delay_ms", 500, 60000);
        if (RelaySecret.Length < 32 || RelaySecret.StartsWith("CHANGE_ME")) throw new InvalidDataException("relay.secret 至少需要 32 个字符");
        RelayEnabled = !Flag("CODEX_PHONE_RELAY_DISABLED");
        ConfiguredUrl = Env("PUBLIC_URL", RelayEnabled ? $"http://{(RelayServer.Contains(':') ? "[" + RelayServer + "]" : RelayServer)}:{PublicPort}/" : "");
        Fingerprint = J.Hash(string.Join('\n', RelayServer, AgentPort, PublicPort, LocalHost, Port, ReconnectDelay, RelaySecret));
    }
    private static string FindRoot()
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
            for (var d = new DirectoryInfo(start); d is not null; d = d.Parent)
                if (Directory.Exists(Path.Combine(d.FullName, "public")) && Directory.Exists(Path.Combine(d.FullName, "config"))) return d.FullName;
        throw new DirectoryNotFoundException("无法定位项目根目录，请设置 CODEX_PHONE_REPO_ROOT");
    }
}

internal static class Persistence
{
    public static JsonNode? Read(string path) { try { return J.Parse(File.ReadAllText(path, Encoding.UTF8)); } catch (Exception e) when (e is IOException or System.Text.Json.JsonException) { return null; } }
    public static void Write(string path, JsonNode value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temp = path + ".tmp-" + Environment.ProcessId + "-" + J.Id();
        try { File.WriteAllText(temp, value.Wire() + "\n", new UTF8Encoding(false)); File.Move(temp, path, true); }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
