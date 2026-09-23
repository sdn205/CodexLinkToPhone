using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    private readonly HashSet<string> pagedThreads = [];
    private readonly Dictionary<string, Dictionary<string, JsonObject>> summaryTurns = [];

    private void TrackSummaryTurns(string tid, JsonNode? turns)
    {
        foreach (var turn in turns.Items())
        {
            if (turn.S("itemsView") is not ("summary" or "notLoaded")) continue;
            pagedThreads.Add(tid);
            if (!summaryTurns.TryGetValue(tid, out var pending)) summaryTurns[tid] = pending = [];
            pending[turn.S("id")] = turn.Obj();
        }
    }

    private async Task<JsonObject> ReadTurnItems(string tid, JsonObject turn)
    {
        var items = new JsonArray();
        string? cursor = null;
        var seen = new HashSet<string>();
        do
        {
            var page = await Router.Request("thread/items/list", J.O(("threadId", tid), ("turnId", turn.S("id")), ("cursor", cursor), ("limit", 8), ("sortDirection", "asc")));
            if (page.G("data") is not JsonArray) throw new IOException("历史条目分页缺少 data");
            foreach (var entry in page.Arr("data"))
            {
                if (entry.S("turnId") != turn.S("id") || entry.G("item") is not JsonObject item) throw new IOException("历史条目身份不一致");
                items.AddNode(item.DeepClone());
            }
            cursor = J.Null(page.S("nextCursor"));
            if (cursor is not null && !seen.Add(cursor)) throw new IOException("历史条目返回重复游标");
        } while (cursor is not null);
        var complete = turn.Obj(); complete["items"] = items; complete["itemsView"] = "full";
        return complete;
    }

    private async Task<JsonNode> ReadThreadFull(string tid)
    {
        if (!pagedThreads.Contains(tid)) return await Router.Request("thread/read", J.O(("threadId", tid), ("includeTurns", true)));
        var response = await Router.Request("thread/read", J.O(("threadId", tid), ("includeTurns", false)));
        if (response.B("desktopSnapshot")) return response;
        var thread = response.G("thread").Obj();
        if (thread.S("id") != tid) throw new IOException("历史会话身份不一致");
        var turns = new JsonArray(); string? cursor = null; var seen = new HashSet<string>();
        do
        {
            var page = await Router.Request("thread/turns/list", J.O(("threadId", tid), ("cursor", cursor), ("limit", 20), ("itemsView", "summary"), ("sortDirection", "asc")));
            if (page.G("data") is not JsonArray) throw new IOException("历史轮次分页缺少 data");
            foreach (var turn in page.Arr("data")) turns.AddNode(await ReadTurnItems(tid, turn.Obj()));
            cursor = J.Null(page.S("nextCursor"));
            if (cursor is not null && !seen.Add(cursor)) throw new IOException("历史轮次返回重复游标");
        } while (cursor is not null);
        thread["turns"] = turns; var result = response.Obj(); result["thread"] = thread;
        return result;
    }
}
