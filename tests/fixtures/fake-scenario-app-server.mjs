import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const logFile = process.env.FAKE_SCENARIO_LOG || "";
const baseTimeMs = Date.now() - 10_000;
const baseTime = toEpochSeconds(baseTimeMs);
const approvalRequestId = 9001;
const secondApprovalRequestId = 9002;
const permissionsApprovalRequestId = 9003;
const nativeRequestIds = {
  mcpElicitation: 9101,
  toolInput: 9102,
  attestation: 9103
};
const threads = new Map();
let nextPhoneThread = 1;
let nextPhoneTurn = 1;
let nextInternalTitleThread = 1;
let initialEmitted = false;
let completionEmitted = false;
const resumeDelayQueues = new Map();
const interruptDelayQueue = { respondMs: 0, completeMs: 0 };
const systemErrorFixtures = [];
const assistantPathFixtures = [];
const threadStartFixturesByModel = new Map();
const threadListDelayQueue = [];
const pagedHistoryFixtures = new Map();
const subsequenceSnapshotFixtures = new Map();
const failedTurnStartOnceTexts = new Set();
let emitLatePreSteerItem = false;
let steerUserEventDelayMs = 0;
const requireResumeBeforeTurn = process.env.FAKE_REQUIRE_RESUME_BEFORE_TURN === "1";
const initialThreadIdle = process.env.FAKE_INITIAL_THREAD_IDLE === "1";
const titleResultDelayMs = Math.max(0, Number(process.env.FAKE_TITLE_RESULT_DELAY_MS || 20));
const resumedThreadIds = new Set();

const runningDiff = [
  "diff --git a/src/live.js b/src/live.js",
  "--- a/src/live.js",
  "+++ b/src/live.js",
  "@@ -1 +1 @@",
  "-console.log('old')",
  "+console.log('new')"
].join("\n");

const completedDiff = [
  "diff --git a/src/final.js b/src/final.js",
  "--- a/src/final.js",
  "+++ b/src/final.js",
  "@@ -1 +1 @@",
  "-export const value = 'old'",
  "+export const value = 'new'"
].join("\n");

const updatedRunningDiff = [
  "diff --git a/src/live2.js b/src/live2.js",
  "--- a/src/live2.js",
  "+++ b/src/live2.js",
  "@@ -1 +1,2 @@",
  "-console.log('before')",
  "+console.log('after')",
  "+console.log('again')"
].join("\n");

const windowPressureInitialDiff = [
  "diff --git a/src/pressure-initial.js b/src/pressure-initial.js",
  "--- a/src/pressure-initial.js",
  "+++ b/src/pressure-initial.js",
  "@@ -1 +1 @@",
  "-export const stage = 'before'",
  "+export const stage = 'initial'"
].join("\n");

const windowPressureUpdatedDiff = [
  "diff --git a/src/pressure-final.js b/src/pressure-final.js",
  "--- a/src/pressure-final.js",
  "+++ b/src/pressure-final.js",
  "@@ -1 +1,3 @@",
  "-export const stage = 'initial'",
  "+export const stage = 'final'",
  "+export const refreshed = true",
  "+export const switched = true"
].join("\n");

const initialPlan = [
  { step: "接入手机", status: "completed" },
  { step: "保持会话隔离", status: "inProgress" },
  { step: "生成完成态卡片", status: "pending" }
];

const threadA = {
  id: "thread-a",
  extra: null,
  sessionId: "session-a",
  forkedFromId: null,
  parentThreadId: null,
  name: "电脑正在运行的会话",
  preview: "手机中途接入复杂场景",
  ephemeral: false,
  historyMode: "paginated",
  modelProvider: "openai",
  cwd: repoRoot,
  cliVersion: "0.153.4",
  source: "vscode",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  path: null,
  recencyAt: baseTime + 1,
  status: { type: "active", activeFlags: [] },
  createdAt: baseTime,
  updatedAt: baseTime + 1,
  turns: [
    {
      id: "turn-a",
      status: "inProgress",
      startedAt: baseTime,
      completedAt: null,
      durationMs: null,
      error: null,
      itemsView: "full",
      items: [
        {
          id: "user-a",
          type: "userMessage",
          clientId: "client-user-a",
          content: [{ type: "text", text: "请实现复杂同步测试", text_elements: [] }]
        },
        {
          id: "plan-a",
          type: "plan",
          text: ""
        }
      ]
    }
  ]
};

if (initialThreadIdle) {
  threadA.status = { type: "idle" };
  threadA.turns[0].status = "completed";
  threadA.turns[0].completedAt = baseTime + 1;
  threadA.turns[0].durationMs = 1000;
}

threads.set(threadA.id, threadA);

