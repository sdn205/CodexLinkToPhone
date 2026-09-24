import { proxyExe, fakeEnv } from "../fixtures/native-fixture.mjs";
import fs from "node:fs/promises";
import { readProxyInstances } from "../fixtures/instance-registry.mjs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const adbSerial = "3B164801AQ300000";
if (process.env.ADB_SERIAL && process.env.ADB_SERIAL !== adbSerial) throw new Error("Only the configured physical phone is allowed");
const workDir = path.join(root, "tests/build", `adb-${Date.now()}`);
const fakeSource = path.join(__dirname, "../fixtures/fake-scenario-app-server.mjs");
const bridgeExecutable = process.env.BRIDGE_TEST_EXE || path.join(root, "server", "dist", "codex-phone-bridge.exe");
const proxyStateFile = path.join(workDir, "proxy-state.json");
const proxyLogFile = path.join(workDir, "proxy.log");
const fakeLogFile = path.join(workDir, "fake.log");
const phoneStateDir = path.join(workDir, "phone-state");
const token = "codex-phone";
const adbTempFiles = "/sdcard/codex*.png /sdcard/current.png /sdcard/back-local.png /sdcard/window.xml /sdcard/sidebar-*.png";
const devtoolsPort = Number(process.env.ADB_DEVTOOLS_PORT || 9222);
const browserPackage = process.env.ADB_BROWSER_PACKAGE || "com.microsoft.emmx";

const results = [];
const parentLines = [];
let proxy = null;
let bridge = null;
let controlPhone = null;
let controlState = null;

  // Retain isolated evidence under tests/build; no recursive deletion.
await fs.mkdir(workDir, { recursive: true });

try {
  await adb(["devices"]);
  await cleanAdbTempFiles();
  await adb(["forward", "--remove", `tcp:${devtoolsPort}`]).catch(() => {});
  await startProxy();
  const proxyState = await waitForProxyState((state) =>
    state.mode === "stdio-tee" && state.upstreamConnected && state.initialized && state.controlUrl
  );
  await startBridge();
  await waitForBridgeConnected();
  controlPhone = await openControlPhone();
  await waitForControlState((state) => state.currentThreadId === "thread-a" && state.busy && state.approvals.length === 1);

  await runStep("ADB 打开隔离手机页面", async () => {
    await adb(["reverse", `tcp:${bridge.port}`, `tcp:${bridge.port}`]);
    await adb(["forward", `tcp:${devtoolsPort}`, "localabstract:chrome_devtools_remote"]);
    const url = `http://127.0.0.1:${bridge.port}/?token=${encodeURIComponent(token)}&v=${Date.now()}`;
    await adbShell(["am", "start", "-a", "android.intent.action.VIEW", "-d", url, "-p", browserPackage])
      .catch(() => adbShell(["am", "start", "-a", "android.intent.action.VIEW", "-d", url]));
    await waitForUiText((text) =>
      hasAll(text, ["Codex Phone", "允许一次"]) &&
      hasOne(text, ["等待你的确认", "等待确认"]) &&
      hasOne(text, ["1 个文件已更改", "个文件已更改"]) &&
      hasOne(text, ["停止生成", "停止"]) &&
      !/工作中|正在回复|繁忙|已省略|已截断/.test(text)
    );
  });

  await runStep("运行态 UI 可操作且没有虚假 Review 入口", async () => {
    const text = await readPageText();
    assert(!/审核更改|Review/i.test(text), "手机 UI 不应出现审核更改/Review");
    assert(!/工作中|正在回复|繁忙|已省略|已截断/.test(text), "运行中 UI 不应显示繁忙、截断或省略提示");
    const facts = await readPageFacts();
    assert(facts.threadItems.length > 0, "真机 DOM 应渲染会话列表项");
    assert(facts.threadItems.every((item) => !item.hasPreview), "会话列表项不应包含首条消息 preview");
    assert(facts.threadItems.every((item) => item.hasName && item.hasMeta && item.childClassNames.every((className) => ["threadName", "threadStatusIndicator", "threadMeta"].includes(className))), "会话列表项应只包含标题、状态标记和时间");
  });

  await runStep("ADB 上滑出现回到底部按钮", async () => {
    await parentRequest(602, "test/long-text");
    await waitForControlState((state) =>
      state.messages.some((message) => String(message.text || "").includes("LONG_TEXT_SYNC_END"))
    );
    const before = await exerciseScrollBottomButton();
    assert(before.canScroll, "真机消息列表应可滚动");
    assert(before.visibleAfterScrollUp, "上滑离开底部后应显示回到底部按钮");
    assert(before.hiddenAfterClick, "点击回到底部后按钮应隐藏");
    assert(before.distanceAfterClick < 80, "点击回到底部后应贴近底部");
  });

  await runStep("ADB 完成态 diff 与已处理回落时间线", async () => {
    const approval = controlState.approvals[0];
    sendControlPhone({ type: "approval:resolve", approvalId: approval.id, decision: "accept" });
    await waitForControlState((state) => state.currentThreadId === "thread-a" && state.approvals.length === 0);
    await parentRequest(601, "test/complete");
    await waitForControlState((state) =>
      state.currentThreadId === "thread-a" &&
      state.busy === false &&
      state.turnTimings.some((timing) => timing.threadId === "thread-a" && timing.turnId === "turn-a") &&
      state.messages.some((message) => message.id === "file-a" && message.kind === "file") &&
      state.messages.some(isCompletedTurnDiffCard) &&
      state.messages.some((message) => message.id === "assistant-final-a")
    );
    await waitForUiText((text) =>
      /已处理\s+\d+[秒s]/.test(text) && text.includes("复杂场景已完成") &&
      hasOne(text, ["1 个文件已更改", "个文件已更改"]) &&
      !/审核更改|Review|繁忙|已省略|已截断/i.test(text)
    );
  });

  await runStep("ADB 代码块语言和复制按钮对齐扩展行为", async () => {
    const facts = await exerciseCodeCopyButton();
    assert(facts.language === "text", "代码块应显示 text 语言标签");
    assert(facts.hasCopyIcon && facts.initialLabel === "Copy", "代码块复制按钮初始应是 Copy 图标按钮");
    assert(facts.copiedLabel === "Copied" && facts.showedCheckIcon, "点击复制后应切换为 Copied 和对勾图标");
    assert(facts.restoredLabel === "Copy" && facts.restoredCopyIcon, "2 秒后复制按钮应恢复 Copy 图标");
  });

  console.log(JSON.stringify({ ok: true, adbSerial, proxyControlUrl: proxyState.controlUrl, port: bridge.port, results }, null, 2));
} finally {
  try {
    controlPhone?.close();
  } catch {}
  try {
    if (bridge?.port) await adb(["reverse", "--remove", `tcp:${bridge.port}`]);
  } catch {}
  try {
    await adb(["forward", "--remove", `tcp:${devtoolsPort}`]);
  } catch {}
  await cleanAdbTempFiles().catch(() => {});
  if (bridge && !bridge.killed) bridge.kill("SIGKILL");
  if (proxy && !proxy.killed) proxy.kill("SIGKILL");
}

