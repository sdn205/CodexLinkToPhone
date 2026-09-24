#include "management/Common.h"
#include "management/Manager.h"
#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <atomic>
#include <thread>

using namespace phone_assistant::management;
namespace {
int checks = 0;
void Expect(bool condition, const char* label) {
    ++checks;
    if (!condition) throw std::runtime_error(label);
}
template<class Function> void Reject(Function function, const char* label) {
    bool rejected = false;
    try { function(); } catch (const std::exception&) { rejected = true; }
    Expect(rejected, label);
}
}
int main() {
    try {
        const std::string source = "{\r\n // 注释保留\r\n \"editor.fontSize\": 14, /* settings */\r\n \"nested\": {\"chatgpt.cliExecutable\": \"nested\"},\r\n}\r\n";
        const auto modified = EditCliSetting(source, "E:\\中文 目录\\codex.exe");
        Expect(ReadCliSetting(modified).value == "E:\\中文 目录\\codex.exe", "Unicode path roundtrip");
        Expect(modified.find("// 注释保留") != modified.npos && modified.find("/* settings */") != modified.npos, "Preserve comments");
        Expect(modified.find("\"nested\"") != modified.npos, "Preserve nested properties");
        const auto removed = EditCliSetting(modified, std::nullopt);
        Expect(!ReadCliSetting(removed).present, "Remove top-level setting");
        Expect(ReadCliSetting(EditCliSetting("{\"chatgpt.cliExecutable\":\"old\",\"other\":1}", "new")).value == "new", "Inline replacement");
        Expect(!ReadCliSetting(EditCliSetting("{\"other\":1,\"chatgpt.cliExecutable\":\"old\"}", std::nullopt)).present, "Remove last property");
        Expect(!ReadCliSetting(EditCliSetting("{\"chatgpt.cliExecutable\":\"old\",\"other\":1}", std::nullopt)).present, "Remove first property");
        Expect(!ReadCliSetting(EditCliSetting("{\"chatgpt.cliExecutable\":\"old\"}", std::nullopt)).present, "Remove only property");
        Expect(EditCliSetting("{\"other\":1 // tail\n}", "x").find("1, // tail") != std::string::npos, "Insert comma before trailing comment");
        Expect(ReadCliSetting(EditCliSetting("{}", "")).present, "Empty string setting remains present");
        Reject([] { EditCliSetting("{\"chatgpt.cliExecutable\":1}", "x"); }, "Reject non-string setting");
        Reject([] { EditCliSetting("{\"chatgpt.cliExecutable\":\"a\",\"chatgpt.cliExecutable\":\"b\"}", "x"); }, "Reject duplicate setting");
        Reject([] { EditCliSetting("{\"other\":", "x"); }, "Reject malformed settings");
        Reject([] { EditCliSetting("[]", "x"); }, "Reject non-object settings");
        Expect(ParseTime("2026-09-24T01:23:45.1230000+08:00") == ParseTime("2026-09-23T17:23:45.123Z"), "Timezone parsing");
        Expect(ParseTime("2026-09-23T17:23:45Z").has_value(), "UTC timestamp parsing");
        Expect(!ParseTime("invalid"), "Reject invalid timestamp");
        Expect(Sha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA256 fixture");
        Reject([] { ParseOptions({L"--automatic", L"--action", L"Stop"}); }, "Reject automatic stop");
        Reject([] { ParseOptions({L"--settings", L"tests/build/settings.json"}); }, "Require paired isolated paths");
        const auto self = FindProcess(GetCurrentProcessId());
        Expect(self.has_value() && SamePath(self->path, ExecutablePath()), "Recognize native process image");
        Expect(std::abs(self->started - NowTicks()) < 30LL * 10000000, "Read process creation time");
        const auto scratch = fs::current_path() / ("registry-sharing-" + std::to_string(GetCurrentProcessId()));
        fs::create_directories(scratch);
        const auto registry = scratch / "instance.json";
        const Json record{{"instanceId", "test"}, {"padding", std::string(65536, 'x')}};
        WriteJson(registry, record);
        std::atomic<bool> done = false;
        std::exception_ptr writeError;
        std::thread writer([&] {
            try { for (int i = 0; i < 200; ++i) {
                const auto temporary = scratch / "instance.tmp";
                WriteJson(temporary, record);
                if (!ReplaceFileW(registry.c_str(), temporary.c_str(), nullptr, 0, nullptr, nullptr))
                    throw std::runtime_error("Registry replacement was blocked by its reader");
            } }
            catch (...) { writeError = std::current_exception(); }
            done = true;
        });
        bool valid = true;
        do {
            const auto value = ReadRegistryJson(registry);
            valid = valid && (value.is_null() || value == record);
        } while (!done);
        writer.join();
        if (writeError) std::rethrow_exception(writeError);
        Expect(valid, "Registry reads allow concurrent atomic replacements");
        Expect(ReadRegistryJson(registry) == record, "Registry reads recover after replacement");
        fs::remove(registry); fs::remove(scratch);
        std::cout << "Native manager core: " << checks << " checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAILED: " << error.what() << '\n'; return 1;
    }
}
