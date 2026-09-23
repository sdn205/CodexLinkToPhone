#pragma once

#include <chrono>
#include <filesystem>
#include <string>

namespace phone_assistant {

enum class ManagerAction {
    Enable,
    Disable,
    Restart,
    Stop,
    Status,
};

enum class StatusLevel {
    Unknown,
    Ok,
    Warning,
    Error,
};

struct ComponentStatus {
    std::wstring text = L"正在读取...";
    StatusLevel level = StatusLevel::Unknown;
};

struct ManagerSnapshot {
    ComponentStatus trae;
    ComponentStatus proxy;
    ComponentStatus bridge;
    ComponentStatus publicConnection;

    bool operationSuccess = false;
    std::wstring message;
    std::wstring recentAction;
};

struct ManagerResult {
    ManagerAction action = ManagerAction::Status;
    bool processStarted = false;
    bool timedOut = false;
    unsigned long exitCode = 1;
    std::wstring rawOutput;
    std::wstring processError;
    ManagerSnapshot snapshot;
};

[[nodiscard]] std::wstring ActionArgument(ManagerAction action);
[[nodiscard]] ManagerResult ParseManagerOutput(
    ManagerAction action,
    unsigned long exitCode,
    std::wstring_view output);
[[nodiscard]] ManagerResult RunManager(
    ManagerAction action,
    std::chrono::milliseconds timeout);

}  // namespace phone_assistant
