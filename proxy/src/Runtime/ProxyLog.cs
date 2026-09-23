using System.Text;

namespace CodexPhoneProxy.Runtime;

internal sealed class ProxyLog(string path)
{
    private readonly object gate = new();
    public void Write(string message)
    {
        lock (gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                if (File.Exists(path) && new FileInfo(path).Length > 2 * 1024 * 1024)
                {
                    for (var index = 3; index >= 1; index--)
                    {
                        var source = index == 1 ? path : $"{path}.{index - 1}";
                        if (File.Exists(source)) File.Move(source, $"{path}.{index}", true);
                    }
                }
                File.AppendAllText(path, $"{DateTimeOffset.UtcNow:O} {message}\n", new UTF8Encoding(false));
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
