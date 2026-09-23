import { proxyExe, fakeEnv } from "../fixtures/native-fixture.mjs";
import fs from "node:fs/promises";
import { readProxyInstances } from "../fixtures/instance-registry.mjs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { WebSocket as NodeWebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const workDir = process.env.BRIDGE_TEST_DIR || path.join(root, "tests/build", `latency-audit-${process.pid}`);
const fakeSource = path.join(__dirname, "../fixtures/fake-scenario-app-server.mjs");
const bridgeExecutable = process.env.BRIDGE_TEST_EXE || path.join(root, "server", "dist", "codex-phone-bridge.exe");
const proxyStateFile = path.join(workDir, "proxy-state.json");
const fakeLogFile = path.join(workDir, "fake.log");
const phoneStateDir = path.join(workDir, "phone-state");
const token = "codex-phone-latency-audit";
const parentLines = [];
let proxy = null;
let bridge = null;
let browser = null;
let page = null;
let slowPhone = null;
let requestId = 9000;
const pageErrors = [];
const slowPhonePayloads = [];

  // Retain isolated evidence under tests/build; no recursive deletion.
await fs.mkdir(workDir, { recursive: true });

try {
  proxy = spawn(proxyExe, ["app-server"], {
    cwd: workDir,
    env: { ...process.env, ...fakeEnv(fakeSource), CODEX_PROXY_REPO_ROOT: root, CODEX_PROXY_STATE: proxyStateFile, CODEX_PHONE_AUTO_START: "0", CODEX_PROXY_LOG: path.join(workDir, "proxy.log"), FAKE_SCENARIO_LOG: fakeLogFile },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  readline.createInterface({ input: proxy.stdout, crlfDelay: Infinity }).on("line", (line) => {
    try { parentLines.push(JSON.parse(line)); } catch {}
  });
  proxy.stdin.write(`${JSON.stringify({ id: "1", method: "initialize", params: { clientInfo: { name: "Trae CN", title: "Codex Extension", version: "26.901.22334" }, capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true, requestAttestation: false } } })}\n`);
  await waitFor(async () => {
    const state = readProxyInstances(proxyStateFile)[0] || {};
    return state.mode === "stdio-tee" && state.upstreamConnected && state.initialized && state.controlUrl ? state : null;
  }, 12000, "proxy ready");

  const port = await findFreePort();
  bridge = spawn(bridgeExecutable, [], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), CODEX_PROXY_STATE: proxyStateFile, CODEX_PHONE_STATE_DIR: phoneStateDir, CODEX_PHONE_TOKEN: token, CODEX_PHONE_RELAY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  bridge.port = port;
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health?token=${token}`).catch(() => null);
    return response?.ok ? true : null;
  }, 15000, "bridge health");
  await assertLegacyProtocolRejected(port);

  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: "zh-CN" });
  await context.addInitScript(() => {
    window.__wsReceived = [];
    const origAddEventListener = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (type, listener, options) {
      if (type === "message") {
        const wrapped = (event) => {
          window.__wsReceived.push(String(event.data || ""));
          return listener.call(this, event);
        };
        return origAddEventListener.call(this, type, wrapped, options);
      }
      return origAddEventListener.call(this, type, listener, options);
    };
  });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.log("CONSOLE:", message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/?token=${token}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("codexDisconnected") && document.querySelectorAll(".threadItem").length > 0, null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#messages .message[data-message-id="assistant-live-a"] .bubble')?.textContent?.length > 0, null, { timeout: 5000 });

  slowPhone = new NodeWebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}&streamProtocol=1`);
  slowPhone.on("message", (data) => {
    try { slowPhonePayloads.push(JSON.parse(data.toString("utf8"))); } catch {}
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("slow phone websocket open timeout")), 5000);
    slowPhone.once("open", () => { clearTimeout(timer); resolve(); });
    slowPhone.once("error", reject);
  });
  await waitFor(() => slowPhonePayloads.some((payload) => payload.type === "state"), 5000, "slow phone initial state");

  await page.evaluate(() => {
    window.__lenLog = [];
    const readLen = () => document.querySelector('#messages .message[data-message-id="assistant-live-a"] .bubble')?.textContent?.length || 0;
    const target = document.querySelector("#messages");
    const obs = new MutationObserver(() => {
      window.__lenLog.push({ t: Date.now(), len: readLen() });
    });
    obs.observe(target, { childList: true, subtree: true, characterData: true });
  });
  const initialLen = await page.evaluate(() => document.querySelector('#messages .message[data-message-id="assistant-live-a"] .bubble')?.textContent?.length || 0);
  await page.evaluate(() => { window.__wsReceived = []; });

  const tickCount = 30;
  for (let index = 0; index < tickCount; index += 1) {
    await parentRequest("test/delta-tick", { seq: index + 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const slowFirstFrames = slowPhonePayloads.filter((payload) => payload.type === "stream:append" && payload.messageId === "assistant-live-a");
  assert.equal(slowFirstFrames.length, 1, "慢客户端 ACK 前最多只能收到一个流式帧");
  const slowFirstFrame = slowFirstFrames[0];
  slowPhone.send(JSON.stringify({
    type: "stream:ack",
    messageId: slowFirstFrame.messageId,
    frameId: slowFirstFrame.frameId,
    offset: slowFirstFrame.offset + String(slowFirstFrame.delta || "").length,
    ok: true
  }));
  await waitFor(() => slowPhonePayloads.filter((payload) => payload.type === "stream:append" && payload.messageId === "assistant-live-a").length >= 2, 5000, "slow phone coalesced frame");
  const slowSecondFrame = slowPhonePayloads.filter((payload) => payload.type === "stream:append" && payload.messageId === "assistant-live-a")[1];
  assert.equal(slowSecondFrame.offset, slowFirstFrame.offset + String(slowFirstFrame.delta || "").length, "慢客户端合并帧 offset 必须连续");
  assert(String(slowSecondFrame.delta || "").includes("实时吐字第 30 段"), "ACK 后下一帧必须合并所有积压新字符");
  slowPhone.send(JSON.stringify({
    type: "stream:ack",
    messageId: slowSecondFrame.messageId,
    frameId: slowSecondFrame.frameId,
    offset: slowSecondFrame.offset + String(slowSecondFrame.delta || "").length,
    ok: true
  }));
  const wsStats = await page.evaluate(() => {
    const all = window.__wsReceived || [];
    const payloads = all.map((data) => {
      try { return JSON.parse(data); } catch { return null; }
    }).filter(Boolean);
    const patches = payloads.filter((payload) => payload.type === "state:patch");
    const liveMessageItems = patches.flatMap((payload) => payload.patch?.messages?.items || [])
      .filter((message) => message.id === "assistant-live-a");
    const streamFrames = payloads.filter((payload) => payload.type === "stream:append" && payload.messageId === "assistant-live-a");
    return {
      total: all.length,
      patches: patches.length,
      liveMessageItems: liveMessageItems.length,
      streamFrames,
      streamBytes: streamFrames.reduce((total, payload) => total + new TextEncoder().encode(JSON.stringify(payload)).length, 0)
    };
  });
  const serverState = await fetch(`http://127.0.0.1:${port}/api/status?full=1&token=${token}`).then((response) => response.json()).catch(() => null);
  const liveMessage = serverState?.messages?.find((message) => message.id === "assistant-live-a");

  const fakeLog = await readFakeLog();
  const notifyTimes = fakeLog
    .filter((entry) => entry.type === "notify" && entry.method === "item/agentMessage/delta")
    .map((entry) => ({ seq: entry.seq, at: entry.at }))
    .sort((a, b) => a.seq - b.seq);
  const lenLog = await page.evaluate(() => window.__lenLog || []);

  const firstNotifyAt = notifyTimes[0]?.at || 0;
  const lastNotifyAt = notifyTimes.at(-1)?.at || 0;
  const expectedFinalLen = String(liveMessage?.text || "").length;
  const firstDom = lenLog.find((entry) => entry.len > initialLen);
  const lastDom = [...lenLog].reverse().find((entry) => entry.len >= expectedFinalLen - 8);
  const finalLen = lenLog.at(-1)?.len || 0;
  const frameDeltaLength = wsStats.streamFrames.reduce((total, frame) => total + String(frame.delta || "").length, 0);
  let expectedOffset = initialLen;
  for (const frame of wsStats.streamFrames) {
    assert.equal(frame.offset, expectedOffset, "流式帧 offset 必须连续");
    assert.equal(frame.messages, undefined, "流式帧不能携带会话消息数组");
    assert.equal(frame.ids, undefined, "流式帧不能携带消息 ID 窗口");
    expectedOffset += String(frame.delta || "").length;
  }
  assert.equal(pageErrors.length, 0, `手机页面不能出现脚本错误：${pageErrors.join("; ")}`);
  assert(wsStats.streamFrames.length > 0, "助手正文必须走独立 stream:append 通道");
  assert.equal(wsStats.patches, 0, "纯文字流式阶段不能夹带状态补丁");
  assert.equal(wsStats.liveMessageItems, 0, "流式正文不能再进入 state:patch.items");
  assert.equal(frameDeltaLength, expectedFinalLen - initialLen, "网络只应传输新增字符一次");
  assert.equal(finalLen, expectedFinalLen, "手机 DOM 必须与服务端权威正文完全一致");
  assert(firstDom && firstNotifyAt && firstDom.t - firstNotifyAt < 1000, "首段文字到手机 DOM 的延迟必须低于 1 秒");
  assert(lastDom && lastNotifyAt && lastDom.t - lastNotifyAt < 1000, "末段文字到手机 DOM 的延迟必须低于 1 秒");

  await page.evaluate(() => { window.__wsReceived = []; });
  await parentRequest("test/complete", {});
  await page.waitForFunction(() => {
    const node = document.querySelector('#messages .message[data-message-id="assistant-final-a"]');
    return node && !node.classList.contains("streaming") && Boolean(node.querySelector("pre code"));
  }, null, { timeout: 5000 });
  const completionStats = await page.evaluate(() => {
    const payloads = (window.__wsReceived || []).map((data) => {
      try { return JSON.parse(data); } catch { return null; }
    }).filter(Boolean);
    const completions = payloads.filter((payload) => payload.type === "stream:complete");
    const finalNode = document.querySelector('#messages .message[data-message-id="assistant-final-a"]');
    return {
      completions,
      finalText: finalNode?.querySelector(".bubble")?.textContent || "",
      hasCodeBlock: Boolean(finalNode?.querySelector("pre code")),
      duplicateFinalStateItems: payloads.flatMap((payload) => (
        payload.type === "state"
          ? payload.state?.messages || []
          : payload.type === "state:patch"
            ? payload.patch?.messages?.items || []
            : []
      ))
        .filter((message) => message.id === "assistant-final-a" && String(message.text || "").length > 0)
        .length
    };
  });
  const finalCompletion = completionStats.completions.find((payload) => payload.messageId === "assistant-final-a");
  assert(finalCompletion, "最终助手消息必须通过 stream:complete 收尾");
  assert.equal(finalCompletion.message?.text, undefined, "完成帧不能重复携带最终正文");
  assert.equal(completionStats.duplicateFinalStateItems, 0, "最终正文不能在 state:patch 中重复传输");
  assert.equal(completionStats.hasCodeBlock, true, "完成态必须一次性渲染 Markdown 代码块");
  assert(completionStats.finalText.includes("手机代码块复制测试"), "完成态 Markdown 文本必须完整");

  console.log(JSON.stringify({
    initialLen,
    notifyCount: notifyTimes.length,
    lenLogCount: lenLog.length,
    expectedFinalLen,
    finalLen,
    firstCharDelayMs: firstDom && firstNotifyAt ? Math.round(firstDom.t - firstNotifyAt) : -1,
    lastCharDelayMs: lastDom && lastNotifyAt ? Math.round(lastDom.t - lastNotifyAt) : -1,
    batchCount: lenLog.length,
    streamFrames: wsStats.streamFrames.length,
    streamBytes: wsStats.streamBytes,
    liveStateMessageItems: wsStats.liveMessageItems,
    slowClientFramesBeforeAck: slowFirstFrames.length,
    slowClientCoalescedChars: String(slowSecondFrame.delta || "").length,
    completionFrames: completionStats.completions.length,
    finalMarkdownCodeBlock: completionStats.hasCodeBlock
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  slowPhone?.close();
  if (bridge) { bridge.kill("SIGKILL"); }
  if (proxy) { proxy.kill("SIGKILL"); }
  await new Promise((resolve) => setTimeout(resolve, 500));
  // Retain isolated evidence under tests/build; no recursive deletion.
}

async function parentRequest(method, params = {}) {
  const id = ++requestId;
  proxy.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return waitFor(() => parentLines.find((line) => Number(line.id) === id), 8000, method);
}

async function assertLegacyProtocolRejected(port) {
  await new Promise((resolve, reject) => {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => reject(new Error("旧手机协议未被及时拒绝")), 5000);
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      try {
        assert.equal(response.statusCode, 426, "旧手机页面必须明确收到协议升级状态");
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("旧手机协议不应建立 WebSocket"));
    });
    ws.once("error", () => {});
  });
}

async function readFakeLog() {
  try {
    const text = await fs.readFile(fakeLogFile, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitFor(factory, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await factory();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`等待超时：${label}`);
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
