#include "Common.h"

#include <stdexcept>

namespace phone_assistant::management {
namespace {
struct Token { size_t first, last; char kind; };
struct Document {
    std::vector<Token> tokens;
    size_t property = SIZE_MAX, value = SIZE_MAX, closing = 0;
};
Document Inspect(std::string_view text) {
    Document document;
    auto& tokens = document.tokens;
    for (size_t i = 0; i < text.size();) {
        const char ch = text[i];
        if (std::isspace(static_cast<unsigned char>(ch))) { ++i; continue; }
        if (text.substr(i, 3) == "\xEF\xBB\xBF" && i == 0) { i += 3; continue; }
        if (text.substr(i, 2) == "//") {
            i = text.find('\n', i);
            if (i == text.npos) break;
            continue;
        }
        if (text.substr(i, 2) == "/*") {
            const auto end = text.find("*/", i + 2);
            if (end == text.npos) throw std::runtime_error("Trae settings 注释未闭合");
            i = end + 2; continue;
        }
        const auto start = i++;
        if (ch == '"') {
            bool closed = false;
            while (i < text.size()) {
                if (text[i] == '\\') { i += 2; continue; }
                if (text[i++] == '"') { closed = true; break; }
            }
            if (!closed) throw std::runtime_error("Trae settings 字符串未闭合");
        } else if (std::string_view("{}[]:,").find(ch) == std::string_view::npos) {
            while (i < text.size() && !std::isspace(static_cast<unsigned char>(text[i])) &&
                std::string_view("{}[]:,/").find(text[i]) == std::string_view::npos) ++i;
        }
        tokens.push_back({start, i, ch});
    }
    std::string canonical;
    for (size_t i = 0; i < tokens.size(); ++i) {
        if (tokens[i].kind == ',' && i + 1 < tokens.size() &&
            (tokens[i + 1].kind == '}' || tokens[i + 1].kind == ']')) continue;
        canonical.append(text.substr(tokens[i].first, tokens[i].last - tokens[i].first));
        canonical += ' ';
    }
    if (!Json::parse(canonical).is_object()) throw std::runtime_error("Trae settings 顶层必须为对象");
    int depth = 0;
    for (size_t i = 0; i < tokens.size(); ++i) {
        const auto& token = tokens[i];
        if (token.kind == '{' || token.kind == '[') ++depth;
        else if (token.kind == '}' || token.kind == ']') {
            --depth;
            if (depth == 0) document.closing = i;
        } else if (depth == 1 && token.kind == '"' && i + 2 < tokens.size() && tokens[i + 1].kind == ':') {
            if (Json::parse(text.substr(token.first, token.last - token.first)).get<std::string>() == "chatgpt.cliExecutable") {
                if (document.property != SIZE_MAX) throw std::runtime_error("Trae settings 中存在重复的 chatgpt.cliExecutable");
                document.property = i;
                document.value = i + 2;
                if (tokens[i + 2].kind != '"') throw std::runtime_error("chatgpt.cliExecutable 必须为字符串");
            }
        }
    }
    return document;
}
} // namespace

CliSetting ReadCliSetting(std::string_view text) {
    const auto document = Inspect(text);
    if (document.property == SIZE_MAX) return {};
    const auto& token = document.tokens[document.value];
    return {true, Json::parse(text.substr(token.first, token.last - token.first)).get<std::string>()};
}
std::string EditCliSetting(std::string_view text, const std::optional<std::string>& value) {
    const auto document = Inspect(text);
    const auto& tokens = document.tokens;
    std::string result(text);
    if (document.property != SIZE_MAX) {
        const auto& token = tokens[document.value];
        if (value) {
            result.replace(token.first, token.last - token.first, Json(*value).dump());
        } else {
            auto start = tokens[document.property].first, end = token.last;
            if (tokens[document.value + 1].kind == ',') end = tokens[document.value + 1].last;
            else if (document.property > 0 && tokens[document.property - 1].kind == ',') start = tokens[document.property - 1].first;
            result.erase(start, end - start);
        }
    } else if (value) {
        const auto previous = tokens[document.closing - 1];
        const auto newline = text.find("\r\n") != text.npos ? "\r\n" : "\n";
        result.insert(tokens[document.closing].first, std::string(newline) + "    \"chatgpt.cliExecutable\": " + Json(*value).dump() + newline);
        if (previous.kind != '{' && previous.kind != ',') result.insert(previous.last, ",");
    }
    Inspect(result);
    return result;
}
} // namespace phone_assistant::management
