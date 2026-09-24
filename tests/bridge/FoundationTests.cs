using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed partial class BridgeRuntime
{
    internal static void RegisterFoundationTests()
    {
        T.Add("proxy-registry/readers-allow-atomic-replacement", async f => {
            string directory = Path.Combine(f.Directory, "registry"); Directory.CreateDirectory(directory);
            string file = Path.Combine(directory, "test.json");
            var state = J.O(("mode", "stdio-tee"), ("instanceId", "test"), ("initialized", true), ("upstreamConnected", true),
                ("loadedThreadIds", new JsonArray()), ("pid", Environment.ProcessId), ("upstreamPid", Environment.ProcessId),
                ("updatedAt", DateTimeOffset.UtcNow.ToString("O")), ("padding", new string('x', 65536)));
            Persistence.Write(file, state);
            var registry = new ProxyRegistry(directory);
            var writer = Task.Run(() => {
                for (int i = 0; i < 200; i++) {
                    File.WriteAllText(file + ".tmp", state.Wire(), System.Text.Encoding.UTF8);
                    File.Replace(file + ".tmp", file, null);
                }
            });
            do {
                var scan = registry.Read();
                T.Is(scan.Instances.Count <= 1);
                foreach (var snapshot in scan.Instances) T.Same(snapshot, state);
                await Task.Yield();
            } while (!writer.IsCompleted);
            await writer;
            T.Equal(registry.Read().Instances.Count, 1);
            using (var locked = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.None))
                T.Is(!registry.Read().Complete, "an unreadable registration is not an absent process");
            T.Is(registry.Read().Complete);
        });
        T.Add("persistence/merged-selection-and-unread-restart", f => {
            var b = f.Bridge; var phone = f.Phone().Client;
            b.Unread.Add("unread-a"); b.PersistUnread();
            var initial = new BridgeRuntime(b.Config, f.Cancel.Token);
            T.Is(!initial.selectionSaved); T.Is(initial.Unread.Contains("unread-a")); initial.Router.Close();
            b.Select(phone, "selected-b", true);
            b.Unread.Add("unread-c"); b.PersistUnread();
            var restored = new BridgeRuntime(b.Config, f.Cancel.Token);
            T.Is(restored.selectionSaved); T.Equal(restored.selection, "selected-b");
            T.Is(restored.Unread.SetEquals(new[] { "unread-a", "unread-c" })); restored.Router.Close();
            b.Select(phone, "", true); b.Unread.Clear(); b.PersistUnread();
            var empty = new BridgeRuntime(b.Config, f.Cancel.Token);
            T.Is(empty.selectionSaved); T.Equal(empty.selection, ""); T.Equal(empty.Unread.Count, 0); empty.Router.Close();
            T.Equal(Directory.GetFiles(f.Directory, "*.json").Length, 1);
        });
        T.Add("configuration/relay-address-and-isolated-mode", f => {
            string? disabled = Environment.GetEnvironmentVariable("CODEX_PHONE_RELAY_DISABLED"), url = Environment.GetEnvironmentVariable("PUBLIC_URL");
            try {
                Environment.SetEnvironmentVariable("CODEX_PHONE_RELAY_DISABLED", "0");
                Environment.SetEnvironmentVariable("PUBLIC_URL", null);
                var config = new Configuration();
                T.Equal(config.Mode, "relay"); T.Is(config.RelayEnabled);
                T.Equal(config.ConfiguredUrl, "http://127.0.0.1:18003/"); T.Is(config.Fingerprint.Length > 0);
                T.Equal(f.Bridge.Health().G("publicAccess").S("relayStatus"), "disabled");
                T.Equal(f.Bridge.PublicUrl, "http://127.0.0.1:18001/");
            } finally {
                Environment.SetEnvironmentVariable("CODEX_PHONE_RELAY_DISABLED", disabled);
                Environment.SetEnvironmentVariable("PUBLIC_URL", url);
            }
        });
        T.Add("configuration/reject-unsupported-mode", f => {
            string? original = Environment.GetEnvironmentVariable("CODEX_PHONE_MODE_CONFIG");
            string path = Path.Combine(f.Directory, "unsupported.ini");
            File.WriteAllText(path, File.ReadAllText(original!).Replace("mode=relay", "mode=unsupported"));
            try { Environment.SetEnvironmentVariable("CODEX_PHONE_MODE_CONFIG", path); T.Throws(() => new Configuration()); }
            finally { Environment.SetEnvironmentVariable("CODEX_PHONE_MODE_CONFIG", original); }
        });
        T.Add("persistence/atomic-roundtrip-and-write-order", f => {
            string path = Path.Combine(f.Directory, "nested/state.json");
            var data = T.Obj("{\"version\":1,\"text\":\"中文🙂\",\"items\":[1,2,3]}");
            Persistence.Write(path, data); T.Same(Persistence.Read(path), data);
            for (int i = 0; i < 50; i++) Persistence.Write(path, J.O(("step", i)));
            T.Equal(Persistence.Read(path).N("step"), 49L);
            T.Equal(Directory.GetFiles(Path.GetDirectoryName(path)!, "*.tmp-*").Length, 0);
        });
        T.Add("persistence/missing-corrupt-and-failed-write", f => {
            string path = Path.Combine(f.Directory, "missing.json"); T.Is(Persistence.Read(path) is null);
            File.WriteAllText(path, "{bad"); T.Is(Persistence.Read(path) is null);
            File.WriteAllText(path, "\uFEFF{\"value\":3}"); T.Equal(Persistence.Read(path).N("value"), 3L);
            string blocked = Path.Combine(f.Directory, "blocked"); Directory.CreateDirectory(blocked);
            T.Throws(() => Persistence.Write(blocked, new JsonObject()));
            Persistence.Write(path, J.O(("ok", true))); T.Is(Persistence.Read(path).B("ok"));
        });
        T.Add("model-catalog/normalize-and-preferred-default", async f => {
            var b = f.Bridge; var peer = f.Peer();
            peer.Handler = m => Task.FromResult<JsonNode>(m.S("method") == "model/list"
                ? T.Obj("{\"data\":[{}, {\"id\":\"gpt-test\",\"name\":\"Test\",\"default\":true,\"defaultEffort\":\"high\",\"supportedReasoningEfforts\":[{\"effort\":\"high\"}]}]}")
                : T.Obj("{\"data\":[]} "));
            await b.InitializeUpstream(); T.Equal(b.Models.Count, 1);
            T.Equal(b.Models[0].S("model"), "gpt-test"); T.Equal(b.Models[0].S("displayName"), "Test");
            T.Equal(b.Models[0].Arr("supportedReasoningEfforts").First().S("label"), "high");
            T.Same(b.DefaultSettings(), T.Obj("{\"model\":\"gpt-test\",\"effort\":\"high\"}"));
        });
        T.Add("model-catalog/settings-default-and-invalid-values", async f => {
            var b = f.Bridge; b.Models = new JsonArray(T.Obj("{\"model\":\"gpt-test\",\"isDefault\":true,\"defaultReasoningEffort\":\"high\",\"supportedReasoningEfforts\":[{\"reasoningEffort\":\"high\"}]}"));
            var (client, wire) = f.Phone();
            foreach (var (model, effort, code) in new[] { ("missing", "high", "invalid_model"), ("gpt-test", "fast", "invalid_reasoning_effort"), ("gpt-test", "", "") }) {
                int count = wire.Sent.Count;
                await b.HandlePhone(client, J.O(("type", "settings:update"), ("threadId", "a"), ("threadRevision", 0), ("model", model), ("effort", effort)));
                await T.Until(() => wire.Sent.Count > count);
                var response = wire.Sent.Last(x => x.S("operation") == "settings:update"); T.Equal(response.S("code"), code);
                if (code == "") T.Equal(response.S("effort"), "high"); else T.Is(!b.Settings.ContainsKey("a"));
            }
        });
        T.Add("thread-runtime/epoch-seconds-milliseconds-iso-invalid", _ => {
            const long stamp = 1800000000000L;
            foreach (var value in new JsonNode[] { JsonValue.Create(stamp)!, JsonValue.Create(stamp / 1000)!, JsonValue.Create("1800000000")!, JsonValue.Create(DateTimeOffset.FromUnixTimeMilliseconds(stamp).ToString("O"))! }) T.Equal(J.Epoch(value), stamp);
            foreach (var value in new[] { "", "bad", "-1", "NaN", "Infinity" }) T.Equal(J.Epoch(JsonValue.Create(value)), 0L);
        });
    }
}
