using System.Text.Json;
using CodexPhoneProxy.Protocol;
using CodexPhoneProxy.Runtime;

namespace CodexPhoneProxy.Proxy;

internal sealed class ProxyState(string instanceId, string token)
{
    private readonly CodexPhoneShared.EditorIdentity editor = CodexPhoneShared.EditorIdentity.Find(Environment.ProcessId);
    public string WorkspaceCwd = "";
    private readonly string startedAt = DateTimeOffset.UtcNow.ToString("O");
    public readonly HashSet<string> LoadedThreads = new();
    public readonly HashSet<string> Subagents = new();
    public readonly HashSet<string> InternalThreads = new();
    public string ControlUrl = "", LastError = "";
    public string? UserAgent, CliVersion, CurrentThread, ActiveTurn;
    public int? UpstreamPid;
    public bool Connected, Initialized, Busy;
    public long Revision;
    public JsonElement LastThread = Json.Null;
    public JsonElement Snapshot() => Json.Obj(("mode", "stdio-tee"), ("pid", Environment.ProcessId),
        ("ppid", ProcessJob.ParentPid()), ("instanceId", instanceId), ("loadedThreadIds", LoadedThreads),
        ("editorId", editor.Id), ("editorName", editor.Name), ("editorPid", editor.Pid), ("workspaceCwd", WorkspaceCwd),
        ("stateRevision", Revision), ("startedAt", startedAt), ("updatedAt", DateTimeOffset.UtcNow.ToString("O")),
        ("controlUrl", ControlUrl), ("token", token), ("upstreamPid", UpstreamPid), ("upstreamConnected", Connected),
        ("initialized", Initialized), ("upstreamUserAgent", UserAgent), ("codexCliVersion", CliVersion),
        ("currentThreadId", CurrentThread), ("activeTurnId", ActiveTurn), ("busy", Busy),
        ("lastThread", LastThread), ("lastError", LastError));

    public bool IsInternal(JsonElement thread) => thread.Get("ephemeral").True() || thread.Str("threadSource") == "system" || InternalThreads.Contains(thread.Str("id"));
    public string RememberKind(JsonElement thread)
    {
        var id = thread.Str("id");
        if (id.Length == 0) return "unknown";
        if (IsInternal(thread)) { InternalThreads.Add(id); return "internal"; }
        var source = thread.Str("threadSource").ToLowerInvariant();
        if (thread.Get("parentThreadId").Present() || thread.Get("source").Has("subAgent") ||
            source.Contains("subagent") || source.Contains("sub-agent") || source.Contains("sub_agent") ||
            source.Contains("threadspawn") || source.Contains("thread-spawn") || source.Contains("thread_spawn"))
        { Subagents.Add(id); return "subagent"; }
        return "root";
    }
    public static bool IsStatus(JsonElement status) => status.Str("type") is "active" or "idle" or "notLoaded" or "systemError";
    public void SetThread(JsonElement thread)
    {
        if (RememberKind(thread) != "root") return;
        CurrentThread = thread.Str("id");
        var status = thread.Get("status");
        if (IsStatus(status))
        {
            Busy = status.Str("type") == "active";
            if (Busy)
            {
                var active = thread.Get("turns").Items().LastOrDefault(turn => turn.Str("status") == "inProgress").Str("id");
                if (active.Length > 0) ActiveTurn = active;
            }
            else ActiveTurn = null;
        }
        LastThread = Json.Obj(("id", thread.Get("id")), ("name", thread.Str("name")), ("cwd", thread.Get("cwd")),
            ("source", thread.Get("source")), ("updatedAt", thread.Get("updatedAt")), ("createdAt", thread.Get("createdAt")));
    }
}
