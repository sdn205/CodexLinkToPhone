import { proxyExe, fakeEnv } from "../fixtures/native-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { readProxyInstances } from "../fixtures/instance-registry.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("two real proxy processes register independently and closing one preserves the other", async (t) => {
  const directory = await fs.mkdtemp(path.join(root, "tests/build", "instance-registry-test-"));
  const statePath = path.join(directory, "instances");
  const children = [];
  async function stop(child) {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.stdin.end();
    await exited;
  }
  t.after(async () => {
    await Promise.all(children.map(stop));
  // Retain isolated evidence under tests/build; no recursive deletion.
  });
  function start() {
    const child = spawn(proxyExe, ["app-server"], {
      cwd: root, windowsHide: true, stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, ...fakeEnv(path.join(root, "tests/fixtures/fake-app-server.mjs")), CODEX_PROXY_REGISTRY: statePath, CODEX_PHONE_AUTO_START: "0", CODEX_PROXY_LOG: path.join(directory, "proxy.log") }
    });
    children.push(child);
    child.stderr.on("data", () => {});
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {
      clientInfo: { name: "registry-test", title: "test", version: "1" },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true, requestAttestation: false }
    } }) + "\n");
    return child;
  }
  async function waitForCount(count) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const entries = readProxyInstances(statePath);
      if (entries.length === count) return entries;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`expected ${count} registered instances`);
  }
  const a = start();
  await waitForCount(1);
  const b = start();
  const both = await waitForCount(2);
  assert.deepEqual(new Set(both.map((state) => state.pid)), new Set([a.pid, b.pid]));
  assert.notEqual(both[0].controlUrl, both[1].controlUrl);
  assert.notEqual(both[0].token, both[1].token);
  await stop(b);
  const remaining = await waitForCount(1);
  assert.equal(remaining[0].pid, a.pid);
  assert.equal(a.exitCode, null);
});