async function startProxy() {
  proxy = spawn(proxyExe, ["app-server"], {
    cwd: workDir,
    env: {
      ...process.env,
      ...fakeEnv(fakeSource),
      CODEX_PROXY_REPO_ROOT: root,
      CODEX_PROXY_REGISTRY: proxyStateFile,
      CODEX_PHONE_AUTO_START: "0",
      CODEX_PROXY_LOG: proxyLogFile,
      FAKE_SCENARIO_LOG: fakeLogFile
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  readline.createInterface({ input: proxy.stdout, crlfDelay: Infinity }).on("line", (line) => {
    try {
      parentLines.push(JSON.parse(line));
    } catch {}
  });
  proxy.stderr.on("data", (chunk) => process.stderr.write(chunk));
  proxy.stdin.write(`${JSON.stringify({
    id: "1",
    method: "initialize",
    params: {
      clientInfo: {
        name: "Trae CN",
        title: "Codex Extension",
        version: "26.901.22334"
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
        requestAttestation: false
      }
    }
  })}\n`);
}

async function startBridge() {
  const port = await findFreePort();
  bridge = spawn(bridgeExecutable, [], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_PROXY_REGISTRY: proxyStateFile,
      CODEX_PHONE_STATE_DIR: phoneStateDir,
      CODEX_PHONE_TOKEN: token,
      CODEX_PHONE_RELAY_DISABLED: "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  bridge.port = port;
  bridge.stdout.on("data", () => {});
  bridge.stderr.on("data", (chunk) => process.stderr.write(chunk));
}

async function waitForBridgeConnected() {
  const statusUrl = `http://127.0.0.1:${bridge.port}/api/health?token=${encodeURIComponent(token)}`;
  return waitFor(async () => {
    const status = await fetchJson(statusUrl).catch(() => null);
    return status?.codex?.status === "connected" ? status : null;
  }, 15_000, "bridge connected");
}

async function openControlPhone() {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws?token=${encodeURIComponent(token)}&streamProtocol=1`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("phone websocket open timeout")), 5000);
    const onError = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    ws.on("open", () => {
      clearTimeout(timer);
      ws.off("error", onError);
      resolve();
    });
    ws.on("error", onError);
  });
  ws.on("error", () => {});
  ws.on("message", (data) => {
    const payload = JSON.parse(data.toString("utf8"));
    if (payload.type === "stream:append") applyControlStream(payload);
    if (payload.type === "stream:complete") completeControlStream(payload);
    if (payload.type === "state") controlState = payload.state;
    if (payload.type === "state:patch") applyStatePatch(payload.patch);
    if (payload.type === "error") throw new Error(payload.message);
  });
  return ws;
}

function sendControlPhone(payload) {
  controlPhone.send(JSON.stringify(payload));
}

function applyStatePatch(patch = {}) {
  if (!controlState) return;
  const previousThreadId = controlState.currentThreadId || "";
  for (const [key, value] of Object.entries(patch)) {
    if (key !== "messages") controlState[key] = value;
  }
  const nextThreadId = controlState.currentThreadId || "";
  const threadChanged = previousThreadId !== nextThreadId;
  if (patch.messages) {
    const existing = threadChanged ? new Map() : new Map((controlState.messages || []).map((message) => [message.id, message]));
    for (const message of patch.messages.items || []) existing.set(message.id, message);
    controlState.messages = (patch.messages.ids || (controlState.messages || []).map((message) => message.id))
      .map((id) => existing.get(id))
      .filter(Boolean);
  } else if (threadChanged) {
    controlState.messages = [];
  }
}

function applyControlStream(payload) {
  if (!controlState || String(controlState.currentThreadId || "") !== String(payload.threadId || "")) return;
  const messages = Array.isArray(controlState.messages) ? controlState.messages.slice() : [];
  let index = messages.findIndex((message) => message.id === payload.messageId);
  if (index < 0 && Number(payload.offset) === 0 && payload.message) {
    const afterIndex = payload.afterId ? messages.findIndex((message) => message.id === payload.afterId) : -1;
    const beforeIndex = payload.beforeId ? messages.findIndex((message) => message.id === payload.beforeId) : -1;
    index = beforeIndex >= 0 ? beforeIndex : afterIndex >= 0 ? afterIndex + 1 : messages.length;
    messages.splice(index, 0, { ...payload.message, text: "", streaming: true });
  }
  const previous = messages[index];
  const text = String(previous?.text || "");
  if (!previous || text.length !== Number(payload.offset)) return;
  const nextText = `${text}${String(payload.delta || "")}`;
  messages[index] = { ...previous, text: nextText, streaming: true };
  controlState.messages = messages;
  sendControlPhone({ type: "stream:ack", messageId: payload.messageId, frameId: payload.frameId, offset: nextText.length, ok: true });
}

function completeControlStream(payload) {
  if (!controlState || String(controlState.currentThreadId || "") !== String(payload.threadId || "")) return;
  controlState.messages = (controlState.messages || []).map((message) => message.id === payload.messageId
    ? { ...message, ...(payload.message || {}), text: message.text, streaming: false, meta: { ...(message.meta || {}), ...(payload.message?.meta || {}) } }
    : message);
}

async function parentRequest(id, method, params = {}) {
  proxy.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return waitFor(() => parentLines.find((line) => line.id === id), 5000, method);
}

async function waitForProxyState(predicate, timeoutMs = 10_000) {
  return waitFor(async () => {
    try {
      const state = readProxyInstances(proxyStateFile)[0];
      return predicate(state) ? state : null;
    } catch {
      return null;
    }
  }, timeoutMs, "proxy state");
}

async function waitForControlState(predicate, timeoutMs = 8000) {
  return waitFor(() => controlState && predicate(controlState) ? controlState : null, timeoutMs, "control phone state");
}

async function waitForUiText(predicate, timeoutMs = 12_000) {
  return waitFor(async () => {
    const text = await readAnyPageText();
    return predicate(text) ? text : null;
  }, timeoutMs, "ADB CDP UI");
}

async function readAnyPageText() {
  const parts = [];
  try {
    parts.push(await readPageText());
  } catch {}
  try {
    const uiText = await readUiAutomatorText();
    if (uiText) parts.push(uiText);
  } catch {}
  if (parts.length) return parts.join("\n\n");
  return await readPageText();
}

async function readPageText() {
  const pages = await findDevtoolsPages();
  const expression = `(() => {
    const visibleText = document.body ? document.body.innerText : "";
    const labels = Array.from(document.querySelectorAll("[aria-label]"))
      .map((node) => node.getAttribute("aria-label") || "")
      .filter(Boolean)
      .join("\\n");
    return [document.title, visibleText, labels].filter(Boolean).join("\\n");
  })()`;
  const textParts = [];
  for (const page of pages) {
    try {
      const result = await cdpEvaluate(page.webSocketDebuggerUrl, expression);
      textParts.push(`[${page.url}]\n${String(result?.result?.value || "")}`);
    } catch {}
  }
  if (!textParts.length) throw new Error(`真机页面 DOM 暂不可读：${pages.map((page) => page.url).join(", ")}`);
  return textParts.join("\n\n");
}

async function readUiAutomatorText() {
  await adbShell(["uiautomator", "dump", "/sdcard/window.xml"]);
  const result = await adbShell(["cat", "/sdcard/window.xml"]);
  return result.stdout || "";
}

async function readPageFacts() {
  const value = await readFirstPageValue(`(() => ({
    threadItems: Array.from(document.querySelectorAll(".threadItem")).map((item) => ({
      hasName: Boolean(item.querySelector(":scope > .threadName")),
      hasMeta: Boolean(item.querySelector(":scope > .threadMeta")),
      hasPreview: Boolean(item.querySelector(".threadPreview")),
      childClassNames: Array.from(item.children).map((child) => child.className || "")
    }))
  }))()`);
  return value || { threadItems: [] };
}

async function exerciseScrollBottomButton() {
  const value = await readFirstPageValue(`(async () => {
    const messages = document.querySelector("#messages");
    const button = document.querySelector("#scrollBottomBtn");
    if (!messages || !button) return { canScroll: false, visibleAfterScrollUp: false, hiddenAfterClick: false, distanceAfterClick: Infinity };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    messages.scrollTop = messages.scrollHeight;
    await wait(120);
    const canScroll = messages.scrollHeight > messages.clientHeight + 12;
    messages.scrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight - 360);
    messages.dispatchEvent(new Event("scroll", { bubbles: true }));
    await wait(180);
    const visibleAfterScrollUp = button.classList.contains("show") && button.getAttribute("aria-hidden") === "false";
    button.click();
    await wait(450);
    const distanceAfterClick = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
    const hiddenAfterClick = !button.classList.contains("show") && button.getAttribute("aria-hidden") === "true";
    return { canScroll, visibleAfterScrollUp, hiddenAfterClick, distanceAfterClick };
  })()`);
  return value || { canScroll: false, visibleAfterScrollUp: false, hiddenAfterClick: false, distanceAfterClick: Infinity };
}

async function exerciseCodeCopyButton() {
  const value = await readFirstPageValue(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const block = document.querySelector(".codeBlockWrap");
    const button = block?.querySelector("[data-copy-code]");
    if (!block || !button) return { language: "", hasCopyIcon: false, initialLabel: "", copiedLabel: "", showedCheckIcon: false, restoredLabel: "", restoredCopyIcon: false };
    const language = block.querySelector(".codeBlockHeader > span")?.textContent?.trim() || "";
    const hasCopyIcon = getComputedStyle(button.querySelector(".copyIcon")).display !== "none";
    const initialLabel = button.getAttribute("aria-label") || "";
    button.click();
    await wait(160);
    const copiedLabel = button.getAttribute("aria-label") || "";
    const showedCheckIcon = getComputedStyle(button.querySelector(".checkIcon")).display !== "none";
    await wait(2100);
    const restoredLabel = button.getAttribute("aria-label") || "";
    const restoredCopyIcon = getComputedStyle(button.querySelector(".copyIcon")).display !== "none";
    return { language, hasCopyIcon, initialLabel, copiedLabel, showedCheckIcon, restoredLabel, restoredCopyIcon };
  })()`);
  return value || { language: "", hasCopyIcon: false, initialLabel: "", copiedLabel: "", showedCheckIcon: false, restoredLabel: "", restoredCopyIcon: false };
}

async function readFirstPageValue(expression) {
  const pages = await findDevtoolsPages();
  for (const page of pages) {
    try {
      const result = await cdpEvaluate(page.webSocketDebuggerUrl, expression);
      if (result?.result) return result.result.value;
    } catch {}
  }
  throw new Error(`真机页面 DOM 暂不可读：${pages.map((page) => page.url).join(", ")}`);
}

async function findDevtoolsPages() {
  const pages = await fetchJson(`http://127.0.0.1:${devtoolsPort}/json/list`);
  const pageList = Array.isArray(pages) ? pages : pages?.value || [];
  const strictPages = pageList
    .filter((entry) =>
      entry.type === "page" &&
      entry.webSocketDebuggerUrl &&
      String(entry.url || "").startsWith(`http://127.0.0.1:${bridge.port}/`)
    );
  if (strictPages.length) return strictPages;

  const codexPages = pageList
    .filter((entry) =>
      entry.type === "page" &&
      entry.webSocketDebuggerUrl &&
      String(entry.title || "").includes("Codex Link To Phone") &&
      /^http:\/\/127\.0\.0\.1:\d+\//.test(String(entry.url || ""))
    );
  if (codexPages.length) return codexPages;
  throw new Error(`未找到真机浏览器中的测试页面：${pageList.map((entry) => entry.url).join(", ")}`);
}

function cdpEvaluate(url, expression) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    let nextId = 1;
    let enabled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      reject(error);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => {
      fail(new Error("Runtime.evaluate CDP timeout"));
    }, 5000);
    const send = (method, params = {}) => {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return id;
    };
    let evaluateId = 0;
    ws.on("open", () => {
      send("Runtime.enable");
    });
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.method === "Runtime.executionContextCreated") return;
      if (!enabled && message.id === 1) {
        enabled = true;
        evaluateId = send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true
        });
        return;
      }
      if (message.id !== evaluateId) return;
      if (message.error) fail(new Error(message.error.message || "Runtime.evaluate CDP error"));
      else done(message.result);
    });
    ws.on("error", fail);
    ws.on("unexpected-response", (_request, response) => {
      fail(new Error(`CDP unexpected response ${response.statusCode || ""}`.trim()));
    });
    ws.on("close", () => {
      if (!settled) fail(new Error("CDP socket closed"));
    });
  });
}

