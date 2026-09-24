#include "Windows.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <tlhelp32.h>
#include <shellapi.h>
#include <winhttp.h>
#include <winternl.h>
#include <algorithm>
#include <set>
#include <stdexcept>
#include <thread>

namespace phone_assistant::management {
Json ReadRegistryJson(const fs::path& path) {
    Handle file(CreateFileW(path.c_str(), GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file) return nullptr;
    std::string text;
    char buffer[4096];
    for (;;) {
        DWORD count = 0;
        if (!ReadFile(file.get(), buffer, sizeof(buffer), &count, nullptr)) return nullptr;
        if (!count) break;
        text.append(buffer, count);
    }
    return Json::parse(text, nullptr, false);
}
namespace {
std::int64_t ProcessTime(HANDLE process) {
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return 0;
    return (static_cast<std::int64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
}
std::wstring Quote(std::wstring_view value) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (wchar_t ch : value) {
        if (ch == L'\\') { ++slashes; continue; }
        result.append(ch == L'"' ? slashes * 2 + 1 : slashes, L'\\');
        result.push_back(ch);
        slashes = 0;
    }
    result.append(slashes * 2, L'\\');
    return result + L'"';
}
std::vector<wchar_t> ChildEnvironment(const EnvironmentChanges& changes) {
    struct Less {
        bool operator()(const std::wstring& a, const std::wstring& b) const {
            return CompareStringOrdinal(a.c_str(), -1, b.c_str(), -1, TRUE) == CSTR_LESS_THAN;
        }
    };
    std::map<std::wstring, std::wstring, Less> values;
    const auto block = GetEnvironmentStringsW();
    if (!block) throw std::runtime_error("读取子进程环境失败");
    for (const wchar_t* current = block; *current; current += wcslen(current) + 1) {
        const std::wstring entry(current);
        const auto equals = entry.find(L'=', entry[0] == L'=' ? 1 : 0);
        if (equals != entry.npos) values[entry.substr(0, equals)] = entry.substr(equals + 1);
    }
    FreeEnvironmentStringsW(block);
    for (const auto& [key, value] : changes) {
        if (value) values[key] = *value;
        else values.erase(key);
    }
    std::vector<wchar_t> result;
    for (const auto& [key, value] : values) {
        const auto entry = key + L"=" + value;
        result.insert(result.end(), entry.begin(), entry.end());
        result.push_back(L'\0');
    }
    result.push_back(L'\0');
    return result;
}
Handle OpenOutput(const fs::path& path) {
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    Handle result(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!result) throw std::runtime_error("无法打开日志：" + Utf8(path.wstring()));
    return result;
}
struct Child { Handle process; DWORD pid; };
Child Spawn(const fs::path& executable, const std::vector<std::wstring>& arguments,
    const fs::path& cwd, const EnvironmentChanges& changes, HANDLE output, HANDLE error) {
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    Handle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr));
    if (!input) throw std::runtime_error("无法打开子进程输入");
    std::vector<HANDLE> inherited{input.get(), output};
    if (error != output) inherited.push_back(error);
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    std::vector<unsigned char> storage(size);
    auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(attributes, 1, 0, &size)) throw std::runtime_error("创建子进程属性失败");
    struct Cleanup {
        LPPROC_THREAD_ATTRIBUTE_LIST attributes;
        ~Cleanup() { DeleteProcThreadAttributeList(attributes); }
    } cleanup{attributes};
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inherited.data(), inherited.size() * sizeof(HANDLE), nullptr, nullptr))
        throw std::runtime_error("设置子进程句柄隔离失败");
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.StartupInfo.wShowWindow = SW_HIDE;
    startup.StartupInfo.hStdInput = input.get();
    startup.StartupInfo.hStdOutput = output;
    startup.StartupInfo.hStdError = error;
    startup.lpAttributeList = attributes;
    auto command = Quote(executable.wstring());
    for (const auto& argument : arguments) command += L" " + Quote(argument);
    auto environment = ChildEnvironment(changes);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        environment.data(), cwd.c_str(), &startup.StartupInfo, &process))
        throw std::runtime_error("无法启动程序：" + Utf8(executable.wstring()) + " (Win32 " + std::to_string(GetLastError()) + ")");
    CloseHandle(process.hThread);
    return {Handle(process.hProcess), process.dwProcessId};
}
class Internet {
public:
    explicit Internet(HINTERNET value) : value_(value) {}
    ~Internet() { if (value_) WinHttpCloseHandle(value_); }
    operator HINTERNET() const { return value_; }
private:
    HINTERNET value_;
};
} // namespace

