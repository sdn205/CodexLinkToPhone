using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed class DesktopPipe : IAsyncDisposable
{
    private readonly NamedPipeServerStream pipe;
    private readonly CancellationTokenSource cancel = new();
    private readonly Task pump;
    public readonly List<JsonObject> Calls = [];
    public bool DropWrites;
    public string Owner = "desktop-owner";
    public DesktopPipe()
    {
        string name = "bridge-test-" + Guid.NewGuid(); Environment.SetEnvironmentVariable("CODEX_PHONE_DESKTOP_PIPE", name);
        pipe = new(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous); pump = Run();
    }
    private async Task Send(JsonNode message)
    {
        byte[] data = message.Bytes(), head = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(head, data.Length);
        // Split the header to exercise partial pipe reads.
        await pipe.WriteAsync(head.AsMemory(0, 2), cancel.Token); await pipe.WriteAsync(head.AsMemory(2), cancel.Token); await pipe.WriteAsync(data, cancel.Token);
    }
    private async Task Run()
    {
        try {
            await pipe.WaitForConnectionAsync(cancel.Token); byte[] head = new byte[4];
            while (!cancel.IsCancellationRequested) {
                await pipe.ReadExactlyAsync(head, cancel.Token); byte[] data = new byte[BinaryPrimitives.ReadInt32LittleEndian(head)]; await pipe.ReadExactlyAsync(data, cancel.Token);
                var m = JsonNode.Parse(data)!.AsObject(); Calls.Add(m);
                if (m.S("method") == "thread-stream-following-changed") {
                    if (!m.G("params").B("following")) continue;
                    await Send(J.O(("type", "broadcast"), ("method", "thread-stream-state-changed"), ("version", 11), ("sourceClientId", Owner), ("targetClientIds", J.Strings(["phone"])),
                        ("params", J.O(("hostId", "local"), ("conversationId", "a"), ("change", T.Obj("{\"type\":\"snapshot\",\"revision\":1,\"conversationState\":{\"id\":\"a\",\"turns\":[{\"turnId\":\"running\",\"status\":\"inProgress\",\"items\":[]}]}}")))))); continue;
                }
                if (m.S("type") != "request") continue;
                if (DropWrites && m.S("method").StartsWith("thread-follower-")) continue;
                var result = m.S("method") == "initialize" ? J.O(("clientId", "phone")) : m.S("method") == "thread-owner-discovery" ? new JsonObject() : T.Obj("{\"result\":{\"turn\":{\"id\":\"accepted\"},\"turnId\":\"accepted\"}}");
                await Send(J.O(("type", "response"), ("requestId", m.G("requestId")), ("resultType", "success"), ("handledByClientId", Owner), ("result", result)));
            }
        } catch (Exception e) when (e is IOException or OperationCanceledException or ObjectDisposedException) { }
    }
    public async ValueTask DisposeAsync() { cancel.Cancel(); pipe.Dispose(); await pump; cancel.Dispose(); }
}

internal sealed partial class BridgeRuntime
{
    internal static void RegisterDesktopTests()
    {
        T.Add("desktop-ipc/owner-discovery-versioned-frames-and-real-timeout", async f => {
            await using var server = new DesktopPipe(); using var ipc = new DesktopIpc(f.Cancel.Token);
            T.Equal(await ipc.FindOwner("a"), "desktop-owner"); T.Equal(server.Calls.Single(x => x.S("method") == "thread-owner-discovery").N("version"), 1L);
            var args = T.Obj("{\"threadId\":\"a\",\"expectedTurnId\":\"running\",\"turnId\":\"running\",\"clientUserMessageId\":\"client\",\"input\":[{\"type\":\"text\",\"text\":\"hello\"}]}");
            await ipc.Request("turn/start", args, server.Owner); await ipc.Request("turn/steer", args, server.Owner); await ipc.Request("turn/interrupt", args, server.Owner);
            foreach (var (method, version) in new[] { ("thread-follower-start-turn", 2L), ("thread-follower-steer-turn", 1L), ("thread-follower-interrupt-turn", 4L) }) {
                var call = server.Calls.Single(x => x.S("method") == method); T.Equal(call.N("version"), version); T.Equal(call.S("targetClientId"), server.Owner);
            }
            server.DropWrites = true;
            try { await ipc.Request("turn/start", args, server.Owner); throw new Exception("Expected timeout"); } catch (BridgeException e) { T.Is(e.Uncertain); T.Equal(e.Code, "desktop_ipc_timeout"); }
            T.Equal(server.Calls.Count(x => x.S("method") == "thread-follower-start-turn"), 2); T.Equal(T.Field<System.Collections.IDictionary>(ipc, "pending").Count, 0);
        });
        T.Add("desktop-ipc/stale-proxy-owner-and-external-writer-fallback", async f => {
            await using var server = new DesktopPipe(); var b = f.Bridge; var peer = f.Peer("one", "a"); peer.Handler = _ => throw new BridgeException("already has an active writer");
            var resumed = await b.Router.Request("thread/resume", J.O(("threadId", "a"))); T.Is(resumed.B("desktopSnapshot")); T.Equal(peer.Calls.Count, 1);
            var result = await b.Router.Request("turn/start", T.Obj("{\"threadId\":\"a\",\"input\":[{\"type\":\"text\",\"text\":\"hello\"}]}")); T.Equal(result.G("turn").S("id"), "accepted"); T.Equal(peer.Calls.Count, 1);
            T.Equal(server.Calls.Count(x => x.S("method") == "thread-follower-start-turn"), 1); b.Router.Close();
        });
    }
}
