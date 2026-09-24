import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createProxyInstanceRegistration } from "../fixtures/instance-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const bridgeExecutable = process.env.BRIDGE_TEST_EXE || path.join(root, "server", "dist", "codex-phone-bridge.exe");
const testRoot = process.env.BRIDGE_TEST_DIR || path.join(root, "tests/build", `auto-lifecycle-test-${process.pid}`);
const stateDir = path.join(testRoot, "state");
const proxyStateFile = path.join(stateDir, "instances");
const configPath = path.join(testRoot, "phone-mode.ini");
const token = "isolated-lifecycle-token";
let bridge = null;
let control = null;
let connections = 0;
const instanceId = `lifecycle-${process.pid}`;
const registration = createProxyInstanceRegistration(proxyStateFile, instanceId);

try {
  await fsp.mkdir(stateDir, { recursive: true });
  control = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => control.once("listening", resolve));
  control.on("connection", (ws) => {
    connections++;
    ws.send(JSON.stringify({ type: "hello", state: proxyState() }));
    ws.on("message", (data) => {
      const message = JSON.parse(data);
      if (message.type === "get-state") ws.send(JSON.stringify({ type: "history", events: [], complete: true }));
      else if (message.id !== undefined) ws.send(JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } }));
    });
  });
  const port = await findFreePort();
  await fsp.writeFile(configPath, [
    "[phone]",
    "mode=relay",
    "local_host=127.0.0.1",
    `local_port=${port}`,
    `token=${token}`,
    "",
    "[relay]",
    "server=127.0.0.1",
    "agent_port=1",
    "public_port=1",
    "secret=isolated-lifecycle-secret-000000000000",
    "reconnect_delay_ms=2000",
    ""
  ].join("\n"), "utf8");
  await writeHealthyProxyState();

  bridge = spawn(bridgeExecutable, [], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_PHONE_MODE_CONFIG: configPath,
      CODEX_PHONE_STATE_DIR: stateDir,
      CODEX_PROXY_REGISTRY: proxyStateFile,
      CODEX_PHONE_RELAY_DISABLED: "1",
      CODEX_PHONE_AUTO_LIFECYCLE: "1",
      CODEX_PHONE_PROXY_GRACE_MS: "5000"
    }
  });

  let output = "";
  bridge.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  bridge.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  await waitForHealth(port, 10000, output);

  registration.remove();
  await delay(2500);
  await writeHealthyProxyState();
  await delay(3500);
  assert.equal(bridge.exitCode, null, "代理在宽限期内恢复后，手机桥不应退出");

  registration.remove();
  await delay(6000);
  assert.equal(bridge.exitCode, null, "登记文件丢失不能关闭健康的代理连接或手机桥");
  const beforeReconnect = connections;
  for (const ws of control.clients) ws.terminate();
  const reconnectDeadline = Date.now() + 4000;
  while (connections === beforeReconnect && Date.now() < reconnectDeadline) await delay(50);
  assert(connections > beforeReconnect, "登记暂不可用时仍可用已确认的代理地址恢复连接");
  await delay(1000);
  assert.equal(bridge.exitCode, null);
  for (const ws of control.clients) ws.terminate();
  await new Promise(resolve => control.close(resolve));
  control = null;
  const missingSince = Date.now();
  const exit = await waitForExit(bridge, 10000);
  const elapsed = Date.now() - missingSince;
  assert.equal(exit.code, 0, `手机桥应正常退出，实际 code=${exit.code} signal=${exit.signal}\n${output}`);
  assert.ok(elapsed >= 4500, `手机桥退出过早，仅等待 ${elapsed}ms`);
  assert.ok(elapsed < 9000, `手机桥退出过晚，等待 ${elapsed}ms`);
  console.log(`自动生命周期隔离测试通过：短暂离线未误关，持续离线 ${elapsed}ms 后退出。`);
} finally {
  if (bridge && bridge.exitCode === null) bridge.kill();
  if (control) {
    for (const ws of control.clients) ws.terminate();
    await new Promise((resolve) => control.close(resolve));
  }
  // Retain isolated evidence under tests/build; no recursive deletion.
}

async function writeHealthyProxyState() {
  registration.write(proxyState());
}
function proxyState() {
  const now = new Date().toISOString();
  return {
    mode: "stdio-tee",
    instanceId,
    loadedThreadIds: [],
    pid: process.pid,
    upstreamPid: process.pid,
    initialized: true,
    upstreamConnected: true,
    startedAt: now,
    updatedAt: now,
    controlUrl: `ws://127.0.0.1:${control.address().port}`,
    token: "isolated-proxy-token"
  };
}

async function waitForHealth(port, timeoutMs, getOutput) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (bridge?.exitCode !== null) throw new Error(`手机桥提前退出：${getOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health?token=${encodeURIComponent(token)}`);
      if (response.ok) {
        const state = await response.json();
        assert.equal(state.app.autoLifecycleEnabled, true);
        assert.equal(state.app.proxyLifecycleGraceMs, 5000);
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`等待隔离手机桥超时：${lastError?.message || "unknown"}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待手机桥自动退出超时")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
