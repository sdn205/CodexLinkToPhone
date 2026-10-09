#include "Manager.h"

#include <wincrypt.h>
#include <memory>
#include <stdexcept>

namespace phone_assistant::management {
namespace {
std::string StatusText(const Json& status) {
    const auto mode = Text(status, "proxyMode");
    return Text(status, "editorStatus", "编辑器未运行") + "；" +
        (mode == "phone" ? "代理模式已开启" : mode == "native" ? "代理模式已关闭" : "代理指向其他程序") + "；" +
        (Flag(status, "paused") ? "手机桥已结束" : Flag(status, "bridgeConnected") ? "手机桥已连接" :
            Flag(status, "bridgeRunning") ? "手机桥正在连接" : "手机桥未启动") + "；" +
        (Flag(status, "publicConnected") ? "Relay 已连接" : "Relay 未连接");
}
std::string StatusLevel(const Json& status, bool success) {
    if (!success) return "error";
    return Flag(status, "editorOnline") && Flag(status, "proxyConfigured") && Flag(status, "proxyConnected") &&
        Flag(status, "bridgeConnected") && Flag(status, "publicConnected") && !Flag(status, "paused") ? "ok" : "warning";
}
std::string Base64(std::string_view input) {
    DWORD size = 0;
    CryptBinaryToStringA(reinterpret_cast<const BYTE*>(input.data()), static_cast<DWORD>(input.size()),
        CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &size);
    std::string result(size, '\0');
    if (size) {
        CryptBinaryToStringA(reinterpret_cast<const BYTE*>(input.data()), static_cast<DWORD>(input.size()),
            CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, result.data(), &size);
        while (!result.empty() && result.back() == '\0') result.pop_back();
    }
    return result;
}
} // namespace
std::pair<std::string, std::string> Runtime::Act() {
    if (options_.action == "Status") return {"status", ""};
    if (options_.action == "Enable") {
        ChangeMode(true);
        return {"enabled", "代理模式已开启；下次加载所选编辑器扩展时自动启动手机桥。"};
    }
    if (options_.action == "Shutdown") { Shutdown(); return {"shutdown", "所选编辑器和手机服务已关闭。"}; }
    if (options_.action == "Start") { StartBridge(false, options_.autoLifecycle); return {"started", "手机桥已启动。"}; }
    const auto before = Observe();
    if (options_.action == "Disable" || options_.action == "Stop") {
        if (options_.action == "Disable") {
            ChangeMode(false);
            bool anotherEnabled = false;
            for (const auto& editor : EditorProfiles(true)) {
                const auto content = fs::exists(editor.settings) ? ReadText(editor.settings) : "{}";
                anotherEnabled |= SamePath(fs::path(Wide(ReadCliSetting(content).value)), options_.proxy);
            }
            if (anotherEnabled) return {"disabled", "所选编辑器代理已关闭；其他编辑器及手机桥继续运行，重载所选扩展后使用原配置。"};
        }
        const bool paused = WritePause(before.status);
        StopBridge();
        if (options_.action == "Disable") return {"disabled", "代理模式已关闭，手机桥已停止；重载编辑器扩展后使用原配置。"};
        return {"stopped", paused ? "手机桥已结束，当前编辑器会话期间保持暂停；手动启动或所有编辑器退出后重新打开时恢复。" :
            "手机桥已停止；下次打开编辑器时自动启动。"};
    }
    if (options_.automatic) {
        bool registered = false;
        for (const auto& proxy : before.proxies) if (Pid(proxy, "pid") == options_.proxyPid) registered = true;
        if (options_.proxyPid && !registered) return {"stale", "自动启动请求来自旧代理，已忽略。"};
        if (!Flag(before.status, "proxyConfigured")) return {"disabled", "代理模式未开启，已跳过自动启动。"};
        if (!Flag(before.status, "proxyConnected")) return {"not-ready", "代理尚未就绪，已跳过自动启动。"};
        if (Flag(before.status, "paused")) return {"suppressed", "当前编辑器会话已暂停，已跳过自动启动。"};
        ClearStalePause(Text(before.status, "traeSessionId"));
        if (Flag(before.status, "bridgeHealthy") && Flag(before.status, "bridgeAutoLifecycle") &&
            Flag(before.status, "bridgeInstanceRouting")) return {"reused", "手机桥已经运行，已复用现有进程。"};
        StartBridge(Flag(before.status, "bridgeHealthy") && !Flag(before.status, "bridgeInstanceRouting"), true);
        WaitReady();
        return {"started", "手机桥已自动启动。"};
    }
    if (!Flag(before.status, "proxyConfigured")) throw std::runtime_error("请先开启代理模式");
    if (!Flag(before.status, "editorOnline")) throw std::runtime_error("请先打开 Trae 或 VS Code");
    if (!Flag(before.status, "proxyConnected")) throw std::runtime_error("编辑器手机代理尚未就绪");
    ClearPause();
    StartBridge(true, true);
    WaitReady();
    return {"restarted", "手机桥已启动并连接成功。"};
}
Reply Runtime::Run() {
    Reply reply;
    std::string disposition = "failed", message;
    std::unique_ptr<ActionLock> lock;
    bool attempted = false;
    try {
        if (options_.action != "Status") {
            lock = std::make_unique<ActionLock>(options_.state);
            if (!lock->acquired()) { reply.exitCode = 2; throw std::runtime_error("手机管理器正忙，请稍后重试"); }
        }
        attempted = true;
        std::tie(disposition, message) = Act();
    } catch (const std::exception& error) {
        if (!reply.exitCode) reply.exitCode = 1;
        message = error.what();
    }
    if (attempted && options_.action != "Status") {
        try { WriteStateSection("recent", {{"action", options_.action}, {"automatic", options_.automatic},
            {"success", reply.exitCode == 0}, {"disposition", disposition}, {"message", message}, {"completedAt", Timestamp()}}); }
        catch (const std::exception& error) {
            if (!reply.exitCode) { reply.exitCode = 1; disposition = "failed"; message = std::string("保存操作记录失败：") + error.what(); }
        }
    }
    Json status = Json::object();
    try { status = Observe().status; }
    catch (const std::exception& error) {
        if (!reply.exitCode) { reply.exitCode = 1; disposition = "failed"; message = std::string("读取状态失败：") + error.what(); }
    }
    const auto statusText = StatusText(status);
    if (options_.action == "Status" && !reply.exitCode) message = statusText;
    reply.value = {{"schemaVersion", 1}, {"operationSuccess", reply.exitCode == 0}, {"action", options_.action},
        {"automatic", options_.automatic}, {"disposition", disposition}, {"message", message},
        {"statusText", statusText}, {"statusLevel", StatusLevel(status, reply.exitCode == 0)}, {"status", status}};
    return reply;
}
Reply Execute(const Options& options) {
    try { return Runtime(options).Run(); }
    catch (const std::exception& error) {
        return {1, {{"schemaVersion", 1}, {"operationSuccess", false}, {"action", options.action},
            {"automatic", options.automatic}, {"disposition", "failed"}, {"message", error.what()}, {"statusLevel", "error"}, {"status", Json::object()}}};
    }
}
std::string GuiOutput(const Json& result) {
    std::string output = "schemaVersion=1\nstringEncoding=base64-utf8\n";
    const auto add = [&](std::string_view key, const Json& value, bool encode = false) {
        const auto text = value.is_string() ? value.get<std::string>() : value.is_null() ? "" : value.dump();
        output += std::string(key) + "=" + (encode ? Base64(text) : text) + "\n";
    };
    for (const auto key : {"operationSuccess", "action", "automatic", "disposition", "statusLevel"}) add(key, Field(result, key));
    for (const auto key : {"message", "statusText"}) add(key, Field(result, key), true);
    const auto& status = Field(result, "status");
    for (auto iterator = status.begin(); iterator != status.end(); ++iterator)
        add(iterator.key(), iterator.value(), iterator.key() == "recentAction" || iterator.key() == "recentActionAt" || iterator.key() == "editorStatus" || iterator.key() == "proxyStatus");
    return output;
}
int CommandMain(const std::vector<std::wstring>& arguments) {
    try {
        const auto options = ParseOptions(arguments);
        const auto reply = Execute(options);
        WriteOutput(options.guiOutput ? GuiOutput(reply.value) : reply.value.dump(2) + "\n");
        return reply.exitCode;
    } catch (const std::exception& error) {
        WriteOutput(Json({{"schemaVersion", 1}, {"operationSuccess", false}, {"message", error.what()}, {"status", Json::object()}}).dump() + "\n");
        return 1;
    }
}
} // namespace phone_assistant::management
