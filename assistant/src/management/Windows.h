#pragma once
#include "Common.h"

#include <windows.h>
#include <utility>

namespace phone_assistant::management {

class Handle {
public:
    explicit Handle(HANDLE value = nullptr) : value_(value) {}
    ~Handle() { if (*this) CloseHandle(value_); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    Handle(Handle&& other) noexcept : value_(std::exchange(other.value_, nullptr)) {}
    Handle& operator=(Handle&& other) noexcept {
        if (this != &other) { if (*this) CloseHandle(value_); value_ = std::exchange(other.value_, nullptr); }
        return *this;
    }
    HANDLE get() const { return value_; }
    explicit operator bool() const { return value_ && value_ != INVALID_HANDLE_VALUE; }
private:
    HANDLE value_;
};
struct ProcessInfo {
    DWORD pid = 0, parent = 0;
    fs::path path;
    std::int64_t started = 0;
};
std::optional<ProcessInfo> FindProcess(DWORD pid);
bool MatchesExecutable(const ProcessInfo& process, const fs::path& expected);
std::vector<ProcessInfo> Processes();
std::wstring CommandLine(DWORD pid);
void StopProcess(const ProcessInfo& process);
std::vector<DWORD> ListenerPids(int port);
void RequestCloseWindows(const std::vector<ProcessInfo>& processes);

using EnvironmentChanges = std::map<std::wstring, std::optional<std::wstring>>;
struct ChildResult { DWORD pid = 0, exitCode = 1; std::string output; };
ChildResult RunCommand(const fs::path& executable, const std::vector<std::wstring>& args,
    const fs::path& cwd, const EnvironmentChanges& environment, int timeoutMs);
ProcessInfo StartDetached(const fs::path& executable, const std::vector<std::wstring>& args,
    const fs::path& cwd, const EnvironmentChanges& environment, const fs::path& stdoutPath, const fs::path& stderrPath);
Json HttpJson(int port, std::string_view token, int timeoutMs);
Json ReadRegistryJson(const fs::path& path);
void WriteOutput(std::string_view text);

class ActionLock {
public:
    explicit ActionLock(const fs::path& state);
    ~ActionLock();
    bool acquired() const { return acquired_; }
private:
    Handle handle_;
    bool acquired_ = false;
};
} // namespace phone_assistant::management
