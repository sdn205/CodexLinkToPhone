using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace CodexPhoneBridge;

// The boundary is a WebSocket double; JSON framing, routing and business logic
// are the production implementations. Separate integration suites use real sockets/exes.
internal sealed class TestSocket : WebSocket
{
    private readonly Channel<byte[]> input = Channel.CreateUnbounded<byte[]>();
    private byte[]? partial;
    private int position;
    private WebSocketState state = WebSocketState.Open;
    public List<JsonObject> Sent { get; } = [];
    public Action<JsonObject>? OnSend;
    public override WebSocketCloseStatus? CloseStatus => null;
    public override string? CloseStatusDescription => null;
    public override string? SubProtocol => null;
    public override WebSocketState State => state;
    public void Receive(JsonNode message) => input.Writer.TryWrite(message.Bytes());
    public override void Abort() { state = WebSocketState.Aborted; input.Writer.TryComplete(); }
    public override void Dispose() => Abort();
    public override Task CloseAsync(WebSocketCloseStatus status, string? reason, CancellationToken ct) { Abort(); return Task.CompletedTask; }
    public override Task CloseOutputAsync(WebSocketCloseStatus status, string? reason, CancellationToken ct) => CloseAsync(status, reason, ct);
    public override Task SendAsync(ArraySegment<byte> data, WebSocketMessageType type, bool end, CancellationToken ct)
    {
        var message = JsonNode.Parse(data.AsSpan())!.Obj(); Sent.Add(message); OnSend?.Invoke(message); return Task.CompletedTask;
    }
    public override async Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> target, CancellationToken ct)
    {
        try { partial ??= await input.Reader.ReadAsync(ct); }
        catch (ChannelClosedException) { return new(0, WebSocketMessageType.Close, true); }
        int size = Math.Min(target.Count, partial.Length - position);
        partial.AsSpan(position, size).CopyTo(target.AsSpan()); position += size;
        bool end = position == partial.Length; if (end) { partial = null; position = 0; }
        return new(size, WebSocketMessageType.Text, end);
    }
}

internal sealed class TestPeer : IDisposable
{
    public TestSocket Wire { get; } = new();
    public ProxyConnection Connection { get; }
    public JsonSocket Socket { get; }
    public Task Pump { get; }
    public Func<JsonObject, Task<JsonNode>> Handler = _ => Task.FromResult<JsonNode>(new JsonObject());
    public List<JsonObject> Calls => Wire.Sent.Where(x => x.S("method") != "").ToList();
    public TestPeer(Fixture f, string id, params string[] threads)
    {
        var state = J.O(("instanceId", id), ("loadedThreadIds", J.Strings(threads)), ("pid", Environment.ProcessId), ("upstreamPid", Environment.ProcessId), ("initialized", true), ("upstreamConnected", true));
        Connection = new(state, f.Cancel.Token); Socket = new(Wire, f.Cancel.Token);
        T.Set(Connection, "socket", Socket);
        T.Call(Connection, "Handle", J.O(("type", "hello"), ("state", state)), false);
        T.Field<Dictionary<string, ProxyConnection>>(f.Bridge.Router, "connections")[id] = Connection;
        T.Call(f.Bridge.Router, "SetOwners", id, threads);
        Connection.Event = (c, m, replay) => f.Bridge.Router.Event(c, m, replay);
        Pump = Socket.Run(m => T.Call(Connection, "Handle", m, false));
        Wire.OnSend = message => { if (message.S("method") != "") EventLoop.Observe(Answer(message)); };
    }
    private async Task Answer(JsonObject request)
    {
        try { var response = await Handler(request); Wire.Receive(J.O(("id", request.G("id")), ("result", response))); }
        catch (Exception e) { Wire.Receive(J.O(("id", request.G("id")), ("error", J.O(("code", e is BridgeException b && b.Uncertain ? -32098 : -32000), ("message", e.Message))))); }
    }
    public void Dispose() => Socket.Dispose();
}

