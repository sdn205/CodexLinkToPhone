using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    private async Task<JsonNode> ReadTurnsPage(string tid, string? cursor, string direction)
    {
        var page = await Router.Request("thread/turns/list", J.O(("threadId", tid), ("cursor", cursor), ("limit", 20), ("itemsView", "full"), ("sortDirection", direction)));
        if (page.G("data") is not JsonArray) throw new IOException("历史轮次分页缺少 data");
        var ids = new HashSet<string>();
        foreach (var turn in page.Arr("data"))
        {
            if (turn.S("id") == "" || !ids.Add(turn.S("id"))) throw new IOException("历史轮次身份重复或缺失");
            if (turn.S("itemsView") is "summary" or "notLoaded" || turn.G("items") is not JsonArray) throw new IOException("历史轮次内容不完整");
        }
        if (cursor is not null && page.S("nextCursor") == cursor) throw new IOException("历史轮次返回重复游标");
        return page;
    }

    private async Task<JsonArray> ReadFullTurns(string tid)
    {
        var turns = new JsonArray();
        string? cursor = null;
        var seen = new HashSet<string>();
        var ids = new HashSet<string>();
        do
        {
            var page = await ReadTurnsPage(tid, cursor, "asc");
            foreach (var turn in page.Arr("data"))
            {
                if (turn.S("id") == "" || !ids.Add(turn.S("id"))) throw new IOException("历史轮次身份重复或缺失");
                if (turn.S("itemsView") is "summary" or "notLoaded" || turn.G("items") is not JsonArray) throw new IOException("历史轮次内容不完整");
                turns.AddNode(turn.DeepClone());
            }
            cursor = J.Null(page.S("nextCursor"));
            if (cursor is not null && !seen.Add(cursor)) throw new IOException("历史轮次返回重复游标");
        } while (cursor is not null);
        return turns;
    }

    private async Task<JsonNode> ReadThreadFull(string tid)
    {
        var response = await Router.Request("thread/read", J.O(("threadId", tid), ("includeTurns", false)));
        if (response.B("desktopSnapshot")) return response;
        var thread = response.G("thread").Obj();
        if (thread.S("id") != tid) throw new IOException("历史会话身份不一致");
        var turns = await ReadFullTurns(tid);
        thread["turns"] = turns; var result = response.Obj(); result["thread"] = thread;
        return result;
    }
}
