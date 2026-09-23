#include "management/Manager.h"
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iostream>
#include <thread>

using namespace phone_assistant::management;

int wmain(int argc, wchar_t** argv) {
    try {
        std::vector<std::wstring> arguments;
        for (int i = 1; i < argc; ++i) arguments.emplace_back(argv[i]);
        const auto marker = Environment(L"CODEX_PHONE_AUTO_START_MARKER");
        if (!marker.empty()) {
            Json record{{"action", ""}, {"automatic", false}, {"proxyPid", 0}};
            for (size_t i = 0; i < arguments.size(); ++i) {
                if (arguments[i] == L"--automatic") record["automatic"] = true;
                else if (arguments[i] == L"--action" && i + 1 < arguments.size()) record["action"] = Utf8(arguments[++i]);
                else if (arguments[i] == L"--proxy-pid" && i + 1 < arguments.size()) record["proxyPid"] = std::stoul(arguments[++i]);
                else throw std::runtime_error("Unexpected auto-start argument");
            }
            WriteJson(fs::path(marker), record);
            return 0;
        }
        const auto state = fs::path(Environment(L"CODEX_PHONE_STATE_DIR"));
        const auto directory = state.parent_path();
        const auto config = ReadIni(fs::path(Environment(L"CODEX_PHONE_MODE_CONFIG")));
        if (std::find(arguments.begin(), arguments.end(), L"--check") != arguments.end()) {
            if (fs::exists(directory / "preflight-failure")) return 7;
            return 0;
        }
        const auto get = [&](const char* key, std::string fallback = {}) {
            const auto found = config.find(key); return found == config.end() ? fallback : found->second;
        };
        const int port = std::stoi(Utf8(Environment(L"PORT")));
        const auto fingerprint = Sha256(get("relay.server") + "\n" + get("relay.agent_port", "8789") + "\n" +
            get("relay.public_port", "8788") + "\n" + get("phone.local_host", "127.0.0.1") + "\n" +
            std::to_string(port) + "\n" + get("relay.reconnect_delay_ms", "2000") + "\n" + get("relay.secret"));
        fs::remove(directory / "old-protocol");
        WriteJson(directory / "bridge-call.json", {{"pid", GetCurrentProcessId()}, {"autoLifecycle", Environment(L"CODEX_PHONE_AUTO_LIFECYCLE") == L"1"}, {"port", port}});
        WSADATA data{};
        if (WSAStartup(MAKEWORD(2, 2), &data)) return 2;
        const auto server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        BOOL exclusive = TRUE;
        setsockopt(server, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<char*>(&exclusive), sizeof(exclusive));
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        address.sin_port = htons(static_cast<u_short>(port));
        if (bind(server, reinterpret_cast<sockaddr*>(&address), sizeof(address)) || listen(server, SOMAXCONN)) return 3;
        for (;;) {
            const auto client = accept(server, nullptr, nullptr);
            if (client == INVALID_SOCKET) break;
            DWORD timeout = 3000;
            setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
            char buffer[8192];
            const auto count = recv(client, buffer, sizeof(buffer), 0);
            if (count <= 0) { closesocket(client); continue; }
            if (fs::exists(directory / "health-fail-once")) {
                fs::remove(directory / "health-fail-once");
                std::this_thread::sleep_for(std::chrono::milliseconds(1600));
                closesocket(client); continue;
            }
            auto instances = Json::array();
            const auto registry = state / "trae-proxy.json.instances";
            if (fs::is_directory(registry)) for (const auto& entry : fs::directory_iterator(registry)) {
                const auto item = ReadJson(entry.path());
                if (Text(item, "instanceId") == "isolated-second" && fs::exists(directory / "missing-instance")) continue;
                if (Text(item, "instanceId").empty()) continue;
                instances.push_back({{"instanceId", Text(item, "instanceId")}, {"connected", true}, {"proxyPid", Pid(item, "pid")}});
            }
            const auto relayState = fs::exists(directory / "relay-disconnected") ? "disconnected" : "connected";
            Json body = {
                {"app", {{"name", "Codex Link To Phone"}, {"pid", GetCurrentProcessId()},
                    {"cwd", Utf8(Environment(L"CODEX_PHONE_REPO_ROOT"))},
                    {"autoLifecycleEnabled", Environment(L"CODEX_PHONE_AUTO_LIFECYCLE") == L"1"}}},
                {"codex", {{"status", "connected"}, {"info", {{"instances", instances}}}}},
                {"publicAccess", {{"mode", "relay"}, {"relayIntegrated", true}, {"relayStatus", relayState},
                    {"relayPid", GetCurrentProcessId()}, {"relayConfigFingerprint", fingerprint}}}
            };
            if (fs::exists(directory / "old-protocol")) body["codex"]["info"] = nullptr;
            if (fs::exists(directory / "wrong-relay-pid")) body["publicAccess"]["relayPid"] = 1;
            const auto payload = body.dump();
            const auto response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
                std::to_string(payload.size()) + "\r\nConnection: close\r\n\r\n" + payload;
            size_t sent = 0;
            while (sent < response.size()) {
                const auto written = send(client, response.data() + sent, static_cast<int>(response.size() - sent), 0);
                if (written <= 0) break;
                sent += written;
            }
            closesocket(client);
        }
        closesocket(server);
        WSACleanup();
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
