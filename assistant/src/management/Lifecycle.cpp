#include "Manager.h"

#include <algorithm>
#include <stdexcept>
#include <thread>

namespace phone_assistant::management {
EnvironmentChanges Runtime::BridgeEnvironment() const {
    return {
        {L"CODEX_PHONE_REPO_ROOT", options_.root.wstring()},
        {L"CODEX_PHONE_MODE_CONFIG", options_.config.wstring()},
        {L"CODEX_PHONE_STATE_DIR", options_.state.wstring()},
        {L"CODEX_PROXY_STATE", (options_.state / "trae-proxy.json").wstring()},
        {L"PORT", std::to_wstring(options_.port)}, {L"CODEX_PHONE_TOKEN", Wide(Token())},
        {L"CODEX_PHONE_AUTO_LIFECYCLE", options_.autoLifecycle ? std::optional<std::wstring>(L"1") : std::nullopt},
        {L"CODEX_PHONE_PROXY_GRACE_MS", options_.autoLifecycle ? std::optional<std::wstring>(L"15000") : std::nullopt},
        {L"CODEX_PHONE_RELAY_DISABLED", std::nullopt}, {L"PUBLIC_URL", std::nullopt}
    };
}
std::string Runtime::Fingerprint() const {
    auto secret = Utf8(Environment(L"CODEX_PHONE_RELAY_SECRET"));
    if (secret.empty()) secret = Config("relay.secret");
    return Sha256(Config("relay.server") + "\n" + Config("relay.agent_port", "8789") + "\n" +
        Config("relay.public_port", "8788") + "\n" + Config("phone.local_host", "127.0.0.1") + "\n" +
        std::to_string(options_.port) + "\n" + Config("relay.reconnect_delay_ms", "2000") + "\n" + secret);
}
void Runtime::CheckExtension() const {
    const auto extension = fs::path(Environment(L"USERPROFILE")) / ".trae-cn/extensions/openai.chatgpt-26.901.22334";
    if (Text(ReadJson(extension / "package.json"), "version") != "26.901.22334")
        throw std::runtime_error("当前扩展版本不匹配，需要 openai.chatgpt 26.901.22334");
    const auto cli = extension / "bin/windows-x86_64/codex.exe";
    const auto version = RunCommand(cli, {L"--version"}, options_.root, {}, 10000);
    if (version.exitCode || Trim(version.output) != "codex-cli 0.153.4")
        throw std::runtime_error("当前 codex-cli 版本不匹配，需要 0.153.4");
}
void Runtime::EnsureProxy() const {
    const auto project = options_.root / "proxy";
    bool needsBuild = !fs::is_regular_file(options_.proxy);
    if (!needsBuild) {
        const auto published = fs::last_write_time(options_.proxy);
        needsBuild = fs::last_write_time(project / "CodexPhoneProxy.csproj") > published;
        for (const auto& entry : fs::recursive_directory_iterator(project / "src"))
            if (entry.is_regular_file() && entry.path().extension() == L".cs" && entry.last_write_time() > published) needsBuild = true;
    }
    if (!needsBuild) return;
    for (const auto& process : Processes()) if (MatchesExecutable(process, options_.proxy)) return;
    const auto dotnet = fs::path(Environment(L"ProgramFiles")) / "dotnet/dotnet.exe";
    if (!fs::is_regular_file(dotnet)) throw std::runtime_error("自动构建代理需要系统 .NET SDK，请先安装 SDK 或提供已构建的代理 EXE");
    const auto temp = project / "build/temp", packages = project / "build/packages", publish = project / "build/publish";
    fs::create_directories(temp);
    const EnvironmentChanges environment{
        {L"DOTNET_CLI_TELEMETRY_OPTOUT", L"1"}, {L"DOTNET_NOLOGO", L"1"},
        {L"NUGET_PACKAGES", packages.wstring()}, {L"TEMP", temp.wstring()}, {L"TMP", temp.wstring()}
    };
    const auto result = RunCommand(dotnet, {L"publish", (project / "CodexPhoneProxy.csproj").wstring(),
        L"-c", L"Release", L"-r", L"win-x64", L"-o", publish.wstring()}, project, environment, options_.timeoutMs);
    if (result.exitCode) throw std::runtime_error("代理构建失败：" + Trim(result.output));
    fs::create_directories(options_.proxy.parent_path());
    fs::copy_file(publish / "codex-phone.exe", options_.proxy, fs::copy_options::overwrite_existing);
}
void Runtime::ChangeMode(bool enable) {
    auto source = fs::exists(options_.settings) ? ReadText(options_.settings) : "{}\n";
    if (Trim(source).empty()) source = "{}\n";
    const auto current = ReadCliSetting(source);
    const auto previous = ReadJson(modeFile_);
    if (enable) {
        if (!options_.isolated) { CheckExtension(); EnsureProxy(); }
        if (!fs::is_regular_file(options_.proxy)) throw std::runtime_error("代理 EXE 不存在，请先构建 proxy 工程");
    } else if (!current.value.empty() && !SamePath(fs::path(Wide(current.value)), options_.proxy)) {
        throw std::runtime_error("chatgpt.cliExecutable 已指向其他程序，已取消恢复以保留该配置");
    }
    const bool alreadyEnabled = SamePath(fs::path(Wide(current.value)), options_.proxy);
    if (enable && alreadyEnabled && previous.is_null())
        throw std::runtime_error("代理已配置，但缺少原配置恢复记录；已保留当前设置");
    const bool hadOriginal = enable && !alreadyEnabled ? current.present : Flag(previous, "previousCliExecutablePresent");
    const auto original = enable && !alreadyEnabled ? current.value : Text(previous, "previousCliExecutable");
    const auto replacement = enable ? std::optional<std::string>(Utf8(options_.proxy.wstring())) :
        hadOriginal ? std::optional<std::string>(original) : std::nullopt;
    const auto updated = EditCliSetting(source, replacement);
    fs::create_directories(options_.state);
    fs::path backup;
    if (fs::exists(options_.settings)) {
        backup = options_.state / ("trae-settings-before-phone-mode-" + std::to_string(NowTicks()) + ".json");
        fs::copy_file(options_.settings, backup);
    }
    const auto previousStateText = fs::exists(modeFile_) ? std::optional<std::string>(ReadText(modeFile_)) : std::nullopt;
    const Json state = {
        {"mode", enable ? "phone" : "native"}, {"settingsPath", Utf8(options_.settings.wstring())},
        {"shimPath", Utf8(options_.proxy.wstring())}, {"backupPath", Utf8(backup.wstring())},
        {"previousCliExecutablePresent", hadOriginal}, {"previousCliExecutable", original},
        {"restartRequired", true}, {"isolated", options_.isolated}, {"updatedAt", Timestamp()}
    };
    // Persist restoration metadata before switching the setting, and roll it back on failure.
    WriteJson(modeFile_, state);
    try { WriteAtomic(options_.settings, updated); }
    catch (...) {
        if (previousStateText) WriteAtomic(modeFile_, *previousStateText);
        else fs::remove(modeFile_);
        throw;
    }
}
bool Runtime::WritePause(const Json& status) {
    if (!Flag(status, "traeOnline") || Text(status, "traeSessionId").empty()) { ClearPause(); return false; }
    WriteJson(pauseFile_, {{"paused", true}, {"traeSessionId", Text(status, "traeSessionId")},
        {"traePid", Pid(status, "traePid")}, {"traeStartedAt", Text(status, "traeStartedAt")}, {"createdAt", Timestamp()}});
    return true;
}
void Runtime::ClearPause() { fs::remove(pauseFile_); }
void Runtime::ClearStalePause(std::string_view session) {
    const auto pause = ReadJson(pauseFile_);
    if (!pause.is_null() && !session.empty() && Text(pause, "traeSessionId") != session) ClearPause();
}
void Runtime::StopBridge() {
    for (const auto& process : Bridges()) StopProcess(process);
}
void Runtime::StartBridge(bool restart, bool autoLifecycle) {
    if (Lower(Config("phone.mode")) != "relay") throw std::runtime_error("phone.mode 必须为 relay");
    if (!fs::is_regular_file(options_.bridge)) throw std::runtime_error("手机桥 EXE 不存在，请先构建 server 工程");
    if (SamePath(options_.bridge, options_.proxy) || SamePath(options_.bridge, ExecutablePath()))
        throw std::runtime_error("手机桥路径不能指向代理或助手");
    options_.autoLifecycle = autoLifecycle;
    const auto environment = BridgeEnvironment();
    const auto preflight = RunCommand(options_.bridge, {L"--check"}, options_.root, environment, 15000);
    if (preflight.exitCode) throw std::runtime_error("手机桥配置校验失败：" + Trim(preflight.output));
    const auto listeners = ListenerPids(options_.port);
    for (const auto pid : listeners) {
        const auto process = FindProcess(pid);
        if (!process || !MatchesExecutable(*process, options_.bridge))
            throw std::runtime_error("端口 " + std::to_string(options_.port) + " 已被其他程序占用（PID " + std::to_string(pid) + "）");
    }
    auto current = Observe();
    // Recheck a failed health probe before replacing any existing connection.
    for (int attempt = 0; current.bridge && !Flag(current.status, "bridgeHealthy") && attempt < 2; ++attempt) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        current = Observe();
    }
    const auto& access = Field(current.health, "publicAccess");
    const auto codexStatus = Text(Field(current.health, "codex"), "status");
    const auto relayStatus = Text(access, "relayStatus");
    const bool reusable = current.bridge && !restart && Flag(current.status, "bridgeHealthy") &&
        Flag(current.status, "bridgeInstanceRouting") && Text(access, "mode") == "relay" &&
        (codexStatus == "starting" || codexStatus == "connected" || codexStatus == "disconnected") &&
        Flag(access, "relayIntegrated") && Pid(access, "relayPid") == current.bridge->pid &&
        Text(access, "relayConfigFingerprint") == Fingerprint() &&
        (relayStatus == "starting" || relayStatus == "connecting" || relayStatus == "connected" || relayStatus == "disconnected") &&
        (!autoLifecycle || Flag(current.status, "bridgeAutoLifecycle"));
    if (reusable) return;
    CheckDeadline();
    for (const auto& process : Bridges()) StopProcess(process);
    fs::create_directories(options_.state);
    fs::remove(options_.state / "relay-agent.json");
    const auto stem = "phone-bridge-" + std::to_string(options_.port);
    const auto stdoutPath = options_.state / (stem + ".out.log"), stderrPath = options_.state / (stem + ".err.log");
    const auto child = StartDetached(options_.bridge, {}, options_.root, environment, stdoutPath, stderrPath);
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    if (!FindProcess(child.pid)) throw std::runtime_error("手机桥启动后立即退出：" + ReadText(stderrPath));
}
void Runtime::WaitReady() {
    do {
        const auto current = Observe();
        if (Flag(current.status, "bridgeConnected") && Flag(current.status, "bridgeAutoLifecycle") &&
            Flag(current.status, "publicConnected")) return;
        CheckDeadline();
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    } while (true);
}
void Runtime::Shutdown() {
    if (options_.isolated) throw std::runtime_error("Shutdown 不允许用于隔离管理");
    const auto processes = Processes();
    std::vector<ProcessInfo> trae, proxies, upstream;
    const auto states = ProxyStates(processes);
    for (const auto& process : processes) {
        if (Lower(Utf8(process.path.filename().wstring())) == "trae cn.exe") trae.push_back(process);
        if (MatchesExecutable(process, options_.proxy)) proxies.push_back(process);
        for (const auto& state : states)
            if (process.pid == Pid(state, "upstreamPid") && process.parent == Pid(state, "pid")) upstream.push_back(process);
    }
    StopBridge();
    RequestCloseWindows(trae);
    const auto deadline = Clock::now() + std::chrono::seconds(8);
    while (Clock::now() < deadline && std::any_of(trae.begin(), trae.end(), [](const ProcessInfo& p) { return FindProcess(p.pid).has_value(); }))
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    for (const auto* group : {&trae, &proxies, &upstream})
        for (const auto& process : *group) StopProcess(process);
}
} // namespace phone_assistant::management
