using System.Diagnostics;
using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed class ProxyRouter(Configuration config, CancellationToken cancellation)
{
    private readonly Dictionary<string, ProxyConnection> connections = [];
    private readonly Dictionary<string, HashSet<string>> owners = [];
    private readonly DesktopIpc desktop = new(cancellation);
    private string preferred = "";
    private readonly HashSet<string> externalThreads = [];
    private long nextDesktopRefresh;
    private bool desktopRefreshing;
    public HashSet<string> Ready { get; } = [];
    public Dictionary<string, Task<JsonNode>> Resuming { get; } = [];
    public Action<ProxyConnection, JsonNode, bool> Event { get; set; } = (_, _, _) => { };
    public Action<JsonNode> DesktopSnapshot { set => desktop.Snapshot = value; }
    public Action Changed { get; set; } = () => { };
    public string CurrentThread { get; set; } = "";
    public bool Connected => connections.Values.Any(x => x.Connected);
    public JsonObject Info()
    {
        var selected = Default();
        var instances = J.A(connections.Values.Select(c =>
            J.O(("instanceId", c.Id), ("proxyPid", c.State.G("pid")),
                ("upstreamPid", c.State.G("upstreamPid")), ("controlUrl", c.State.G("controlUrl")),
                ("connected", c.Connected),
                ("loadedThreadIds", J.Strings(owners.Where(x => x.Value.Contains(c.Id)).Select(x => x.Key))))));
        return J.O(("userAgent", "trae-codex-proxy"), ("proxy", true),
            ("proxyPid", selected?.State.G("pid")), ("upstreamPid", selected?.State.G("upstreamPid")),
            ("controlUrl", selected?.State.G("controlUrl")), ("instances", instances));
    }
    public static List<JsonObject> ReadInstances(string path)
    {
        var result = new List<JsonObject>(); string dir = path;
        if (!Directory.Exists(dir)) return result;
        foreach (string file in Directory.EnumerateFiles(dir, "*.json"))
        {
            var state = Persistence.Read(file);
            if (state is not JsonObject o || Path.GetFileName(file) != state.S("instanceId") + ".json" || state.S("mode") != "stdio-tee" || !state.B("initialized") || !state.B("upstreamConnected") || state.G("loadedThreadIds") is not JsonArray) continue;
            if (J.Now - J.Epoch(state.G("updatedAt")) > 30000 || !Alive(state.N("pid")) || !Alive(state.N("upstreamPid"))) continue;
            result.Add(o);
        }
        return result.OrderBy(x => x.S("startedAt"), StringComparer.Ordinal).ToList();
    }
    private static bool Alive(long id) { try { using var p = Process.GetProcessById((int)id); return !p.HasExited; } catch (ArgumentException) { return false; } }
    public async Task Run()
    {
        desktop.Disconnected = () => { foreach (var id in externalThreads) Ready.Remove(id); nextDesktopRefresh = 0; };
        long missing = 0;
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                var states = ReadInstances(config.ProxyState); var found = states.Select(x => x.S("instanceId")).ToHashSet();
                foreach (var id in connections.Keys.Where(x => !found.Contains(x)).ToArray()) { connections[id].Close(); connections.Remove(id); SetOwners(id, []); Changed(); }
                foreach (var state in states)
                {
                    string id = state.S("instanceId");
                    if (connections.ContainsKey(id)) continue;
                    var c = new ProxyConnection(state, cancellation); connections[id] = c;
                    SetOwners(id, state.Arr("loadedThreadIds").Select(x => x.Text()));
                    c.Changed = _ => { if (!c.Connected) foreach (var own in owners.Where(x => x.Value.Contains(id))) Ready.Remove(own.Key); Changed(); };
                    c.Event = Handle;
                }
                foreach (var c in connections.Values) if (!c.Connected && !c.Connecting) EventLoop.Observe(c.Connect());
                if (externalThreads.Count > 0 && !desktopRefreshing && J.Now >= nextDesktopRefresh) EventLoop.Observe(RefreshDesktop());
                if (states.Count > 0) missing = 0; else if (missing == 0) missing = J.Now;
                if (config.AutoLifecycle && missing > 0 && J.Now - missing >= config.GraceMs) return;
                await Task.Delay(500, cancellation);
            }
        }
        finally { Close(); }
    }
    private async Task RefreshDesktop()
    {
        desktopRefreshing = true; nextDesktopRefresh = J.Now + 5000;
        try
        {
            foreach (var tid in externalThreads.ToArray())
            {
                try { string? owner = await desktop.FindOwner(tid); if (owner is not null) await desktop.Request("thread/read", J.O(("threadId", tid)), owner); else { externalThreads.Remove(tid); Ready.Remove(tid); desktop.Forget(tid); } }
                catch (Exception e) { Ready.Remove(tid); Console.Error.WriteLine("桌面会话恢复失败：" + e.Message); }
            }
        }
        finally { desktopRefreshing = false; }
    }
    private void Handle(ProxyConnection c, JsonNode message, bool replay)
    {
        if (message.S("type") == "hello") SetOwners(c.Id, c.State.Arr("loadedThreadIds").Select(x => x.Text()));
        var notification = message.G("notification");
        var p = notification.G("params");
        if (notification.S("method") == "proxy/threadOwnership") { if (!replay) SetOwner(c.Id, p.S("threadId"), p.B("loaded")); Changed(); return; }
        string tid = p.S("threadId", p.G("thread").S("id"));
        if (tid.Length > 0 && owners.TryGetValue(tid, out var ids) && ids.Count > 0 && !ids.Contains(c.Id)) return;
        Event(c, message, replay);
    }
    private void SetOwners(string instance, IEnumerable<string> ids)
    {
        var next = ids.ToHashSet();
        foreach (var tid in owners.Keys.ToArray()) if (owners[tid].Contains(instance) && !next.Contains(tid)) SetOwner(instance, tid, false);
        foreach (var tid in next) SetOwner(instance, tid, true);
    }
    private void SetOwner(string instance, string thread, bool loaded)
    {
        if (thread.Length == 0) return;
        if (!owners.TryGetValue(thread, out var ids)) owners[thread] = ids = [];
        bool changed = loaded ? ids.Add(instance) : ids.Remove(instance);
        if (ids.Count == 0) owners.Remove(thread);
        if (changed) Ready.Remove(thread);
    }
    private ProxyConnection? Owner(string tid)
    {
        if (!owners.TryGetValue(tid, out var ids) || ids.Count == 0) return null;
        if (ids.Count > 1) throw new BridgeException("会话所属实例存在冲突，暂时不能提交", "thread_owner_conflict");
        return connections.TryGetValue(ids.First(), out var c) && c.Connected ? c : throw new BridgeException("此会话所属窗口尚未连接", "thread_owner_disconnected");
    }
    private ProxyConnection? Default()
    {
        if (owners.TryGetValue(CurrentThread, out var ids) && ids.Count == 1 && connections.TryGetValue(ids.First(), out var own) && own.Connected) return own;
        return connections.GetValueOrDefault(preferred) is { Connected: true } selected ? selected : connections.Values.FirstOrDefault(x => x.Connected);
    }
    public string CreationTarget(string tid) => (Owner(tid) ?? Default())?.Id ?? throw new BridgeException("没有可新建会话的已连接窗口", "proxy_unavailable");
    public async Task<JsonNode> Request(string method, JsonObject? args = null, int timeout = 60000, bool select = false, string instance = "")
    {
        string tid = args.S("threadId"); var owner = Owner(tid);
        bool follower = method is "turn/start" or "turn/steer" or "turn/interrupt" or "thread/resume" or "thread/read";
        if (tid.Length > 0 && owner is null && follower)
        {
            string? desktopOwner = await desktop.FindOwner(tid);
            if (desktopOwner is not null) { externalThreads.Add(tid); return await desktop.Request(method, args!, desktopOwner); }
            externalThreads.Remove(tid);
            desktop.Forget(tid);
        }
        if (tid.Length > 0 && owner is null && method.StartsWith("turn/", StringComparison.Ordinal)) throw new BridgeException("会话尚未在已连接窗口加载", "thread_owner_unavailable");
        var c = instance.Length > 0 ? connections.GetValueOrDefault(instance) : owner ?? Default();
        if (owner is not null && c != owner) throw new BridgeException("请求目标与会话所属窗口不一致", "thread_owner_conflict");
        if (c?.Connected != true) throw new BridgeException("没有已连接的 Trae Codex 实例", "proxy_unavailable");
        JsonNode result;
        try { result = await c.Request(method, args, timeout, select); }
        catch (BridgeException e) when (tid.Length > 0 && follower && e.Message.Contains("already has an active writer", StringComparison.OrdinalIgnoreCase))
        {
            string? desktopOwner = await desktop.FindOwner(tid); if (desktopOwner is null) throw;
            SetOwner(c.Id, tid, false); externalThreads.Add(tid); return await desktop.Request(method, args!, desktopOwner);
        }
        string loaded = result.G("thread").S("id");
        if (loaded.Length > 0 && method is "thread/start" or "thread/resume" or "thread/revert") SetOwner(c.Id, loaded, true);
        if (method is "thread/unsubscribe" or "thread/archive") SetOwner(c.Id, tid, false);
        if (select) preferred = c.Id;
        return result;
    }
    public void Close() { foreach (var c in connections.Values) c.Close(); desktop.Dispose(); }
}
