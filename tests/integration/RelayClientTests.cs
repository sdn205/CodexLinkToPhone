using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using CodexPhoneBridge;

Console.OutputEncoding = new UTF8Encoding(false);
using var loop = new EventLoop();
loop.Run(() => RelayClientTests.Run(args));

internal static class RelayClientTests
{
    private const string Secret = "isolated-csharp-relay-secret-0123456789";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);
    private static readonly JsonArray Results = [];

    public static async Task Run(string[] args)
    {
        string suite = args.Length == 1 && args[0] is "client" or "slow" ? args[0]
            : throw new ArgumentException("Expected client or slow");
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !Directory.Exists(Path.Combine(root.FullName, "server/src"))) root = root.Parent;
        if (root is null) throw new DirectoryNotFoundException("Project root not found");
        string directory = Path.Combine(root.FullName, "tests/build/relay-" + suite,
            DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff") + "-" + Environment.ProcessId);
        Directory.CreateDirectory(directory);
        try
        {
            await Exercise(root.FullName, directory, suite);
            Console.WriteLine($"Relay {suite}: {Results.Count}/{Results.Count} passed; evidence: {directory}");
        }
        catch (Exception error)
        {
            Results.Add(J.O(("name", suite + "/failure"), ("passed", false), ("error", error.ToString())));
            Console.Error.WriteLine(error);
            Environment.ExitCode = 1;
        }
        finally { Persistence.Write(Path.Combine(directory, "results.json"), Results); }
    }

    private static async Task Exercise(string root, string directory, string suite)
    {
        // Every listener and state file belongs to this test. No production config is read.
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        var ct = deadline.Token;
        await using var target = new TargetServer(suite == "slow", ct);
        var agentReservation = new TcpListener(IPAddress.Loopback, 0);
        var publicReservation = new TcpListener(IPAddress.Loopback, 0);
        int agentPort, publicPort;
        try
        {
            agentReservation.Start(); publicReservation.Start();
            agentPort = ((IPEndPoint)agentReservation.LocalEndpoint).Port;
            publicPort = ((IPEndPoint)publicReservation.LocalEndpoint).Port;
        }
        finally { agentReservation.Stop(); publicReservation.Stop(); }

        await using var server = new RelayServer(root, directory, agentPort, publicPort);
        await server.Start(ct);
        Configuration Config(string name, string secret)
        {
            string state = Path.Combine(directory, name), ini = Path.Combine(state, "phone-mode.ini");
            Directory.CreateDirectory(state);
            File.WriteAllText(ini, $"[phone]\nmode=relay\nlocal_host=127.0.0.1\nlocal_port={target.Port}\ntoken=relay-test-token\n"
                + $"[relay]\nserver=127.0.0.1\nagent_port={agentPort}\npublic_port={publicPort}\nsecret={secret}\nreconnect_delay_ms=500\n", new UTF8Encoding(false));
            Environment.SetEnvironmentVariable("CODEX_PHONE_REPO_ROOT", root);
            Environment.SetEnvironmentVariable("CODEX_PHONE_STATE_DIR", state);
            Environment.SetEnvironmentVariable("CODEX_PHONE_MODE_CONFIG", ini);
            foreach (string nameToClear in new[] { "PORT", "CODEX_PHONE_TOKEN", "CODEX_PHONE_RELAY_SECRET", "CODEX_PHONE_RELAY_DISABLED", "PUBLIC_URL" })
                Environment.SetEnvironmentVariable(nameToClear, null);
            var config = new Configuration();
            Check(config.RelayEnabled && config.Port == target.Port && config.AgentPort == agentPort && config.PublicPort == publicPort,
                "Production configuration did not load the isolated endpoints");
            return config;
        }

        if (suite == "client")
        {
            using var reject = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var bad = new RelayClient(Config("wrong-secret", "wrong-csharp-relay-secret-0123456789"), reject.Token);
            bool connected = false;
            bad.Changed = () => connected |= bad.Status == "connected";
            Task run = bad.Run();
            try
            {
                await Until(() => bad.Status == "disconnected" && bad.Error.Contains("authentication failed"), run, ct);
                Check(!connected, "Wrong secret was accepted");
                Pass("relay-client/wrong-secret-rejected");
            }
            finally { await StopClient(reject, run); }
        }

        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var client = new RelayClient(Config("client", Secret), stop.Token);
        Task running = client.Run();
        try
        {
            await Until(() => client.Status == "connected", running, ct);
            if (suite == "client")
            {
                byte[] payload = new byte[100_000];
                new Random(42).NextBytes(payload);
                await RoundTrip(publicPort, payload, ct);
                Pass("relay-client/100000-byte-integrity");

                var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                int connected = 0;
                Task Gate()
                {
                    if (++connected == 4) ready.TrySetResult();
                    return ready.Task;
                }
                await Task.WhenAll(Enumerable.Range(0, 4).Select(i => RoundTrip(publicPort,
                    Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat($"parallel-{i}-", 8000))), ct, Gate)));
                Pass("relay-client/four-concurrent-tunnels");

                await server.Stop();
                await Until(() => client.Status == "disconnected", running, ct);
                await server.Start(ct);
                await Until(() => client.Status == "connected", running, ct);
                await RoundTrip(publicPort, "reconnect-ok"u8.ToArray(), ct);
                Check(!running.IsCompleted, "Client exited during reconnect");
                Pass("relay-client/reconnect-after-server-restart");
            }
            else
            {
                using var slow = new TcpClient { ReceiveBufferSize = 1024 };
                await slow.ConnectAsync(IPAddress.Loopback, publicPort, ct);
                // Pause a receiver, exercise a second tunnel, then resume and
                // verify every byte. Closing the slow client is NOT a pass.
                await slow.GetStream().WriteAsync("SLOW"u8.ToArray(), ct);
                await target.FloodStarted.Task.WaitAsync(Timeout, ct);
                for (int i = 0; i < 4; i++)
                    await RoundTrip(publicPort, Encoding.UTF8.GetBytes($"fast-client-stays-responsive-{i}"), ct);
                Check(client.Status == "connected" && !running.IsCompleted, "Slow client disconnected the agent");
                Pass("relay-slow/independent-tunnel-remains-responsive");
                slow.ReceiveBufferSize = 65536;
                byte[] chunk = new byte[32768]; int remaining = 16 * 1024 * 1024;
                while (remaining > 0)
                {
                    int n = await slow.GetStream().ReadAsync(chunk.AsMemory(0, Math.Min(chunk.Length, remaining)), ct);
                    Check(n > 0, "Paused receiver was disconnected before completing 16 MiB");
                    Check(chunk.AsSpan(0, n).IndexOfAnyExcept((byte)0x73) < 0, "Paused receiver data corruption");
                    remaining -= n;
                }
                Pass("relay-slow/resumed-receiver-completes-16MiB");
            }
        }
        finally { await StopClient(stop, running); }
        Check(client.Status == "stopped", "Client did not stop cleanly");
        var state = Persistence.Read(Path.Combine(directory, "client/relay-agent.json"));
        Check(state.S("status") == "stopped" && state.B("relayIntegrated") && state.N("pid") == Environment.ProcessId,
            "Production client did not persist the final isolated state");
        Pass("relay-" + suite + "/clean-shutdown-and-state");
    }

    private static async Task StopClient(CancellationTokenSource stop, Task run)
    {
        stop.Cancel();
        try { await run.WaitAsync(Timeout); }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }

    private static async Task Until(Func<bool> condition, Task running, CancellationToken ct)
    {
        using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
        wait.CancelAfter(Timeout);
        while (!condition())
        {
            if (running.IsCompleted) { await running; throw new IOException("Relay client exited before the expected state"); }
            await Task.Delay(10, wait.Token);
        }
    }

    private static async Task RoundTrip(int port, byte[] payload, CancellationToken ct, Func<Task>? gate = null)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(Timeout);
        using var client = new TcpClient { NoDelay = true };
        await client.ConnectAsync(IPAddress.Loopback, port, timeout.Token);
        if (gate is not null) await gate().WaitAsync(timeout.Token);
        var stream = client.GetStream();
        await stream.WriteAsync(payload, timeout.Token);
        byte[] reply = new byte[payload.Length];
        await stream.ReadExactlyAsync(reply, timeout.Token);
        Check(reply.AsSpan().SequenceEqual(payload), "Relay changed the payload bytes");
    }

    private static void Check(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    private static void Pass(string name) { Results.Add(J.O(("name", name), ("passed", true))); Console.WriteLine("PASS " + name); }

    private sealed class TargetServer : IAsyncDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource stop;
        private readonly List<TcpClient> clients = [];
        private readonly List<Task> handlers = [];
        private readonly Task accepting;
        private readonly bool flood;
        public TaskCompletionSource FloodStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int Port => ((IPEndPoint)listener.LocalEndpoint).Port;

        public TargetServer(bool flood, CancellationToken ct)
        {
            this.flood = flood;
            stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
            listener.Start(); accepting = Accept();
        }
        private async Task Accept()
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    var client = await listener.AcceptTcpClientAsync(stop.Token);
                    clients.Add(client); handlers.Add(Handle(client));
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
            catch (SocketException) when (stop.IsCancellationRequested) { }
        }
        private async Task Handle(TcpClient client)
        {
            using (client)
            {
                try
                {
                    var stream = client.GetStream(); byte[] buffer = new byte[65536];
                    if (flood)
                    {
                        // Read the marker exactly; a TCP read need not contain all four bytes.
                        await stream.ReadExactlyAsync(buffer.AsMemory(0, 4), stop.Token);
                        if (buffer.AsSpan(0, 4).SequenceEqual("SLOW"u8))
                        {
                            Array.Fill(buffer, (byte)0x73);
                            for (int i = 0; i < 256; i++)
                            {
                                await stream.WriteAsync(buffer, stop.Token);
                                if (i == 0) FloodStarted.TrySetResult();
                            }
                            await Task.Delay(System.Threading.Timeout.Infinite, stop.Token);
                            return;
                        }
                        await stream.WriteAsync(buffer.AsMemory(0, 4), stop.Token);
                    }
                    while (true)
                    {
                        int n = await stream.ReadAsync(buffer, stop.Token);
                        if (n == 0) return;
                        await stream.WriteAsync(buffer.AsMemory(0, n), stop.Token);
                    }
                }
                catch (Exception e) when (e is IOException or SocketException or OperationCanceledException or ObjectDisposedException) { }
            }
        }
        public async ValueTask DisposeAsync()
        {
            stop.Cancel(); listener.Stop();
            foreach (var client in clients) client.Dispose();
            await accepting.WaitAsync(Timeout);
            await Task.WhenAll(handlers).WaitAsync(Timeout);
            stop.Dispose();
        }
    }

    private sealed class RelayServer(string root, string directory, int agentPort, int publicPort) : IAsyncDisposable
    {
        private Process? process;
        private readonly ConcurrentQueue<string> output = new();
        private int generation;
        private volatile bool ready;
        public async Task Start(CancellationToken ct)
        {
            Check(process is null, "Relay server already running");
            string executable = Path.Combine(root, "relay/dist/relay-server.exe");
            if (!File.Exists(executable)) throw new FileNotFoundException("Build relay before running the tests", executable);
            generation++; ready = false;
            var start = new ProcessStartInfo(executable) { WorkingDirectory = root, UseShellExecute = false,
                CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
            foreach (string arg in new[] { "run", "--public-bind", "127.0.0.1", "--public-port", publicPort.ToString(),
                "--agent-bind", "127.0.0.1", "--agent-port", agentPort.ToString(), "--secret", Secret,
                "--log", Path.Combine(directory, $"relay-{generation}.log") }) start.ArgumentList.Add(arg);
            process = new Process { StartInfo = start };
            process.OutputDataReceived += Capture; process.ErrorDataReceived += Capture;
            if (!process.Start()) throw new IOException("Could not start isolated relay");
            process.BeginOutputReadLine(); process.BeginErrorReadLine();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(Timeout);
            while (!ready)
            {
                if (process.HasExited) throw new IOException("Relay failed: " + string.Join('\n', output));
                await Task.Delay(10, timeout.Token);
            }
        }
        private void Capture(object sender, DataReceivedEventArgs e)
        {
            if (e.Data is null) return;
            output.Enqueue(e.Data);
            if (e.Data.Contains("已监听")) ready = true;
        }
        public async Task Stop()
        {
            if (process is null) return;
            try
            {
                if (!process.HasExited) process.Kill();
                await process.WaitForExitAsync().WaitAsync(Timeout);
            }
            finally
            {
                process.Dispose(); process = null;
                File.WriteAllLines(Path.Combine(directory, $"relay-{generation}.console.log"), output, new UTF8Encoding(false));
                output.Clear();
            }
        }
        public async ValueTask DisposeAsync() => await Stop();
    }
}
