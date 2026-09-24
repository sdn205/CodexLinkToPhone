using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed class ProxyRegistry(string directory)
{
    private string lastFailure = "";
    public sealed record Scan(List<JsonObject> Instances, bool Complete);
    public Scan Read()
    {
        var instances = new List<JsonObject>();
        string failure = "";
        try
        {
            foreach (string file in Directory.EnumerateFiles(directory, "*.json"))
            {
                try
                {
                    // The writer atomically replaces the file; readers must allow that rename.
                    using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    using var reader = new StreamReader(stream, Encoding.UTF8);
                    var state = J.Parse(reader.ReadToEnd());
                    if (state is not JsonObject o || Path.GetFileName(file) != state.S("instanceId") + ".json" ||
                        state.S("mode") != "stdio-tee" || !state.B("initialized") || !state.B("upstreamConnected") ||
                        state.G("loadedThreadIds") is not JsonArray) continue;
                    if (J.Now - J.Epoch(state.G("updatedAt")) > 30000 || !ProcessesAlive(state)) continue;
                    instances.Add(o);
                }
                catch (FileNotFoundException) { }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
                { failure = $"{file}: {error.GetType().Name} 0x{error.HResult:X8} {error.Message}"; }
            }
        }
        catch (DirectoryNotFoundException) { }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { failure = $"{directory}: {error.GetType().Name} 0x{error.HResult:X8} {error.Message}"; }
        if (failure != lastFailure)
        {
            Console.Error.WriteLine(failure.Length > 0 ? "读取代理登记失败：" + failure : "代理登记读取已恢复");
            lastFailure = failure;
        }
        return new(instances.OrderBy(x => x.S("startedAt"), StringComparer.Ordinal).ToList(), failure.Length == 0);
    }
    public static bool ProcessesAlive(JsonNode state) => Alive(state.N("pid")) && Alive(state.N("upstreamPid"));
    private static bool Alive(long id)
    {
        if (id <= 0 || id > int.MaxValue) return false;
        try { using var process = Process.GetProcessById((int)id); return !process.HasExited; }
        catch (ArgumentException) { return false; }
    }
}