std::optional<ProcessInfo> FindProcess(DWORD pid) {
    if (!pid) return {};
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
    if (!process || WaitForSingleObject(process.get(), 0) == WAIT_OBJECT_0) return {};
    std::wstring path(32768, L'\0');
    DWORD size = static_cast<DWORD>(path.size());
    if (!QueryFullProcessImageNameW(process.get(), 0, path.data(), &size)) return {};
    path.resize(size);
    return ProcessInfo{pid, 0, fs::path(path), ProcessTime(process.get())};
}
bool MatchesExecutable(const ProcessInfo& process, const fs::path& expected) {
    if (SamePath(process.path, expected)) return true;
    // A running image moved into a deployment archive keeps its original argv[0].
    // Require an exact absolute launch path and the same EXE filename.
    if (!SamePath(process.path.filename(), expected.filename())) return false;
    const auto command = CommandLine(process.pid);
    if (command.empty()) return false;
    int count = 0;
    const auto arguments = CommandLineToArgvW(command.c_str(), &count);
    if (!arguments) return false;
    const auto launch = count ? fs::path(arguments[0]) : fs::path{};
    LocalFree(arguments);
    return launch.is_absolute() && SamePath(launch, expected);
}
std::vector<ProcessInfo> Processes() {
    std::vector<ProcessInfo> result;
    Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    if (!snapshot) throw std::runtime_error("无法枚举进程");
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    for (BOOL found = Process32FirstW(snapshot.get(), &entry); found; found = Process32NextW(snapshot.get(), &entry)) {
        if (auto process = FindProcess(entry.th32ProcessID)) {
            process->parent = entry.th32ParentProcessID;
            result.push_back(std::move(*process));
        }
    }
    return result;
}
std::wstring CommandLine(DWORD pid) {
    using Query = NTSTATUS(NTAPI*)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG, PULONG);
    const auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
    if (!query || !process) return {};
    ULONG size = 0;
    query(process.get(), static_cast<PROCESSINFOCLASS>(60), nullptr, 0, &size);
    if (!size || size > 1024 * 1024) return {};
    std::vector<unsigned char> buffer(size);
    if (query(process.get(), static_cast<PROCESSINFOCLASS>(60), buffer.data(), size, nullptr) < 0) return {};
    const auto text = reinterpret_cast<const UNICODE_STRING*>(buffer.data());
    return text->Buffer ? std::wstring(text->Buffer, text->Length / sizeof(wchar_t)) : L"";
}
void StopProcess(const ProcessInfo& process) {
    if (!process.pid || process.pid == GetCurrentProcessId()) throw std::runtime_error("拒绝终止管理器自身");
    Handle handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, process.pid));
    if (!handle) {
        if (!FindProcess(process.pid)) return;
        throw std::runtime_error("无法打开待停止进程 PID " + std::to_string(process.pid));
    }
    if (ProcessTime(handle.get()) != process.started) throw std::runtime_error("进程已更换，取消停止 PID " + std::to_string(process.pid));
    if (!TerminateProcess(handle.get(), 0) && WaitForSingleObject(handle.get(), 0) != WAIT_OBJECT_0)
        throw std::runtime_error("无法停止进程 PID " + std::to_string(process.pid));
    if (WaitForSingleObject(handle.get(), 8000) != WAIT_OBJECT_0) throw std::runtime_error("等待进程退出超时 PID " + std::to_string(process.pid));
}
std::vector<DWORD> ListenerPids(int port) {
    std::set<DWORD> result;
    for (ULONG family : {AF_INET, AF_INET6}) {
        DWORD size = 0;
        auto code = GetExtendedTcpTable(nullptr, &size, FALSE, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
        if (code != ERROR_INSUFFICIENT_BUFFER) {
            if (code == NO_ERROR) continue;
            throw std::runtime_error("无法检查监听端口");
        }
        std::vector<unsigned char> storage(size);
        code = GetExtendedTcpTable(storage.data(), &size, FALSE, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
        if (code != NO_ERROR) throw std::runtime_error("读取监听端口失败");
        if (family == AF_INET) {
            const auto table = reinterpret_cast<PMIB_TCPTABLE_OWNER_PID>(storage.data());
            for (DWORD i = 0; i < table->dwNumEntries; ++i)
                if (ntohs(static_cast<u_short>(table->table[i].dwLocalPort)) == port) result.insert(table->table[i].dwOwningPid);
        } else {
            const auto table = reinterpret_cast<PMIB_TCP6TABLE_OWNER_PID>(storage.data());
            for (DWORD i = 0; i < table->dwNumEntries; ++i)
                if (ntohs(static_cast<u_short>(table->table[i].dwLocalPort)) == port) result.insert(table->table[i].dwOwningPid);
        }
    }
    return {result.begin(), result.end()};
}
void RequestCloseWindows(const std::vector<ProcessInfo>& processes) {
    EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
        const auto& targets = *reinterpret_cast<const std::vector<ProcessInfo>*>(parameter);
        DWORD pid = 0;
        GetWindowThreadProcessId(window, &pid);
        if (std::any_of(targets.begin(), targets.end(), [&](const ProcessInfo& item) { return item.pid == pid; }))
            PostMessageW(window, WM_CLOSE, 0, 0);
        return TRUE;
    }, reinterpret_cast<LPARAM>(&processes));
}
ChildResult RunCommand(const fs::path& executable, const std::vector<std::wstring>& args,
    const fs::path& cwd, const EnvironmentChanges& environment, int timeoutMs) {
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    HANDLE read = nullptr, write = nullptr;
    if (!CreatePipe(&read, &write, &security, 0)) throw std::runtime_error("无法创建命令输出管道");
    Handle input(read), output(write);
    SetHandleInformation(input.get(), HANDLE_FLAG_INHERIT, 0);
    auto child = Spawn(executable, args, cwd, environment, output.get(), output.get());
    output = Handle();
    ChildResult result{child.pid};
    const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
    bool finished = false;
    do {
        DWORD available = 0;
        while (PeekNamedPipe(input.get(), nullptr, 0, nullptr, &available, nullptr) && available) {
            char buffer[8192];
            DWORD count = 0;
            if (!ReadFile(input.get(), buffer, std::min<DWORD>(available, sizeof(buffer)), &count, nullptr) || !count) break;
            if (result.output.size() + count <= 1024 * 1024) result.output.append(buffer, count);
            available -= count;
        }
        if (finished) break;
        finished = WaitForSingleObject(child.process.get(), 20) == WAIT_OBJECT_0;
        if (!finished && Clock::now() >= deadline) {
            TerminateProcess(child.process.get(), ERROR_TIMEOUT);
            WaitForSingleObject(child.process.get(), 2000);
            throw std::runtime_error("命令执行超时：" + Utf8(executable.filename().wstring()));
        }
    } while (true);
    GetExitCodeProcess(child.process.get(), &result.exitCode);
    return result;
}
ProcessInfo StartDetached(const fs::path& executable, const std::vector<std::wstring>& args,
    const fs::path& cwd, const EnvironmentChanges& environment, const fs::path& stdoutPath, const fs::path& stderrPath) {
    auto output = OpenOutput(stdoutPath), error = OpenOutput(stderrPath);
    auto child = Spawn(executable, args, cwd, environment, output.get(), error.get());
    return {child.pid, GetCurrentProcessId(), executable, ProcessTime(child.process.get())};
}
Json HttpJson(int port, std::string_view token, int timeoutMs) {
    Internet session(WinHttpOpen(L"CodexPhoneAssistant/1", WINHTTP_ACCESS_TYPE_NO_PROXY, nullptr, nullptr, 0));
    if (!session) return nullptr;
    WinHttpSetTimeouts(session, timeoutMs, timeoutMs, timeoutMs, timeoutMs);
    Internet connection(WinHttpConnect(session, L"127.0.0.1", static_cast<INTERNET_PORT>(port), 0));
    if (!connection) return nullptr;
    std::string query = "/api/health?token=";
    const char hex[] = "0123456789ABCDEF";
    for (unsigned char c : token) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') query += static_cast<char>(c);
        else { query += '%'; query += hex[c >> 4]; query += hex[c & 15]; }
    }
    Internet request(WinHttpOpenRequest(connection, L"GET", Wide(query).c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0));
    if (!request) return nullptr;
    DWORD redirects = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    WinHttpSetOption(request, WINHTTP_OPTION_REDIRECT_POLICY, &redirects, sizeof(redirects));
    if (!WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, nullptr, 0, 0, 0) || !WinHttpReceiveResponse(request, nullptr)) return nullptr;
    DWORD status = 0, length = sizeof(status);
    if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, nullptr, &status, &length, nullptr) || status != 200) return nullptr;
    std::string body;
    const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
    for (;;) {
        char buffer[8192]; DWORD count = 0;
        if (!WinHttpReadData(request, buffer, sizeof(buffer), &count)) return nullptr;
        if (!count) break;
        body.append(buffer, count);
        if (body.size() > 8 * 1024 * 1024 || Clock::now() >= deadline) return nullptr;
    }
    return Json::parse(body, nullptr, false);
}
void WriteOutput(std::string_view text) {
    const auto output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!output || output == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    DWORD mode = 0;
    if (GetConsoleMode(output, &mode)) {
        const auto wide = Wide(text);
        WriteConsoleW(output, wide.data(), static_cast<DWORD>(wide.size()), &written, nullptr);
    } else {
        while (!text.empty() && WriteFile(output, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) && written)
            text.remove_prefix(written);
    }
}
ActionLock::ActionLock(const fs::path& state)
    : handle_(CreateMutexW(nullptr, FALSE, (L"Local\\CodexPhoneManager_" + Wide(Sha256(Lower(Utf8(state.wstring()))).substr(0, 16))).c_str())) {
    if (!handle_) throw std::runtime_error("无法创建管理操作锁");
    const auto result = WaitForSingleObject(handle_.get(), 5000);
    acquired_ = result == WAIT_OBJECT_0 || result == WAIT_ABANDONED;
}
ActionLock::~ActionLock() { if (acquired_) ReleaseMutex(handle_.get()); }
} // namespace phone_assistant::management
