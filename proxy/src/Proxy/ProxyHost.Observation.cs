using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using CodexPhoneProxy.Protocol;
using CodexPhoneProxy.Runtime;

namespace CodexPhoneProxy.Proxy;

internal sealed partial class ProxyHost
{
    private void ObserveResponse(string method, JsonElement response, JsonElement parameters, bool selectThread)
    {
        if (response.Get("error").Present()) return;
        var result = response.Get("result");
        var thread = result.Get("thread");
        if (method is "thread/start" or "thread/resume" or "thread/revert") SetLoaded(thread.Str("id"), true);
        if (method is "thread/unsubscribe" or "thread/archive") SetLoaded(parameters.Str("threadId"), false);
        if (method == "initialize")
        {
            state.Initialized = true;
            state.UserAgent = result.Get("userAgent").ValueKind == JsonValueKind.String ? result.Str("userAgent") : null;
            var match = Regex.Match(state.UserAgent ?? "", @"(?:^|/)((?:\d+\.){2}\d+(?:-[0-9A-Za-z.-]+)?)(?:\b|\s|\()", RegexOptions.CultureInvariant);
            state.CliVersion = match.Success ? match.Groups[1].Value : null;
            WriteState();
        }
        if (method == "thread/list") foreach (var item in result.Get("data").Items()) state.RememberKind(item);
        if ((method is "thread/start" or "thread/resume" or "thread/revert") && thread.Str("id").Length > 0)
        {
            if (parameters.Get("ephemeral").True() || state.IsInternal(thread)) { state.InternalThreads.Add(thread.Str("id")); return; }
            if (selectThread) { state.SetThread(thread); StateChanged(); }
        }
        else if (method == "thread/read" && thread.Str("id").Length > 0 && (state.CurrentThread is null || thread.Str("id") == state.CurrentThread))
        { state.SetThread(thread); StateChanged(); }
        if (selectThread && (method is "turn/start" or "turn/steer") && parameters.Str("threadId").Length > 0)
        {
            state.CurrentThread = parameters.Str("threadId");
            var turnId = result.Get("turn").Str("id");
            if (turnId.Length == 0) turnId = result.Str("turnId");
            if (turnId.Length > 0) state.ActiveTurn = turnId;
            state.Busy = true;
            StateChanged();
        }
    }
    private void ObserveNotification(JsonElement message)
    {
        var method = message.Str("method");
        var parameters = message.Get("params");
        var thread = parameters.Get("thread");
        var threadId = parameters.Str("threadId");
        if (method == "thread/started") SetLoaded(thread.Str("id"), true);
        if (method == "turn/started") SetLoaded(threadId, true);
        if (method == "thread/closed" || method == "thread/status/changed" && parameters.Get("status").Str("type") == "notLoaded") SetLoaded(threadId, false);
        if (method == "thread/started" && state.IsInternal(thread)) { state.InternalThreads.Add(thread.Str("id")); return; }
        if (state.InternalThreads.Contains(threadId)) return;
        if (method == "thread/started" && thread.Str("id").Length > 0)
        {
            if (state.RememberKind(thread) != "subagent" && state.CurrentThread is null) { state.SetThread(thread); StateChanged(); }
        }
        else if (method == "turn/started" && threadId.Length > 0 && !state.Subagents.Contains(threadId))
        {
            state.CurrentThread ??= threadId;
            if (threadId != state.CurrentThread) return;
            state.ActiveTurn = parameters.Get("turn").Get("id").Present() ? parameters.Get("turn").Str("id") : null;
            state.Busy = true;
            StateChanged();
        }
        else if (method == "turn/completed" && threadId.Length > 0 && !state.Subagents.Contains(threadId))
        {
            if (threadId != state.CurrentThread) return;
            state.ActiveTurn = null; state.Busy = false; StateChanged();
        }
        else if (method == "thread/status/changed" && threadId.Length > 0 && !state.Subagents.Contains(threadId) && ProxyState.IsStatus(parameters.Get("status")))
        {
            if (threadId != state.CurrentThread) return;
            state.Busy = parameters.Get("status").Str("type") == "active";
            if (!state.Busy) state.ActiveTurn = null;
            StateChanged();
        }
        else if (method == "serverRequest/resolved") serverPending.Remove(parameters.Get("requestId").Text());
    }
    private void SetLoaded(string threadId, bool loaded)
    {
        if (threadId.Length == 0 || state.LoadedThreads.Contains(threadId) == loaded) return;
        if (loaded) state.LoadedThreads.Add(threadId); else state.LoadedThreads.Remove(threadId);
        Broadcast(Json.Obj(("type", "notification"), ("notification", Json.Obj(("method", "proxy/threadOwnership"),
            ("params", Json.Obj(("threadId", threadId), ("loaded", loaded)))))));
        StateChanged();
    }
    private void StartBridge()
    {
        if (!options.AutoStart || autoStartRequested) return;
        autoStartRequested = true;
        if (!File.Exists(options.Manager)) { log.Write("phone_manager_missing " + options.Manager); return; }
        try
        {
            var info = ChildProcess.StartInfo(options.Manager,
                ["--action", "Restart", "--automatic", "--proxy-pid", Environment.ProcessId.ToString()]);
            info.WorkingDirectory = options.Root;
            var manager = Process.Start(info) ?? throw new IOException("手机桥管理器启动失败");
            manager.StandardInput.Close();
            // Keep manager output off the extension's JSON-RPC stdout.
            _ = DrainManager(manager);
            log.Write($"phone_manager_auto_start pid={manager.Id}");
        }
        catch (Exception error) { log.Write("phone_manager_auto_start_error " + error.Message); }
    }
    private static async Task DrainManager(Process manager)
    {
        try
        {
            await Task.WhenAll(manager.StandardOutput.BaseStream.CopyToAsync(Stream.Null), manager.StandardError.BaseStream.CopyToAsync(Stream.Null));
            await manager.WaitForExitAsync();
        }
        catch (IOException) { }
        finally { manager.Dispose(); }
    }
}
