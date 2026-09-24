using System.Text.Json;
using CodexPhoneProxy.Protocol;

namespace CodexPhoneProxy.Runtime;

// Discovery is ancillary to stdio forwarding. File-system failures stay here.
internal sealed class InstanceRegistration(string path, ProxyLog log)
{
    private long retryAt;
    private string failure = "";
    public bool Publish(JsonElement state)
    {
        var now = Environment.TickCount64;
        if (now < retryAt) return false;
        var bytes = Json.Encode(state);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllBytes(path + ".tmp", bytes);
            if (File.Exists(path)) File.Replace(path + ".tmp", path, null);
            else File.Move(path + ".tmp", path);
            if (failure.Length > 0) log.Write($"state_write_recovered path={path}");
            failure = "";
            retryAt = 0;
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            var reason = $"{error.GetType().Name} hresult=0x{error.HResult:X8} {error.Message}";
            if (reason != failure) log.Write($"state_write_error path={path} {reason}");
            failure = reason;
            retryAt = now + 5000;
            return false;
        }
    }
    public void Remove()
    {
        foreach (var file in new[] { path, path + ".tmp" })
            try { File.Delete(file); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            { log.Write($"registry_cleanup path={file} hresult=0x{error.HResult:X8} {error.Message}"); }
    }
}
