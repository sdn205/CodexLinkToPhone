#include "PhoneManagerClient.h"
#include "management/Manager.h"

#include <windows.h>
#include <wincrypt.h>
#include <algorithm>
#include <cwctype>
#include <map>
#include <optional>
#include <string_view>
#include <vector>

namespace phone_assistant {
namespace {
using FieldMap = std::map<std::wstring, std::wstring, std::less<>>;

std::wstring Trim(std::wstring_view value) {
    std::size_t first = 0;
    while (first < value.size() && std::iswspace(value[first]) != 0) {
        ++first;
    }
    std::size_t last = value.size();
    while (last > first && std::iswspace(value[last - 1]) != 0) {
        --last;
    }
    return std::wstring(value.substr(first, last - first));
}

std::wstring Lower(std::wstring_view value) {
    std::wstring result(value);
    std::transform(result.begin(), result.end(), result.begin(), [](wchar_t ch) {
        return static_cast<wchar_t>(std::towlower(ch));
    });
    return result;
}

std::wstring Utf8ToWide(std::string_view value) {
    if (value.empty()) {
        return {};
    }

    const int size = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (size <= 0) {
        const int fallbackSize = MultiByteToWideChar(
            CP_ACP, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
        if (fallbackSize <= 0) {
            return {};
        }
        std::wstring fallback(static_cast<std::size_t>(fallbackSize), L'\0');
        MultiByteToWideChar(
            CP_ACP, 0, value.data(), static_cast<int>(value.size()), fallback.data(), fallbackSize);
        return fallback;
    }

    std::wstring result(static_cast<std::size_t>(size), L'\0');
    MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size);
    return result;
}

std::optional<std::wstring> DecodeBase64Utf8(std::wstring_view value) {
    if (value.empty()) {
        return std::wstring{};
    }

    DWORD byteCount = 0;
    const std::wstring encoded(value);
    if (!CryptStringToBinaryW(
            encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64,
            nullptr, &byteCount, nullptr, nullptr)) {
        return std::nullopt;
    }

    std::vector<unsigned char> bytes(byteCount);
    if (!CryptStringToBinaryW(
            encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64,
            bytes.data(), &byteCount, nullptr, nullptr)) {
        return std::nullopt;
    }
    bytes.resize(byteCount);
    return Utf8ToWide(std::string_view(
        reinterpret_cast<const char*>(bytes.data()), bytes.size()));
}

bool IsTextField(std::wstring_view key) {
    return key == L"message" || key == L"statustext" || key == L"recentaction" ||
           key == L"recentactionat";
}

std::wstring DecodeTextValue(
    std::wstring_view key, std::wstring_view value, bool unprefixedBase64) {
    constexpr std::wstring_view prefix = L"b64:";
    if (value.starts_with(prefix)) {
        if (auto decoded = DecodeBase64Utf8(value.substr(prefix.size()))) {
            return *decoded;
        }
        return std::wstring(value);
    }
    if (unprefixedBase64 && IsTextField(key)) {
        if (auto decoded = DecodeBase64Utf8(value)) {
            return *decoded;
        }
    }
    return std::wstring(value);
}

FieldMap ReadFields(std::wstring_view output) {
    FieldMap fields;
    std::size_t offset = 0;
    while (offset <= output.size()) {
        const auto end = output.find_first_of(L"\r\n", offset);
        const auto line = output.substr(offset, end == std::wstring_view::npos ? output.size() - offset : end - offset);
        const auto equals = line.find(L'=');
        if (equals != std::wstring_view::npos) {
            auto key = Lower(Trim(line.substr(0, equals)));
            if (!key.empty()) {
                fields[std::move(key)] = Trim(line.substr(equals + 1));
            }
        }
        if (end == std::wstring_view::npos) {
            break;
        }
        offset = end + 1;
        if (offset < output.size() && output[end] == L'\r' && output[offset] == L'\n') {
            ++offset;
        }
    }
    return fields;
}

std::wstring Field(const FieldMap& fields, std::wstring_view key) {
    const auto it = fields.find(key);
    return it == fields.end() ? std::wstring{} : it->second;
}

bool ParseBool(std::wstring_view value, bool fallback = false) {
    const auto normalized = Lower(Trim(value));
    if (normalized == L"true" || normalized == L"1" || normalized == L"yes" || normalized == L"on") {
        return true;
    }
    if (normalized == L"false" || normalized == L"0" || normalized == L"no" || normalized == L"off") {
        return false;
    }
    return fallback;
}

StatusLevel ParseLevel(std::wstring_view value, StatusLevel fallback) {
    const auto normalized = Lower(Trim(value));
    if (normalized == L"ok" || normalized == L"success" || normalized == L"connected" ||
        normalized == L"green" || normalized == L"online") {
        return StatusLevel::Ok;
    }
    if (normalized == L"warning" || normalized == L"warn" || normalized == L"yellow" ||
        normalized == L"pending" || normalized == L"offline") {
        return StatusLevel::Warning;
    }
    if (normalized == L"error" || normalized == L"failed" || normalized == L"fail" ||
        normalized == L"red") {
        return StatusLevel::Error;
    }
    return fallback;
}


} // namespace

std::wstring ActionArgument(ManagerAction action) {
    switch (action) {
        case ManagerAction::Enable:
            return L"Enable";
        case ManagerAction::Disable:
            return L"Disable";
        case ManagerAction::Restart:
            return L"Restart";
        case ManagerAction::Stop:
            return L"Stop";
        case ManagerAction::Status:
            return L"Status";
    }
    return L"Status";
}

ManagerResult ParseManagerOutput(
    ManagerAction action, unsigned long exitCode, std::wstring_view output) {
    ManagerResult result;
    result.action = action;
    result.processStarted = true;
    result.exitCode = exitCode;
    result.rawOutput = std::wstring(output);

    const auto fields = ReadFields(output);
    const bool encodedText = Lower(Field(fields, L"stringencoding")) == L"base64-utf8";
    const auto text = [&](std::wstring_view key) {
        return DecodeTextValue(key, Field(fields, key), encodedText);
    };

    auto successValue = Field(fields, L"operationsuccess");
    if (successValue.empty()) {
        successValue = Field(fields, L"success");
    }
    result.snapshot.operationSuccess = ParseBool(successValue, exitCode == 0);
    result.snapshot.message = text(L"message");
    result.snapshot.recentAction = text(L"recentaction");

    const bool traeOnline = ParseBool(Field(fields, L"traeonline"));
    auto traeText = text(L"traestatus");
    if (traeText.empty()) {
        traeText = traeOnline ? L"运行中" : L"未运行";
    }
    result.snapshot.trae = {
        std::move(traeText),
        ParseLevel(Field(fields, L"traelevel"), traeOnline ? StatusLevel::Ok : StatusLevel::Warning)};

    const auto proxyMode = Lower(Field(fields, L"proxymode"));
    const bool proxyConfigured = ParseBool(Field(fields, L"proxyconfigured"), proxyMode == L"phone");
    const bool proxyConnected = ParseBool(Field(fields, L"proxyconnected"));
    auto proxyText = text(L"proxystatus");
    StatusLevel proxyFallback = StatusLevel::Warning;
    if (proxyText.empty()) {
        if (proxyMode == L"phone" && proxyConfigured) {
            proxyText = proxyConnected ? L"已开启，代理在线" : L"已开启，等待连接";
            proxyFallback = proxyConnected ? StatusLevel::Ok : StatusLevel::Warning;
        } else if (proxyMode == L"native") {
            proxyText = L"未开启，当前使用原版 Codex";
        } else if (proxyMode == L"custom") {
            proxyText = L"已指向其他程序";
        } else {
            proxyText = L"未开启";
        }
    } else if (proxyConfigured) {
        proxyFallback = proxyConnected ? StatusLevel::Ok : StatusLevel::Warning;
    }
    result.snapshot.proxy = {
        std::move(proxyText), ParseLevel(Field(fields, L"proxylevel"), proxyFallback)};

    const bool bridgeRunning = ParseBool(Field(fields, L"bridgerunning"));
    const auto bridgeHealthyValue = Field(fields, L"bridgehealthy");
    const bool bridgeHealthy = ParseBool(bridgeHealthyValue, bridgeRunning);
    const bool bridgeConnected = ParseBool(Field(fields, L"bridgeconnected"));
    const bool paused = ParseBool(Field(fields, L"paused"));
    auto bridgeText = text(L"bridgestatus");
    if (bridgeText.empty()) {
        if (paused) {
            bridgeText = L"已结束（本轮 Trae）";
        } else if (bridgeRunning && !bridgeHealthy) {
            bridgeText = L"运行中，状态异常";
        } else if (bridgeRunning && bridgeConnected) {
            bridgeText = L"运行中，已连接 Trae";
        } else if (bridgeRunning) {
            bridgeText = L"运行中，等待 Trae";
        } else {
            bridgeText = L"未运行";
        }
    }
    result.snapshot.bridge = {
        std::move(bridgeText),
        ParseLevel(
            Field(fields, L"bridgelevel"),
            !paused && bridgeRunning && !bridgeHealthy
                ? StatusLevel::Error
                : (!paused && bridgeHealthy && bridgeConnected
                    ? StatusLevel::Ok
                    : StatusLevel::Warning))};

    const bool publicConnected = ParseBool(Field(fields, L"publicconnected"));
    const auto publicMode = Lower(Field(fields, L"publicmode"));
    auto publicText = text(L"publicstatus");
    const auto normalizedPublicText = Lower(Trim(publicText));
    const bool rawPublicState =
        normalizedPublicText == L"connected" || normalizedPublicText == L"disconnected" ||
        normalizedPublicText == L"stopped" || normalizedPublicText == L"disabled" ||
        normalizedPublicText == L"unknown" || normalizedPublicText == L"connecting";
    if (publicText.empty() || rawPublicState) {
        if (publicMode == L"relay") {
            publicText = publicConnected ? L"Relay 已连接" : L"Relay 未连接";
        } else {
            publicText = publicConnected ? L"已连接" : L"未连接";
        }
    }
    result.snapshot.publicConnection = {
        std::move(publicText),
        ParseLevel(
            Field(fields, L"publiclevel"),
            publicConnected ? StatusLevel::Ok : StatusLevel::Warning)};

    if (fields.empty() && exitCode != 0) {
        const std::wstring failure = exitCode == 2 ? L"管理器忙，稍后自动重试" : L"状态读取失败";
        result.snapshot.trae = {failure, StatusLevel::Error};
        result.snapshot.proxy = {failure, StatusLevel::Error};
        result.snapshot.bridge = {failure, StatusLevel::Error};
        result.snapshot.publicConnection = {failure, StatusLevel::Error};
    }

    if (result.snapshot.message.empty()) {
        result.snapshot.message = text(L"statustext");
    }
    return result;
}

ManagerResult RunManager(ManagerAction action, std::chrono::milliseconds timeout) {
    try {
        auto options = management::ParseOptions({});
        options.action = management::Utf8(ActionArgument(action));
        options.timeoutMs = static_cast<int>(timeout.count());
        const auto reply = management::Execute(options);
        return ParseManagerOutput(action, static_cast<unsigned long>(reply.exitCode),
            management::Wide(management::GuiOutput(reply.value)));
    } catch (const std::exception& error) {
        ManagerResult result;
        result.action = action;
        result.processError = management::Wide(error.what());
        result.snapshot.message = result.processError;
        return result;
    }
}
} // namespace phone_assistant
