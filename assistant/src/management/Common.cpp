#include "Common.h"

#include <windows.h>
#include <bcrypt.h>
#include <algorithm>
#include <atomic>
#include <charconv>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace phone_assistant::management {

const Json& Field(const Json& object, std::string_view key) {
    static const Json empty;
    if (!object.is_object()) return empty;
    const auto found = object.find(std::string(key));
    return found == object.end() ? empty : *found;
}
std::string Text(const Json& object, std::string_view key, std::string fallback) {
    const auto& value = Field(object, key);
    return value.is_string() ? value.get<std::string>() : fallback;
}
bool Flag(const Json& object, std::string_view key) {
    const auto& value = Field(object, key);
    return value.is_boolean() && value.get<bool>();
}
unsigned long Pid(const Json& object, std::string_view key) {
    const auto& value = Field(object, key);
    if (!value.is_number_integer()) return 0;
    const auto number = value.get<std::int64_t>();
    return number > 0 && number <= MAXDWORD ? static_cast<unsigned long>(number) : 0;
}
std::string Trim(std::string_view text) {
    const auto first = text.find_first_not_of(" \t\r\n");
    if (first == text.npos) return {};
    return std::string(text.substr(first, text.find_last_not_of(" \t\r\n") - first + 1));
}
std::string Lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}
std::wstring Wide(std::string_view text) {
    if (text.empty()) return {};
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
    if (!count) throw std::runtime_error("文本不是有效 UTF-8");
    std::wstring result(count, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count);
    return result;
}
std::string Utf8(std::wstring_view text) {
    if (text.empty()) return {};
    const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    if (!count) throw std::runtime_error("文本不是有效 Unicode");
    std::string result(count, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count, nullptr, nullptr);
    return result;
}
std::wstring Environment(std::wstring_view name) {
    const std::wstring key(name);
    const auto count = GetEnvironmentVariableW(key.c_str(), nullptr, 0);
    if (!count) return {};
    std::wstring value(count, L'\0');
    const auto written = GetEnvironmentVariableW(key.c_str(), value.data(), count);
    if (written >= count) throw std::runtime_error("环境变量在读取期间发生变化");
    value.resize(written);
    return value;
}
bool SamePath(const fs::path& left, const fs::path& right) {
    if (left.empty() || right.empty()) return false;
    const auto a = fs::absolute(left).lexically_normal().wstring();
    const auto b = fs::absolute(right).lexically_normal().wstring();
    return CompareStringOrdinal(a.c_str(), static_cast<int>(a.size()), b.c_str(), static_cast<int>(b.size()), TRUE) == CSTR_EQUAL;
}
fs::path ExecutablePath() {
    std::wstring buffer(32768, L'\0');
    const auto count = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!count || count == buffer.size()) throw std::runtime_error("无法取得助手路径");
    buffer.resize(count);
    return buffer;
}
std::string ReadText(const fs::path& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw std::runtime_error("无法读取文件：" + Utf8(path.wstring()));
    std::string text(std::istreambuf_iterator<char>{stream}, {});
    if (text.starts_with("\xEF\xBB\xBF")) text.erase(0, 3);
    return text;
}
Json ReadJson(const fs::path& path) {
    try { return Json::parse(ReadText(path)); } catch (const std::exception&) { return nullptr; }
}
void WriteAtomic(const fs::path& path, std::string_view text) {
    static std::atomic<unsigned long> sequence{0};
    fs::create_directories(path.parent_path());
    auto temporary = path;
    temporary += L".tmp-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(++sequence);
    try {
        std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
        stream.exceptions(std::ios::badbit | std::ios::failbit);
        stream.write(text.data(), static_cast<std::streamsize>(text.size()));
        stream.close();
        if (!MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("无法原子更新文件：" + Utf8(path.wstring()));
    } catch (...) {
        std::error_code ignored;
        fs::remove(temporary, ignored);
        throw;
    }
}
void WriteJson(const fs::path& path, const Json& value) { WriteAtomic(path, value.dump(2) + "\n"); }
std::int64_t NowTicks() {
    FILETIME value{};
    GetSystemTimeAsFileTime(&value);
    return (static_cast<std::int64_t>(value.dwHighDateTime) << 32) | value.dwLowDateTime;
}
std::string Timestamp() {
    SYSTEMTIME value{};
    GetSystemTime(&value);
    char buffer[40]{};
    sprintf_s(buffer, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
        value.wYear, value.wMonth, value.wDay, value.wHour, value.wMinute, value.wSecond, value.wMilliseconds);
    return buffer;
}
std::optional<std::int64_t> ParseTime(std::string_view text) {
    if (text.size() < 19) return {};
    const auto number = [&](size_t position, size_t length) -> int {
        int value = 0;
        const auto [end, error] = std::from_chars(text.data() + position, text.data() + position + length, value);
        return error == std::errc{} && end == text.data() + position + length ? value : -1;
    };
    if (text[4] != '-' || text[7] != '-' || text[10] != 'T' || text[13] != ':' || text[16] != ':') return {};
    const int y = number(0, 4), m = number(5, 2), d = number(8, 2), h = number(11, 2), minute = number(14, 2), s = number(17, 2);
    if (y < 1601 || m < 1 || m > 12 || d < 1 || d > 31 || h < 0 || h > 23 || minute < 0 || minute > 59 || s < 0 || s > 59) return {};
    SYSTEMTIME value{};
    value.wYear = static_cast<WORD>(y); value.wMonth = static_cast<WORD>(m); value.wDay = static_cast<WORD>(d);
    value.wHour = static_cast<WORD>(h); value.wMinute = static_cast<WORD>(minute); value.wSecond = static_cast<WORD>(s);
    FILETIME file{};
    if (!SystemTimeToFileTime(&value, &file)) return {};
    auto ticks = (static_cast<std::int64_t>(file.dwHighDateTime) << 32) | file.dwLowDateTime;
    size_t position = 19;
    if (position < text.size() && text[position] == '.') {
        ++position;
        std::int64_t place = 1000000;
        const auto start = position;
        while (position < text.size() && text[position] >= '0' && text[position] <= '9') {
            ticks += (text[position++] - '0') * place;
            place /= 10;
        }
        if (position == start) return {};
    }
    if (position == text.size() || (text[position] == 'Z' && position + 1 == text.size())) return ticks;
    if (position + 6 != text.size() || (text[position] != '+' && text[position] != '-') || text[position + 3] != ':') return {};
    const auto hours = number(position + 1, 2), minutes = number(position + 4, 2);
    if (hours < 0 || hours > 14 || minutes < 0 || minutes > 59) return {};
    const auto offset = (hours * 60LL + minutes) * 60 * 10000000;
    return ticks + (text[position] == '-' ? offset : -offset);
}
std::string Sha256(std::string_view text) {
    unsigned char digest[32]{};
    if (BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0,
            reinterpret_cast<PUCHAR>(const_cast<char*>(text.data())), static_cast<ULONG>(text.size()), digest, sizeof(digest)) < 0)
        throw std::runtime_error("SHA-256 计算失败");
    std::ostringstream result;
    result << std::hex << std::setfill('0');
    for (const auto byte : digest) result << std::setw(2) << static_cast<unsigned int>(byte);
    return result.str();
}

