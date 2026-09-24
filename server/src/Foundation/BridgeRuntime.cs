using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed class ThreadRuntime
{
    public bool Busy; public string Turn = ""; public long Started, ReplyStarted, Revision;
    public JsonObject? LastTiming;
    public Dictionary<string, JsonObject> Timings = [];
}

internal sealed partial class BridgeRuntime
{
    public Configuration Config { get; }
    public CancellationToken Cancellation { get; }
    public string Epoch { get; } = J.Id();
    public string CurrentThread { get; private set; } = "";
    public long CurrentRevision { get; private set; }
    public HashSet<PhoneSession> Clients { get; } = [];
    public MessageStore Messages { get; } = new();
    public ProxyRouter Router { get; }
    public ImageStore Images { get; }
    public MessageNormalizer Normalizer { get; }
    public RelayClient? Relay { get; }
    public Dictionary<string, JsonObject> Threads { get; } = [];
    public Dictionary<string, JsonObject> Settings { get; } = [];
    public JsonArray Models { get; private set; } = new();
    public Dictionary<string, JsonNode> TokenUsage { get; } = [];
    public HashSet<string> Unread { get; } = [];
    private readonly Dictionary<string, ThreadRuntime> runtimes = [];
    private readonly HashSet<string> internalThreads = [], subAgents = [];
    private bool selectionSaved;
    private string selection = "";
    private long snapshotSequence;
    private bool broadcastScheduled;
    private bool initializing;
    private string? lanUrl;
    private readonly Dictionary<string, Task<JsonNode>> hydration = [];
    private readonly Dictionary<string, long> lastHydration = [];
    private readonly HashSet<string> paging = [];
    private readonly Dictionary<string, JsonObject> pendingTitles = [];
    public BridgeRuntime(Configuration config, CancellationToken cancellation)
    {
        Config = config; Cancellation = cancellation;
        Directory.CreateDirectory(config.StateDir); Directory.CreateDirectory(config.UploadDir);
        Images = new(config); Normalizer = new(Images); Router = new(config, cancellation);
        if (config.RelayEnabled) Relay = new(config, cancellation);
        Router.Event = ProxyEvent; Router.DesktopSnapshot = result => { HydrateResponse(result, Messages.Revision, Runtime(result.G("thread").S("id")).Revision); Broadcast(); };
        Router.Changed = () => Broadcast();
        if (Relay is not null) Relay.Changed = () => Broadcast();
        var stored = Persistence.Read(StatePath("state.json"));
        foreach (var id in stored.Arr("unreadThreads")) if (id.Text() != "") Unread.Add(id.Text());
        var selected = stored.G("selection"); selectionSaved = selected is JsonObject; selection = selected.S("threadId");
        LoadOperations();
    }
    public string StatePath(string name) => Path.Combine(Config.StateDir, name);
    public ThreadRuntime Runtime(string tid) { if (!runtimes.TryGetValue(tid, out var r)) runtimes[tid] = r = new(); return r; }
    public ThreadRuntime ReadRuntime(string tid) => runtimes.GetValueOrDefault(tid) ?? new();
    private string LanUrl => lanUrl ??= System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()
        .Where(n => n.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up && n.NetworkInterfaceType != System.Net.NetworkInformation.NetworkInterfaceType.Loopback)
        .SelectMany(n => n.GetIPProperties().UnicastAddresses).Select(a => a.Address)
        .Where(a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork && !System.Net.IPAddress.IsLoopback(a))
        .Select(a => $"http://{a}:{Config.Port}/").FirstOrDefault() ?? $"http://127.0.0.1:{Config.Port}/";
    public string PublicUrl => new Uri(Config.ConfiguredUrl != "" ? Config.ConfiguredUrl : LanUrl).AbsoluteUri;
    public string DirectUrl => PublicUrl + (PublicUrl.Contains('?') ? "&" : "?") + "token=" + Uri.EscapeDataString(Config.Token);
    private void PersistState() => Persistence.Write(StatePath("state.json"),
        J.O(("version", 1), ("selection", selectionSaved ? J.O(("threadId", J.Null(selection))) : null),
            ("unreadThreads", J.Strings(Unread)), ("updatedAt", J.Now)));
    public void SetCurrent(string tid)
    {
        if (CurrentThread == tid) return; CurrentThread = tid; Router.CurrentThread = tid; CurrentRevision++;
        foreach (var c in Clients.Where(x => x.FollowDesktop)) Select(c, tid, false);
    }
    public void Select(PhoneSession client, string tid, bool persist, bool force = false)
    {
        if (client.ThreadId != tid || force) { client.ThreadId = tid; client.Revision++; client.Reset(); }
        if (persist) { client.FollowDesktop = false; selectionSaved = true; selection = tid; PersistState(); }
    }
    public void AddClient(PhoneSession client)
    {
        client.ThreadId = selectionSaved ? selection : CurrentThread; client.FollowDesktop = !selectionSaved; client.Revision = CurrentRevision; Clients.Add(client);
        client.SendState(true); if (client.ThreadId != "") EventLoop.Observe(HydrateClient(client, client.ThreadId));
    }
    private async Task HydrateClient(PhoneSession client, string tid)
    {
        try { await EnsureHydrated(tid); }
        catch (Exception e) { Console.Error.WriteLine("读取手机会话失败：" + e.Message); }
        finally { if (client.ThreadId == tid) client.SendState(true); }
    }
    public void Broadcast(bool immediate = false)
    {
        if (immediate) { foreach (var c in Clients.ToArray()) c.SendState(); return; }
        if (broadcastScheduled || Cancellation.IsCancellationRequested) return; broadcastScheduled = true; EventLoop.Observe(DelayedBroadcast());
    }
    private async Task DelayedBroadcast() { try { await Task.Delay(80, Cancellation); foreach (var c in Clients.ToArray()) c.SendState(); } finally { broadcastScheduled = false; } }
    public async Task Run()
    {
        if (Relay is not null) EventLoop.Observe(Relay.Run());
        EventLoop.Observe(Tick()); await Router.Run();
    }
    private async Task Tick()
    {
        while (!Cancellation.IsCancellationRequested)
        {
            await Task.Delay(500, Cancellation);
            foreach (var c in Clients.ToArray()) { if (J.Now - c.LastActivity > 60000) c.Background = true; c.FlushStreams(); if (c.NeedsFull && !c.Background) c.SendState(true); }
            if (pendingWrites == 0) foreach (var tid in historyCursor.Keys.Concat(historyRead).Concat(summaryTurns.Keys).Distinct().ToArray()) EventLoop.Observe(LoadHistory(tid));
        }
    }
    public void Stop() { Router.Close(); foreach (var client in Clients.ToArray()) client.Close(); PersistOperations(); }
    private bool Track(string tid) => tid != "" && !internalThreads.Contains(tid) && !subAgents.Contains(tid);
    private bool Internal(JsonNode? thread) => thread.B("ephemeral") || thread.S("threadSource") == "system" || internalThreads.Contains(thread.S("id"));
    private static bool SubAgent(JsonNode? thread) => thread.G("parentThreadId") is not null || thread.G("source").G("subAgent") is not null;
    public static bool ThreadNotFound(Exception e) => e.Message.Contains("thread not found", StringComparison.OrdinalIgnoreCase) || e.Message.Contains("no rollout found", StringComparison.OrdinalIgnoreCase);
    private void Ready() { if (!Router.Connected) throw new BridgeException("等待 Trae Codex 代理连接", "proxy_unavailable"); }
}
