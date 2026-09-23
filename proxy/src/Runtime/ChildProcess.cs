using System.Diagnostics;
using System.Text;

namespace CodexPhoneProxy.Runtime;

internal static class ChildProcess
{
    public static ProcessStartInfo StartInfo(string file, IEnumerable<string> arguments, bool redirect = true)
    {
        var info = new ProcessStartInfo(file)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = redirect, RedirectStandardOutput = redirect, RedirectStandardError = redirect,
            WorkingDirectory = Environment.CurrentDirectory
        };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        return info;
    }
    public static async Task ValidateVersionAsync(string codex)
    {
        using var process = Process.Start(StartInfo(codex, ["--version"])) ?? throw new IOException("Codex 启动失败");
        process.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
        var errors = process.StandardError.ReadToEndAsync(timeout.Token);
        try
        {
            await process.WaitForExitAsync(timeout.Token);
            var version = (await output).Trim();
            var error = (await errors).Trim();
            if (process.ExitCode != 0 || version != $"codex-cli {ProxyOptions.CodexVersion}")
                throw new InvalidOperationException($"要求 codex-cli {ProxyOptions.CodexVersion}，实际输出：{version} {error}");
        }
        finally { if (!process.HasExited) process.Kill(true); }
    }
    public static async Task<int> ForwardAsync(string codex, string[] args)
    {
        using var job = new ProcessJob();
        using var process = Process.Start(StartInfo(codex, args)) ?? throw new IOException("Codex 启动失败");
        job.Assign(process);
        var input = Task.Run(async () =>
        {
            try { await Console.OpenStandardInput().CopyToAsync(process.StandardInput.BaseStream); process.StandardInput.Close(); }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
        });
        var output = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
        var error = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
        try
        {
            await process.WaitForExitAsync();
            await Task.WhenAll(output, error);
            return process.ExitCode;
        }
        finally { if (!process.HasExited) process.Kill(true); }
    }
}
