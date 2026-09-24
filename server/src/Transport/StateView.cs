using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    public JsonObject Health() => J.O(("app", J.O(("name", "Codex Link To Phone"), ("bridgeVersion", "2026-09-24.js-behavior"), ("bridgeEpoch", Epoch), ("pid", Environment.ProcessId), ("autoLifecycleEnabled", Config.AutoLifecycle), ("proxyLifecycleGraceMs", Config.GraceMs), ("publicUrl", PublicUrl), ("directUrl", DirectUrl), ("qrPath", "/qr.svg?token=" + Uri.EscapeDataString(Config.Token)), ("cwd", Config.Cwd))),
        ("codex", J.O(("status", Router.Connected ? "connected" : "disconnected"), ("error", Router.Connected ? "" : "等待 Trae Codex 实例连接"), ("info", Router.Info()))),
        ("publicAccess", J.O(("mode", Config.Mode), ("configuredUrl", J.Null(Config.ConfiguredUrl)), ("relayIntegrated", Relay is not null), ("relayStatus", Relay?.Status ?? "disabled"), ("relayError", Relay?.Error ?? ""), ("relayPid", Relay is not null ? Environment.ProcessId : null), ("relayServer", Relay is not null ? Config.RelayServer : null), ("relayAgentPort", Relay is not null ? Config.AgentPort : null), ("relayPublicPort", Relay is not null ? Config.PublicPort : null), ("relayConfigFingerprint", Relay is not null ? Config.Fingerprint : null))));
    public JsonObject Catalog()
    {
        var state = Health();
        state["threads"] = J.A(Threads.Values.OrderByDescending(t => t.N("recencyAt")).Select(t =>
        { var summary = t.Obj(); summary["unread"] = Unread.Contains(t.S("id")); if (ReadRuntime(t.S("id")).Busy) summary["status"] = "running"; return summary; }));
        state.Set("models", Models); return state;
    }
    public JsonObject State(PhoneSession? client = null, bool compact = true)
    {
        string tid = client?.ThreadId ?? CurrentThread; var runtime = ReadRuntime(tid); var all = Messages.ForThread(tid); var visible = client?.Window(all) ?? all;
        var state = Catalog(); state["currentThreadId"] = J.Null(tid); state["threadRevision"] = client?.Revision ?? CurrentRevision;
        state["activeTurnThreadId"] = runtime.Busy ? J.Null(tid) : null; state["activeTurnId"] = J.Null(runtime.Turn); state["activeTurnStartedAt"] = runtime.Started > 0 ? runtime.Started : null; state["activeTurnReplyStartedAt"] = runtime.ReplyStarted > 0 ? runtime.ReplyStarted : null;
        state.Set("lastTurnTiming", runtime.LastTiming); state["turnTimings"] = J.A(runtime.Timings.Values); state["busy"] = runtime.Busy;
        state.Set("threadTokenUsage", TokenUsage.GetValueOrDefault(tid)); state.Set("threadSettings", tid == "" && client?.PendingOptions is not null ? client.PendingOptions : Settings.GetValueOrDefault(tid) ?? DefaultSettings());
        state["messages"] = J.A(visible.Select(m => compact ? Compact(m) : FullMessage(m)));
        state["sync"] = J.O(("mode", compact ? "compact-patch" : "full"), ("totalMessages", all.Count), ("omittedMessages", all.Count - visible.Count), ("messageLimit", visible.Count), ("textLimit", Config.TextLimit), ("toolTextLimit", Config.ToolTextLimit)); return state;
    }
    public static JsonObject FullMessage(JsonObject original)
    {
        var message = Annotations.Project(original); string text = message.S("text");
        message["textHash"] = J.TextHash(text); message["originalLength"] = text.Length; message["textTruncated"] = false;
        return message;
    }
    public JsonObject Compact(JsonObject original, bool stream = false)
    {
        var message = FullMessage(original); var meta = message.G("meta").Obj(); meta.Remove("snapshotOrders");
        if (message.S("kind") == "command") meta.Remove("aggregatedOutput");
        if (message.S("kind") == "turn_diff") meta.Remove("unifiedDiff");
        if (meta.S("type") == "agentMessage" && meta.S("text") == message.S("text")) meta.Remove("text"); if (meta.S("type") == "userMessage") meta.Remove("content");
        if (message.S("role") == "assistant" && message.S("text").Contains(":codex-annotation"))
        {
            var previous = Messages.ForThread(MessageOrder.Thread(message)).TakeWhile(x => x.S("id") != message.S("id")).LastOrDefault(x => x.S("role") == "user");
            var annotations = Annotations.Decode(previous?.S("text") ?? ""); if (annotations is not null) meta.Set("responseAnnotations", annotations.G("annotations"));
        }
        if (message.S("kind") is "file" or "turn_diff") meta["changes"] = J.A(meta.Arr("changes").Select(c => J.O(("path", c.S("path")), ("added", c.N("added")), ("deleted", c.N("deleted")), ("kind", c.G("kind").S("type", c.S("kind"))), ("status", c.S("status")))));
        message["meta"] = meta; message.Remove("unifiedDiff"); message.Remove("aggregatedOutput");
        string text = message.S("text"); int limit = message.S("role") == "tool" ? Config.ToolTextLimit : Config.TextLimit;
        bool truncate = !PhoneSession.StreamingText(message) && text.Length > limit;
        if (truncate) { int head = (int)(limit * .7), tail = limit - head; message["text"] = text[..head] + "\n\n[中间内容已在手机端折叠]\n\n" + text[^tail..]; }
        message["textTruncated"] = truncate; message["originalLength"] = text.Length;
        if (stream) { message.Remove("text"); message.Remove("textHash"); message.Remove("textTruncated"); message.Remove("originalLength"); }
        return message;
    }
}

internal static class Annotations
{
    public static JsonObject? Decode(string text)
    {
        const string prefix = "\n# Response annotations:\n", open = "\n<response-annotations>\n", close = "\n</response-annotations>\n";
        if (!text.StartsWith(prefix, StringComparison.Ordinal)) return null; int start = text.IndexOf(open, prefix.Length, StringComparison.Ordinal); if (start < 0) return null; int end = text.IndexOf(close, start + open.Length, StringComparison.Ordinal); if (end < 0) return null;
        try
        {
            if (J.Parse(text[(start + open.Length)..end]) is not JsonArray values || values.Count == 0) return null;
            foreach (var v in values) { if (v is not JsonObject || v.S("text").Trim() == "") return null; var src = v.G("source"); if (src is not null && (src.S("messageId") == "" || src.N("startOffset", -1) < 0 || src.N("endOffset") <= src.N("startOffset"))) return null; }
            string tail = text[(end + close.Length)..]; var marker = System.Text.RegularExpressions.Regex.Match(tail, @"(?:^|\n)## My request(?: for Codex)?:\s*\n"); if (!marker.Success) return null;
            return J.O(("annotations", values), ("prompt", tail[(marker.Index + marker.Length)..].Trim()));
        }
        catch (System.Text.Json.JsonException) { return null; }
    }
    public static JsonObject Project(JsonObject original)
    {
        var m = original.Obj(); if (m.S("role") != "user") return m; var decoded = Decode(m.S("text")); if (decoded is null) return m;
        m.Set("text", decoded.G("prompt")); var meta = m.G("meta").Obj(); meta.Set("responseAnnotations", decoded.G("annotations")); m["meta"] = meta; return m;
    }
}