if (!initialThreadIdle) setTimeout(emitInitialRunningTurn, Number(process.env.FAKE_INITIAL_DELAY_MS || 80));

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => handleLine(line).catch((error) => record({ type: "error", message: error.message })));
input.on("close", () => process.exit(0));
setInterval(() => {}, 1000).unref();

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
    await record({ type: "server-response", id: message.id, result: message.result, error: message.error });
    if ([approvalRequestId, secondApprovalRequestId, permissionsApprovalRequestId].includes(message.id)) {
      notify("serverRequest/resolved", { threadId: "thread-a", requestId: message.id });
    }
    return;
  }

  if (!message?.method) return;
  await record({ type: "request", method: message.method, params: message.params });

  if (message.method === "initialize") {
    if (!isCurrentInitializeParams(message.params)) {
      respondError(message.id, "invalid 0.153.4 initialize params", -32602);
      return;
    }
    respond(message.id, {
      userAgent: "codex_vscode/0.153.4 (Windows 10.0.26100; x86_64) test",
      codexHome: path.join(repoRoot, "tests", "build", "complex-scenarios-test", "codex-home"),
      platformFamily: "windows",
      platformOs: "windows"
    });
    return;
  }

  if (message.method === "initialized") return;

  if (message.method === "thread/list") {
    const snapshot = {
      // 与真实 Codex 协议一致：归档线程不出现在未归档列表里。
      data: Array.from(threads.values()).filter((thread) => !thread.ephemeral && !thread.archived).map(threadSummary),
      nextCursor: null,
      backwardsCursor: null
    };
    const delayMs = Math.max(0, Number(threadListDelayQueue.shift() || 0));
    if (delayMs > 0) await delay(delayMs);
    respond(message.id, snapshot);
    return;
  }

  if (message.method === "model/list") {
    respond(message.id, {
      data: [
        {
          model: "gpt-test-default",
          displayName: "GPT Test",
          description: "内置测试模型",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", label: "low" },
            { reasoningEffort: "medium", label: "medium" },
            { reasoningEffort: "high", label: "high" }
          ]
        }
      ],
      nextCursor: null
    });
    return;
  }

  if (message.method === "thread/settings/update") {
    const threadSettings = {
      model: message.params?.model,
      effort: message.params?.effort
    };
    notify("thread/settings/updated", {
      threadId: message.params?.threadId,
      threadSettings
    });
    respond(message.id, {});
    return;
  }

  if (message.method === "thread/read") {
    const threadId = message.params?.threadId || "thread-a";
    // 先截取快照再延迟回包，用来复现真实父端 read 已经取到旧数据、
    // 但响应晚于实时 notification 到达手机桥的竞态。
    const snapshot = clone(snapshotSourceForThread(threadId));
    if (pagedHistoryFixtures.has(threadId)) snapshot.turns = [];
    const responseDelayMs = Math.max(0, Number(message.params?.testResponseDelayMs || 0));
    if (responseDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    respond(message.id, { thread: snapshot });
    return;
  }

  if (message.method === "thread/revert") {
    const threadId = String(message.params?.threadId || "");
    const thread = threads.get(threadId);
    if (!thread) {
      respondError(message.id, `thread not found: ${threadId}`, -32001);
      return;
    }
    const beforeTurnId = String(message.params?.beforeTurnId || "");
    const boundaryIndex = thread.turns.findIndex((turn) => String(turn?.id || "") === beforeTurnId);
    if (boundaryIndex < 0) {
      respondError(message.id, `turn not found: ${beforeTurnId}`, -32001);
      return;
    }
    thread.turns.splice(boundaryIndex);
    thread.status = { type: "idle" };
    thread.updatedAt = toEpochSeconds(Date.now());
    thread.recencyAt = thread.updatedAt;
    respond(message.id, { thread: { ...clone(thread), turns: [] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
    notify("thread/reverted", { threadId });
    return;
  }

  if (message.method === "thread/resume") {
    const threadId = message.params?.threadId || "thread-a";
    resumedThreadIds.add(threadId);
    // 请求到达时就冻结快照，复现 resume 已读取旧历史、回包却晚于新消息的竞态。
    const snapshot = clone(snapshotSourceForThread(threadId));
    const delays = resumeDelayQueues.get(threadId) || [];
    const delayMs = Number(delays.shift() || 0);
    if (delays.length) resumeDelayQueues.set(threadId, delays);
    else resumeDelayQueues.delete(threadId);
    if (delayMs > 0) await delay(delayMs);
    const response = threadLifecycleResponse(snapshot, { resume: true });
    const pagedFixture = pagedHistoryFixtures.get(threadId);
    if (pagedFixture) {
      response.thread.turns = [];
      response.initialTurnsPage = {
        data: clone(pagedFixture.initialTurns),
        nextCursor: pagedFixture.nextCursor,
        backwardsCursor: null
      };
    }
    respond(message.id, response);
    return;
  }

  if (message.method === "thread/turns/list") {
    const threadId = message.params?.threadId || "";
    const fixture = pagedHistoryFixtures.get(threadId);
    if (!fixture) {
      respond(message.id, { data: [], nextCursor: null, backwardsCursor: null });
      return;
    }
    const thread = threads.get(threadId);
    if (thread?.status?.type === "active") {
      respondError(message.id, "thread/turns/list blocked while Codex turn is running", -32003);
      return;
    }
    const cursor = String(message.params?.cursor || "");
    respond(message.id, {
      data: cursor === fixture.nextCursor ? clone(fixture.olderTurns) : clone(fixture.initialTurns),
      nextCursor: cursor === fixture.nextCursor ? null : fixture.nextCursor,
      backwardsCursor: null
    });
    return;
  }

  if (message.method === "thread/start") {
    const fixture = threadStartFixturesByModel.get(String(message.params?.model || ""));
    const thread = message.params?.ephemeral
      ? createInternalTitleThread(message.params)
      : createPhoneThread(fixture?.threadId || "");
    if (!message.params?.ephemeral && message.params?.serviceName) thread.name = String(message.params.serviceName);
    if (fixture?.name) thread.name = fixture.name;
    if (fixture?.delayMs > 0) await delay(fixture.delayMs);
    threads.set(thread.id, thread);
    notify("thread/started", { thread: threadSummary(thread) });
    respond(message.id, threadLifecycleResponse(thread));
    return;
  }

  if (message.method === "turn/start") {
    const textInput = (message.params?.input || []).find((input) => input?.type === "text");
    const text = String(textInput?.text || "");
    if (text === "模拟双窗口写入冲突") {
      respondError(message.id, "thread already has an active writer");
      return;
    }
    if (!message.params?.outputSchema && text === "测试一下能不能生成手机端会话标题") await delay(450);
    if (!message.params?.outputSchema && text.includes("编辑首发失败后重试") && !failedTurnStartOnceTexts.has(text)) {
      failedTurnStartOnceTexts.add(text);
      respondError(message.id, "模拟编辑回滚后的首次发送失败");
      return;
    }
    if (!message.params?.outputSchema && text.includes("失败图片发送")) {
      await delay(300);
      respondError(message.id, "模拟电脑端停止后发送失败");
      return;
    }
    if (!message.params?.outputSchema && text.includes("断线重发只发送一次")) await delay(350);
    const threadId = message.params?.threadId;
    if (requireResumeBeforeTurn && !resumedThreadIds.has(threadId)) {
      respondError(message.id, `thread not found: ${threadId}`, -32001);
      return;
    }
    const thread = threads.get(threadId) || createPhoneThread(threadId);
    threads.set(thread.id, thread);
    const turn = createPhoneTurn(
      thread,
      message.params?.input || [],
      "",
      "",
      message.params?.clientUserMessageId || null
    );
    notify("turn/started", { threadId: thread.id, turn: clone(turn) });
    const userItem = turn.items.find((item) => item?.type === "userMessage");
    if (userItem) {
      notify("item/started", { threadId: thread.id, turnId: turn.id, startedAtMs: Date.now(), item: clone(userItem) });
      notify("item/completed", { threadId: thread.id, turnId: turn.id, completedAtMs: Date.now(), item: clone(userItem) });
    }
    respond(message.id, { turn: clone(turn) });
    if (thread.ephemeral && message.params?.outputSchema && !text.includes("模拟标题生成超时")) {
      setTimeout(() => emitStructuredTitleResult(thread, turn), titleResultDelayMs);
    }
    return;
  }

  if (message.method === "thread/name/set") {
    const thread = threads.get(message.params?.threadId);
    if (thread) thread.name = String(message.params?.name || "");
    notify("thread/name/updated", {
      threadId: message.params?.threadId,
      threadName: message.params?.name
    });
    respond(message.id, {});
    return;
  }

  if (message.method === "thread/compact" || message.method === "thread/compact/start") {
    notify("thread/compacted", { threadId: message.params?.threadId });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "thread/archive") {
    const thread = threads.get(message.params?.threadId);
    if (thread) {
      thread.archived = true;
      thread.status = { type: "archived" };
    }
    notify("thread/archived", { threadId: message.params?.threadId });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/set-token-usage") {
    notify("thread/tokenUsage/updated", {
      threadId: String(message.params?.threadId || "thread-a"),
      turnId: message.params?.turnId || null,
      tokenUsage: {
        last: {
          inputTokens: Number(message.params?.inputTokens || 120000),
          cachedInputTokens: Number(message.params?.cachedInputTokens || 0),
          outputTokens: Number(message.params?.outputTokens || 10000),
          reasoningOutputTokens: 0,
          totalTokens: Number(message.params?.totalTokens || 130000)
        },
        contextWindow: Number(message.params?.contextWindow || 950000)
      }
    });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "thread/unsubscribe") {
    respond(message.id, { status: "unsubscribed" });
    return;
  }

  if (message.method === "test/arm-late-pre-steer-item") {
    emitLatePreSteerItem = true;
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/set-steer-user-delay") {
    steerUserEventDelayMs = Math.max(0, Number(message.params?.delayMs || 0));
    respond(message.id, { ok: true, delayMs: steerUserEventDelayMs });
    return;
  }

  if (message.method === "turn/steer") {
    const now = Date.now();
    const threadId = message.params?.threadId || "thread-a";
    const turnId = message.params?.expectedTurnId || "turn-a";
    const item = {
      id: `steer-user-${message.params?.clientUserMessageId || Date.now()}`,
      type: "userMessage",
      clientId: message.params?.clientUserMessageId || null,
      // 与真实 Codex 协议一致：中途追加的用户消息带真实发送时刻，
      // 服务端按它排序，保证消息固定显示在对话流末尾。
      userMessageOrderAt: now,
      content: clone(message.params?.input || [])
    };
    const turn = threads.get(threadId)?.turns?.find((entry) => entry.id === turnId);
    const emitSteerEvents = () => {
      if (turn && emitLatePreSteerItem) {
        emitLatePreSteerItem = false;
        const lateItem = {
          id: "late-pre-steer-item",
          type: "commandExecution",
          command: "npm run late-pre-steer",
          cwd: repoRoot,
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          exitCode: 0,
          aggregatedOutput: "late pre-steer completion",
          durationMs: 10
        };
        turn.items.push(clone(lateItem));
        // 该条目在权威快照中位于 steer 用户消息之前，但完成事件在手机本地
        // 用户消息之后到达，复现旧 event fence 与 snapshot 反向成环的问题。
        notify("item/completed", {
          threadId,
          turnId,
          completedAtMs: now,
          item: clone(lateItem)
        });
      }
      if (turn && !turn.items.some((entry) => entry.id === item.id)) turn.items.push(clone(item));
      notify("item/started", {
        threadId,
        turnId,
        startedAtMs: now,
        item: clone(item)
      });
      notify("item/completed", {
        threadId,
        turnId,
        completedAtMs: now,
        item: clone(item)
      });
      notify("item/agentMessage/delta", {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "assistant-live-a",
        delta: "\n已收到手机追加指令。"
      });
    };
    const delayedEventsMs = steerUserEventDelayMs;
    steerUserEventDelayMs = 0;
    if (delayedEventsMs > 0) {
      respond(message.id, { turnId: "turn-a" });
      setTimeout(emitSteerEvents, delayedEventsMs);
    } else {
      emitSteerEvents();
      respond(message.id, { turnId: "turn-a" });
    }
    return;
  }

  if (message.method === "turn/interrupt") {
    if (threads.get(message.params?.threadId)?.ephemeral) {
      respond(message.id, {});
      return;
    }
    const { respondMs, completeMs } = interruptDelayQueue;
    const respondLater = () => {
      if (completeMs > 0) {
        setTimeout(() => emitCompletedTurn({ reason: "interrupt" }), completeMs);
      } else {
        emitCompletedTurn({ reason: "interrupt" });
      }
      respond(message.id, {});
    };
    if (respondMs > 0) setTimeout(respondLater, respondMs);
    else respondLater();
    return;
  }

  if (message.method === "test/set-interrupt-delay") {
    interruptDelayQueue.respondMs = Math.max(0, Number(message.params?.respondMs || 0));
    interruptDelayQueue.completeMs = Math.max(0, Number(message.params?.completeMs || 0));
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/system-error") {
    systemErrorFixtures.push({
      message: String(message.params?.message || "代理连接断开，正在重试"),
      threadId: String(message.params?.threadId || "thread-a")
    });
    notify("error", {
      threadId: String(message.params?.threadId || "thread-a"),
      error: { message: String(message.params?.message || "代理连接断开，正在重试") },
      willRetry: message.params?.willRetry !== false
    });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/reasoning-many-deltas") {
    const count = Math.max(1, Number(message.params?.count || 20));
    const intervalMs = Math.min(120, Math.max(0, Number(message.params?.intervalMs || 0)));
    const threadId = String(message.params?.threadId || "thread-a");
    const turnId = String(message.params?.turnId || "turn-a");
    const text = String(message.params?.text || "正在思考的摘要内容会逐字输出到很长的长度以便观察动画是否被影响");
    const turn = threads.get(threadId)?.turns?.at(-1) || threadA.turns[0];
    const item = {
      id: "reasoning-many-deltas",
      type: "reasoning",
      summary: [],
      content: []
    };
    if (!turn.items.some((entry) => entry.id === item.id)) turn.items.push(item);
    const deltas = Array.from(text).slice(0, count);
    for (const [index, delta] of deltas.entries()) {
      notify("item/reasoning/summaryTextDelta", {
        threadId,
        turnId,
        itemId: item.id,
        summaryIndex: 0,
        delta
      });
      if (intervalMs > 0 && index < deltas.length - 1) await delay(intervalMs);
    }
    respond(message.id, { ok: true, emitted: deltas.length });
    return;
  }

  if (message.method === "test/complete-running-thread") {
    const threadId = String(message.params?.threadId || "thread-running-pressure");
    const thread = threads.get(threadId);
    const turn = thread?.turns?.at(-1);
    if (!thread || !turn) {
      respondError(message.id, "找不到运行中测试会话");
      return;
    }
    turn.status = "completed";
    turn.completedAt = toEpochSeconds(Date.now());
    turn.durationMs = 10_000;
    thread.status = { type: "idle" };
    thread.updatedAt = turn.completedAt;
    thread.recencyAt = turn.completedAt;
    notify("turn/completed", { threadId, turn: clone(turn) });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
    respond(message.id, { ok: true, threadId });
    return;
  }

  if (message.method === "test/delta-tick") {
    const seq = Number(message.params?.seq || 0);
    notify("item/agentMessage/delta", {
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "assistant-live-a",
      delta: `\n实时吐字第 ${seq} 段：${"y".repeat(16)}`
    });
    record({ type: "notify", method: "item/agentMessage/delta", seq });
    respond(message.id, { ok: true, seq });
    return;
  }

  if (message.method === "test/assistant-path-message") {
    assistantPathFixtures.push({
      id: `assistant-path-${assistantPathFixtures.length + 1}`,
      text: String(message.params?.text || "查看 [app.js](/E:/codexlinktophone/src/app.js) 和 [guide.md](E:\\codexlinktophone\\docs\\guide.md) 的修改")
    });
    notify("item/completed", {
      threadId: "thread-a",
      turnId: "turn-a",
      completedAtMs: Date.now(),
      item: {
        id: assistantPathFixtures.at(-1).id,
        type: "agentMessage",
        text: assistantPathFixtures.at(-1).text
      }
    });
    respond(message.id, { ok: true, itemId: assistantPathFixtures.at(-1).id });
    return;
  }

  if (message.method === "test/complete") {
    emitCompletedTurn({ reason: "test" });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/complete-phone-turn") {
    const thread = threads.get(message.params?.threadId);
    const turn = thread?.turns?.at(-1);
    if (!thread || !turn) {
      respondError(message.id, "找不到手机端测试 turn");
      return;
    }
    const completedAt = toEpochSeconds(Date.now());
    turn.status = "completed";
    turn.completedAt = completedAt;
    turn.durationMs = Math.max(1, Math.round((completedAt - turn.startedAt) * 1000));
    thread.status = { type: "idle" };
    thread.updatedAt = completedAt;
    thread.recencyAt = completedAt;
    notify("turn/completed", { threadId: thread.id, turn: clone(turn) });
    notify("thread/status/changed", { threadId: thread.id, status: { type: "idle" } });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/diff-updates") {
    notify("turn/diff/updated", { threadId: "thread-a", turnId: "turn-a", diff: "" });
    notify("turn/diff/updated", { threadId: "thread-a", turnId: "turn-a", diff: updatedRunningDiff });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/reasoning-summary") {
    const turn = threadA.turns[0];
    const item = {
      id: "reasoning-default-collapsed",
      type: "reasoning",
      summary: ["默认折叠的思考摘要正文"],
      content: []
    };
    if (!turn.items.some((entry) => entry.id === item.id)) turn.items.push(item);
    notify("item/reasoning/summaryTextDelta", {
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: item.id,
      summaryIndex: 0,
      delta: item.summary[0]
    });
    respond(message.id, { ok: true, itemId: item.id });
    return;
  }

  if (message.method === "test/emit-user-message-snapshot") {
    const params = message.params || {};
    const threadId = String(params.threadId || "");
    const turnId = String(params.turnId || "");
    const clientUserMessageId = String(params.clientUserMessageId || "");
    if (threadId && turnId && clientUserMessageId) {
      const item = {
        id: `item-${Date.now()}`,
        type: "userMessage",
        clientId: clientUserMessageId,
        content: [{ type: "text", text: String(params.text || ""), text_elements: [] }]
      };
      notify("item/started", {
        threadId,
        turnId,
        startedAtMs: Date.now(),
        item: clone(item)
      });
      notify("item/completed", {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: clone(item)
      });
    }
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/reconnect-delta") {
    notify("item/agentMessage/delta", {
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "assistant-live-a",
      delta: "\n断线期间输出。"
    });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/long-text") {
    notify("item/agentMessage/delta", {
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "assistant-live-a",
      delta: `\n长文本完整同步开始\n${"完整同步内容".repeat(1600)}\nLONG_TEXT_SYNC_END`
    });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/many-messages") {
    const threadId = message.params?.threadId || "thread-a";
    for (let index = 0; index < 300; index += 1) {
      notify("item/completed", {
        threadId,
        turnId: "bulk-turn",
        item: {
          id: `bulk-message-${index}`,
          type: "agentMessage",
          text: `批量历史消息 ${index}`
        },
        completedAtMs: Date.now() + index
      });
    }
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/create-running-window-pressure") {
    const threadId = String(message.params?.threadId || "thread-window-pressure");
    const turnId = String(message.params?.turnId || "turn-window-pressure");
    const count = Math.max(81, Math.min(500, Number(message.params?.count || 85)));
    const thread = createPhoneThread(threadId);
    thread.name = "长会话结构消息回归";
    thread.source = "vscode";
    const turn = createPhoneTurn(
      thread,
      [{ type: "text", text: "验证长会话中的计划和文件变更", text_elements: [] }],
      turnId,
      "user-window-pressure"
    );
    threads.set(thread.id, thread);
    notify("thread/started", { thread: threadSummary(thread) });
    notify("item/completed", {
      threadId,
      turnId,
      item: clone(turn.items[0]),
      completedAtMs: Date.now()
    });
    notify("turn/started", { threadId, turn: clone(turn) });

    const planItem = {
      id: "plan-window-pressure",
      type: "plan",
      text: "- [~] 建立窗口压力\n- [ ] 刷新并重连\n- [ ] 完成 A-B-A 切换"
    };
    turn.items.push(planItem);
    notify("turn/plan/updated", {
      threadId,
      turnId,
      explanation: "长会话结构消息初始计划",
      plan: [
        { step: "建立窗口压力", status: "inProgress" },
        { step: "刷新并重连", status: "pending" },
        { step: "完成 A-B-A 切换", status: "pending" }
      ]
    });
    notify("turn/diff/updated", { threadId, turnId, diff: windowPressureInitialDiff });

    for (let index = 0; index < count; index += 1) {
      const item = {
        id: `window-pressure-item-${index}`,
        type: "agentMessage",
        text: `长会话窗口压力消息 ${index}`,
        phase: null,
        memoryCitation: null
      };
      turn.items.push(item);
      notify("item/completed", {
        threadId,
        turnId,
        item: clone(item),
        completedAtMs: Date.now() + index + 1
      });
    }

    planItem.text = "- [x] 建立窗口压力\n- [x] 刷新并重连\n- [~] 完成 A-B-A 切换";
    notify("turn/plan/updated", {
      threadId,
      turnId,
      explanation: "长会话结构消息最终计划",
      plan: [
        { step: "建立窗口压力", status: "completed" },
        { step: "刷新并重连", status: "completed" },
        { step: "完成 A-B-A 切换", status: "inProgress" }
      ]
    });
    notify("turn/diff/updated", { threadId, turnId, diff: windowPressureUpdatedDiff });
    respond(message.id, { ok: true, threadId, turnId, count });
    return;
  }

  if (message.method === "test/create-running-snapshot-only") {
    const threadId = String(message.params?.threadId || "thread-snapshot-only");
    const turnId = String(message.params?.turnId || "turn-snapshot-only");
    const thread = createPhoneThread(threadId);
    thread.name = "仅靠 resume 快照恢复";
    thread.source = "vscode";
    const turn = createPhoneTurn(
      thread,
      [{ type: "text", text: "仅从运行中快照恢复结构消息", text_elements: [] }],
      turnId,
      "user-snapshot-only"
    );
    turn.items.push({
      id: "plan-snapshot-only",
      type: "plan",
      text: "- [x] 读取结构化计划\n- [~] 从 fileChange 恢复 live diff"
    });
    turn.items.push({
      id: "file-snapshot-only",
      type: "fileChange",
      status: "inProgress",
      changes: [{
        path: "src/snapshot-only.js",
        kind: { type: "update", move_path: null },
        diff: "@@ -1 +1,2 @@\n-export const snapshot = false\n+export const snapshot = true\n+export const restored = true"
      }]
    });
    threads.set(thread.id, thread);

    // 故意不发送 turn/plan/updated、turn/diff/updated 或 fileChange item
    // notification。手机桥只能从随后的 thread/resume 快照恢复这些内容。
    notify("thread/started", { thread: threadSummary(thread) });
    notify("turn/started", { threadId, turn: clone(turn) });
    respond(message.id, { ok: true, threadId, turnId });
    return;
  }

  if (message.method === "test/create-running-persisted-only") {
    const threadId = String(message.params?.threadId || "thread-persisted-only");
    const turnId = String(message.params?.turnId || "turn-persisted-only");
    const thread = createPhoneThread(threadId);
    thread.name = "只靠磁盘恢复运行中结构消息";
    thread.source = "vscode";
    const turn = createPhoneTurn(
      thread,
      [{ type: "text", text: "验证桥重启后的结构消息持久化", text_elements: [] }],
      turnId,
      "user-persisted-only"
    );
    // 故意只把用户消息放入 resume 快照；plan 和 diff 只通过实时事件发送，
    // 用来模拟真实版本重启后 thread/resume 不返回结构消息的情况。
    threads.set(thread.id, thread);
    notify("thread/started", { thread: threadSummary(thread) });
    notify("item/completed", {
      threadId,
      turnId,
      item: clone(turn.items[0]),
      completedAtMs: Date.now()
    });
    notify("turn/started", { threadId, turn: clone(turn) });
    notify("turn/plan/updated", {
      threadId,
      turnId,
      explanation: "磁盘恢复测试计划",
      plan: [
        { step: "保留计划", status: "completed" },
        { step: "恢复 live diff", status: "inProgress" }
      ]
    });
    notify("turn/diff/updated", {
      threadId,
      turnId,
      diff: "diff --git a/src/persisted-only.js b/src/persisted-only.js\n--- a/src/persisted-only.js\n+++ b/src/persisted-only.js\n@@ -1 +1,2 @@\n-old\n+new\n+restored"
    });
    respond(message.id, { ok: true, threadId, turnId });
    return;
  }

  if (message.method === "test/create-paginated-history") {
    const threadId = String(message.params?.threadId || "thread-paginated-history");
    const turnId = String(message.params?.turnId || "turn-paginated-running");
    const thread = createPhoneThread(threadId);
    thread.name = "分页历史恢复回归";
    thread.source = "vscode";
    thread.turns = [];
    const now = toEpochSeconds(Date.now());
    const oldTurn = {
      id: "turn-paginated-old",
      status: "completed",
      startedAt: now - 180,
      completedAt: now - 170,
      durationMs: 10_000,
      error: null,
      itemsView: "full",
      items: [
        { id: "paged-old-user", type: "userMessage", clientId: null, content: [{ type: "text", text: "旧分页问题", text_elements: [] }] },
        { id: "paged-old-plan", type: "plan", text: "- [x] 历史计划" },
        {
          id: "paged-old-file",
          type: "fileChange",
          status: "completed",
          changes: [{ path: "src/paged-old.js", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new" }]
        },
        { id: "paged-old-assistant", type: "agentMessage", text: "旧分页回复" }
      ]
    };
    const middleTurn = {
      id: "turn-paginated-middle",
      status: "completed",
      startedAt: now - 120,
      completedAt: now - 110,
      durationMs: 10_000,
      error: null,
      itemsView: "full",
      items: [
        { id: "paged-middle-user", type: "userMessage", clientId: null, content: [{ type: "text", text: "中间分页问题", text_elements: [] }] },
        { id: "paged-middle-assistant", type: "agentMessage", text: "中间分页回复" }
      ]
    };
    const latestTurn = createPhoneTurn(
      thread,
      [{ type: "text", text: "当前运行中的分页问题", text_elements: [] }],
      turnId,
      "paged-running-user"
    );
    thread.turns = [oldTurn, middleTurn, latestTurn];
    pagedHistoryFixtures.set(threadId, {
      initialTurns: [latestTurn],
      olderTurns: [middleTurn, oldTurn],
      nextCursor: "paged-history-older"
    });
    threads.set(threadId, thread);
    notify("thread/started", { thread: threadSummary(thread) });
    notify("item/completed", { threadId, turnId, item: clone(latestTurn.items[0]), completedAtMs: Date.now() });
    notify("turn/started", { threadId, turn: clone(latestTurn) });
    respond(message.id, { ok: true, threadId, turnId });
    return;
  }

  if (message.method === "test/complete-paginated-history") {
    const threadId = String(message.params?.threadId || "thread-paginated-history");
    const thread = threads.get(threadId);
    const turn = thread?.turns?.at(-1);
    if (!thread || !turn) {
      respondError(message.id, "找不到分页历史测试会话");
      return;
    }
    turn.status = "completed";
    turn.completedAt = toEpochSeconds(Date.now());
    turn.durationMs = 10_000;
    thread.status = { type: "idle" };
    thread.updatedAt = turn.completedAt;
    thread.recencyAt = turn.completedAt;
    notify("turn/completed", { threadId, turn: clone(turn) });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
    respond(message.id, { ok: true, threadId });
    return;
  }

  if (message.method === "test/live-item-after-read-snapshot") {
    const threadId = message.params?.threadId || "thread-a";
    const turnId = message.params?.turnId || "turn-a";
    const thread = threads.get(threadId);
    const turn = thread?.turns?.find((entry) => entry.id === turnId);
    if (!thread || !turn) {
      respondError(message.id, "找不到 read 竞态测试会话");
      return;
    }
    const item = {
      id: message.params?.itemId || "read-race-live-item-a",
      type: "agentMessage",
      text: message.params?.text || "旧 thread/read 快照之后到达的实时消息",
      phase: null,
      memoryCitation: null
    };
    turn.items.push(item);
    notify("item/completed", {
      threadId,
      turnId,
      item: clone(item),
      completedAtMs: Date.now()
    });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/distinct-identical-items") {
    const threadId = message.params?.threadId || "thread-b";
    const turnId = message.params?.turnId || "turn-b";
    const thread = threads.get(threadId);
    const turn = thread?.turns?.find((entry) => entry.id === turnId);
    if (!thread || !turn) {
      respondError(message.id, "找不到相同正文测试会话");
      return;
    }
    const text = message.params?.text || "两条正文相同但 itemId 不同的合法回复";
    const items = [
      { id: "identical-item-b-1", type: "agentMessage", text, phase: null, memoryCitation: null },
      { id: "identical-item-b-2", type: "agentMessage", text, phase: null, memoryCitation: null }
    ];
    turn.items.push(...items);
    for (const [index, item] of items.entries()) {
      notify("item/completed", {
        threadId,
        turnId,
        item: clone(item),
        completedAtMs: Date.now() + index
      });
    }
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/background-message-burst") {
    const threadId = message.params?.threadId || "thread-a";
    const turnId = message.params?.turnId || "pagination-growth-turn";
    const count = Math.max(1, Math.min(300, Number(message.params?.count || 100)));
    const idPrefix = String(message.params?.idPrefix || "pagination-growth-message");
    const textPrefix = String(message.params?.textPrefix || "加载更早后的后台新增消息");
    for (let index = 0; index < count; index += 1) {
      notify("item/completed", {
        threadId,
        turnId,
        item: {
          id: `${idPrefix}-${index}`,
          type: "agentMessage",
          text: `${textPrefix} ${index}`
        },
        completedAtMs: Date.now() + index
      });
    }
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/stale-turn-completed") {
    const thread = createPhoneThread("thread-stale-completion");
    thread.name = "旧完成事件竞态会话";
    thread.source = "vscode";
    threads.set(thread.id, thread);
    notify("thread/started", { thread: threadSummary(thread) });

    const oldTurn = createPhoneTurn(
      thread,
      [{ type: "text", text: "旧 turn", text_elements: [] }],
      "turn-stale-old",
      "user-stale-old"
    );
    notify("turn/started", { threadId: thread.id, turn: clone(oldTurn) });

    const newTurn = createPhoneTurn(
      thread,
      [{ type: "text", text: "新 turn", text_elements: [] }],
      "turn-stale-new",
      "user-stale-new"
    );
    notify("turn/started", { threadId: thread.id, turn: clone(newTurn) });
    notify("item/agentMessage/delta", {
      threadId: thread.id,
      turnId: newTurn.id,
      itemId: "assistant-stale-new",
      delta: "新 turn 仍在运行"
    });

    oldTurn.status = "completed";
    oldTurn.completedAt = toEpochSeconds(Date.now());
    oldTurn.durationMs = Math.max(1, Math.round((oldTurn.completedAt - oldTurn.startedAt) * 1000));
    notify("turn/completed", { threadId: thread.id, turn: clone(oldTurn) });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/second-approval") {
    emitServerRequest({
      id: secondApprovalRequestId,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "file-a",
        startedAtMs: Date.now(),
        reason: "需要修改测试文件",
        grantRoot: null
      }
    });
    emitServerRequest({
      id: permissionsApprovalRequestId,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "cmd-a",
        environmentId: null,
        startedAtMs: Date.now(),
        cwd: repoRoot,
        reason: "测试新版权限审批",
        permissions: {
          network: { enabled: true },
          fileSystem: null
        }
      }
    });
    emitNativeTraeRequests();
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/pc-other-thread") {
    emitOtherThreadActivity();
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/set-command-output") {
    const thread = threads.get(String(message.params?.threadId || ""));
    const turn = thread?.turns?.at(-1);
    if (!turn) { respondError(message.id, "Missing command test turn"); return; }
    const id = "command-recovery-output";
    let item = turn.items.find((entry) => entry.id === id);
    if (!item) {
      for (let index = 0; index < Number(message.params?.earlierCount || 0); index++) {
        const earlier = { id: "recovery-earlier-" + index, type: "agentMessage", text: "Earlier history " + index, phase: "commentary" };
        turn.items.push(earlier);
        notify("item/completed", { threadId: thread.id, turnId: turn.id, item: clone(earlier) });
      }
      item = { id, type: "commandExecution", command: "recovery-output", status: "completed" };
      turn.items.push(item);
    }
    item.aggregatedOutput = String(message.params?.output || "");
    notify("item/completed", { threadId: thread.id, turnId: turn.id, item: clone(item) });
    respond(message.id, { ok: true, id });
    return;
  }

  if (message.method === "test/long-command") {
    const item = {
      id: "cmd-long",
      type: "commandExecution",
      name: "测试长命令",
      command: "npm test --long",
      status: "inProgress"
    };
    notify("item/started", { threadId: "thread-a", turnId: "turn-a", startedAtMs: Date.now(), item: clone(item) });
    let index = 0;
    let aggregatedOutput = "";
    const timer = setInterval(() => {
      index += 1;
      const lines = Array.from({ length: 15 }, (_, j) => `命令输出第 ${(index - 1) * 15 + j + 1} 行：这一行内容足够长，用来测试展开后的命令滚动区域，编号 ${(index - 1) * 15 + j + 1}`);
      aggregatedOutput += `${lines.join("\n")}\n`;
      notify("item/commandExecution/outputDelta", {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "cmd-long",
        delta: `${lines.join("\n")}\n`
      });
      if (index >= 8) {
        clearInterval(timer);
        notify("item/completed", {
          threadId: "thread-a",
          turnId: "turn-a",
          completedAtMs: Date.now(),
          item: clone({ ...item, status: "completed", aggregatedOutput })
        });
      }
    }, 60);
    timer.unref?.();
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/context-compaction") {
    const threadId = String(message.params?.threadId || "thread-a");
    const turnId = String(message.params?.turnId || "turn-a");
    const thread = threads.get(threadId);
    const turn = thread?.turns?.find((entry) => entry.id === turnId);
    if (!thread || !turn) {
      respondError(message.id, "找不到上下文压缩测试会话");
      return;
    }
    const item = { id: `context-compaction-${threadId}`, type: "contextCompaction" };
    if (!turn.items.some((entry) => entry.id === item.id)) turn.items.push(item);
    notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: clone(item) });
    respond(message.id, { ok: true, threadId, turnId });
    return;
  }

  if (message.method === "test/old-delta") {
    notify("item/agentMessage/delta", {
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "assistant-live-a",
      delta: "\n旧会话后台继续输出。"
    });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/stream-burst") {
    // 模拟长运行会话的持续流式输出，用于复现“积压越多、切会话越卡”。
    let index = 0;
    const burstCount = Math.max(1, Math.min(300, Number(message.params?.count || 300)));
    const timer = setInterval(() => {
      index += 1;
      notify("item/agentMessage/delta", {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "assistant-live-a",
        delta: `\n流式输出第 ${index} 段：${"x".repeat(1800)}`
      });
      if (index >= burstCount) clearInterval(timer);
    }, 12);
    timer.unref?.();
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/thread-b-background-updates") {
    notify("turn/plan/updated", {
      threadId: "thread-b",
      turnId: "turn-b",
      explanation: "后台 B 计划",
      plan: [{ step: "保留 B 的完整消息", status: "inProgress" }]
    });
    notify("item/reasoning/summaryTextDelta", {
      threadId: "thread-b",
      turnId: "turn-b",
      itemId: "reasoning-b",
      summaryIndex: 0,
      delta: "B 后台推理内容"
    });
    notify("item/commandExecution/outputDelta", {
      threadId: "thread-b",
      turnId: "turn-b",
      itemId: "command-b",
      delta: "B 后台命令输出"
    });
    notify("turn/diff/updated", {
      threadId: "thread-b",
      turnId: "turn-b",
      diff: "diff --git a/src/b.js b/src/b.js\n--- a/src/b.js\n+++ b/src/b.js\n@@ -1 +1 @@\n-old\n+new"
    });
    notify("item/agentMessage/delta", {
      threadId: "thread-b",
      turnId: "turn-b",
      itemId: "assistant-b",
      delta: "\nB 后台继续输出。"
    });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/set-resume-delays") {
    for (const [threadId, delays] of Object.entries(message.params?.delays || {})) {
      resumeDelayQueues.set(threadId, Array.isArray(delays) ? delays.map(Number) : [Number(delays || 0)]);
    }
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/set-thread-start-fixtures") {
    threadStartFixturesByModel.clear();
    for (const [model, fixture] of Object.entries(message.params?.fixtures || {})) {
      threadStartFixturesByModel.set(model, {
        delayMs: Math.max(0, Number(fixture?.delayMs || 0)),
        threadId: String(fixture?.threadId || ""),
        name: String(fixture?.name || "")
      });
    }
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/create-same-text-history") {
    const threadId = String(message.params?.threadId || "thread-same-text-history");
    const text = String(message.params?.text || "完全相同的重复问题");
    const thread = createPhoneThread(threadId);
    thread.name = "同文 hydration 竞态";
    const turn = createPhoneTurn(
      thread,
      [{ type: "text", text, text_elements: [] }],
      "turn-same-text-old",
      "user-same-text-old"
    );
    turn.startedAt = toEpochSeconds(Date.now() - 30_000);
    turn.status = "completed";
    turn.completedAt = toEpochSeconds(Date.now() - 29_000);
    turn.durationMs = 1000;
    thread.status = { type: "idle" };
    thread.updatedAt = turn.completedAt;
    thread.recencyAt = turn.completedAt;
    threads.set(thread.id, thread);
    notify("thread/started", { thread: threadSummary(thread) });
    respond(message.id, { ok: true, threadId, text });
    return;
  }

  if (message.method === "test/annotation-delta") {
    const thread = threads.get(message.params.threadId);
    const turn = thread.turns.at(-1);
    let item = turn.items.find(candidate => candidate.id === message.params.itemId);
    if (!item) {
      item = { id: message.params.itemId, type: "agentMessage", phase: "final_answer", text: "", memoryCitation: null };
      turn.items.push(item);
      notify("item/started", { threadId: thread.id, turnId: turn.id, item: clone(item) });
    }
    item.text += message.params.delta;
    notify("item/agentMessage/delta", { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: message.params.delta });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/annotation-item") {
    const thread = threads.get(message.params.threadId);
    const turn = thread.turns.at(-1);
    const item = { id: message.params.itemId, type: "agentMessage", phase: "final_answer", text: message.params.text, memoryCitation: null };
    const index = turn.items.findIndex(candidate => candidate.id === item.id);
    if (index >= 0) turn.items[index] = item;
    else turn.items.push(item);
    notify("item/completed", { threadId: thread.id, turnId: turn.id, completedAtMs: Date.now(), item: clone(item) });
    respond(message.id, { ok: true });
    return;
  }

  if (message.method === "test/create-edit-history") {
    const threadId = String(message.params?.threadId || "thread-edit-history");
    const oldText = String(message.params?.oldText || "修改前文字");
    const thread = createPhoneThread(threadId);
    thread.name = "消息编辑回归";
    const firstTurn = createPhoneTurn(
      thread,
      [{ type: "text", text: "保留的上一轮消息", text_elements: [] }],
      `${threadId}-turn-1`,
      `${threadId}-user-1`
    );
    firstTurn.items.push({ id: `${threadId}-assistant-1`, type: "agentMessage", text: "保留的上一轮回复", phase: "final_answer", memoryCitation: null });
    firstTurn.status = "completed";
    firstTurn.completedAt = toEpochSeconds(Date.now() - 2000);
    firstTurn.durationMs = 1000;

    const editTurnId = `${threadId}-turn-edit`;
    const editMessageId = `${threadId}-user-edit`;
    const editTurn = createPhoneTurn(thread, [
      { type: "text", text: oldText, text_elements: [] },
      { type: "image", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", name: "old-image.png" }
    ], editTurnId, editMessageId);
    editTurn.items.push(
      {
        id: `${threadId}-plan-edit`,
        type: "plan",
        text: "",
        plan: [
          { step: "旧计划步骤", status: "completed" },
          { step: "不应保留的计划", status: "pending" }
        ]
      },
      {
        id: `${threadId}-file-edit`,
        type: "fileChange",
        status: "completed",
        changes: [{ path: "src/old-edit.js", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+edited" }]
      },
      { id: `${threadId}-assistant-edit`, type: "agentMessage", text: String(message.params?.assistantText || "修改前的旧回复"), phase: "final_answer", memoryCitation: null }
    );
    editTurn.status = "completed";
    editTurn.completedAt = toEpochSeconds(Date.now() - 500);
    editTurn.durationMs = 1200;
    thread.status = { type: "idle" };
    thread.createdAt = firstTurn.startedAt;
    thread.updatedAt = editTurn.completedAt;
    thread.recencyAt = editTurn.completedAt;
    threads.set(thread.id, thread);
    notify("thread/started", { thread: threadSummary(thread) });
    respond(message.id, { ok: true, threadId, editTurnId, editMessageId, oldText });
    return;
  }

  if (message.method === "test/stale-active-canonical-idle") {
    const thread = createPhoneThread("thread-canonical-idle");
    thread.name = "权威状态为空闲";
    thread.status = { type: "idle" };
    threads.set(thread.id, thread);
    notify("thread/started", { thread: threadSummary(thread) });
    // 让手机先看见错误 active，再由稍晚返回的权威 thread/list 修正。
    threadListDelayQueue.push(220);
    notify("thread/status/changed", { threadId: thread.id, status: { type: "active", activeFlags: [] } });
    respond(message.id, { ok: true, threadId: thread.id });
    return;
  }

  if (message.method === "test/stale-idle-canonical-active") {
    const thread = createPhoneThread("thread-canonical-active");
    thread.name = "权威状态为运行中";
    const turn = createPhoneTurn(
      thread,
      [{ type: "text", text: "保持权威运行状态", text_elements: [] }],
      "turn-canonical-active",
      "user-canonical-active"
    );
    threads.set(thread.id, thread);
    notify("thread/started", { thread: threadSummary(thread) });
    notify("turn/started", { threadId: thread.id, turn: clone(turn) });
    threadListDelayQueue.push(120);
    setTimeout(() => {
      notify("thread/status/changed", { threadId: thread.id, status: { type: "idle" } });
    }, 30);
    respond(message.id, { ok: true, threadId: thread.id });
    return;
  }

  if (message.method === "test/running-turn-list-stale-idle") {
    const thread = createPhoneThread("thread-running-list-stale-idle");
    thread.name = "运行中列表短暂空闲";
    const turn = createPhoneTurn(
      thread,
      [{ type: "text", text: "保持明确运行中的 turn", text_elements: [] }],
      "turn-running-list-stale-idle",
      "user-running-list-stale-idle"
    );
    threads.set(thread.id, thread);
    notify("thread/started", { thread: threadSummary(thread) });
    notify("turn/started", { threadId: thread.id, turn: clone(turn) });
    thread.status = { type: "idle" };
    threadListDelayQueue.push(40);
    setTimeout(() => notify("thread/status/changed", { threadId: thread.id, status: { type: "active", activeFlags: [] } }), 180);
    respond(message.id, { ok: true, threadId: thread.id, turnId: turn.id });
    return;
  }

  if (message.method === "test/create-snapshot-alias-thread") {
    const threadId = "thread-snapshot-alias";
    const oldTurnId = "turn-snapshot-alias-old";
    const newerTurnId = "turn-snapshot-alias-newer";
    const now = toEpochSeconds(Date.now());
    const thread = createPhoneThread(threadId);
    thread.name = "快照实时消息合并";
    thread.status = { type: "idle" };
    thread.turns = [
      {
        id: oldTurnId,
        status: "completed",
        startedAt: now - 30,
        completedAt: now - 20,
        durationMs: 10_000,
        error: null,
        itemsView: "full",
        items: [
          { id: "item-900", type: "userMessage", clientId: "snapshot-alias-user-client", content: [{ type: "text", text: "快照重复问题", text_elements: [] }] },
          { id: "item-902", type: "fileChange", status: "completed", changes: [{ path: "src/alias.js", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new" }] },
          { id: "item-901", type: "agentMessage", text: "快照重复回复", phase: "final_answer", memoryCitation: null }
        ]
      },
      {
        id: newerTurnId,
        status: "completed",
        startedAt: now - 10,
        completedAt: now - 5,
        durationMs: 5_000,
        error: null,
        itemsView: "full",
        items: [
          { id: "item-903", type: "userMessage", clientId: null, content: [{ type: "text", text: "后续问题", text_elements: [] }] },
          { id: "item-904", type: "agentMessage", text: "后续回复", phase: "final_answer", memoryCitation: null }
        ]
      }
    ];
    thread.createdAt = now - 30;
    thread.updatedAt = now - 5;
    thread.recencyAt = now - 5;
    threads.set(thread.id, thread);
    notify("thread/started", { thread: threadSummary(thread) });
    notify("item/completed", {
      threadId,
      turnId: oldTurnId,
      item: clone(thread.turns[0].items[1]),
      completedAtMs: Date.now()
    });
    respond(message.id, { ok: true, threadId, oldTurnId, newerTurnId });
    return;
  }

  if (message.method === "test/emit-snapshot-alias-live-items") {
    const threadId = "thread-snapshot-alias";
    const turnId = "turn-snapshot-alias-old";
    const completedAtMs = Date.now();
    notify("item/completed", {
      threadId,
      turnId,
      item: { id: "canonical-alias-user", type: "userMessage", clientId: "snapshot-alias-user-client", content: [{ type: "text", text: "快照重复问题", text_elements: [] }] },
      completedAtMs
    });
    notify("item/completed", {
      threadId,
      turnId,
      item: { id: "canonical-alias-assistant", type: "agentMessage", text: "快照重复回复", phase: "final_answer", memoryCitation: null },
      completedAtMs: completedAtMs + 1
    });
    respond(message.id, { ok: true, threadId, turnId });
    return;
  }

  if (message.method === "test/create-uuidv7-resume-order-thread") {
    const threadId = String(message.params?.threadId || "thread-uuidv7-resume-order");
    const baseStartedAt = toEpochSeconds(Date.now() - 60_000);
    const thread = createPhoneThread(threadId);
    thread.name = "UUIDv7 resume 顺序回归";
    thread.source = "vscode";
    thread.status = { type: "idle" };
    thread.turns = Array.from({ length: 3 }, (_, index) => {
      const sequence = index + 1;
      const startedAt = baseStartedAt + (index * 10);
      // 真实协议只给整秒 startedAt，而 UUIDv7 保留该秒内的毫秒。
      // 900ms 的稳定差值会触发旧比较器把助手回复排到用户消息之前。
      const uuidTimestampMs = (startedAt * 1000) + 900;
      const turnId = uuidV7FromTimestampMs(uuidTimestampMs, sequence);
      const userId = `uuid-order-user-${sequence}`;
      const assistantId = `uuid-order-assistant-${sequence}`;
      const fileId = sequence === 3 ? "uuid-order-file-3" : null;
      const items = [
        {
          id: userId,
          type: "userMessage",
          clientId: null,
          content: [{ type: "text", text: `UUIDv7 顺序问题 ${sequence}`, text_elements: [] }]
        }
      ];
      if (fileId) {
        items.push({
          id: fileId,
          type: "fileChange",
          status: "completed",
          changes: [{
            path: "src/uuidv7-order.js",
            kind: { type: "update", move_path: null },
            diff: "@@ -1 +1 @@\n-old\n+new"
          }]
        });
      }
      items.push({
        id: assistantId,
        type: "agentMessage",
        text: `UUIDv7 顺序回复 ${sequence}`,
        phase: "final_answer",
        memoryCitation: null
      });
      return {
        id: turnId,
        status: "completed",
        startedAt,
        completedAt: startedAt + 2,
        durationMs: 2000,
        error: null,
        itemsView: "full",
        items
      };
    });
    thread.createdAt = thread.turns[0].startedAt;
    thread.updatedAt = thread.turns.at(-1).completedAt;
    thread.recencyAt = thread.updatedAt;
    threads.set(thread.id, thread);
    notify("thread/started", { thread: threadSummary(thread) });
    respond(message.id, {
      ok: true,
      threadId,
      turns: thread.turns.map((turn) => ({
        turnId: turn.id,
        startedAt: turn.startedAt,
        uuidTimestampMs: uuidV7TimestampMs(turn.id),
        userId: turn.items[0].id,
        fileId: turn.items.find((item) => item.type === "fileChange")?.id || null,
        assistantId: turn.items.find((item) => item.type === "agentMessage")?.id || null
      }))
    });
    return;
  }

  if (message.method === "test/create-subsequence-order-thread") {
    const threadId = String(message.params?.threadId || "thread-subsequence-order");
    const turnId = String(message.params?.turnId || "turn-subsequence-order");
    const thread = createPhoneThread(threadId);
    thread.name = "双快照子序列排序回归";
    thread.source = "vscode";
    const turn = createPhoneTurn(
      thread,
      [{ type: "text", text: "验证完整快照与紧凑子序列保持同一顺序", text_elements: [] }],
      turnId,
      "subsequence-order-user"
    );
    const ids = {
      userId: turn.items[0].id,
      beforeCommentaryId: "subsequence-before-commentary",
      beforeCommandId: "subsequence-before-command",
      fileId: "subsequence-file",
      oldFinalId: "subsequence-old-final",
      steerUserId: "subsequence-steer-user",
      afterCommandId: "subsequence-after-command",
      afterCommentaryId: "subsequence-after-commentary",
      newFinalId: "subsequence-new-final"
    };
    const beforeCommentary = {
      id: ids.beforeCommentaryId,
      type: "agentMessage",
      text: "中途插入前的过程说明",
      phase: "commentary",
      memoryCitation: null
    };
    const beforeCommand = {
      id: ids.beforeCommandId,
      type: "commandExecution",
      command: "npm run pre-steer",
      cwd: repoRoot,
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      exitCode: 0,
      aggregatedOutput: "pre steer ok",
      durationMs: 20
    };
    const fileChange = {
      id: ids.fileId,
      type: "fileChange",
      status: "completed",
      changes: [{
        path: "src/subsequence-order.js",
        kind: { type: "update", move_path: null },
        diff: "@@ -1 +1 @@\n-old\n+new"
      }]
    };
    const oldFinal = {
      id: ids.oldFinalId,
      type: "agentMessage",
      text: "中途插入前已经产生的回复",
      phase: "final_answer",
      memoryCitation: null
    };
    const steerUser = {
      id: ids.steerUserId,
      type: "userMessage",
      clientId: "subsequence-steer-client",
      userMessageOrderAt: Date.now() + 5,
      content: [{ type: "text", text: "手机中途插入的新要求", text_elements: [] }]
    };
    const afterCommand = {
      id: ids.afterCommandId,
      type: "commandExecution",
      command: "npm run post-steer",
      cwd: repoRoot,
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      exitCode: 0,
      aggregatedOutput: "post steer ok",
      durationMs: 30
    };
    const afterCommentary = {
      id: ids.afterCommentaryId,
      type: "agentMessage",
      text: "中途插入后的过程说明",
      phase: "commentary",
      memoryCitation: null
    };
    const newFinal = {
      id: ids.newFinalId,
      type: "agentMessage",
      text: "中途插入后的最终回复",
      phase: "final_answer",
      memoryCitation: null
    };
    const orderedItems = [
      beforeCommentary,
      beforeCommand,
      fileChange,
      oldFinal,
      steerUser,
      afterCommand,
      afterCommentary,
      newFinal
    ];
    const startedAtMs = Date.now();
    threads.set(thread.id, thread);
    notify("thread/started", { thread: threadSummary(thread) });
    notify("item/completed", {
      threadId,
      turnId,
      item: clone(turn.items[0]),
      completedAtMs: startedAtMs
    });
    notify("turn/started", { threadId, turn: clone(turn) });
    for (const [index, item] of orderedItems.entries()) {
      turn.items.push(clone(item));
      notify("item/completed", {
        threadId,
        turnId,
        item: clone(item),
        completedAtMs: startedAtMs + index + 1
      });
      if (item.id === ids.fileId) {
        notify("turn/diff/updated", {
          threadId,
          turnId,
          diff: "diff --git a/src/subsequence-order.js b/src/subsequence-order.js\n--- a/src/subsequence-order.js\n+++ b/src/subsequence-order.js\n@@ -1 +1 @@\n-old\n+new"
        });
      }
    }

    turn.status = "completed";
    turn.completedAt = toEpochSeconds(startedAtMs + orderedItems.length + 1);
    turn.durationMs = Math.max(1, Math.round((turn.completedAt - turn.startedAt) * 1000));
    thread.status = { type: "idle" };
    thread.updatedAt = turn.completedAt;
    thread.recencyAt = turn.completedAt;
    const fullThread = clone(thread);
    const compactThread = clone(thread);
    compactThread.turns[0].items = compactThread.turns[0].items.filter((item) => [
      ids.userId,
      ids.beforeCommentaryId,
      ids.oldFinalId,
      ids.steerUserId,
      ids.afterCommentaryId,
      ids.newFinalId
    ].includes(item.id));
    subsequenceSnapshotFixtures.set(threadId, {
      fullThread,
      compactThread,
      useCompact: false
    });
    notify("turn/completed", { threadId, turn: clone(turn) });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
    respond(message.id, { ok: true, threadId, turnId, ids });
    return;
  }

  if (message.method === "test/use-compact-subsequence-snapshot") {
    const threadId = String(message.params?.threadId || "thread-subsequence-order");
    const fixture = subsequenceSnapshotFixtures.get(threadId);
    if (!fixture) {
      respondError(message.id, "找不到双快照子序列测试会话");
      return;
    }
    fixture.useCompact = true;
    respond(message.id, { ok: true, threadId });
    return;
  }

  if (message.method === "test/create-incomplete-order-thread") {
    const threadId = String(message.params?.threadId || "thread-incomplete-order");
    const turnId = String(message.params?.turnId || "turn-incomplete-order");
    const thread = createPhoneThread(threadId);
    thread.name = "不完整快照排序回归";
    thread.source = "vscode";
    const turn = createPhoneTurn(
      thread,
      [{ type: "text", text: "验证实时命令与快照最终回复顺序", text_elements: [] }],
      turnId,
      "incomplete-order-user"
    );
    const snapshotMiddle = {
      id: "incomplete-snapshot-middle",
      type: "agentMessage",
      text: "快照中的前置过程消息",
      phase: "commentary",
      memoryCitation: null
    };
    turn.items.push(snapshotMiddle);
    threads.set(thread.id, thread);

    notify("thread/started", { thread: threadSummary(thread) });
    notify("item/completed", {
      threadId,
      turnId,
      item: clone(turn.items[0]),
      completedAtMs: Date.now()
    });
    notify("turn/started", { threadId, turn: clone(turn) });
    notify("turn/plan/updated", {
      threadId,
      turnId,
      explanation: "这个计划只存在于实时事件",
      plan: [
        { step: "运行构建", status: "completed" },
        { step: "生成最终回复", status: "completed" }
      ]
    });
    notify("item/completed", {
      threadId,
      turnId,
      item: clone(snapshotMiddle),
      completedAtMs: Date.now() + 1
    });

    const finalItem = {
      id: "incomplete-snapshot-final",
      type: "agentMessage",
      text: "不完整快照最终回复",
      phase: "final_answer",
      memoryCitation: null
    };
    turn.items.push(finalItem);

    const command = {
      id: "incomplete-live-command",
      type: "commandExecution",
      command: "npm run build",
      cwd: repoRoot,
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      exitCode: 0,
      aggregatedOutput: "build ok",
      durationMs: 50
    };
    notify("item/completed", { threadId, turnId, item: clone(command), completedAtMs: Date.now() + 2 });

    const fileChange = {
      id: "incomplete-live-file",
      type: "fileChange",
      status: "completed",
      changes: [{
        path: "src/incomplete-order.js",
        kind: { type: "update", move_path: null },
        diff: "@@ -1 +1 @@\n-old\n+new"
      }]
    };
    notify("item/completed", { threadId, turnId, item: clone(fileChange), completedAtMs: Date.now() + 3 });
    notify("turn/diff/updated", {
      threadId,
      turnId,
      diff: "diff --git a/src/incomplete-order.js b/src/incomplete-order.js\n--- a/src/incomplete-order.js\n+++ b/src/incomplete-order.js\n@@ -1 +1 @@\n-old\n+new"
    });
    notify("item/completed", { threadId, turnId, item: clone(finalItem), completedAtMs: Date.now() + 4 });

    turn.status = "completed";
    turn.completedAt = toEpochSeconds(Date.now());
    turn.durationMs = Math.max(1, Math.round((turn.completedAt - turn.startedAt) * 1000));
    thread.status = { type: "idle" };
    thread.updatedAt = turn.completedAt;
    thread.recencyAt = turn.completedAt;
    // command、fileChange 和 plan 故意不写入 turn.items；紧凑快照是实时完整顺序的子序列。
    notify("turn/completed", { threadId, turn: clone(turn) });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
    respond(message.id, { ok: true, threadId, turnId });
    return;
  }

  if (message.method === "test/complete-thread-b") {
    const thread = threads.get("thread-b");
    const turn = thread?.turns?.find((entry) => entry.id === "turn-b");
    const item = {
      id: "assistant-final-b",
      type: "agentMessage",
      text: "B 会话已在后台完整结束。",
      phase: "final_answer",
      memoryCitation: null
    };
    turn.items.push(item);
    turn.status = "completed";
    turn.completedAt = toEpochSeconds(Date.now());
    turn.durationMs = Math.max(1, Math.round((turn.completedAt - turn.startedAt) * 1000));
    thread.status = { type: "idle" };
    thread.updatedAt = turn.completedAt;
    thread.recencyAt = turn.completedAt;
    notify("item/completed", { threadId: "thread-b", turnId: "turn-b", item: clone(item), completedAtMs: Date.now() });
    notify("turn/completed", { threadId: "thread-b", turn: clone(turn) });
    notify("thread/status/changed", { threadId: "thread-b", status: { type: "idle" } });
    respond(message.id, { ok: true });
    return;
  }

  respond(message.id, { ok: true, method: message.method });
}

function emitInitialRunningTurn() {
  if (initialEmitted) return;
  initialEmitted = true;
  notify("thread/started", { thread: threadSummary(threadA) });
  notify("item/completed", {
    threadId: "thread-a",
    turnId: "turn-a",
    item: clone(threadA.turns[0].items[0]),
    completedAtMs: baseTimeMs + 10
  });
  notify("turn/started", { threadId: "thread-a", turn: clone(threadA.turns[0]) });
  notify("turn/plan/updated", {
    threadId: "thread-a",
    turnId: "turn-a",
    explanation: null,
    plan: clone(initialPlan)
  });
  notify("turn/diff/updated", { threadId: "thread-a", turnId: "turn-a", diff: runningDiff });
  notify("item/agentMessage/delta", {
    threadId: "thread-a",
    turnId: "turn-a",
    itemId: "assistant-live-a",
    delta: "正在处理手机中途接入场景。"
  });
  // 只存在于 app-server 的 resume 快照中，不发 notification；用来验证
  // 手机桥/手机初连时能主动补齐运行中会话在接入前已经存在的历史。
  threadA.turns[0].items.push({
    id: "resume-only-history-a",
    type: "agentMessage",
    text: "这条历史只能通过运行中 resume 快照补齐。",
    phase: null,
    memoryCitation: null
  });
  emitServerRequest({
    id: approvalRequestId,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "cmd-a",
      startedAtMs: baseTimeMs + 200,
      approvalId: null,
      environmentId: null,
      reason: "运行项目测试",
      command: "npm test",
      cwd: repoRoot,
      commandActions: [],
      networkApprovalContext: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null
    }
  });
}

function emitCompletedTurn({ reason }) {
  if (completionEmitted) return;
  completionEmitted = true;
  const turn = threadA.turns[0];
  const completedAtMs = Date.now();
  const completedAt = toEpochSeconds(completedAtMs);
  turn.status = "completed";
  turn.completedAt = completedAt;
  turn.durationMs = completedAtMs - baseTimeMs;
  threadA.status = { type: "idle" };
  threadA.updatedAt = completedAt;
  threadA.recencyAt = completedAt;
  turn.items = [
    turn.items[0],
    turn.items[1],
    {
      id: "cmd-a",
      type: "commandExecution",
      command: "npm test",
      cwd: repoRoot,
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      exitCode: 0,
      aggregatedOutput: "ok",
      durationMs: 120
    },
    {
      id: "file-a",
      type: "fileChange",
      status: "completed",
      changes: [
        {
          path: "src/patch-from-file-change.js",
          kind: { type: "update", move_path: null },
          diff: "@@ -1 +1,2 @@\n-old\n+new\n+again"
        }
      ]
    },
    {
      id: "assistant-mid-a",
      type: "agentMessage",
      text: "我已经改完文件，准备继续测试。",
      phase: null,
      memoryCitation: null
    },
    {
      id: "assistant-final-a",
      type: "agentMessage",
      text: `复杂场景已完成：${reason}。\n\n\`\`\`text\n手机代码块复制测试\n\`\`\``,
      phase: "final_answer",
      memoryCitation: null
    }
  ];
  notify("item/completed", { threadId: "thread-a", turnId: "turn-a", item: clone(turn.items[2]), completedAtMs: baseTimeMs + 220 });
  notify("item/completed", { threadId: "thread-a", turnId: "turn-a", item: clone(turn.items[3]), completedAtMs: baseTimeMs + 240 });
  notify("turn/diff/updated", { threadId: "thread-a", turnId: "turn-a", diff: completedDiff });
  notify("item/completed", { threadId: "thread-a", turnId: "turn-a", item: clone(turn.items[4]), completedAtMs: baseTimeMs + 280 });
  notify("item/completed", { threadId: "thread-a", turnId: "turn-a", item: clone(turn.items[5]), completedAtMs: baseTimeMs + 340 });
  notify("turn/completed", {
    threadId: "thread-a",
    turn: clone(turn)
  });
  notify("thread/status/changed", { threadId: "thread-a", status: { type: "idle" } });
}

function emitOtherThreadActivity() {
  const thread = createPhoneThread("thread-b");
  thread.name = "电脑端其他会话";
  thread.preview = "不应自动切走手机";
  thread.source = "vscode";
  const turn = createPhoneTurn(thread, [{ type: "text", text: "电脑端其他会话消息", text_elements: [] }], "turn-b", "user-b");
  threads.set(thread.id, thread);
  notify("thread/started", { thread: threadSummary(thread) });
  notify("turn/started", { threadId: thread.id, turn: clone(turn) });
  notify("item/agentMessage/delta", {
    threadId: thread.id,
    turnId: "turn-b",
    itemId: "assistant-b",
    delta: "这条消息不应出现在手机当前会话。"
  });
}

function createPhoneThread(id = "") {
  const now = toEpochSeconds(Date.now());
  const thread = {
    id: id || `phone-thread-${nextPhoneThread++}`,
    extra: null,
    sessionId: `session-${id || nextPhoneThread}`,
    forkedFromId: null,
    parentThreadId: null,
    name: "新会话",
    preview: "来自手机端",
    ephemeral: false,
    historyMode: "paginated",
    modelProvider: "openai",
    cwd: repoRoot,
    cliVersion: "0.153.4",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    path: null,
    recencyAt: now,
    status: { type: "idle" },
    createdAt: now,
    updatedAt: now,
    turns: []
  };
  return thread;
}

function createInternalTitleThread(params = {}) {
  const thread = createPhoneThread(`internal-title-${nextInternalTitleThread++}`);
  thread.name = null;
  thread.preview = "";
  thread.ephemeral = true;
  thread.titleModel = String(params.model || "");
  thread.threadSource = params.threadSource || "system";
  thread.cwd = params.cwd || thread.cwd;
  return thread;
}

function emitStructuredTitleResult(thread, turn) {
  const text = JSON.stringify({
    title: "修复手机端会话标题",
    description: "手机端 新建会话 标题生成 gpt-5.4-mini"
  });
  const item = {
    id: `title-agent-${turn.id}`,
    type: "agentMessage",
    text,
    phase: "final_answer",
    memoryCitation: null
  };
  turn.items.push(item);
  turn.status = "completed";
  turn.completedAt = toEpochSeconds(Date.now());
  notify("item/completed", {
    threadId: thread.id,
    turnId: turn.id,
    item: clone(item),
    completedAtMs: Date.now()
  });
  notify("turn/completed", { threadId: thread.id, turn: clone(turn) });
}

function createPhoneTurn(thread, input, requestedTurnId = "", requestedUserId = "", clientUserMessageId = null) {
  const nowMs = Date.now();
  const now = toEpochSeconds(nowMs);
  const turn = {
    id: requestedTurnId || `phone-turn-${nextPhoneTurn++}`,
    status: "inProgress",
    startedAt: now,
    completedAt: null,
    durationMs: null,
    error: null,
    itemsView: "full",
    items: [
      {
        id: requestedUserId || `phone-user-${nextPhoneTurn}`,
        type: "userMessage",
        clientId: clientUserMessageId,
        content: input
      }
    ]
  };
  thread.status = { type: "active", activeFlags: [] };
  thread.updatedAt = now;
  thread.recencyAt = now;
  thread.turns.push(turn);
  return turn;
}

function threadSummary(thread) {
  return {
    ...clone(thread),
    turns: []
  };
}

function snapshotSourceForThread(threadId) {
  const fixture = subsequenceSnapshotFixtures.get(threadId);
  if (fixture) return fixture.useCompact ? fixture.compactThread : fixture.fullThread;
  return threads.get(threadId) || threadA;
}

function threadLifecycleResponse(thread, options = {}) {
  const response = {
    thread: clone(thread),
    model: "gpt-test-default",
    modelProvider: "openai",
    serviceTier: null,
    cwd: thread.cwd,
    runtimeWorkspaceRoots: [thread.cwd],
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: [thread.cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    },
    activePermissionProfile: null,
    reasoningEffort: null,
    multiAgentMode: "explicitRequestOnly"
  };
  if (options.resume) response.initialTurnsPage = null;
  return response;
}

function emitNativeTraeRequests() {
  emitServerRequest({
    id: nativeRequestIds.mcpElicitation,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      serverName: "test-mcp",
      mode: "form",
      _meta: null,
      message: "由 Trae 原生处理的 MCP 表单",
      requestedSchema: { type: "object", properties: {}, required: [] }
    }
  });
  emitServerRequest({
    id: nativeRequestIds.toolInput,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "tool-input-a",
      autoResolutionMs: null,
      questions: [{
        id: "choice",
        header: "原生输入",
        question: "请选择 Trae 原生选项",
        isOther: false,
        isSecret: false,
        options: [{ label: "继续", description: "由 Trae 回答" }]
      }]
    }
  });
  emitServerRequest({
    id: nativeRequestIds.attestation,
    method: "attestation/generate",
    params: {}
  });
}

function emitServerRequest(request) {
  write(request);
}

function toEpochSeconds(value) {
  return Math.floor(Number(value) / 1000);
}

function uuidV7FromTimestampMs(value, sequence = 0) {
  const timestampHex = Math.max(0, Math.trunc(Number(value) || 0)).toString(16).padStart(12, "0").slice(-12);
  const sequenceHex = Math.max(0, Math.trunc(Number(sequence) || 0)).toString(16).padStart(3, "0").slice(-3);
  const tailHex = Math.max(0, Math.trunc(Number(sequence) || 0)).toString(16).padStart(12, "0").slice(-12);
  return `${timestampHex.slice(0, 8)}-${timestampHex.slice(8)}-7${sequenceHex}-8${sequenceHex}-${tailHex}`;
}

function uuidV7TimestampMs(value) {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(String(value || ""));
  return match ? Number.parseInt(`${match[1]}${match[2]}`, 16) : 0;
}

function notify(method, params) {
  write({ method, params });
}

function respond(id, result) {
  write({ id, result });
}

function respondError(id, message, code = -32000) {
  write({ id, error: { code, message } });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCurrentInitializeParams(params) {
  return typeof params?.clientInfo?.name === "string" &&
    typeof params?.clientInfo?.title === "string" &&
    typeof params?.clientInfo?.version === "string" &&
    params?.capabilities?.experimentalApi === true &&
    params?.capabilities?.mcpServerOpenaiFormElicitation === true &&
    typeof params?.capabilities?.requestAttestation === "boolean";
}

async function record(entry) {
  if (!logFile) return;
  await fs.appendFile(logFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, "utf8");
}
