import { proxyExe, fakeEnv } from "../fixtures/native-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readProxyInstances } from "../fixtures/instance-registry.mjs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const testDir = path.join(root, "tests/build", "proxy-test");
const stateFile = path.join(root, "tests/build", "proxy-tee-test.json");
const logFile = path.join(root, "tests/build", "proxy-tee-test.log");
const fakeSource = path.join(__dirname, "../fixtures/fake-app-server.mjs");
import { managerFixture as fakeAutoStartManager } from "../fixtures/native-manager.mjs";
const autoStartMarker = path.join(testDir, "auto-start-marker.json");

await fs.mkdir(testDir, { recursive: true });
await fs.rm(stateFile, { force: true });
await fs.rm(logFile, { force: true });

const normal = await runScenario(false, true);
const busy = await runScenario(true, false);
assert.equal(normal.argsPreserved, true, "前置 -c 参数必须原样传给上游");
assert.equal(normal.initializationGate, true, "初始化完成前控制请求必须被明确阻止");
assert.equal(normal.initialized, true, "代理必须跟踪 initialize 完成状态");
assert.equal(normal.codexCliVersion, "0.153.4", "代理必须记录当前 codex-cli 版本");
assert.equal(normal.autoStartRequested, true, "initialize 成功后必须通过统一管理器自动启动手机桥");
assert.equal(normal.parentReadCurrentProtocol, true, "Trae thread/read 必须收到当前版完整 Thread");
assert.equal(normal.controlReadCurrentProtocol, true, "手机 thread/read 必须收到当前版完整 Thread");
assert.equal(normal.subagentEventsIgnored, true, "子代理线程事件不能切换手机 current/busy");
assert.equal(busy.argsPreserved, true, "忙碌场景也必须原样传递前置参数");
assert.equal(busy.objectStatusActiveTracked, true, "新版 active 对象状态必须设置 busy");
assert.equal(busy.objectStatusIdleTracked, true, "新版 idle 对象状态必须清除 busy");
assert.equal(busy.steerCurrentProtocol, true, "忙碌时 turn/steer 必须返回当前版 turnId");
assert.equal(busy.steerUserStartedOnce, true, "steer 用户消息必须向 Trae 补发一次 item/started(userMessage)");
assert.equal(busy.steerUserCompletedOnce, true, "steer 用户消息必须向 Trae 补发一次 item/completed(userMessage)");
assert.equal(busy.steerDisplayStartedOnce, true, "steer 用户消息必须先向 Trae 补发一次可见 steeringUserMessage");
assert.equal(busy.steerDisplayBeforeCanonical, true, "可见 steeringUserMessage 必须先于 canonical userMessage");
assert.equal(busy.steerDisplayItemShape.status, "pending", "可见 steeringUserMessage 必须先是 pending 状态");
assert.equal(busy.steerDisplayItemShape.hasInputArray, true, "可见 steeringUserMessage 必须带 input 数组");
assert.equal(busy.steerDisplayItemShape.hasRestoreMessage, true, "可见 steeringUserMessage 必须带扩展所需 restoreMessage");
assert.equal(busy.steerUserItemShape.hasContentArray, true, "steer 补发 item 必须带 content 数组");
assert.equal(busy.steerUserItemShape.hasInputField, false, "steer 补发 item 不能带 steering 专属 input 字段");
assert.equal(busy.steerUserItemShape.hasAttachments, false, "steer 补发 item 不能带 steering 专属 attachments 字段");
assert.equal(busy.steerUserItemShape.hasStatus, false, "steer 补发 item 不能带 steering 专属 status 字段");
assert.equal(busy.steerUserItemShape.hasRestoreMessage, false, "steer 补发 item 不能带 steering 专属 restoreMessage 字段");
assert.equal(busy.turnStartCurrentProtocol, true, "忙碌时 turn/start 必须返回当前版完整 Turn");
assert.equal(busy.subagentEventsIgnored, true, "忙碌场景也必须忽略子代理线程事件");
console.log(JSON.stringify({ normal, busy }, null, 2));

