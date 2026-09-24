using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodexPhoneBridge;

internal sealed class MessageNormalizer(ImageStore images)
{
    public (string Text, JsonArray Images) UserContent(JsonNode? content)
    {
        var text = new List<string>(); var pictures = new JsonArray(); var seen = new HashSet<string>();
        foreach (var input in content.Items())
        {
            string chunk = input.S("type") switch { "text" => input.S("text"), "mention" => "@" + input.S("name"), "skill" => "$" + input.S("name"), _ => "" }; if (chunk != "") text.Add(chunk);
            var image = images.FromInput(input); if (image is not null && seen.Add(image.S("path", image.S("fingerprint", image.S("url"))))) pictures.AddNode(image);
        }
        return (string.Join("\n\n", text), pictures);
    }
    public JsonObject? Normalize(JsonNode item, JsonObject context)
    {
        if (item.S("id") == "" || context.S("threadId") == "") return null;
        string type = item.S("type"), turn = context.S("turnId"); long created = J.Epoch(context.G("createdAt")); if (created == 0) created = J.Now;
        // Context contributes event identity and timing, never another copy of the item.
        var metadata = context.Obj(); metadata.Remove("item");
        var meta = J.Merge(item, metadata); meta.Remove("createdAt"); meta.Remove("completedAt");
        meta["turnStartedAt"] = J.Epoch(context.G("createdAt")) is > 0 and var started ? started : null;
        meta["turnCompletedAt"] = J.Epoch(context.G("completedAt")) is > 0 and var ended ? ended : null;
        long turnOrder = context.N("turnOrderAt", J.UuidTime(turn)); if (turnOrder == 0) turnOrder = created; meta["turnOrderAt"] = turnOrder;
        string role = "tool", kind = "", text = "", id = item.S("id"); bool streaming = item.S("status") == "inProgress";
        switch (type)
        {
            case "userMessage":
                role = "user"; kind = "text"; var user = UserContent(item.G("content")); text = user.Text; meta.Remove("content"); meta["images"] = user.Images;
                string cid = item.S("clientUserMessageId", item.S("clientId")); if (cid != "") meta["clientUserMessageId"] = cid; if (meta.N("userMessageOrderAt") == 0) meta["userMessageOrderAt"] = turnOrder; break;
            case "agentMessage": role = "assistant"; kind = "text"; text = item.S("text"); streaming = context.B("streaming"); break;
            case "reasoning": role = "assistant"; kind = "reasoning"; meta["summaryParts"] = J.A(item.Arr("summary")); meta["contentParts"] = J.A(item.Arr("content")); text = string.Join("\n\n", item.Arr("summary").Concat(item.Arr("content")).Select(x => x.Text())); streaming = context.B("streaming"); break;
            case "plan":
                role = "assistant"; kind = "plan"; if (turn != "") id = turn + ":plan";
                var plan = PlanSteps(item.G("plan") is JsonArray a ? a : item.G("plan").G("steps") ?? item.G("steps") ?? item.G("tasks"));
                text = item.S("text").Trim(); if (text == "") text = PlanText(item.S("explanation"), plan);
                if (plan.Count == 0) foreach (Match m in Regex.Matches(text, @"(?m)^\s*-\s*\[([xX~ ])\]\s+(.+?)\s*$")) plan.AddNode(J.O(("step", m.Groups[2].Value), ("status", m.Groups[1].Value.ToLowerInvariant() == "x" ? "completed" : m.Groups[1].Value == "~" ? "in_progress" : "pending")));
                meta["plan"] = plan; meta["explanation"] = item.S("explanation"); streaming = context.B("streaming"); break;
            case "commandExecution": kind = "command"; text = item.S("command") + (item.S("aggregatedOutput") == "" ? "" : "\n\n" + item.S("aggregatedOutput")); break;
            case "fileChange": kind = "file"; var changes = DiffData.Normalize(item.G("changes")); meta["changes"] = changes; text = $"文件变更：{item.S("status")}，共 {changes.Count} 项"; break;
            case "mcpToolCall": kind = "tool"; text = item.S("server") + "." + item.S("tool") + "：" + item.S("status"); break;
            case "dynamicToolCall": kind = "dynamic_tool"; text = (item.S("namespace") == "" ? "" : item.S("namespace") + ".") + item.S("tool") + "：" + item.S("status"); string output = string.Join("\n\n", item.Arr("contentItems").Where(x => x.S("type") == "inputText").Select(x => x.S("text"))); if (output != "") text += "\n\n" + output; meta["images"] = J.A(item.Arr("contentItems").Where(x => x.S("type") == "inputImage" && x.S("imageUrl") != "").Select((x, i) => J.O(("url", x.G("imageUrl")), ("name", "工具图片 " + (i + 1))))); break;
            case "collabAgentToolCall": kind = "collab_agent"; text = item.S("tool") + "：" + item.S("status") + (item.S("prompt") == "" ? "" : "\n\n" + item.S("prompt")); break;
            case "subAgentActivity": kind = "subagent_activity"; text = item.S("kind") + "：" + item.S("agentPath"); break;
            case "webSearch": kind = "search"; text = "搜索：" + item.S("query"); break;
            case "imageView": kind = "image_view"; text = "查看图片：" + item.S("path"); meta["images"] = Picture(item.S("path")); break;
            case "imageGeneration": kind = "image_generation"; var generated = Picture(item.S("savedPath")); string result = item.S("result").Trim(); if (generated.Count == 0 && Regex.IsMatch(result, @"^(https?://|data:image/)", RegexOptions.IgnoreCase)) generated.AddNode(J.O(("url", result), ("name", "生成图片"))); text = "图片生成：" + item.S("status") + (generated.Count == 0 && result != "" ? "\n\n" + result : ""); meta["images"] = generated; break;
            case "sleep": kind = "sleep"; text = $"等待 {item.N("durationMs")} ms"; break;
            case "hookPrompt": kind = "hook_prompt"; text = string.Join("\n\n", item.Arr("fragments").Select(x => x.S("text"))); break;
            case "enteredReviewMode": case "exitedReviewMode": role = "assistant"; kind = "review_state"; bool entered = type == "enteredReviewMode"; text = (entered ? "进入" : "退出") + "审核模式" + (item.S("review") == "" ? "" : "\n\n" + item.S("review")); meta["state"] = entered ? "entered" : "exited"; break;
            case "contextCompaction": role = "assistant"; kind = "context_compaction"; text = "已压缩上下文"; streaming = context.G("completedAt") is null || J.Epoch(context.G("completedAt")) == 0; meta["status"] = streaming ? "inProgress" : "completed"; break;
            default: return null;
        }
        return J.O(("id", id), ("role", role), ("kind", kind), ("text", text), ("streaming", streaming), ("meta", meta), ("createdAt", created));
    }
    private JsonArray Picture(string path) => path != "" && ImageStore.Supported(path) ? new JsonArray(J.O(("url", images.LocalUrl(path)), ("path", path), ("name", Path.GetFileName(path)))) : new();
    public static JsonArray PlanSteps(JsonNode? raw) => J.A(raw.Items().Select(x => J.O(("step", x is JsonValue ? x.Text() : x.S("step", x.S("text"))), ("status", Regex.Replace(x.S("status").ToLowerInvariant(), "[-\\s]", "_") switch { "completed" or "complete" or "done" => "completed", "inprogress" or "in_progress" or "running" => "in_progress", _ => "pending" }))).Where(x => x.S("step") != ""));
    public static string PlanText(string explanation, JsonArray steps) => (explanation + "\n" + string.Join('\n', steps.Select(x => "- [" + (x.S("status") == "completed" ? "x" : x.S("status") == "in_progress" ? "~" : " ") + "] " + x.S("step")))).Trim();
}
