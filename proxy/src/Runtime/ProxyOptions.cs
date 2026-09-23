namespace CodexPhoneProxy.Runtime;

internal sealed record ProxyOptions(string Root, string Codex, string StatePath, string LogPath, string Manager)
{
    public const string ExtensionVersion = "26.901.22334";
    public const string CodexVersion = "0.153.4";
    public bool AutoStart { get; } = (Env("CODEX_PHONE_AUTO_START") ?? "1").ToLowerInvariant() is "1" or "true" or "yes";
    public int HistoryCount { get; } = Limit("CODEX_PROXY_CONTROL_HISTORY_LIMIT", 2500, 100);
    public int HistoryBytes { get; } = Limit("CODEX_PROXY_CONTROL_HISTORY_MAX_BYTES", 16 * 1024 * 1024, 4 * 1024 * 1024);
    public int RequestTimeoutMs { get; } = Limit("CODEX_PROXY_CONTROL_REQUEST_TIMEOUT_MS", 55000, 5000);
    public int HeartbeatMs { get; } = Limit("CODEX_PROXY_CONTROL_HEARTBEAT_MS", 15000, 5000);
    public int ClientBufferedBytes { get; } = Limit("CODEX_PROXY_MAX_BUFFERED_BYTES", 4 * 1024 * 1024, 64 * 1024);
    public int ForwardedBytes { get; } = Limit("CODEX_PROXY_FORWARDED_REQUEST_MAX_BYTES", 8 * 1024 * 1024, 1024 * 1024);
    public bool ScenarioTesting { get; } = !string.IsNullOrEmpty(Env("FAKE_SCENARIO_LOG"));
    public static string? Env(string name) => Environment.GetEnvironmentVariable(name)?.Trim() is { Length: > 0 } value ? value : null;
    private static int Limit(string name, int fallback, int minimum) =>
        Math.Max(minimum, int.TryParse(Env(name), out var value) && value != 0 ? value : fallback);

    public static ProxyOptions Load()
    {
        var root = Env("CODEX_PHONE_REPO_ROOT") ?? Env("CODEX_PROXY_REPO_ROOT");
        if (root is null)
        {
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
                if (File.Exists(Path.Combine(directory.FullName, "package.json")) && Directory.Exists(Path.Combine(directory.FullName, "proxy")))
                { root = directory.FullName; break; }
        }
        if (root is null || !Directory.Exists(root)) throw new DirectoryNotFoundException("请配置有效的 CODEX_PHONE_REPO_ROOT");
        root = Path.GetFullPath(root);
        var codex = Env("CODEX_PHONE_REAL_CODEX_EXE") ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".trae-cn", "extensions",
            $"openai.chatgpt-{ExtensionVersion}", "bin", "windows-x86_64", "codex.exe");
        codex = Path.GetFullPath(codex);
        if (!File.Exists(codex)) throw new FileNotFoundException("找不到原版 Codex", codex);
        if (string.Equals(codex, Environment.ProcessPath, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("原版 Codex 路径不能指向代理自身");
        return new(root, codex,
            Path.GetFullPath(Env("CODEX_PROXY_STATE") ?? Path.Combine(root, ".state", "trae-proxy.json")),
            Path.GetFullPath(Env("CODEX_PROXY_LOG") ?? Path.Combine(root, ".state", "codex-proxy-native.log")),
            Path.GetFullPath(Env("CODEX_PHONE_MANAGER_EXE") ?? Path.Combine(root, "assistant", "dist", "Codex手机助手.exe")));
    }
    public static bool IsProxyCommand(string[] args)
    {
        var index = Array.FindIndex(args, arg => arg.Equals("app-server", StringComparison.OrdinalIgnoreCase));
        if (index < 0) return false;
        return !args.Skip(index + 1).Any(arg => arg.ToLowerInvariant() is
            "--help" or "-h" or "help" or "daemon" or "proxy" or "generate-ts" or "generate-json-schema");
    }
}