internal sealed class Fixture : IAsyncDisposable
{
    public CancellationTokenSource Cancel { get; } = new();
    public BridgeRuntime Bridge { get; }
    public string Directory { get; }
    private readonly List<TestPeer> peers = [];
    private readonly List<(JsonSocket Socket, Task Pump)> phones = [];
    public Fixture(string name)
    {
        Directory = Path.Combine(T.RunDirectory, name.Replace('/', '_'));
        System.IO.Directory.CreateDirectory(Directory);
        Environment.SetEnvironmentVariable("CODEX_PHONE_STATE_DIR", Directory);
        Environment.SetEnvironmentVariable("CODEX_PROXY_REGISTRY", Path.Combine(Directory, "instances"));
        Bridge = new(new(), Cancel.Token);
    }
    public TestPeer Peer(string id = "one", params string[] threads) { var peer = new TestPeer(this, id, threads); peers.Add(peer); return peer; }
    public (PhoneSession Client, TestSocket Wire) Phone(string tid = "a", bool add = false)
    {
        var wire = new TestSocket(); var socket = new JsonSocket(wire, Cancel.Token);
        var client = new PhoneSession(Bridge, socket) { ThreadId = tid, FollowDesktop = false };
        phones.Add((socket, socket.Run(m => EventLoop.Observe(Bridge.HandlePhone(client, m)))));
        if (add) Bridge.Clients.Add(client);
        return (client, wire);
    }
    public async ValueTask DisposeAsync()
    {
        Cancel.Cancel(); Bridge.Router.Close();
        foreach (var (socket, _) in phones) socket.Dispose();
        foreach (var p in peers) p.Dispose();
        foreach (var task in phones.Select(x => x.Pump).Concat(peers.Select(x => x.Pump))) await task;
        // Keep isolated files as evidence; production state is never used.
    }
}

internal static class T
{
    private static readonly List<(string Name, Func<Fixture, Task> Run)> cases = [];
    public static string Root = "", RunDirectory = "";
    public static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();
    public static void Add(string name, Action<Fixture> run) => cases.Add((name, f => { run(f); return Task.CompletedTask; }));
    public static void Add(string name, Func<Fixture, Task> run) => cases.Add((name, run));
    public static void Is(bool value, string message = "Assertion failed") { if (!value) throw new Exception(message); }
    public static void Equal<TValue>(TValue actual, TValue expected, string message = "") { if (!EqualityComparer<TValue>.Default.Equals(actual, expected)) throw new Exception($"{message} Expected {expected}; actual {actual}"); }
    public static void Same(JsonNode? actual, JsonNode? expected) => Is(JsonNode.DeepEquals(actual, expected), $"Expected {expected}; actual {actual}");
    public static void Throws(Action run, string contains = "") { try { run(); } catch (Exception e) { Is(e.Message.Contains(contains), e.ToString()); return; } throw new Exception("Expected an exception"); }
    public static async Task Rejects(Func<Task> run, string contains = "") { try { await run(); } catch (Exception e) { Is(e.Message.Contains(contains), e.ToString()); return; } throw new Exception("Expected task rejection"); }
    public static async Task Until(Func<bool> predicate, int timeout = 3000)
    { long deadline = J.Now + timeout; while (!predicate()) { if (J.Now > deadline) throw new TimeoutException("Test condition was not reached"); await Task.Delay(5); } }
    public static TValue Field<TValue>(object target, string name) => (TValue)target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(target)!;
    public static void Set(object target, string name, object? value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
    public static object? Call(object target, string name, params object?[] args)
    { try { return target.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(target, args); } catch (TargetInvocationException e) { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(e.InnerException!).Throw(); throw; } }
    private static long eventSequence;
    public static JsonObject Message(string id, string text = "hello", string tid = "a", string turn = "turn-a", string kind = "text", string role = "assistant", bool stream = false)
        => J.O(("id", id), ("role", role), ("kind", kind), ("text", text), ("streaming", stream), ("createdAt", 1800000000000L), ("meta", J.O(("threadId", tid), ("turnId", turn), ("proxyEventSource", "test"), ("proxyEventSeq", ++eventSequence))));
    public static async Task Run()
    {
        var results = new JsonArray(); int failed = 0;
        foreach (var entry in cases)
        {
            await using var f = new Fixture(entry.Name);
            try { await entry.Run(f).WaitAsync(TimeSpan.FromSeconds(entry.Name.EndsWith("real-timeout") ? 75 : 15)); Console.WriteLine("PASS " + entry.Name); results.Add(J.O(("name", entry.Name), ("passed", true))); }
            catch (Exception e) { failed++; Console.Error.WriteLine("FAIL " + entry.Name + "\n" + e); results.Add(J.O(("name", entry.Name), ("passed", false), ("error", e.ToString()))); }
        }
        Persistence.Write(Path.Combine(RunDirectory, "results.json"), results);
        Console.WriteLine($"Bridge modules: {cases.Count - failed}/{cases.Count} passed");
        Environment.ExitCode = failed > 0 ? 1 : 0;
    }
}
