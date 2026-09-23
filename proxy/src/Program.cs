using CodexPhoneProxy.Runtime;
using CodexPhoneProxy.Proxy;

try
{
    var options = ProxyOptions.Load();
    await ChildProcess.ValidateVersionAsync(options.Codex);
    if (!ProxyOptions.IsProxyCommand(args)) return await ChildProcess.ForwardAsync(options.Codex, args);
    await using var host = new ProxyHost(options);
    Console.CancelKeyPress += (_, e) => { e.Cancel = true; host.Stop(0); };
    return await host.RunAsync(args);
}
catch (Exception error)
{
    Console.Error.WriteLine($"Codex Phone 代理启动失败：{error.Message}");
    return 1;
}
