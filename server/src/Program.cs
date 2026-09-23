using System.Text;

namespace CodexPhoneBridge;

internal static class Program
{
    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Contains("--version")) { Console.WriteLine("codex-phone-bridge 2026-09-24.js-behavior (.NET 10 Native AOT)"); return 0; }
        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };
        AppDomain.CurrentDomain.ProcessExit += (_, _) => { try { cancellation.Cancel(); } catch (ObjectDisposedException) { } };
        try
        {
            var config = new Configuration();
            if (args.Contains("--check")) { Console.WriteLine("Phone bridge configuration OK"); return 0; }
            using var loop = new EventLoop();
            loop.Run(async () =>
            {
                var bridge = new BridgeRuntime(config, cancellation.Token); var http = new HttpHost(bridge, loop);
                try { await http.Start(); await bridge.Run(); }
                catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
                finally { cancellation.Cancel(); bridge.Stop(); await http.Stop(); }
            }); return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
}
