using System.Text.Json;
using CodexPhoneShared;

namespace CodexPhoneProxy.Runtime;

internal static class ExtensionCli
{
    public static string Resolve()
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string editor = EditorIdentity.Find(Environment.ProcessId).Id;
        if (editor is "trae" or "vscode") return ForEditor(home, editor);
        // Direct terminal use has no editor owner; use an installed supported copy.
        foreach (string candidate in new[] { "vscode", "trae" })
        {
            try { return ForEditor(home, candidate); }
            catch (IOException) { }
            catch (JsonException) { }
            catch (InvalidOperationException) { }
        }
        throw new FileNotFoundException($"找不到编辑器扩展内的 Codex，请安装 openai.chatgpt {ProxyOptions.ExtensionVersion}");
    }

    internal static string ForEditor(string home, string editor)
    {
        string folder = editor switch { "trae" => ".trae-cn", "vscode" => ".vscode", _ => throw new ArgumentException("未知编辑器", nameof(editor)) };
        string extensions = Path.GetFullPath(Path.Combine(home, folder, "extensions"));
        using var registry = JsonDocument.Parse(File.ReadAllText(Path.Combine(extensions, "extensions.json")));
        foreach (var entry in registry.RootElement.EnumerateArray())
        {
            if (!entry.TryGetProperty("identifier", out var identifier) ||
                !identifier.TryGetProperty("id", out var id) || id.GetString() != "openai.chatgpt" ||
                !entry.TryGetProperty("version", out var version) || version.GetString() != ProxyOptions.ExtensionVersion) continue;
            string relative = entry.GetProperty("relativeLocation").GetString() ?? "";
            string installed = Path.GetFullPath(Path.Combine(extensions, relative));
            if (relative.Length == 0 || !installed.StartsWith(extensions + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Codex 扩展登记路径无效");
            using var package = JsonDocument.Parse(File.ReadAllText(Path.Combine(installed, "package.json")));
            if (package.RootElement.GetProperty("version").GetString() != ProxyOptions.ExtensionVersion)
                throw new InvalidOperationException("Codex 扩展版本与安装登记不一致");
            string cli = Path.Combine(installed, "bin", "windows-x86_64", "codex.exe");
            if (!File.Exists(cli)) throw new FileNotFoundException("扩展缺少 Codex CLI", cli);
            return cli;
        }
        throw new InvalidOperationException($"{editor} 需要安装 openai.chatgpt {ProxyOptions.ExtensionVersion}");
    }
}