async function runScenario(fakeBusy, expectAutoStart) {
  await fs.rm(stateFile, { force: true });
  await fs.rm(autoStartMarker, { force: true });
  const argsFile = path.join(testDir, fakeBusy ? "upstream-args-busy.json" : "upstream-args-normal.json");
  await fs.rm(argsFile, { force: true });
  const launchArgs = ["-c", "features.code_mode_host=true", "app-server"];
  const proxyEnv = {
    ...process.env,
    ...fakeEnv(fakeSource),
    CODEX_PROXY_REPO_ROOT: root,
    CODEX_PROXY_STATE: stateFile,
    CODEX_PHONE_MANAGER_EXE: fakeAutoStartManager,
    CODEX_PHONE_AUTO_START_MARKER: autoStartMarker,
    CODEX_PROXY_LOG: logFile,
    FAKE_SEND_BUSY: fakeBusy ? "1" : "0",
    FAKE_STATUS_OBJECT: "1",
    FAKE_ARGS_FILE: argsFile
  };
  if (expectAutoStart) delete proxyEnv.CODEX_PHONE_AUTO_START;
  else proxyEnv.CODEX_PHONE_AUTO_START = "0";

  const proxy = spawn(proxyExe, launchArgs, {
    cwd: testDir,
    env: proxyEnv,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true
  });
  const output = readline.createInterface({ input: proxy.stdout, crlfDelay: Infinity });
  const parentLines = [];
  output.on("line", (line) => {
    try { parentLines.push(JSON.parse(line)); } catch {}
  });

  try {
    const state = await waitForState((value) => value.mode === "stdio-tee" && value.upstreamConnected && value.controlUrl);
    await waitForFile(argsFile);
    const upstreamArgs = JSON.parse(await fs.readFile(argsFile, "utf8"));
    const argsPreserved = JSON.stringify(upstreamArgs) === JSON.stringify(launchArgs);

    const initializingControl = await openControl(state);
    const initializingRead = await controlRequest(initializingControl, 100, "thread/read", { threadId: "before-init" });
    initializingControl.close();
    const initializationGate = initializingRead.error?.code === -32002;

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
    const initializeResponse = await waitFor(() => parentLines.find((line) => line.id === "1"), 15000);
    const initializedState = await waitForState((value) => value.initialized === true);
    let autoStartRequested = null;
    if (expectAutoStart) {
      await waitForFile(autoStartMarker);
      const autoStart = JSON.parse(await fs.readFile(autoStartMarker, "utf8"));
      autoStartRequested = autoStart.action === "Restart" && autoStart.automatic === true &&
        Number(autoStart.proxyPid) === Number(initializedState.pid);
    }
    const control = await openControl(state);

    proxy.stdin.write(`${JSON.stringify({ id: 1, method: "thread/read", params: { threadId: "from-trae" } })}\n`);
    const parentResponse = await waitFor(() => parentLines.find((line) => line.id === 1));
    const controlRead = await controlRequest(control, 2, "thread/read", { threadId: "from-phone" });
    const parentSawControlResponse = parentLines.some((line) => line.id === -1 || line.id === 2);
    const blockedRead = fakeBusy ? controlRead.error?.code === -32003 : false;
    const lateControl = await openControl(state);
    const lateHistory = await controlHistory(lateControl);
    lateControl.close();
    const currentControlHistory = await controlHistory(control);
    const steer = fakeBusy ? await controlRequest(control, 3, "turn/steer", {
      threadId: "fake-thread",
      clientUserMessageId: "stability-steer",
      expectedTurnId: "fake-turn",
      input: [{ type: "text", text: "busy steer", text_elements: [] }]
    }) : null;
    if (fakeBusy) await delay(300);
    const steerUserLifecycle = fakeBusy ? {
      started: parentLines.filter((line) =>
        line.method === "item/started" &&
        line.params?.item?.type === "userMessage" &&
        String(line.params?.item?.clientId || "") === "stability-steer" &&
        line.params?.turnId === "fake-turn"
      ).length,
      completed: parentLines.filter((line) =>
        line.method === "item/completed" &&
        line.params?.item?.type === "userMessage" &&
        String(line.params?.item?.clientId || "") === "stability-steer" &&
        line.params?.turnId === "fake-turn"
      ).length
    } : null;
    const steerUserItem = fakeBusy ? parentLines.find((line) =>
      line.method === "item/started" &&
      line.params?.item?.type === "userMessage" &&
      String(line.params?.item?.clientId || "") === "stability-steer" &&
      line.params?.turnId === "fake-turn"
    )?.params?.item || null : null;
    const steerUserItemShape = fakeBusy ? {
      hasContentArray: Array.isArray(steerUserItem?.content),
      hasInputField: Object.prototype.hasOwnProperty.call(steerUserItem || {}, "input"),
      hasAttachments: Object.prototype.hasOwnProperty.call(steerUserItem || {}, "attachments"),
      hasStatus: Object.prototype.hasOwnProperty.call(steerUserItem || {}, "status"),
      hasRestoreMessage: Object.prototype.hasOwnProperty.call(steerUserItem || {}, "restoreMessage")
    } : null;
    const steerDisplayEvents = fakeBusy ? parentLines.filter((line) =>
      line.method === "item/started" &&
      line.params?.item?.type === "steeringUserMessage" &&
      String(line.params?.item?.clientUserMessageId || "") === "stability-steer" &&
      line.params?.turnId === "fake-turn"
    ) : [];
    const steerDisplayItem = steerDisplayEvents[0]?.params?.item || null;
    const steerDisplayItemShape = fakeBusy ? {
      status: steerDisplayItem?.status || null,
      hasInputArray: Array.isArray(steerDisplayItem?.input),
      hasRestoreMessage: Boolean(steerDisplayItem?.restoreMessage?.context && Array.isArray(steerDisplayItem.restoreMessage.context.commentAttachments))
    } : null;
    const steerDisplayIndex = fakeBusy ? parentLines.indexOf(steerDisplayEvents[0]) : -1;
    const steerCanonicalIndex = fakeBusy ? parentLines.findIndex((line) =>
      line.method === "item/started" &&
      line.params?.item?.type === "userMessage" &&
      String(line.params?.item?.clientId || "") === "stability-steer" &&
      line.params?.turnId === "fake-turn"
    ) : -1;
    const turnStart = fakeBusy ? await controlRequest(control, 4, "turn/start", {
      threadId: "fake-thread",
      input: [{ type: "text", text: "busy 时直接发送", text_elements: [] }]
    }) : null;
    let objectStatusActiveTracked = fakeBusy ? initializedState.busy === true : null;
    let objectStatusIdleTracked = null;
    if (fakeBusy) {
      proxy.stdin.write(`${JSON.stringify({ id: 90, method: "test/status-idle", params: {} })}\n`);
      await waitFor(() => parentLines.find((line) => line.id === 90));
      const idleState = await waitForState((value) => value.initialized === true && value.busy === false && value.currentThreadId === "fake-thread");
      objectStatusIdleTracked = idleState.busy === false;
    }
    const expectedRootThreadId = fakeBusy ? "fake-thread" : "from-trae";
    const beforeSubagent = await waitForState((value) => value.currentThreadId === expectedRootThreadId);
    proxy.stdin.write(`${JSON.stringify({ id: 91, method: "test/subagent-events", params: {} })}\n`);
    await waitFor(() => parentLines.find((line) => line.id === 91));
    await delay(100);
    const afterSubagent = readProxyInstances(stateFile)[0];
    const subagentEventsIgnored = afterSubagent.currentThreadId === beforeSubagent.currentThreadId && afterSubagent.busy === beforeSubagent.busy;

    control.close();
    return {
      argsPreserved,
      initializationGate,
      initialized: Boolean(initializeResponse.result) && initializedState.initialized,
      codexCliVersion: initializedState.codexCliVersion,
      autoStartRequested,
      parentReadCurrentProtocol: isCurrentThread(parentResponse.result?.thread, "from-trae"),
      controlReadCurrentProtocol: fakeBusy ? null : isCurrentThread(controlRead.result?.thread, "from-phone"),
      controlReadBlocked: blockedRead,
      controlResponseHiddenFromTrae: !parentSawControlResponse,
      lateHistoryReplayed: lateHistory.events.length > 0,
      lateHistoryHasBusyNotification: fakeBusy ? lateHistory.events.some((event) => event.type === "notification" && event.notification?.method === "thread/status/changed" && event.notification?.params?.status?.type === "active") : null,
      lateHistoryHasParentReadResponse: lateHistory.events.some((event) => event.type === "stdio-response" && event.method === "thread/read"),
      currentControlHistoryExcludesLiveEvents: !currentControlHistory.events.some((event) => event.type === "stdio-response" && event.method === "thread/read"),
      steerCurrentProtocol: fakeBusy ? steer?.result?.turnId === "fake-turn" : null,
      steerUserStartedOnce: fakeBusy ? steerUserLifecycle.started === 1 : null,
      steerUserCompletedOnce: fakeBusy ? steerUserLifecycle.completed === 1 : null,
      steerDisplayStartedOnce: fakeBusy ? steerDisplayEvents.length === 1 : null,
      steerDisplayBeforeCanonical: fakeBusy ? steerDisplayIndex >= 0 && steerCanonicalIndex > steerDisplayIndex : null,
      steerDisplayItemShape,
      steerUserItemShape,
      turnStartCurrentProtocol: fakeBusy ? isCurrentTurn(turnStart?.result?.turn, "fake-control-turn") : null,
      objectStatusActiveTracked,
      objectStatusIdleTracked,
      subagentEventsIgnored,
      proxyExited: proxy.exitCode !== null
    };
  } finally {
    try { proxy.stdin.end(); } catch {}
    await waitForProcessExit(proxy, 2000);
    if (proxy.exitCode === null) proxy.kill("SIGKILL");
  }
}

