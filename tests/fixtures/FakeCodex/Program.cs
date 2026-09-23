using System.Diagnostics;
using System.Text;

if (args.Length == 1 && args[0] == "--version")
{
    Console.WriteLine("codex-cli " + (Environment.GetEnvironmentVariable("FAKE_VERSION") ?? "0.153.4"));
    return 0;
}
if (Environment.GetEnvironmentVariable("FAKE_ECHO_ARGS") is { Length: > 0 })
{
    // Test-only serialization; never shipped in the production EXE.
    Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(args));
    return 0;
}
var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("FAKE_NODE") ?? "node.exe")
{
    UseShellExecute = false, CreateNoWindow = true,
    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
};
info.ArgumentList.Add(Environment.GetEnvironmentVariable("FAKE_SCRIPT") ?? throw new Exception("FAKE_SCRIPT missing"));
foreach (var arg in args) info.ArgumentList.Add(arg);
using var child = Process.Start(info)!;
_ = Task.Run(async () =>
{
    try { await Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream); child.StandardInput.Close(); }
    catch (IOException) { }
});
var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
await child.WaitForExitAsync();
await Task.WhenAll(output, error);
return child.ExitCode;
