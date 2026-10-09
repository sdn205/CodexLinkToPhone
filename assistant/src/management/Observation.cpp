#include "Manager.h"
#include <algorithm>
#include <stdexcept>

namespace phone_assistant::management {
Runtime::Runtime(const Options& options)
    : options_(options), config_(ReadIni(options.config)),
      stateFile_(options.state / "state.json"),
      deadline_(Clock::now() + std::chrono::milliseconds(options.timeoutMs)) {
    if (!options_.port) {
        const auto text = Config("phone.local_port", "8787");
        size_t parsed = 0;
        options_.port = std::stoi(text, &parsed);
        if (parsed != text.size() || options_.port < 1 || options_.port > 65535) throw std::runtime_error("phone.local_port 超出有效范围");
    }
}
Json Runtime::StateSection(std::string_view name) const {
    return Field(ReadJson(stateFile_), name);
}
void Runtime::WriteStateSection(std::string_view name, const Json& value) {
    auto state = ReadJson(stateFile_);
    if (!state.is_object()) state = Json::object();
    state["version"] = 1;
    if (value.is_null()) state.erase(std::string(name));
    else state[std::string(name)] = value;
    WriteJson(stateFile_, state);
}
std::string Runtime::Config(std::string_view name, std::string fallback) const {
    const auto found = config_.find(std::string(name));
    return found == config_.end() || found->second.empty() ? fallback : found->second;
}
std::string Runtime::Token() const {
    const auto environment = Environment(L"CODEX_PHONE_TOKEN");
    return environment.empty() ? Config("phone.token", "codex-phone") : Utf8(environment);
}
void Runtime::CheckDeadline() const {
    if (Clock::now() >= deadline_) throw std::runtime_error("管理操作超时");
}
std::vector<ProcessInfo> Runtime::Bridges() const {
    std::vector<ProcessInfo> result;
    for (const auto& process : Processes()) {
        if (!MatchesExecutable(process, options_.bridge)) continue;
        // A copied executable per isolated test keeps PID ownership unambiguous.
        if (process.pid == GetCurrentProcessId() || SamePath(process.path, options_.proxy))
            throw std::runtime_error("手机桥路径不能指向管理器或代理");
        result.push_back(process);
    }
    return result;
}
bool Runtime::ValidProxy(const Json& state, const std::vector<ProcessInfo>& processes) const {
    const auto alive = [&](DWORD pid) -> const ProcessInfo* {
        const auto found = std::find_if(processes.begin(), processes.end(), [&](const ProcessInfo& process) { return process.pid == pid; });
        return found == processes.end() ? nullptr : &*found;
    };
    if (Text(state, "mode") != "stdio-tee" || Text(state, "instanceId").empty() ||
        !Field(state, "loadedThreadIds").is_array() || !Flag(state, "initialized") || !Flag(state, "upstreamConnected")) return false;
    const auto started = ParseTime(Text(state, "startedAt"));
    const auto process = alive(Pid(state, "pid"));
    return started && process && std::abs(process->started - *started) <= 30LL * 10000000 &&
        alive(Pid(state, "upstreamPid")) && (options_.isolated || MatchesExecutable(*process, options_.proxy));
}
Json Runtime::ProxyStates(const std::vector<ProcessInfo>& processes) const {
    auto states = Json::array();
    std::error_code error;
    const auto end = fs::directory_iterator();
    for (auto it = fs::directory_iterator(options_.proxyRegistry, error); !error && it != end; it.increment(error)) {
        if (it->path().extension() != L".json") continue;
        auto state = ReadRegistryJson(it->path());
        if (it->path().filename() != Wide(Text(state, "instanceId") + ".json") || !ValidProxy(state, processes)) continue;
        const auto updated = ParseTime(Text(state, "updatedAt"));
        if (!updated || std::abs(NowTicks() - *updated) > 30LL * 10000000) continue;
        states.push_back(std::move(state));
    }
    std::sort(states.begin(), states.end(), [](const Json& a, const Json& b) {
        return std::pair{Text(a, "startedAt"), Text(a, "instanceId")} < std::pair{Text(b, "startedAt"), Text(b, "instanceId")};
    });
    return states;
}
Runtime::Observation Runtime::Observe() const {
    Observation result;
    const auto processes = Processes();
    result.proxies = ProxyStates(processes);
    const auto listeners = ListenerPids(options_.port);
    for (const auto& process : processes) {
        if (MatchesExecutable(process, options_.bridge) && (!result.bridge ||
            std::find(listeners.begin(), listeners.end(), process.pid) != listeners.end())) result.bridge = process;
    }
    result.health = HttpJson(options_.port, Token(), 1000);
    const auto reportedPid = Pid(Field(result.health, "app"), "pid");
    // Health responses alone never grant permission to manage an unrelated process.
    const auto reported = std::find_if(processes.begin(), processes.end(), [&](const ProcessInfo& item) {
        return item.pid == reportedPid && MatchesExecutable(item, options_.bridge);
    });
    if (reported == processes.end()) result.health = nullptr;
    else result.bridge = *reported;
    const bool healthy = result.bridge && result.health.is_object();
    const auto& app = Field(result.health, "app");
    const auto& codex = Field(result.health, "codex");
    const auto& access = Field(result.health, "publicAccess");
    const auto& instances = Field(Field(codex, "info"), "instances");
    std::set<std::string> connected;
    if (instances.is_array()) for (const auto& item : instances) {
        if (!Flag(item, "connected")) continue;
        Json live{{"mode", "stdio-tee"}, {"instanceId", Text(item, "instanceId")},
            {"pid", Pid(item, "proxyPid")}, {"upstreamPid", Pid(item, "upstreamPid")},
            {"startedAt", Text(item, "startedAt")}, {"loadedThreadIds", Field(item, "loadedThreadIds")},
            {"initialized", true}, {"upstreamConnected", true}};
        if (!ValidProxy(live, processes)) continue;
        connected.insert(Text(item, "instanceId"));
        if (std::none_of(result.proxies.begin(), result.proxies.end(), [&](const Json& record) {
            return Text(record, "instanceId") == Text(live, "instanceId");
        })) result.proxies.push_back(std::move(live));
    }
    for (const auto& state : result.proxies) {
        if (!options_.proxyPid || Pid(state, "pid") == options_.proxyPid) { result.selected = state; break; }
    }
    const auto trae = EditorContext(result.selected, processes, options_.editor == "all" ? "" : options_.editor);
    const auto sessions = EditorSessions(processes, result.proxies);
    const auto profiles = EditorProfiles();
    bool configured = false, custom = false;
    std::string cliValue, editorStatus, proxyStatus;
    const auto triggerEditor = options_.automatic ? Text(EditorContext(result.selected, processes), "editorId") : "";
    for (const auto& profile : profiles) {
        const auto content = fs::exists(profile.settings) ? ReadText(profile.settings) : "{}";
        const auto setting = ReadCliSetting(Trim(content).empty() ? "{}" : content);
        const bool enabled = SamePath(fs::path(Wide(setting.value)), options_.proxy);
        if (triggerEditor.empty() || triggerEditor == profile.id) { configured |= enabled; custom |= !enabled && !setting.value.empty(); cliValue = setting.value; }
        const bool online = std::any_of(sessions.begin(), sessions.end(), [&](const Json& x) { return Text(x, "editorId") == profile.id; });
        if (!editorStatus.empty()) { editorStatus += "；"; proxyStatus += "；"; }
        editorStatus += profile.name + (online ? " 运行中" : " 未运行");
        proxyStatus += profile.name + (enabled ? " 已开启" : " 未开启");
    }
    const std::string mode = configured ? "phone" : custom ? "custom" : "native";
    const bool allConnected = std::all_of(result.proxies.begin(), result.proxies.end(),
        [&](const Json& proxy) { return connected.contains(Text(proxy, "instanceId")); });
    const auto publicMode = healthy ? Text(access, "mode", Config("phone.mode", "unknown")) : Config("phone.mode", "unknown");
    const auto publicStatus = healthy && publicMode == "relay" ? Text(access, "relayStatus", "unknown") : "stopped";
    const bool publicConnected = healthy && publicMode == "relay" && publicStatus == "connected" &&
        Flag(access, "relayIntegrated") && Pid(access, "relayPid") == reportedPid && reportedPid;
    const auto pause = StateSection("pause"), recent = StateSection("recent");
    auto pids = Json::array();
    for (const auto& state : result.proxies) pids.push_back(Pid(state, "pid"));
    bool paused = false;
    if (Field(pause, "sessions").is_array()) {
        for (const auto& current : sessions) for (const auto& previous : Field(pause, "sessions"))
            paused |= Text(current, "sessionId") == Text(previous, "sessionId");
    } else paused = Flag(trae, "online") && !Text(trae, "sessionId").empty() && Text(pause, "traeSessionId") == Text(trae, "sessionId");
    result.status = {
        {"traeOnline", Flag(trae, "online")}, {"traePid", Pid(trae, "pid")},
        {"traeSessionId", Text(trae, "sessionId")}, {"traeStartedAt", Text(trae, "startedAt")},
        {"editorOnline", !sessions.empty()}, {"editorStatus", editorStatus}, {"editorSessions", sessions},
        {"proxyMode", mode}, {"proxyConfigured", configured}, {"proxyStatus", options_.isolated ? "" : proxyStatus}, {"cliExecutable", cliValue},
        {"proxyConnected", !result.proxies.empty()}, {"proxyPid", Pid(result.selected, "pid")}, {"proxyPids", pids},
        {"proxyInstanceCount", result.proxies.size()}, {"bridgeRunning", result.bridge.has_value()}, {"bridgeHealthy", healthy},
        {"bridgeConnected", healthy && !result.proxies.empty() && Text(codex, "status") == "connected" && allConnected},
        {"bridgePid", result.bridge ? result.bridge->pid : 0}, {"bridgeAutoLifecycle", healthy && Flag(app, "autoLifecycleEnabled")},
        {"bridgeInstanceRouting", healthy && instances.is_array()}, {"publicMode", publicMode},
        {"publicConnected", publicConnected}, {"publicStatus", publicStatus},
        {"paused", paused},
        {"recentAction", Text(recent, "message")}, {"recentActionSuccess", Field(recent, "success")},
        {"recentActionAt", Text(recent, "completedAt")}
    };
    return result;
}
} // namespace phone_assistant::management
