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
Json Runtime::ProxyStates(const std::vector<ProcessInfo>& processes) const {
    auto states = Json::array();
    const auto directory = options_.proxyRegistry;
    if (!fs::is_directory(directory)) return states;
    const auto alive = [&](DWORD pid) -> const ProcessInfo* {
        const auto found = std::find_if(processes.begin(), processes.end(), [&](const ProcessInfo& process) { return process.pid == pid; });
        return found == processes.end() ? nullptr : &*found;
    };
    for (const auto& file : fs::directory_iterator(directory)) {
        if (!file.is_regular_file() || file.path().extension() != L".json") continue;
        auto state = ReadJson(file.path());
        if (Text(state, "mode") != "stdio-tee" || Text(state, "instanceId").empty() ||
            !Field(state, "loadedThreadIds").is_array() || !Flag(state, "initialized") || !Flag(state, "upstreamConnected")) continue;
        const auto updated = ParseTime(Text(state, "updatedAt")), started = ParseTime(Text(state, "startedAt"));
        const auto process = alive(Pid(state, "pid"));
        if (!updated || NowTicks() - *updated > 30LL * 10000000 || *updated - NowTicks() > 30LL * 10000000 ||
            !started || !process || std::abs(process->started - *started) > 30LL * 10000000 || !alive(Pid(state, "upstreamPid"))) continue;
        if (!options_.isolated && !MatchesExecutable(*process, options_.proxy)) continue;
        states.push_back(std::move(state));
    }
    std::sort(states.begin(), states.end(), [](const Json& a, const Json& b) {
        return std::pair{Text(a, "startedAt"), Text(a, "instanceId")} < std::pair{Text(b, "startedAt"), Text(b, "instanceId")};
    });
    return states;
}
Json Runtime::TraeContext(const Json& selected, const std::vector<ProcessInfo>& processes) const {
    const auto find = [&](DWORD pid) -> const ProcessInfo* {
        const auto found = std::find_if(processes.begin(), processes.end(), [&](const ProcessInfo& item) { return item.pid == pid; });
        return found == processes.end() ? nullptr : &*found;
    };
    if (!Text(selected, "traeSessionId").empty()) {
        const auto pid = Pid(selected, "traePid");
        return {{"online", pid ? find(pid) != nullptr : !selected.is_null()}, {"pid", pid},
            {"sessionId", Text(selected, "traeSessionId")}, {"startedAt", Text(selected, "traeStartedAt")}};
    }
    const ProcessInfo* candidate = nullptr;
    DWORD next = Pid(selected, "pid");
    std::set<DWORD> visited;
    for (int depth = 0; depth < 20 && next && visited.insert(next).second; ++depth) {
        const auto process = find(next);
        if (!process) break;
        if (Lower(Utf8(process->path.filename().wstring())) == "trae cn.exe") candidate = process;
        next = process->parent;
    }
    if (!candidate && !options_.isolated) {
        for (const auto& process : processes) {
            if (Lower(Utf8(process.path.filename().wstring())) != "trae cn.exe") continue;
            const auto command = CommandLine(process.pid);
            if (command.find(L"--type=") != command.npos || command.find(L"--node-ipc") != command.npos) continue;
            if (!candidate || process.started < candidate->started) candidate = &process;
        }
    }
    if (candidate) return {{"online", true}, {"pid", candidate->pid},
        {"sessionId", std::to_string(candidate->pid) + ":" + std::to_string(candidate->started + 504911232000000000LL)},
        {"startedAt", ""}};
    if (!selected.is_null()) return {{"online", true}, {"pid", 0},
        {"sessionId", "proxy:" + std::to_string(Pid(selected, "pid")) + ":" + Text(selected, "startedAt")},
        {"startedAt", Text(selected, "startedAt")}};
    return {{"online", false}, {"pid", 0}, {"sessionId", ""}, {"startedAt", ""}};
}
Runtime::Observation Runtime::Observe() const {
    Observation result;
    const auto settings = fs::exists(options_.settings) ? ReadText(options_.settings) : "{}";
    const auto cli = ReadCliSetting(Trim(settings).empty() ? "{}" : settings);
    const auto mode = SamePath(fs::path(Wide(cli.value)), options_.proxy) ? "phone" : cli.value.empty() ? "native" : "custom";
    const auto processes = Processes();
    result.proxies = ProxyStates(processes);
    for (const auto& state : result.proxies) {
        if (!options_.proxyPid || Pid(state, "pid") == options_.proxyPid) { result.selected = state; break; }
    }
    const auto trae = TraeContext(result.selected, processes);
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
    if (instances.is_array()) for (const auto& item : instances) if (Flag(item, "connected")) connected.insert(Text(item, "instanceId"));
    const bool allConnected = std::all_of(result.proxies.begin(), result.proxies.end(),
        [&](const Json& proxy) { return connected.contains(Text(proxy, "instanceId")); });
    const auto publicMode = healthy ? Text(access, "mode", Config("phone.mode", "unknown")) : Config("phone.mode", "unknown");
    const auto publicStatus = healthy && publicMode == "relay" ? Text(access, "relayStatus", "unknown") : "stopped";
    const bool publicConnected = healthy && publicMode == "relay" && publicStatus == "connected" &&
        Flag(access, "relayIntegrated") && Pid(access, "relayPid") == reportedPid && reportedPid;
    const auto pause = StateSection("pause"), recent = StateSection("recent");
    auto pids = Json::array();
    for (const auto& state : result.proxies) pids.push_back(Pid(state, "pid"));
    result.status = {
        {"traeOnline", Flag(trae, "online")}, {"traePid", Pid(trae, "pid")},
        {"traeSessionId", Text(trae, "sessionId")}, {"traeStartedAt", Text(trae, "startedAt")},
        {"proxyMode", mode}, {"proxyConfigured", std::string_view(mode) == "phone"}, {"cliExecutable", cli.value},
        {"proxyConnected", !result.proxies.empty()}, {"proxyPid", Pid(result.selected, "pid")}, {"proxyPids", pids},
        {"proxyInstanceCount", result.proxies.size()}, {"bridgeRunning", result.bridge.has_value()}, {"bridgeHealthy", healthy},
        {"bridgeConnected", healthy && !result.proxies.empty() && Text(codex, "status") == "connected" && allConnected},
        {"bridgePid", result.bridge ? result.bridge->pid : 0}, {"bridgeAutoLifecycle", healthy && Flag(app, "autoLifecycleEnabled")},
        {"bridgeInstanceRouting", healthy && instances.is_array()}, {"publicMode", publicMode},
        {"publicConnected", publicConnected}, {"publicStatus", publicStatus},
        {"paused", Flag(trae, "online") && !Text(trae, "sessionId").empty() && Text(pause, "traeSessionId") == Text(trae, "sessionId")},
        {"recentAction", Text(recent, "message")}, {"recentActionSuccess", Field(recent, "success")},
        {"recentActionAt", Text(recent, "completedAt")}
    };
    return result;
}
} // namespace phone_assistant::management