std::map<std::string, std::string> ReadIni(const fs::path& path) {
    std::map<std::string, std::string> values;
    std::istringstream stream(ReadText(path));
    std::string line, section;
    while (std::getline(stream, line)) {
        line = Trim(line);
        if (line.empty() || line[0] == '#' || line[0] == ';') continue;
        if (line.front() == '[' && line.back() == ']') { section = Lower(Trim(std::string_view(line).substr(1, line.size() - 2))); continue; }
        const auto equals = line.find('=');
        if (equals == line.npos || !equals) continue;
        values[section + "." + Lower(Trim(std::string_view(line).substr(0, equals)))] = Trim(std::string_view(line).substr(equals + 1));
    }
    return values;
}
Options ParseOptions(const std::vector<std::wstring>& arguments) {
    Options options;
    bool customSettings = false, customState = false;
    const auto integer = [](const std::wstring& text, int minimum, int maximum) {
        size_t end = 0;
        const int value = std::stoi(text, &end);
        if (end != text.size() || value < minimum || value > maximum) throw std::runtime_error("命令行数值超出范围");
        return value;
    };
    for (size_t i = 0; i < arguments.size(); ++i) {
        const auto key = Lower(Utf8(arguments[i]));
        if (key == "--automatic") { options.automatic = true; continue; }
        if (key == "--standalone") { options.autoLifecycle = false; continue; }
        if (key == "--gui-output") { options.guiOutput = true; continue; }
        if (++i >= arguments.size()) throw std::runtime_error("参数缺少值：" + key);
        const auto& value = arguments[i];
        if (key == "--action") options.action = Utf8(value);
        else if (key == "--root") options.root = value;
        else if (key == "--settings") { options.settings = value; customSettings = true; }
        else if (key == "--state-dir") { options.state = value; customState = true; }
        else if (key == "--config") options.config = value;
        else if (key == "--proxy") options.proxy = value;
        else if (key == "--bridge") options.bridge = value;
        else if (key == "--port") options.port = integer(value, 1, 65535);
        else if (key == "--timeout-ms") options.timeoutMs = integer(value, 1000, 120000);
        else if (key == "--proxy-pid") options.proxyPid = static_cast<DWORD>(integer(value, 1, INT_MAX));
        else throw std::runtime_error("未知参数：" + key);
    }
    options.isolated = customSettings || customState || !options.config.empty() || !options.proxy.empty() || !options.bridge.empty();
    if (options.isolated && (!customSettings || !customState))
        throw std::runtime_error("隔离管理必须同时指定 --settings 和 --state-dir");
    if (options.root.empty()) options.root = Environment(L"CODEX_PHONE_REPO_ROOT");
    if (options.root.empty()) {
        for (auto directory = ExecutablePath().parent_path(); !directory.empty();) {
            if (fs::exists(directory / "package.json") && fs::is_directory(directory / "proxy")) { options.root = directory; break; }
            const auto parent = directory.parent_path();
            if (parent == directory) break;
            directory = parent;
        }
    }
    if (options.root.empty() || !fs::is_directory(options.root)) throw std::runtime_error("无法定位项目根目录，请设置 CODEX_PHONE_REPO_ROOT");
    options.root = fs::absolute(options.root).lexically_normal();
    const auto resolve = [&](fs::path& value, const fs::path& fallback) {
        if (value.empty()) value = fallback;
        if (value.is_relative()) value = options.root / value;
        value = fs::absolute(value).lexically_normal();
    };
    resolve(options.settings, fs::path(Environment(L"APPDATA")) / L"Trae CN/User/settings.json");
    resolve(options.state, options.root / "assistant/data");
    resolve(options.config, options.root / "config/phone-mode.ini");
    resolve(options.proxy, options.root / "proxy/dist/codex-phone.exe");
    resolve(options.bridge, options.root / "server/dist/codex-phone-bridge.exe");
    if (options.isolated && (SamePath(options.state, options.root / "assistant/data") || SamePath(options.state, options.root / ".state") ||
        SamePath(options.settings, fs::path(Environment(L"APPDATA")) / L"Trae CN/User/settings.json") ||
        SamePath(options.bridge, options.root / "server/dist/codex-phone-bridge.exe")))
        throw std::runtime_error("隔离管理不能使用正式状态、设置或手机桥路径");
    options.bridgeData = options.isolated ? options.state / "bridge" : options.root / "server/data";
    options.bridgeLogs = options.isolated ? options.state / "logs" : options.root / "server/logs";
    options.proxyRegistry = options.isolated ? options.state / "proxy/instances" : options.root / "proxy/runtime/instances";
    options.backups = options.isolated ? options.state / "backups" : options.root / "assistant/backups";
    const auto action = Lower(options.action);
    bool valid = false;
    for (const auto name : {"Enable", "Disable", "Restart", "Stop", "Status", "Start", "Shutdown"})
        if (action == Lower(name)) { options.action = name; valid = true; break; }
    if (!valid) throw std::runtime_error("未知管理动作：" + options.action);
    if (options.automatic && options.action != "Restart") throw std::runtime_error("--automatic 只能与 Restart 一起使用");
    return options;
}
} // namespace phone_assistant::management
