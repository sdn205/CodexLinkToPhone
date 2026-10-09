#include "PhoneManagerClient.h"

#include <windows.h>
#include <wincrypt.h>

#include <iostream>
#include <string>

namespace {

std::string WideToUtf8(std::wstring_view value) {
    const int size = WideCharToMultiByte(
        CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<std::size_t>(size), '\0');
    WideCharToMultiByte(
        CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}

std::wstring Base64(std::wstring_view value) {
    const std::string utf8 = WideToUtf8(value);
    DWORD size = 0;
    CryptBinaryToStringA(
        reinterpret_cast<const BYTE*>(utf8.data()), static_cast<DWORD>(utf8.size()),
        CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &size);
    std::string encoded(size, '\0');
    CryptBinaryToStringA(
        reinterpret_cast<const BYTE*>(utf8.data()), static_cast<DWORD>(utf8.size()),
        CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, encoded.data(), &size);
    if (!encoded.empty() && encoded.back() == '\0') {
        encoded.pop_back();
    }
    return std::wstring(encoded.begin(), encoded.end());
}

int failures = 0;

void Expect(bool condition, const char* label) {
    if (!condition) {
        std::cerr << "FAILED: " << label << '\n';
        ++failures;
    }
}

void TestLegacyPlainFields() {
    const auto result = phone_assistant::ParseManagerOutput(
        phone_assistant::ManagerAction::Status, 0,
        L"success=true\n"
        L"traeStatus=运行中\ntraeLevel=ok\n"
        L"proxyStatus=已开启\nproxyLevel=ok\n"
        L"bridgeStatus=已连接\nbridgeLevel=ok\n"
        L"publicStatus=Relay 已连接\npublicLevel=ok\n"
        L"recentAction=手机桥运行正常\n");
    Expect(result.snapshot.operationSuccess, "legacy success");
    Expect(result.snapshot.trae.text == L"运行中", "legacy trae text");
    Expect(result.snapshot.proxy.level == phone_assistant::StatusLevel::Ok, "legacy proxy level");
    Expect(result.snapshot.recentAction == L"手机桥运行正常", "legacy recent action");
}

void TestCurrentManagerContract() {
    const std::wstring output =
        L"schemaVersion=1\nstringEncoding=base64-utf8\noperationSuccess=true\n"
        L"traeOnline=true\nproxyMode=phone\nproxyConfigured=true\nproxyConnected=true\n"
        L"bridgeRunning=true\nbridgeHealthy=true\nbridgeConnected=true\n"
        L"publicMode=relay\npublicConnected=true\npublicStatus=connected\n"
        L"message=" + Base64(L"操作成功") + L"\nrecentAction=" + Base64(L"手机桥运行正常") + L"\n";
    const auto result = phone_assistant::ParseManagerOutput(
        phone_assistant::ManagerAction::Restart, 0, output);
    Expect(result.snapshot.operationSuccess, "contract success");
    Expect(result.snapshot.trae.text == L"运行中", "contract trae inferred");
    Expect(result.snapshot.proxy.text == L"已开启，代理在线", "contract proxy inferred");
    Expect(result.snapshot.bridge.text == L"运行中，已连接编辑器", "contract bridge inferred");
    Expect(result.snapshot.publicConnection.text == L"Relay 已连接", "contract public inferred");
    Expect(result.snapshot.message == L"操作成功", "contract base64 message");
    Expect(result.snapshot.recentAction == L"手机桥运行正常", "contract base64 recent action");
}

void TestPrefixedBase64() {
    const auto result = phone_assistant::ParseManagerOutput(
        phone_assistant::ManagerAction::Status, 0,
        L"success=true\ntraeStatus=b64:" + Base64(L"运行中") + L"\ntraeLevel=ok\n");
    Expect(result.snapshot.trae.text == L"运行中", "b64 prefix");
}

void TestPausedBridge() {
    const auto result = phone_assistant::ParseManagerOutput(
        phone_assistant::ManagerAction::Status, 0,
        L"operationSuccess=true\npaused=true\nbridgeRunning=false\nbridgeConnected=false\n");
    Expect(result.snapshot.bridge.text == L"已结束（本轮编辑器）", "stopped bridge text");
    Expect(result.snapshot.bridge.level == phone_assistant::StatusLevel::Warning, "paused bridge level");
}

void TestDualEditorStatus() {
    const auto result = phone_assistant::ParseManagerOutput(
        phone_assistant::ManagerAction::Status, 0,
        L"stringEncoding=base64-utf8\noperationSuccess=true\neditorOnline=true\n"
        L"editorStatus=" + Base64(L"Trae 运行中；VS Code 运行中") +
        L"\nproxyStatus=" + Base64(L"Trae 已开启；VS Code 已开启") + L"\n");
    Expect(result.snapshot.trae.text == L"Trae 运行中；VS Code 运行中", "dual editor status decoding");
    Expect(result.snapshot.proxy.text == L"Trae 已开启；VS Code 已开启", "dual proxy status decoding");
}

void TestUnhealthyBridgeAndRawPublicState() {
    const auto result = phone_assistant::ParseManagerOutput(
        phone_assistant::ManagerAction::Status, 0,
        L"stringEncoding=base64-utf8\noperationSuccess=true\n"
        L"bridgeRunning=true\nbridgeHealthy=false\nbridgeConnected=false\n"
        L"publicMode=relay\npublicConnected=false\npublicStatus=disabled\n");
    Expect(result.snapshot.bridge.text == L"运行中，状态异常", "unhealthy bridge text");
    Expect(result.snapshot.bridge.level == phone_assistant::StatusLevel::Error, "unhealthy bridge level");
    Expect(result.snapshot.publicConnection.text == L"Relay 未连接", "raw public state localized");
}

}  // namespace

int main() {
    TestLegacyPlainFields();
    TestCurrentManagerContract();
    TestPrefixedBase64();
    TestPausedBridge();
    TestDualEditorStatus();
    TestUnhealthyBridgeAndRawPublicState();
    if (failures == 0) {
        std::cout << "All parser tests passed.\n";
    }
    return failures == 0 ? 0 : 1;
}
