#pragma once
#include "Common.h"
#include "Windows.h"
#include <set>

namespace phone_assistant::management {

struct Reply {
    int exitCode = 0;
    Json value;
};
Reply Execute(const Options& options);
std::string GuiOutput(const Json& result);
int CommandMain(const std::vector<std::wstring>& arguments);

class Runtime {
public:
    explicit Runtime(const Options& options);
    Reply Run();
private:
    Options options_;
    std::map<std::string, std::string> config_;
    fs::path stateFile_;
    Json StateSection(std::string_view name) const;
    void WriteStateSection(std::string_view name, const Json& value);
    Clock::time_point deadline_;
    struct Observation {
        Json status;
        Json proxies = Json::array();
        Json selected;
        Json health;
        std::optional<ProcessInfo> bridge;
    };
    std::string Config(std::string_view name, std::string fallback = {}) const;
    std::string Token() const;
    EnvironmentChanges BridgeEnvironment() const;
    std::string Fingerprint() const;
    std::vector<ProcessInfo> Bridges() const;
    Json ProxyStates(const std::vector<ProcessInfo>& processes) const;
    Json TraeContext(const Json& selected, const std::vector<ProcessInfo>& processes) const;
    Observation Observe() const;
    void ChangeMode(bool enable);
    void CheckExtension() const;
    void EnsureProxy() const;
    void StopBridge();
    void StartBridge(bool restart, bool autoLifecycle);
    void WaitReady();
    bool WritePause(const Json& status);
    void ClearPause();
    void ClearStalePause(std::string_view session);
    void Shutdown();
    std::pair<std::string, std::string> Act();
    void CheckDeadline() const;
};

} // namespace phone_assistant::management