function hasAll(text, expectedItems) {
  return expectedItems.every((item) => text.includes(item));
}

function hasOne(text, expectedItems) {
  return expectedItems.some((item) => text.includes(item));
}

function isTimelineRowsTurnDiff(message) {
  if (message?.kind !== "turn_diff") return false;
  if (message?.meta?.display === "timeline_rows" || message?.display === "timeline_rows") return true;
  return String(message?.id || "").endsWith(":turn-diff-rows");
}

function isCompletedTurnDiffCard(message) {
  if (message?.kind !== "turn_diff") return false;
  if (message?.meta?.display === "completed_card" || message?.display === "completed_card") return true;
  return !isTimelineRowsTurnDiff(message) && !isAboveComposerTurnDiff(message);
}

function isAboveComposerTurnDiff(message) {
  return Boolean(message?.kind === "turn_diff" && (message?.meta?.display === "above_composer" || message?.display === "above_composer"));
}

async function runStep(name, fn) {
  const startedAt = Date.now();
  await fn();
  results.push({ name, ok: true, durationMs: Date.now() - startedAt });
}

async function cleanAdbTempFiles() {
  await adbShell(["rm", "-f", ...adbTempFiles.split(" ")]);
}

async function adbShell(args) {
  return adb(["shell", ...args]);
}

function adb(args) {
  return runProcess("adb", ["-s", adbSerial, ...args], { timeoutMs: 20_000 });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} timeout`));
    }, options.timeoutMs || 10_000);
    child.stdout.on("data", (chunk) => stdout += chunk.toString("utf8"));
    child.stderr.on("data", (chunk) => stderr += chunk.toString("utf8"));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function waitFor(factory, timeoutMs, label) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await factory();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(120);
  }
  throw lastError || new Error(`${label} timeout`);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.request(url, { method: "GET" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => body += chunk);
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          fail(new Error(`HTTP ${response.statusCode}: ${body}`));
          return;
        }
        try {
          done(JSON.parse(body));
        } catch (error) {
          fail(error);
        }
      });
      response.on("aborted", () => fail(new Error("HTTP response aborted")));
      response.on("error", fail);
    });
    request.on("error", fail);
    request.setTimeout(3000, () => request.destroy(new Error("HTTP timeout")));
    request.end();
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
