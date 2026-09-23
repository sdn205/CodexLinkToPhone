using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    private sealed class TitleWaiter { public string Turn = "", Text = ""; public TaskCompletionSource<JsonObject?> Done = new(TaskCreationOptions.RunContinuationsAsynchronously); }
    private readonly Dictionary<string, TitleWaiter> titleWaiters = [];
    private readonly HashSet<string> titleJobs = [];
    private static string ProvisionalTitle(string prompt)
    {
        string text = prompt.Replace("\r", "").Split('\n').FirstOrDefault(s => s.Trim() != "")?.Trim() ?? "新会话"; text = Regex.Replace(Regex.Replace(text, @"^#{1,6}\s+", ""), @"\s+", " "); return text.Length > 36 ? text[..35].TrimEnd() + "…" : text;
    }
    private async Task PersistName(string tid, string name) { try { await Router.Request("thread/name/set", J.O(("threadId", tid), ("name", name)), 30000); } catch (Exception e) { Console.Error.WriteLine("写入标题失败：" + e.Message); } }
    private void ScheduleTitle(string tid)
    { if (!pendingTitles.ContainsKey(tid) || titleJobs.Contains(tid) || !Router.Connected) return; titleJobs.Add(tid); EventLoop.Observe(TitleJob(tid)); }
    private async Task TitleJob(string tid)
    {
        string titleThread = ""; TitleWaiter? waiter = null;
        try
        {
            await Task.Yield(); if (!pendingTitles.TryGetValue(tid, out var metadata)) return;
            string current = Threads.GetValueOrDefault(tid).S("name"); if (!GenericName(current) && current != metadata.S("provisionalName")) return;
            var start = await Router.Request("thread/start", J.O(("model", "gpt-5.4-mini"), ("modelProvider", null), ("cwd", metadata.S("cwd", Config.Cwd)), ("approvalPolicy", "never"), ("permissions", ":read-only"), ("runtimeWorkspaceRoots", new JsonArray()),
                ("config", J.O(("features.enable_fanout", false), ("features.hooks", false), ("features.multi_agent", false), ("features.multi_agent_v2", false), ("web_search", "disabled"), ("model_reasoning_effort", "low"))),
                ("personality", null), ("ephemeral", true), ("threadSource", "system"), ("experimentalRawEvents", false), ("dynamicTools", null), ("allowProviderModelFallback", true), ("serviceTier", null)));
            titleThread = start.G("thread").S("id"); if (titleThread == "") return; internalThreads.Add(titleThread); waiter = new(); titleWaiters[titleThread] = waiter;
            string prompt = metadata.S("prompt").Trim(); if (prompt.Length > 2000) prompt = prompt[..2000];
            string instruction = "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.\nGenerate a concise UI title (up to 36 characters) and a compact search-oriented description (up to 100 characters).\nDo not include quotes, markdown, formatting characters, or trailing punctuation.\nIf the task includes a ticket reference, include it verbatim.\nUse the user's locale and write only the structured fields.\nUser prompt:\n" + prompt;
            var schema = J.O(("$schema", "https://json-schema.org/draft/2020-12/schema"), ("type", "object"), ("properties", J.O(("title", J.O(("type", "string"), ("minLength", 1), ("maxLength", 36))), ("description", J.O(("type", "string"), ("minLength", 1))))), ("required", J.Strings(["title", "description"])), ("additionalProperties", false));
            var turnTask = Router.Request("turn/start", J.O(("threadId", titleThread), ("clientUserMessageId", J.Id()), ("input", new JsonArray(J.O(("type", "text"), ("text", instruction), ("text_elements", new JsonArray())))), ("cwd", null), ("approvalPolicy", null), ("permissions", ":read-only"), ("runtimeWorkspaceRoots", new JsonArray()), ("model", null), ("effort", null), ("serviceTier", null), ("summary", "none"), ("personality", null), ("outputSchema", schema), ("collaborationMode", null)));
            EventLoop.Observe(TrackTitleStart(turnTask, waiter));
            var result = await waiter.Done.Task.WaitAsync(TimeSpan.FromMilliseconds(Configuration.Int("CODEX_PHONE_TITLE_TIMEOUT_MS", 30000, 250)), Cancellation);
            if (result is null) return;
            string name = result.S("title"); string latest = Threads.GetValueOrDefault(tid).S("name");
            if (GenericName(latest) || latest == metadata.S("provisionalName")) { await PersistName(tid, name); Rename(tid, name); Broadcast(); }
        }
        catch (TimeoutException) { if (waiter?.Turn is { Length: > 0 } turn) EventLoop.Observe(Router.Request("turn/interrupt", J.O(("threadId", titleThread), ("turnId", turn)), 15000)); }
        catch (Exception e) { Console.Error.WriteLine("标题生成失败：" + e.Message); }
        finally
        {
            if (titleThread != "") { titleWaiters.Remove(titleThread); if (!Cancellation.IsCancellationRequested) try { await Router.Request("thread/unsubscribe", J.O(("threadId", titleThread)), 15000); } catch (Exception e) { Console.Error.WriteLine("释放标题会话失败：" + e.Message); } }
            pendingTitles.Remove(tid); PersistOperations(); titleJobs.Remove(tid);
        }
    }
    private static async Task TrackTitleStart(Task<JsonNode> task, TitleWaiter waiter)
    { try { var r = await task; if (waiter.Turn == "") waiter.Turn = r.G("turn").S("id"); } catch (Exception e) { waiter.Done.TrySetException(e); } }
    private void TitleNotification(string method, JsonObject p)
    {
        if (!titleWaiters.TryGetValue(p.S("threadId"), out var waiter)) return;
        if (method == "turn/started") { waiter.Turn = p.G("turn").S("id", waiter.Turn); return; }
        if (waiter.Turn != "" && p.S("turnId") != "" && waiter.Turn != p.S("turnId")) return;
        if (method == "item/agentMessage/delta") { waiter.Text += p.S("delta"); return; }
        if (method == "item/completed" && p.G("item").S("type") == "agentMessage") { waiter.Text = p.G("item").S("text"); return; }
        if (method != "turn/completed") return;
        if (waiter.Turn != "" && p.G("turn").S("id") != waiter.Turn) return;
        if (p.G("turn").S("status") != "completed") { waiter.Done.TrySetException(new IOException("标题生成轮次失败")); return; }
        JsonObject? result = null;
        try { var data = J.Parse(waiter.Text); string title = data.S("title"); if (title.Length is > 0 and <= 36 && data.S("description") != "") { title = Regex.Replace(title.Split('\n').FirstOrDefault(s => s.Trim() != "")?.Trim() ?? "", @"^title[:\s]+", "", RegexOptions.IgnoreCase).Trim('`', '\"', '\'', '“', '”', '‘', '’'); title = Regex.Replace(title, @"\s+", " ").TrimEnd('.', '?', '!').Trim(); if (title != "") result = J.O(("title", title), ("description", Regex.Replace(data.S("description").Trim(), @"\s+", " "))); } } catch (System.Text.Json.JsonException) { }
        waiter.Done.TrySetResult(result);
    }
}
