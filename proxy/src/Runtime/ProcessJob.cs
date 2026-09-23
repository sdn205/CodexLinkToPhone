using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace CodexPhoneProxy.Runtime;

// Closing the proxy (including a forced stop) must not orphan its app-server.
internal sealed partial class ProcessJob : IDisposable
{
    private readonly SafeFileHandle handle = CreateJobObjectW(IntPtr.Zero, null);
    public ProcessJob()
    {
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
        if (!SetInformationJobObject(handle, 9, in limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public void Assign(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.Handle))
        {
            var error = new Win32Exception(Marshal.GetLastWin32Error());
            try { process.Kill(true); } catch (InvalidOperationException) { }
            throw error;
        }
    }
    public void Dispose() => handle.Dispose();
    public static int ParentPid()
    {
        var info = new ProcessBasicInformation();
        return NtQueryInformationProcess(new IntPtr(-1), 0, ref info, Marshal.SizeOf<ProcessBasicInformation>(), out _) == 0
            ? (int)info.Parent : 0;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public nuint MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public nuint Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public nuint ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation { public IntPtr ExitStatus, Peb, Affinity, Priority, Pid, Parent; }
    [LibraryImport("kernel32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial SafeFileHandle CreateJobObjectW(IntPtr attributes, string? name);
    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetInformationJobObject(SafeFileHandle job, int type, in ExtendedLimits info, uint size);
    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [LibraryImport("ntdll.dll")]
    private static partial int NtQueryInformationProcess(IntPtr process, int type, ref ProcessBasicInformation info, int size, out int returned);
}
