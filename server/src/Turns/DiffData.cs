using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodexPhoneBridge;

internal static class DiffData
{
    private static string PathName(string p) => Regex.Replace(p.Replace('\\', '/'), "/+", "/");
    public static JsonArray Normalize(JsonNode? raw) => J.A(raw.Items().Where(x => x.S("path") != "").Select(x =>
    {
        var c = x.Obj(); c["path"] = PathName(x.S("path")); var stats = Stats(x.S("diff"), x.G("kind").S("type"));
        c["added"] = Math.Max(0, x.N("added", stats.Added)); c["deleted"] = Math.Max(0, x.N("deleted", stats.Deleted)); return c;
    }));
    private static (int Added, int Deleted) Stats(string diff, string kind = "")
    {
        var lines = diff.Replace("\r", "").Split('\n'); int add = 0, del = 0;
        foreach (var line in lines) { if (line.StartsWith("+++") || line.StartsWith("---")) continue; if (line.StartsWith('+')) add++; else if (line.StartsWith('-')) del++; }
        if (add == 0 && del == 0 && kind == "add") add = lines.Count(x => x.Length > 0); return (add, del);
    }
    public static JsonArray Parse(string diff)
    {
        var changes = new List<JsonObject>(); JsonObject? current = null;
        string Header(string s) { s = s.Trim().Trim('"'); return s == "/dev/null" ? "" : PathName(Regex.Replace(s, "^[ab]/", "")); }
        foreach (string line in diff.Replace("\r", "").Split('\n'))
        {
            var m = Regex.Match(line, @"^diff --git\s+(.+?)\s+(.+)$");
            if (m.Success) { if (current is not null) changes.Add(current); current = J.O(("path", Header(m.Groups[2].Value)), ("added", 0), ("deleted", 0)); continue; }
            if (current is null && (line.StartsWith("--- ") || line.StartsWith("+++ "))) current = J.O(("path", ""), ("added", 0), ("deleted", 0));
            if (current is null) continue;
            if (line.StartsWith("+++ ")) { string p = Header(line[4..]); if (p != "") current["path"] = p; }
            else if (line.StartsWith("--- ")) { if (current.S("path") == "") current["path"] = Header(line[4..]); }
            else if (line.StartsWith("rename to ")) current["path"] = Header(line[10..]);
            else if (line.StartsWith('+')) current["added"] = current.N("added") + 1;
            else if (line.StartsWith('-')) current["deleted"] = current.N("deleted") + 1;
        }
        if (current is not null) changes.Add(current); return Aggregate(changes);
    }
    public static JsonArray Aggregate(IEnumerable<JsonNode> changes) => J.A(changes.Where(x => x.S("path") != "").GroupBy(x => PathName(x.S("path"))).OrderBy(x => x.Key, StringComparer.Ordinal).Select(g => J.O(("path", g.Key), ("added", g.Sum(x => x.N("added"))), ("deleted", g.Sum(x => x.N("deleted"))))));
}
