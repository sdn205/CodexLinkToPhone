#include "Manager.h"

#include <algorithm>
#include <stdexcept>
#include <thread>

namespace phone_assistant::management {
EnvironmentChanges Runtime::BridgeEnvironment() const {
    return {
        {L"CODEX_PHONE_REPO_ROOT", options_.root.wstring()},
        {L"CODEX_PHONE_MODE_CONFIG", options_.config.wstring()},
        {L"CODEX_PHONE_STATE_DIR", options_.bridgeData.wstring()},
        {L"CODEX_PROXY_REGISTRY", options_.proxyRegistry.wstring()},
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
void Runtime::CheckExtension(const EditorProfile& editor) const {
    const auto cli = FindExtensionCli(editor.extensions, "26.901.22334");
    const auto version = RunCommand(cli, {L"--version"}, options_.root, {}, 10000);
    if (version.exitCode || Trim(version.output) != "codex-cli 0.153.4")
        throw std::runtime_error(editor.name + " 扩展内 codex-cli 版本不匹配，需要 0.153.4");
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
    const auto profiles = EditorProfiles();
    if (profiles.empty()) throw std::runtime_error("没有可管理的编辑器");
    for (const auto& editor : profiles) {
        const auto source = fs::exists(editor.settings) ? ReadText(editor.settings) : "{}";
        const auto current = ReadCliSetting(Trim(source).empty() ? "{}" : source);
        if (enable && !options_.isolated) CheckExtension(editor);
        if (enable && SamePath(fs::path(Wide(current.value)), options_.proxy) && ProxySettingState(editor).is_null())
            throw std::runtime_error(editor.name + " 缺少原配置恢复记录，已保留当前设置");
        if (!enable && !current.value.empty() && !SamePath(fs::path(Wide(current.value)), options_.proxy)) {
            const auto previous = ProxySettingState(editor);
            if (!previous.is_null() && current.value != Text(previous, "previousCliExecutable"))
                throw std::runtime_error(editor.name + " CLI 已指向其他程序，已保留该配置");
        }
    }
    if (enable && !options_.isolated) EnsureProxy();
    for (const auto& editor : profiles) ChangeEditorMode(editor, enable);
}
void Runtime::ChangeEditorMode(const EditorProfile& editor, bool enable) {
    auto source = fs::exists(editor.settings) ? ReadText(editor.settings) : "{}\n";
    if (Trim(source).empty()) source = "{}\n";
    const auto current = ReadCliSetting(source);
    const auto previous = ProxySettingState(editor);
    if (enable) {
        if (!fs::is_regular_file(options_.proxy)) throw std::runtime_error("代理 EXE 不存在，请先构建 proxy 工程");
    }
    if (!enable && !SamePath(fs::path(Wide(current.value)), options_.proxy)) return;
    const bool alreadyEnabled = SamePath(fs::path(Wide(current.value)), options_.proxy);
    if (enable && alreadyEnabled && previous.is_null())
        throw std::runtime_error("代理已配置，但缺少原配置恢复记录；已保留当前设置");
    const bool hadOriginal = enable && !alreadyEnabled ? current.present : Flag(previous, "previousCliExecutablePresent");
    const auto original = enable && !alreadyEnabled ? current.value : Text(previous, "previousCliExecutable");
    const auto replacement = enable ? std::optional<std::string>(Utf8(options_.proxy.wstring())) :
        hadOriginal ? std::optional<std::string>(original) : std::nullopt;
    const auto updated = EditCliSetting(source, replacement);
    fs::create_directories(options_.backups);
    fs::path backup;
    if (fs::exists(editor.settings)) {
        backup = options_.backups / (editor.id + "-settings-before-phone-mode-" + std::to_string(NowTicks()) + ".json");
        fs::copy_file(editor.settings, backup);
    }
    const Json state = {
        {"settingsPath", Utf8(editor.settings.wstring())}, {"backupPath", Utf8(backup.wstring())},
        {"previousCliExecutablePresent", hadOriginal}, {"previousCliExecutable", original},
        {"updatedAt", Timestamp()}
    };
    // Persist restoration metadata before switching the setting, and roll it back on failure.
    SaveProxySettingState(editor, state);
    try { WriteAtomic(editor.settings, updated); }
    catch (...) {
        SaveProxySettingState(editor, previous);
        throw;
    }
}
bool Runtime::WritePause(const Json& status) {
    const auto sessions = Field(status, "editorSessions");
    if (!sessions.is_array() || sessions.empty()) { ClearPause(); return false; }
    WriteStateSection("pause", {{"paused", true}, {"sessions", sessions},
        {"traeSessionId", Text(status, "traeSessionId")}, {"createdAt", Timestamp()}});
    return true;
}
void Runtime::ClearPause() { WriteStateSection("pause", nullptr); }
void Runtime::ClearStalePause(std::string_view) {
    // The caller already checked the current observation. A second health
    // probe here needlessly delays startup while the bridge is stopped.
    ClearPause();
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
    fs::create_directories(options_.bridgeLogs);
    const auto stem = "phone-bridge-" + std::to_string(options_.port);
    const auto stdoutPath = options_.bridgeLogs / (stem + ".out.log"), stderrPath = options_.bridgeLogs / (stem + ".err.log");
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
        const auto name = Lower(Utf8(process.path.filename().wstring()));
        if ((name == "trae cn.exe" && options_.editor != "vscode") || (name == "code.exe" && options_.editor != "trae")) trae.push_back(process);
        for (const auto& state : states) {
            const auto editor = Text(EditorContext(state, processes), "editorId");
            if (options_.editor != "all" && options_.editor != editor) continue;
            if (process.pid == Pid(state, "pid") && MatchesExecutable(process, options_.proxy)) proxies.push_back(process);
            if (process.pid == Pid(state, "upstreamPid") && process.parent == Pid(state, "pid")) upstream.push_back(process);
        }
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