function isCurrentThread(thread, id) {
  return thread?.id === id &&
    thread.extra === null &&
    typeof thread.sessionId === "string" &&
    thread.historyMode === "paginated" &&
    typeof thread.createdAt === "number" &&
    typeof thread.status === "object" &&
    Array.isArray(thread.turns);
}

function isCurrentTurn(turn, id) {
  return turn?.id === id &&
    Array.isArray(turn.items) &&
    turn.itemsView === "full" &&
    turn.status === "inProgress" &&
    Object.prototype.hasOwnProperty.call(turn, "startedAt") &&
    Object.prototype.hasOwnProperty.call(turn, "durationMs");
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function openControl(state) {
  const ws = new WebSocket(`${state.controlUrl}?token=${encodeURIComponent(state.token)}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("control open timeout")), 5000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on("error", reject);
  });
  return ws;
}

function controlRequest(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 5000);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function controlHistory(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("history timeout")), 5000);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "history") return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "get-state", includeHistory: true }));
  });
}

async function waitForState(predicate, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const state = readProxyInstances(stateFile, { healthyOnly: false }).find(predicate);
      if (predicate(state)) return state;
    } catch {}
    await delay(100);
  }
  throw new Error("state wait timeout");
}

async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error("wait timeout");
}

async function waitForFile(filePath, timeoutMs = 5000) {
  await waitFor(async () => {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }, timeoutMs);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
