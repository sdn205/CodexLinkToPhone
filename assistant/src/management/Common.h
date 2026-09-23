#pragma once

#include <json.hpp>
#include <chrono>
#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace phone_assistant::management {

using Json = nlohmann::ordered_json;
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;

const Json& Field(const Json& object, std::string_view key);
std::string Text(const Json& object, std::string_view key, std::string fallback = {});
bool Flag(const Json& object, std::string_view key);
unsigned long Pid(const Json& object, std::string_view key);
std::string Trim(std::string_view text);
std::string Lower(std::string value);
std::wstring Wide(std::string_view text);
std::string Utf8(std::wstring_view text);
std::wstring Environment(std::wstring_view name);
bool SamePath(const fs::path& left, const fs::path& right);
fs::path ExecutablePath();
std::string ReadText(const fs::path& path);
Json ReadJson(const fs::path& path);
void WriteAtomic(const fs::path& path, std::string_view text);
void WriteJson(const fs::path& path, const Json& value);
std::string Timestamp();
std::optional<std::int64_t> ParseTime(std::string_view text);
std::int64_t NowTicks();
std::string Sha256(std::string_view text);

struct Options {
    fs::path root, settings, state, config, proxy, bridge;
    std::string action = "Status";
    unsigned long proxyPid = 0;
    int port = 0;
    int timeoutMs = 90000;
    bool automatic = false;
    bool autoLifecycle = true;
    bool isolated = false;
    bool guiOutput = false;
};

Options ParseOptions(const std::vector<std::wstring>& arguments);
std::map<std::string, std::string> ReadIni(const fs::path& path);

struct CliSetting {
    bool present = false;
    std::string value;
};
CliSetting ReadCliSetting(std::string_view text);
std::string EditCliSetting(std::string_view text, const std::optional<std::string>& value);

} // namespace phone_assistant::management
