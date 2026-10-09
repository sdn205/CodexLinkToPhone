#include "Manager.h"
#include <algorithm>
#include <stdexcept>

namespace phone_assistant::management {
fs::path FindExtensionCli(const fs::path& extensions, std::string_view version) {
    const auto registry = ReadJson(extensions / "extensions.json");
    if (registry.is_array()) for (const auto& entry : registry) {
        if (Text(Field(entry, "identifier"), "id") != "openai.chatgpt" || Text(entry, "version") != version) continue;
        const auto relative = fs::path(Wide(Text(entry, "relativeLocation")));
        const auto installed = fs::absolute(extensions / relative).lexically_normal();
        const auto within = installed.lexically_relative(fs::absolute(extensions).lexically_normal());
        if (relative.empty() || relative.is_absolute() || within.empty() || *within.begin() == L"..")
            throw std::runtime_error("Codex 扩展登记路径无效");
        if (Text(ReadJson(installed / "package.json"), "version") != version)
            throw std::runtime_error("Codex 扩展版本与安装登记不一致");
        const auto cli = installed / "bin/windows-x86_64/codex.exe";
        if (!fs::is_regular_file(cli)) throw std::runtime_error("扩展缺少 Codex CLI: " + Utf8(cli.wstring()));
        return cli;
    }
    throw std::runtime_error("需要在 " + Utf8(extensions.wstring()) + " 安装 openai.chatgpt " + std::string(version));
}
namespace {
std::string EditorId(const ProcessInfo& process) {
    const auto name = Lower(Utf8(process.path.filename().wstring()));
    return name == "trae cn.exe" ? "trae" : name == "code.exe" ? "vscode" : "";
}
}
std::vector<Runtime::EditorProfile> Runtime::EditorProfiles(bool all) const {
    const auto home = fs::path(Environment(L"USERPROFILE"));
    std::vector<EditorProfile> profiles{
        {"trae", "Trae", options_.settings, home / ".trae-cn/extensions"},
        {"vscode", "VS Code", options_.vscodeSettings, home / ".vscode/extensions"}};
    std::erase_if(profiles, [&](const EditorProfile& p) {
        return p.settings.empty() || (!all && options_.editor != "all" && options_.editor != p.id) ||
            (!options_.isolated && options_.editor == "all" && !fs::exists(p.settings) && !fs::exists(p.extensions));
    });
    return profiles;
}
Json Runtime::ProxySettingState(const EditorProfile& editor) const {
    if (options_.isolated && options_.vscodeSettings.empty()) return StateSection("proxy");
    auto state = Field(StateSection("proxies"), editor.id);
    if (state.is_null() && editor.id == "trae") {
        const auto legacy = StateSection("proxy");
        if (SamePath(fs::path(Wide(Text(legacy, "settingsPath"))), editor.settings)) state = legacy;
    }
    return state;
}
void Runtime::SaveProxySettingState(const EditorProfile& editor, const Json& value) {
    if (options_.isolated && options_.vscodeSettings.empty()) { WriteStateSection("proxy", value); return; }
    auto profiles = StateSection("proxies");
    if (!profiles.is_object()) profiles = Json::object();
    if (value.is_null()) profiles.erase(editor.id); else profiles[editor.id] = value;
    WriteStateSection("proxies", profiles);
}
Json Runtime::EditorContext(const Json& selected, const std::vector<ProcessInfo>& processes, std::string_view filter) const {
    const auto find = [&](DWORD pid) -> const ProcessInfo* {
        const auto found = std::find_if(processes.begin(), processes.end(), [&](const ProcessInfo& p) { return p.pid == pid; });
        return found == processes.end() ? nullptr : &*found;
    };
    if (options_.isolated && !selected.is_null()) {
        const auto id = Text(selected, "editorId", "trae");
        const auto session = Text(selected, "editorSessionId", Text(selected, "traeSessionId"));
        if (!session.empty()) return {{"online", true}, {"editorId", id}, {"pid", Pid(selected, "editorPid") ? Pid(selected, "editorPid") : Pid(selected, "traePid")},
            {"sessionId", session}, {"startedAt", Text(selected, "startedAt")}};
    }
    const ProcessInfo* candidate = nullptr;
    DWORD next = Pid(selected, "pid");
    std::set<DWORD> visited;
    for (int depth = 0; depth < 24 && next && visited.insert(next).second; ++depth) {
        const auto p = find(next); if (!p) break;
        const auto id = EditorId(*p);
        if (!id.empty() && (filter.empty() || filter == id)) candidate = p;
        next = p->parent;
    }
    if (!candidate && selected.is_null() && !options_.isolated) {
        for (const auto& p : processes) {
            const auto id = EditorId(p);
            if (id.empty() || (!filter.empty() && id != filter)) continue;
            const auto parent = find(p.parent);
            if (parent && EditorId(*parent) == id) continue;
            const auto command = CommandLine(p.pid);
            if (command.find(L"--type=") != command.npos || command.find(L"--node-ipc") != command.npos) continue;
            if (!candidate || p.started < candidate->started) candidate = &p;
        }
    }
    if (candidate) return {{"online", true}, {"editorId", EditorId(*candidate)}, {"pid", candidate->pid},
        {"sessionId", std::to_string(candidate->pid) + ":" + std::to_string(candidate->started + 504911232000000000LL)}, {"startedAt", ""}};
    if (options_.isolated && !selected.is_null()) return {{"online", true}, {"editorId", "trae"}, {"pid", 0},
        {"sessionId", "proxy:" + std::to_string(Pid(selected, "pid")) + ":" + Text(selected, "startedAt")}, {"startedAt", Text(selected, "startedAt")}};
    return {{"online", false}, {"editorId", std::string(filter)}, {"pid", 0}, {"sessionId", ""}, {"startedAt", ""}};
}
Json Runtime::EditorSessions(const std::vector<ProcessInfo>& processes, const Json& proxies) const {
    Json sessions = Json::array(); std::set<std::string> seen;
    const auto add = [&](const Json& context) {
        const auto session = Text(context, "sessionId");
        if (Flag(context, "online") && !session.empty() && seen.insert(session).second) sessions.push_back(context);
    };
    for (const auto& state : proxies) add(EditorContext(state, processes));
    if (!options_.isolated) for (const auto& profile : EditorProfiles(true)) add(EditorContext(nullptr, processes, profile.id));
    return sessions;
}
} // namespace phone_assistant::management
