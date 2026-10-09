using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CodexPhoneShared;

// Both binaries use the same process ancestry rule; window ownership is never
// inferred from whichever editor happened to start first.
internal sealed record EditorIdentity(string Id, string Name, int Pid)
{
    public static EditorIdentity Find(int processId)
    {
        var result = new EditorIdentity("unknown", "Codex", 0);
        var visited = new HashSet<int>();
        for (int depth = 0; depth < 24 && processId > 0 && visited.Add(processId); depth++)
        {
            try
            {
                using var process = Process.GetProcessById(processId);
                string id = process.ProcessName.ToLowerInvariant() switch { "trae cn" => "trae", "code" => "vscode", _ => "" };
                if (id.Length > 0)
                {
                    // An editor may have been launched from the other editor's terminal.
                    // Keep the nearest editor's identity while finding its main process.
                    if (result.Id != "unknown" && result.Id != id) break;
                    result = new(id, id == "trae" ? "Trae" : "VS Code", processId);
                }
                var info = new BasicInfo();
                if (NtQueryInformationProcess(process.Handle, 0, ref info, Marshal.SizeOf<BasicInfo>(), out _) != 0) break;
                processId = (int)info.Parent;
            }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { break; }
        }
        return result;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicInfo { public IntPtr ExitStatus, Peb, Affinity, Priority, Pid, Parent; }
    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int type, ref BasicInfo info, int size, out int returned);
}
