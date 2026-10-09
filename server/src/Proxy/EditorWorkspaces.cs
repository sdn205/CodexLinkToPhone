using System.Diagnostics;
using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal static class EditorWorkspaces
{
    public static JsonObject Read(string registry, JsonNode state)
    {
        int pid = (int)state.N("ppid");
        if (pid <= 0) return new();
        var value = Persistence.Read(Path.Combine(Path.GetDirectoryName(registry)!, "workspaces", pid + ".json"));
        if (value.N("pid") != pid || !DateTimeOffset.TryParse(value.S("startedAt"), out var started)) return new();
        try
        {
            using var process = Process.GetProcessById(pid);
            if (Math.Abs((process.StartTime.ToUniversalTime() - started.UtcDateTime).TotalSeconds) > 30) return new();
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { return new(); }
        return J.O(("cwd", value.S("cwd")), ("folders", J.A(value.Arr("folders"))), ("editorId", value.S("editorId")));
    }
}
