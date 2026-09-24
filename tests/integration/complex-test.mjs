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
const workDir = process.env.BRIDGE_TEST_DIR || path.join(root, "tests/build", `complex-${Date.now()}`);
const fakeSource = path.join(__dirname, "../fixtures/fake-scenario-app-server.mjs");
const bridgeExecutable = process.env.BRIDGE_TEST_EXE || path.join(root, "server", "dist", "codex-phone-bridge.exe");
const proxyStateFile = path.join(workDir, "proxy-state.json");
const proxyLogFile = path.join(workDir, "proxy.log");
const fakeLogFile = path.join(workDir, "fake.log");
const phoneStateDir = path.join(workDir, "phone-state");
const token = "codex-phone";

const results = [];
let proxy = null;
let bridge = null;
let phone = null;
let phoneState = null;
let proxyOutput = null;
const parentLines = [];
const phoneErrors = [];
const phoneSendResults = [];
const phoneEditResults = [];
const phoneThreadOperationResults = [];
const nativeTraeRequestIds = [9101, 9102, 9103];
let paginationThreadId = null;
let titleGenerationContext = null;

  // Retain isolated evidence under tests/build; no recursive deletion.
await fs.mkdir(workDir, { recursive: true });

try {
  await startProxy();
  const proxyState = await waitForProxyState((state) =>
    state.mode === "stdio-tee" && state.upstreamConnected && state.initialized && state.controlUrl
  );
  await startBridge();
  phone = await openPhone(await waitForBridgeUrl());

  await runStep("运行中手机桥中途接入可回放真实事件", async () => {
    await waitForPhoneState((state) =>
      state.codex.status === "connected" &&
      state.currentThreadId === "thread-a" &&
      state.busy === true &&
      state.activeTurnId === "turn-a" &&
      hasMessage((message) => message.role === "user" && String(message.text || "") === "请实现复杂同步测试") &&
      hasMessage((message) => message.kind === "plan" && message.streaming) &&
      hasMessage((message) => isAboveComposerTurnDiff(message) && messageTurnId(message) === "turn-a") &&
      hasMessage((message) => String(message.text || "").includes("正在处理手机中途接入场景")) &&
      hasMessage((message) => message.id === "resume-only-history-a") &&
      state.threads.length >= 1 &&
      currentThread()?.name === "电脑正在运行的会话" &&
      state.threads.some((thread) => thread.id === "thread-a" && thread.preview === "手机中途接入复杂场景") &&
      state.sync?.omittedMessages === 0 &&
      state.approvals.length === 1
    );
    const log = await readFakeLog();
    assert(countRequests(log, "thread/read") === 0, "busy 中途接入不应触发 thread/read");
    assert(countRequests(log, "thread/resume") >= 1, "运行中初连必须通过 thread/resume 补齐接入前历史");
  });

  await runStep("运行中刷新会话列表且不触发 thread/read", async () => {
    const before = await readFakeLog();
    sendPhone({ type: "state:request" });
    sendPhone({ type: "threads:refresh" });
    await waitFor(async () => {
      const log = await readFakeLog();
      return countRequests(log, "thread/list") > countRequests(before, "thread/list") ? log : null;
    }, 5000, "running refresh thread/list");
    const log = await readFakeLog();
    assert(countRequests(log, "thread/read") === 0, "busy 刷新不应触发 thread/read");
    assert(countTextInMessages("正在处理手机中途接入场景。") === 1, "刷新不应重复历史 delta");
    assert(phoneState.approvals.length === 1, "刷新不应重复审批卡片");
    assert(currentThread()?.name === "电脑正在运行的会话", "刷新后应保留真实会话标题");
    assert(phoneState.threads.some((thread) => thread.id === "thread-a" && thread.preview === "手机中途接入复杂场景"), "会话列表必须保留扩展返回的 preview");
  });

  await runStep("运行中手机追加消息同步到电脑端", async () => {
    await parentRequest("arm-late-pre-steer", "test/arm-late-pre-steer-item");
    sendPhone({ type: "message:send", text: "手机追加：保持当前 turn", images: [] });
    const steerRequest = await waitForFakeRequest("turn/steer");
    assert(typeof steerRequest.params?.clientUserMessageId === "string" && steerRequest.params.clientUserMessageId.length > 0, "turn/steer 必须携带 clientUserMessageId");
    await waitFor(() => parentLines.some((line) =>
      line.method === "item/completed" &&
      line.params?.item?.type === "userMessage" &&
      line.params.item.clientId === steerRequest.params.clientUserMessageId
    ), 5000, "Trae steer userMessage lifecycle");
    const matchingParentEvents = parentLines.filter((line) =>
      ["item/started", "item/completed"].includes(line.method) &&
      line.params?.item?.type === "userMessage" &&
      line.params.item.clientId === steerRequest.params.clientUserMessageId
    );
    assert(matchingParentEvents.filter((line) => line.method === "item/started").length === 1, "Trae 必须收到且只收到一次 steer item/started");
    assert(matchingParentEvents.filter((line) => line.method === "item/completed").length === 1, "Trae 必须收到且只收到一次 steer item/completed");

    const displayEvents = parentLines.filter((line) =>
      line.method === "item/started" &&
      line.params?.item?.type === "steeringUserMessage" &&
      line.params.item.clientUserMessageId === steerRequest.params.clientUserMessageId
    );
    assert(displayEvents.length === 1, "Trae 必须收到且只收到一次可见 steeringUserMessage");
    const displayItem = displayEvents[0].params.item;
    assert(displayItem.status === "pending", "手机中途消息必须先按扩展协议投影为 pending");
    assert(Array.isArray(displayItem.input) && displayItem.input.some((entry) => entry?.text === "手机追加：保持当前 turn"), "可见 steeringUserMessage 必须保留原始输入");
    assert(displayItem.restoreMessage?.context && Array.isArray(displayItem.restoreMessage.context.commentAttachments), "可见 steeringUserMessage 必须满足扩展 restoreMessage 结构");
    const displayIndex = parentLines.indexOf(displayEvents[0]);
    const canonicalIndex = parentLines.findIndex((line) =>
      line.method === "item/started" &&
      line.params?.item?.type === "userMessage" &&
      line.params.item.clientId === steerRequest.params.clientUserMessageId
    );
    assert(displayIndex >= 0 && canonicalIndex > displayIndex, "可见 steeringUserMessage 必须先于 canonical userMessage 到达扩展");
    const liveReducerItems = [
      { id: "initial-user", type: "userMessage", content: [{ type: "text", text: "初始问题", text_elements: [] }] },
      { id: "work-before-steer", type: "commandExecution", status: "inProgress" }
    ];
    for (const event of parentLines.slice(displayIndex).filter((line) =>
      ["item/started", "item/completed"].includes(line.method) &&
      ["steeringUserMessage", "userMessage"].includes(line.params?.item?.type) &&
      (line.params.item.clientUserMessageId === steerRequest.params.clientUserMessageId ||
        line.params.item.clientId === steerRequest.params.clientUserMessageId)
    )) {
      const item = event.params.item;
      const existingIndex = liveReducerItems.findIndex((candidate) => candidate.id === item.id);
      if (existingIndex >= 0) liveReducerItems[existingIndex] = item;
      else liveReducerItems.push(item);
    }
    assert(
      traeVisibleUserTexts(liveReducerItems).filter((text) => text === "手机追加：保持当前 turn").length === 1,
      "按扩展 reducer 归并后，手机中途消息必须恰好形成一个可见 user-message"
    );

    await waitForPhoneState((state) => {
      const lateIndex = state.messages.findIndex((message) => message.id === "late-pre-steer-item");
      const userIndex = state.messages.findIndex((message) =>
        message.role === "user" &&
        String(message.meta?.clientUserMessageId || "") === String(steerRequest.params.clientUserMessageId)
      );
      return lateIndex >= 0 && userIndex > lateIndex;
    });

    const read = await parentRequest("steer-history-read-1", "thread/read", { threadId: "thread-a" });
    const readAgain = await parentRequest("steer-history-read-2", "thread/read", { threadId: "thread-a" });
    for (const response of [read, readAgain]) {
      const items = response.result?.thread?.turns?.find((turn) => turn.id === "turn-a")?.items || [];
      const userIndex = items.findIndex((item) => item?.type === "userMessage" && item.clientId === steerRequest.params.clientUserMessageId);
      const projected = items[userIndex - 1];
      assert(userIndex > 0 && projected?.type === "steeringUserMessage", "重开线程时中途 userMessage 前必须恢复可见 steering 投影");
      assert(projected.clientUserMessageId === steerRequest.params.clientUserMessageId && projected.status === "accepted", "历史 steering 投影必须关联同一 clientUserMessageId");
      assert(items.filter((item) => item?.type === "steeringUserMessage" && item.clientUserMessageId === steerRequest.params.clientUserMessageId).length === 1, "重复读取线程快照不能叠加 steering 投影");
      assert(items.filter((item) => item?.type === "userMessage").length === 2, "历史投影不能复制初始或中途 canonical userMessage");
      assert(traeVisibleUserTexts(items).filter((text) => text === "手机追加：保持当前 turn").length === 1, "历史快照经扩展 reducer 归并后，中途消息必须恰好可见一次");
    }
  });

  await runStep("turn/steer 接受后手机先显示消息且 canonical 到达后不重复", async () => {
    const delayedText = "手机 steer 接受后立即显示";
    const delayedCanonicalMs = 700;
    await parentRequest("set-steer-user-delay", "test/set-steer-user-delay", { delayMs: delayedCanonicalMs });
    const parentStart = parentLines.length;
    const before = await readFakeLog();
    const steerCountBefore = countRequestsForThread(before, "turn/steer", "thread-a");
    sendPhone({ type: "message:send", text: delayedText, images: [] });
    const log = await waitForFakeRequestCountForThread("turn/steer", "thread-a", steerCountBefore + 1);
    const steerRequest = [...log].reverse().find((entry) =>
      entry.type === "request" &&
      entry.method === "turn/steer" &&
      entry.params?.threadId === "thread-a" &&
      entry.params?.input?.some((input) => input?.text === delayedText)
    );
    assert(steerRequest, "延迟 canonical 测试必须发送 turn/steer");
    const clientUserMessageId = String(steerRequest.params.clientUserMessageId || "");
    assert(clientUserMessageId, "延迟 canonical 测试必须携带 clientUserMessageId");
    const acceptedAt = Date.now();
    await waitForPhoneState((state) => state.messages.filter((message) =>
      message.role === "user" &&
      message.text === delayedText &&
      String(message.meta?.clientUserMessageId || "") === clientUserMessageId
    ).length === 1, 1000);
    const acceptedDisplayDelay = Date.now() - acceptedAt;
    assert(acceptedDisplayDelay < delayedCanonicalMs, `turn/steer 接受后的手机显示不能等待 canonical 事件，实际 ${acceptedDisplayDelay}ms`);
    assert(!parentLines.slice(parentStart).some((line) =>
      line.method === "item/started" &&
      line.params?.item?.type === "userMessage" &&
      line.params.item.clientId === clientUserMessageId
    ), "canonical item/started 尚未到达时，手机消息必须来自桥内已接受投影");

    await waitFor(() => parentLines.some((line) =>
      line.method === "item/started" &&
      line.params?.item?.type === "userMessage" &&
      line.params.item.clientId === clientUserMessageId
    ), 5000, "delayed steer canonical userMessage");
    await waitForPhoneState((state) => state.messages.filter((message) =>
      message.role === "user" && message.text === delayedText
    ).length === 1, 5000);
  });

  await runStep("CLI 内置模型与下一轮设置在 turn/start 原子应用", async () => {
    await waitForPhoneState((state) =>
      state.models?.some((model) => model.model === "gpt-test-default") &&
      state.threadSettings?.model === "gpt-test-default"
    );
    const before = await readFakeLog();
    sendPhone({ type: "settings:update", model: "gpt-test-default", effort: "high" });
    await waitForPhoneState((state) => state.threadSettings?.model === "gpt-test-default" && state.threadSettings?.effort === "high");
    await delay(100);
    const after = await readFakeLog();
    assert(countRequests(after, "thread/settings/update") === countRequests(before, "thread/settings/update"), "当前协议不应发送不存在的 thread/settings/update");
  });

  await runStep("过期设置错误只提示且不污染对话流", async () => {
    const errorText = "会话状态已更新，请重新选择设置";
    const errorCountBefore = phoneErrors.length;
    sendPhone({
      type: "settings:update",
      threadId: phoneState.currentThreadId,
      threadRevision: Number(phoneState.threadRevision || 0) + 1,
      model: "gpt-test-default",
      effort: "high"
    });
    await waitFor(
      () => phoneErrors.slice(errorCountBefore).includes(errorText),
      5000,
      "stale settings error"
    );
    await delay(150);
    assert(
      !phoneState.messages.some((message) => message.role === "system" && String(message.text || "") === errorText),
      "手机操作状态不能写入工作对话流"
    );
  });

  await runStep("空 diff 被忽略且多次 diff 只保留最新", async () => {
    await parentRequest(100, "test/diff-updates");
    await waitForPhoneState((state) => {
      const diffs = state.messages.filter((message) => isAboveComposerTurnDiff(message) && messageTurnId(message) === "turn-a");
      return diffs.length === 1 && fileChangesForMessage(diffs[0]).some((change) => change.path === "src/live2.js" && change.added === 2 && change.deleted === 1);
    });
  });

  await runStep("手机 WebSocket 重连不重复断线期间事件", async () => {
    phone.close();
    await delay(120);
    await parentRequest(103, "test/reconnect-delta");
    phone = await openPhone(await waitForBridgeUrl());
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-a" &&
      countTextInMessages("断线期间输出。") === 1
    );
  });

  await runStep("超长消息完整同步不截断", async () => {
    await parentRequest(104, "test/long-text");
    await waitForPhoneState((state) =>
      state.sync?.omittedMessages === 0 &&
      Number(state.sync?.textLimit) >= 64 * 1024 &&
      state.messages.some((message) =>
        String(message.text || "").includes("LONG_TEXT_SYNC_END") &&
        String(message.text || "").length > 8000 &&
        message.textTruncated === false
      )
    );
  });

  await runStep("手机新建会话不混入旧 running turn", async () => {
    const beforeNew = await readFakeLog();
    const threadStartsBeforeNew = countRequests(beforeNew, "thread/start");
    const internalTitleStartsBeforeNew = beforeNew.filter((entry) =>
      entry.type === "request" && entry.method === "thread/start" && entry.params?.ephemeral === true
    ).length;
    sendPhone({ type: "thread:new" });
    await waitForPhoneState((state) =>
      state.currentThreadId === null &&
      state.busy === false &&
      state.approvals.length === 0 &&
      !state.messages.some((message) => messageThreadId(message) === "thread-a")
    );
    const afterNew = await readFakeLog();
    assert(countRequests(afterNew, "thread/start") === threadStartsBeforeNew, "只点击新会话不能提前创建 Codex 线程");
    await parentRequest(101, "test/old-delta");
    await delay(250);
    assert(phoneState.currentThreadId === null, "旧会话后台输出不应切走手机空白新会话");
    assert(!phoneState.messages.some((message) => String(message.text || "").includes("旧会话后台继续输出")), "旧会话后台输出不应混入手机新会话");
    const refreshClient = await openSecondaryPhone(await waitForBridgeUrl());
    const threadListsBeforeTitleRace = countRequests(await readFakeLog(), "thread/list");
    const firstPrompt = "测试一下能不能生成手机端会话标题";
    const clientPromptId = "phone-client-id-title-race-001";
    sendPhone({ type: "message:send", text: firstPrompt, images: [], clientUserMessageId: clientPromptId });
    await waitFor(async () => {
      const log = await readFakeLog();
      return log.find((entry) =>
        entry.type === "request" &&
        entry.method === "turn/start" &&
        entry.params?.input?.some((input) => input.type === "text" && input.text === firstPrompt)
      ) || null;
    }, 5000, "custom service name title race turn/start");
    await delay(520);
    refreshClient.send({ type: "threads:refresh" });
    await waitForFakeRequestCount("thread/list", threadListsBeforeTitleRace + 1);
    refreshClient.close();
    await waitForFakeRequestCount("turn/start", 1);
    await waitForPhoneState((state) =>
      String(state.currentThreadId || "").startsWith("phone-thread-") &&
      state.busy === true &&
      state.messages.some((message) =>
        message.role === "user" &&
        String(message.text || "").includes(firstPrompt) &&
        messageThreadId(message) === state.currentThreadId
      ) &&
      !state.messages.some((message) => messageThreadId(message) === "thread-a")
    );
    const targetThreadId = phoneState.currentThreadId;
    const logAfterFirstSend = await readFakeLog();
    const createdThreadStartIndex = logAfterFirstSend.findIndex((entry) =>
      entry.type === "request" && entry.method === "thread/start" && entry.params?.ephemeral !== true
    );
    const firstTurnStartIndex = logAfterFirstSend.findIndex((entry) =>
      entry.type === "request" &&
      entry.method === "turn/start" &&
      entry.params?.threadId === targetThreadId &&
      entry.params?.input?.some((input) => input.type === "text" && input.text === firstPrompt)
    );
    assert(createdThreadStartIndex >= 0 && firstTurnStartIndex > createdThreadStartIndex, "新会话必须先创建线程再发送首条 turn");
    assert(
      !logAfterFirstSend.slice(createdThreadStartIndex + 1, firstTurnStartIndex).some((entry) => entry.type === "request" && entry.method === "thread/list"),
      "新会话首条 turn 不能等待 thread/list"
    );
    const resumeCountBeforeStateRequest = countRequestsForThread(logAfterFirstSend, "thread/resume", targetThreadId);
    sendPhone({ type: "state:request" });
    await delay(250);
    const logAfterStateRequest = await readFakeLog();
    assert(
      countRequestsForThread(logAfterStateRequest, "thread/resume", targetThreadId) === resumeCountBeforeStateRequest,
      "当前代理已加载的新运行线程不能重复 thread/resume"
    );
    assert(!phoneState.messages.some((message) => String(message.text || "").includes("刷新运行中会话失败")), "新运行线程不能显示刷新失败");
    await waitForPhoneState((state) =>
      state.currentThreadId === targetThreadId &&
      state.busy === true &&
      state.threads.some((thread) => thread.id === targetThreadId && thread.name === "修复手机端会话标题")
    );
    titleGenerationContext = { targetThreadId, firstPrompt, internalTitleStartsBeforeNew, clientPromptId };
  });

  await runStep("手机首条消息先提交主 turn 再并发生成并同步标题", async () => {
    assert(titleGenerationContext, "必须保留首条消息标题测试上下文");
    const { targetThreadId, firstPrompt, internalTitleStartsBeforeNew, clientPromptId } = titleGenerationContext;
    const log = await readFakeLog();
    const internalStarts = log.filter((entry) =>
      entry.type === "request" && entry.method === "thread/start" && entry.params?.ephemeral === true
    ).slice(internalTitleStartsBeforeNew);
    const titleTurns = log.filter((entry) =>
      entry.type === "request" && entry.method === "turn/start" && entry.params?.outputSchema
    );
    const internalStart = internalStarts[0];
    const titleTurn = titleTurns.at(-1);
    const createdThreadStartIndex = log.findIndex((entry) =>
      entry.type === "request" && entry.method === "thread/start" && entry.params?.ephemeral !== true
    );
    const internalStartIndex = log.findIndex((entry, index) =>
      index > createdThreadStartIndex && entry.type === "request" && entry.method === "thread/start" && entry.params?.ephemeral === true
    );
    const firstTurnStartIndex = log.findIndex((entry) =>
      entry.type === "request" &&
      entry.method === "turn/start" &&
      entry.params?.threadId === targetThreadId &&
      entry.params?.input?.some((input) => input.type === "text" && input.text === firstPrompt)
    );
    const nameSet = log.find((entry) =>
      entry.type === "request" && entry.method === "thread/name/set" && entry.params?.threadId === targetThreadId && entry.params?.name === "修复手机端会话标题"
    );
    assert(internalStarts.length === 1, "扩展标题流程只应启动一个临时标题线程");
    assert(internalStart?.params?.model === "gpt-5.4-mini", "标题模型必须与扩展一致");
    assert(internalStart?.params?.config?.model_reasoning_effort === "low", "标题推理强度必须为 low");
    assert(internalStartIndex > firstTurnStartIndex, "标题线程不能排在首条用户 turn 前形成队头阻塞");
    assert(!Object.prototype.hasOwnProperty.call(log[createdThreadStartIndex]?.params || {}, "serviceName"), "普通手机线程不能把扩展名称写成初始标题");
    assert(
      internalStart?.params?.threadSource === "system" &&
      internalStart?.params?.permissions === ":read-only" &&
      Array.isArray(internalStart?.params?.runtimeWorkspaceRoots) &&
      internalStart?.params?.experimentalRawEvents === false &&
      internalStart?.params?.dynamicTools === null &&
      internalStart?.params?.allowProviderModelFallback === true,
      "标题线程必须使用只读 system 临时线程参数"
    );
    assert(
      titleTurn?.params?.summary === "none" &&
      titleTurn?.params?.permissions === ":read-only" &&
      Array.isArray(titleTurn?.params?.runtimeWorkspaceRoots) &&
      titleTurn?.params?.collaborationMode === null &&
      titleTurn?.params?.outputSchema?.required?.includes("title") &&
      titleTurn?.params?.outputSchema?.required?.includes("description") &&
      titleTurn?.params?.outputSchema?.properties?.description,
      "标题 turn 必须使用扩展的只读结构化输出字段"
    );
    assert(String(titleTurn?.params?.input?.[0]?.text || "").includes(`User prompt:\n${firstPrompt}`), "标题 prompt 必须包含首条用户消息");
    assert(nameSet?.params?.name === "修复手机端会话标题", "结构化标题必须通过 thread/name/set 写入真实会话");
    assert(!phoneState.threads.some((thread) => String(thread.id).startsWith("internal-title-")), "临时标题线程不能出现在手机会话列表");
    const currentProxyState = await waitForProxyState((state) => state.currentThreadId === targetThreadId, 3000);
    assert(currentProxyState.currentThreadId === targetThreadId, "临时标题线程不能切走代理当前会话");
    await parentRequest(1226, "test/complete-phone-turn", { threadId: targetThreadId });
    await waitForPhoneState((state) => state.currentThreadId === targetThreadId && state.busy === false);
    const firstTurnStartEntry = log.find((entry) =>
      entry.type === "request" &&
      entry.method === "turn/start" &&
      entry.params?.threadId === targetThreadId &&
      entry.params?.input?.some((input) => input.type === "text" && input.text === firstPrompt)
    );
    const firstClientId = String(firstTurnStartEntry?.params?.clientUserMessageId || "");
    assert(firstClientId, "首条手机消息 turn/start 必须携带 clientUserMessageId");
    assert(firstClientId === clientPromptId, "手机端提供的 clientUserMessageId 必须原样贯通到 turn/start");
    await waitFor(() => parentLines.some((line) =>
      line.method === "item/completed" &&
      line.params?.item?.type === "userMessage" &&
      line.params.item.clientId === firstClientId
    ), 5000, "Trae turn/start userMessage lifecycle");
    const matchingParentEvents = parentLines.filter((line) =>
      ["item/started", "item/completed"].includes(line.method) &&
      line.params?.item?.type === "userMessage" &&
      line.params.item.clientId === firstClientId
    );
    assert(matchingParentEvents.filter((line) => line.method === "item/started").length === 1, "Trae 必须收到且只收到一次 turn/start userMessage item/started");
    assert(matchingParentEvents.filter((line) => line.method === "item/completed").length === 1, "Trae 必须收到且只收到一次 turn/start userMessage item/completed");
    const officialUser = phoneState.messages.find((m) =>
      m.role === "user" &&
      (String(m.meta?.clientUserMessageId || "") === firstClientId || String(m.meta?.clientId || "") === firstClientId)
    );
    assert(officialUser, "首条手机消息必须有官方实体");
    const snapshotTurnId = String(officialUser?.meta?.turnId || "");
    await parentRequest(1601, "test/emit-user-message-snapshot", {
      threadId: targetThreadId,
      turnId: snapshotTurnId,
      clientUserMessageId: firstClientId,
      text: firstPrompt
    });
    await waitFor(() => {
      const matches = phoneState.messages.filter((m) =>
        m.role === "user" &&
        (String(m.meta?.clientUserMessageId || "") === firstClientId || String(m.meta?.clientId || "") === firstClientId)
      );
      return matches.length === 1;
    }, 5000, "快照占位消息必须合并到 canonical 用户消息");
    const canonicalMatches = phoneState.messages.filter((m) =>
      m.role === "user" &&
      (String(m.meta?.clientUserMessageId || "") === firstClientId || String(m.meta?.clientId || "") === firstClientId)
    );
    assert(canonicalMatches.length === 1, "同 clientUserMessageId 只允许一条用户消息");
    assert(!String(canonicalMatches[0].id).startsWith("item-"), "快照占位 id 不能成为最终消息 id");
    assert(!phoneState.messages.some((m) => m.role === "user" && String(m.id).startsWith("item-")), "时间线不能出现 item-N 用户消息");
  });

  await runStep("标题模型超时后按扩展写入首条消息兜底且不切换模型", async () => {
    sendPhone({ type: "thread:new" });
    await waitForPhoneState((state) => state.currentThreadId === null && state.busy === false);
    const before = await readFakeLog();
    const internalStartsBefore = before.filter((entry) =>
      entry.type === "request" && entry.method === "thread/start" && entry.params?.ephemeral === true
    ).length;
    const prompt = "## 模拟标题生成超时兜底";
    const fallbackTitle = "模拟标题生成超时兜底";
    sendPhone({ type: "message:send", text: prompt, images: [] });
    await waitForPhoneState((state) =>
      String(state.currentThreadId || "").startsWith("phone-thread-") &&
      state.busy === true &&
      state.threads.some((thread) => thread.id === state.currentThreadId && thread.name === fallbackTitle)
    );
    const targetThreadId = phoneState.currentThreadId;
    const log = await readFakeLog();
    const internalStarts = log.filter((entry) =>
      entry.type === "request" && entry.method === "thread/start" && entry.params?.ephemeral === true
    ).slice(internalStartsBefore);
    const fallbackNameSet = await waitFor(async () => {
      const latestLog = await readFakeLog();
      return latestLog.find((entry) =>
        entry.type === "request" && entry.method === "thread/name/set" && entry.params?.threadId === targetThreadId && entry.params?.name === fallbackTitle
      ) || null;
    }, 5000, "标题摘要写入真实会话");
    assert(internalStarts.length === 1, "标题失败兜底不能再启动第二模型线程");
    assert(internalStarts[0]?.params?.model === "gpt-5.4-mini", "标题失败时仍只能使用扩展标题模型");
    assert(fallbackNameSet?.params?.name === fallbackTitle, "标题模型失败后必须写入扩展同款首条消息兜底");
    await parentRequest(1227, "test/complete-phone-turn", { threadId: targetThreadId });
    await waitForPhoneState((state) => state.currentThreadId === targetThreadId && state.busy === false);
  });

  await runStep("重复提交同一消息只启动一个 turn", async () => {
    await waitForPhoneState((state) => state.busy === false);
    sendPhone({ type: "thread:new" });
    await waitForPhoneState((state) => state.currentThreadId === null && state.busy === false);
    const requestId = "duplicate-message-request";
    const text = "同一次提交只能发送一次";
    const before = await readFakeLog();
    const startCountBefore = countRequests(before, "turn/start");
    const payload = { type: "message:send", requestId, text, images: [] };
    sendPhone(payload);
    sendPhone(payload);
    await waitForFakeRequestCount("turn/start", startCountBefore + 1);
    await waitForPhoneState((state) => String(state.currentThreadId || "").startsWith("phone-thread-"));
    const targetThreadId = phoneState.currentThreadId;
    await delay(250);
    const after = await readFakeLog();
    assert(after.filter((entry) => entry.type === "request" && entry.method === "turn/start" && entry.params?.threadId === targetThreadId).length === 1, "重复 requestId 不应再次启动 turn");
    assert(phoneState.messages.filter((message) => message.role === "user" && String(message.text || "") === text).length === 1, "重复 requestId 只应保留一条用户消息");
    await waitFor(() => phoneSendResults.some((result) => result.requestId === requestId && result.ok === true), 5000, "duplicate request success result");
  });

  await runStep("发送中断线后同一 requestId 重发且只启动一个 turn", async () => {
    const targetThreadId = phoneState.currentThreadId;
    await parentRequest(1225, "test/complete-phone-turn", { threadId: targetThreadId });
    await waitForPhoneState((state) => state.currentThreadId === targetThreadId && state.busy === false);
    const requestId = "reconnect-pending-message-request";
    const text = "断线重发只发送一次";
    const payload = { type: "message:send", requestId, text, images: [] };
    const before = await readFakeLog();
    const startCountBefore = countRequestsForThread(before, "turn/start", targetThreadId);
    sendPhone(payload);
    await waitForFakeRequestCountForThread("turn/start", targetThreadId, startCountBefore + 1);
    phone.close();
    await delay(80);
    phoneState = null;
    phone = await openPhone(await waitForBridgeUrl());
    await waitForPhoneState((state) => state.currentThreadId === targetThreadId);
    sendPhone(payload);
    await waitFor(() => phoneSendResults.some((result) => result.requestId === requestId && result.ok === true), 5000, "reconnected request success result");
    await delay(150);
    const after = await readFakeLog();
    assert(countRequestsForThread(after, "turn/start", targetThreadId) === startCountBefore + 1, "断线重发同一 requestId 不能重复启动 turn");
    assert(phoneState.messages.filter((message) => message.role === "user" && String(message.text || "") === text).length === 1, "断线重发后用户消息只能保留一条");
  });

  await runStep("三类手机审批可处理且原生请求留给 Trae", async () => {
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-a" &&
      state.approvals.length === 1 &&
      hasMessage((message) => message.role === "user" && String(message.text || "") === "请实现复杂同步测试")
    );
    await parentRequest(106, "test/second-approval");
    await waitFor(() => nativeTraeRequestIds.every((id) => parentLines.some((line) => line.id === id && line.method)), 5000, "native Trae requests");
    await waitForPhoneState((state) => state.currentThreadId === "thread-a" && state.approvals.length === 3);
    const commandApproval = phoneState.approvals.find((approval) => approval.method === "item/commandExecution/requestApproval");
    const fileApproval = phoneState.approvals.find((approval) => approval.method === "item/fileChange/requestApproval");
    const permissionsApproval = phoneState.approvals.find((approval) => approval.method === "item/permissions/requestApproval");
    assert(commandApproval && fileApproval && permissionsApproval, "三类当前版审批应同时保留");
    assert(phoneState.approvals.every((approval) => [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval"
    ].includes(approval.method)), "MCP、tool input、attestation 不能进入手机审批");
    let log = await readFakeLog();
    assert(!log.some((entry) => entry.type === "server-response" && nativeTraeRequestIds.includes(entry.id)), "手机不能抢答 Trae 原生 server request");
    sendPhone({ type: "approval:resolve", approvalId: commandApproval.id, decision: "accept" });
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-a" &&
      state.approvals.length === 2 &&
      !state.approvals.some((approval) => approval.method === "item/commandExecution/requestApproval")
    );
    sendPhone({ type: "approval:resolve", approvalId: fileApproval.id, decision: "decline" });
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-a" &&
      state.approvals.length === 1 &&
      state.approvals[0].method === "item/permissions/requestApproval"
    );
    sendPhone({ type: "approval:resolve", approvalId: permissionsApproval.id, decision: "acceptForSession" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a" && state.approvals.length === 0);
    log = await readFakeLog();
    assert(log.some((entry) => entry.type === "server-response" && entry.id === 9001 && entry.result?.decision === "accept"), "审批结果应回到真实 app-server 请求");
    assert(log.some((entry) => entry.type === "server-response" && entry.id === 9002 && entry.result?.decision === "decline"), "第二个审批结果应回到真实 app-server 请求");
    assert(log.some((entry) =>
      entry.type === "server-response" &&
      entry.id === 9003 &&
      entry.result?.scope === "session" &&
      entry.result?.permissions?.network?.enabled === true
    ), "permissions 审批必须返回当前版 permissions/scope");
    assert(!log.some((entry) => entry.type === "server-response" && nativeTraeRequestIds.includes(entry.id)), "手机审批结束后仍不能抢答原生请求");

    await waitFor(() => parentLines.some((line) =>
      line.method === "serverRequest/resolved" && line.params?.requestId === 9001
    ), 5000, "serverRequest/resolved 9001");
    sendParentResponse(9001, { decision: "decline" });
    await delay(200);
    log = await readFakeLog();
    assert(log.filter((entry) => entry.type === "server-response" && entry.id === 9001).length === 1, "resolved 后 Trae 的重复审批响应必须被代理丢弃");

    sendParentResponse(9101, { action: "decline", content: null, _meta: null });
    sendParentResponse(9102, { answers: {} });
    sendParentResponse(9103, { token: "fixture-attestation-token" });
    await waitFor(async () => {
      const currentLog = await readFakeLog();
      return nativeTraeRequestIds.every((id) => currentLog.some((entry) => entry.type === "server-response" && entry.id === id)) ? currentLog : null;
    }, 5000, "native Trae responses");
  });

  await runStep("电脑端其他会话活动不自动切走手机", async () => {
    const proxyBefore = await waitForProxyState((state) => state.currentThreadId === "thread-a" && state.busy === true && state.activeTurnId === "turn-a");
    await parentRequest(102, "test/pc-other-thread");
    await delay(300);
    assert(phoneState.currentThreadId === "thread-a", "电脑端其他会话不应改变手机当前会话");
    assert(!phoneState.messages.some((message) => messageThreadId(message) === "thread-b"), "其他会话消息不应混入手机当前时间线");
    const proxyAfter = await waitForProxyState((state) => Boolean(state.updatedAt));
    assert(proxyAfter.currentThreadId === proxyBefore.currentThreadId, "后台根线程通知不能覆盖代理 currentThreadId");
    assert(proxyAfter.busy === proxyBefore.busy && proxyAfter.activeTurnId === proxyBefore.activeTurnId, "后台根线程通知不能覆盖代理 busy/activeTurnId");
  });

  await runStep("两个运行中会话反复切换仍保持完整且隔离", async () => {
    sendPhone({ type: "thread:open", threadId: "thread-b" });
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-b" &&
      state.busy === true &&
      state.activeTurnId === "turn-b" &&
      state.messages.some((message) => String(message.text || "").includes("电脑端其他会话消息")) &&
      state.messages.some((message) => String(message.text || "").includes("这条消息不应出现在手机当前会话"))
    );
    await parentRequest(109, "test/thread-b-background-updates");
    await parentRequest(110, "test/old-delta");
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-b" &&
      state.messages.some((message) => String(message.text || "").includes("B 后台继续输出")) &&
      state.messages.some((message) => String(message.text || "").includes("B 后台推理内容")) &&
      state.messages.some((message) => String(message.text || "").includes("B 后台命令输出")) &&
      state.messages.some((message) => message.kind === "plan" && String(message.text || "").includes("保留 B 的完整消息")) &&
      state.messages.some((message) => message.kind === "turn_diff" && messageTurnId(message) === "turn-b") &&
      !state.messages.some((message) => String(message.text || "").includes("旧会话后台继续输出"))
    );

    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-a" &&
      state.busy === true &&
      state.activeTurnId === "turn-a" &&
      state.messages.some((message) => String(message.text || "").includes("旧会话后台继续输出")) &&
      !state.messages.some((message) => String(message.text || "").includes("B 后台继续输出"))
    );

    sendPhone({ type: "thread:open", threadId: "thread-b" });
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-b" &&
      state.messages.some((message) => String(message.text || "").includes("B 后台继续输出")) &&
      state.messages.filter((message) => String(message.text || "").includes("B 后台继续输出")).length === 1
    );
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-a" &&
      state.messages.filter((message) => String(message.text || "").includes("旧会话后台继续输出")).length === 1
    );
  });

  await runStep("相同正文的不同 itemId 在切换恢复后仍各自保留", async () => {
    const identicalText = "两条正文相同但 itemId 不同的合法回复";
    sendPhone({ type: "thread:open", threadId: "thread-b" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-b");
    await parentRequest(1200, "test/distinct-identical-items", {
      threadId: "thread-b",
      turnId: "turn-b",
      text: identicalText
    });
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-b" &&
      state.messages.filter((message) => String(message.text || "") === identicalText).length === 2
    );

    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a");
    const logBeforeResume = await readFakeLog();
    const resumeCountBefore = countRequests(logBeforeResume, "thread/resume");
    sendPhone({ type: "thread:open", threadId: "thread-b" });
    await waitForFakeRequestCount("thread/resume", resumeCountBefore + 1);
    await waitForPhoneState((state) => state.currentThreadId === "thread-b");
    await delay(180);
    assert(
      phoneState.messages.filter((message) => String(message.text || "") === identicalText).length === 2,
      "切换触发 snapshot merge 后不能按正文合并两个不同 itemId"
    );
    assert(hasMessage((message) => message.id === "identical-item-b-1"), "第一个相同正文 item 必须保留");
    assert(hasMessage((message) => message.id === "identical-item-b-2"), "第二个相同正文 item 必须保留");
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a");
  });

  await runStep("两个手机页面各自选择会话且互不拉回", async () => {
    const secondary = await openSecondaryPhone(await waitForBridgeUrl());
    try {
      await waitForSecondaryPhoneState(secondary, (state) => state.currentThreadId === "thread-a");
      sendPhone({ type: "thread:open", threadId: "thread-b" });
      await waitForPhoneState((state) =>
        state.currentThreadId === "thread-b" &&
        state.messages.some((message) => message.role === "user" && String(message.text || "") === "电脑端其他会话消息")
      );

      secondary.send({ type: "thread:open", threadId: "thread-a" });
      await waitForSecondaryPhoneState(secondary, (state) =>
        state.currentThreadId === "thread-a" &&
        state.messages.some((message) => message.role === "user" && String(message.text || "") === "请实现复杂同步测试")
      );
      await delay(180);
      assert(phoneState.currentThreadId === "thread-b", "客户端二选择 A 后不能把客户端一从 B 拉回 A");

      await parentRequest(1201, "test/live-item-after-read-snapshot", {
        threadId: "thread-b",
        turnId: "turn-b",
        itemId: "secondary-client-isolation-b",
        text: "只属于客户端一所选 B 的后台新消息"
      });
      await waitForPhoneState((state) =>
        state.currentThreadId === "thread-b" &&
        state.messages.some((message) => message.id === "secondary-client-isolation-b") &&
        state.messages.some((message) => message.role === "user" && String(message.text || "") === "电脑端其他会话消息")
      );
      await delay(180);
      assert(secondary.state.currentThreadId === "thread-a", "客户端二必须继续停留在 A");
      assert(phoneState.currentThreadId === "thread-b", "客户端一必须继续停留在 B");
      assert(!secondary.state.messages.some((message) => message.id === "secondary-client-isolation-b"), "B 的后台消息不能混入客户端二的 A");
    } finally {
      secondary.close();
    }
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a");
  });

  await runStep("延迟创建按客户端隔离且不影响其他客户端选择", async () => {
    const secondary = await openSecondaryPhone(await waitForBridgeUrl());
    const primaryCreatedThreadId = "thread-new-race-primary";
    const secondaryCreatedThreadId = "thread-new-race-secondary";
    const secondaryText = "客户端二只发送到自己的待创建会话";
    try {
      await waitForSecondaryPhoneState(secondary, (state) => state.currentThreadId === "thread-a");
      await parentRequest(1210, "test/set-thread-start-fixtures", {
        fixtures: {
          "test-race-primary": {
            delayMs: 900,
            threadId: primaryCreatedThreadId,
            name: "客户端一慢新建"
          },
          "test-race-secondary": {
            delayMs: 500,
            threadId: secondaryCreatedThreadId,
            name: "客户端二独立新建"
          }
        }
      });
      const logBeforeNew = await readFakeLog();
      const threadStartsBeforeNew = countRequests(logBeforeNew, "thread/start");

      const primaryRevisionBeforeNew = phoneState.threadRevision;
      sendPhone({ type: "thread:new", options: { model: "test-race-primary" } });
      await waitForPhoneState((state) =>
        state.currentThreadId === null && Number(state.threadRevision) > Number(primaryRevisionBeforeNew)
      );
      const secondaryRevisionBeforeNew = secondary.state.threadRevision;
      secondary.send({ type: "thread:new", options: { model: "test-race-secondary" } });
      await waitForSecondaryPhoneState(secondary, (state) =>
        state.currentThreadId === null && Number(state.threadRevision) > Number(secondaryRevisionBeforeNew)
      );
      const logAfterNew = await readFakeLog();
      assert(countRequests(logAfterNew, "thread/start") === threadStartsBeforeNew, "两个客户端只点击新会话都不能提前创建真实线程");
      secondary.send({ type: "message:send", text: secondaryText, images: [] });

      const primaryRevisionBeforeOpen = phoneState.threadRevision;
      const primaryOpenRequestId = "deferred-creation-primary-open-b";
      sendPhone({ type: "thread:open", requestId: primaryOpenRequestId, threadId: "thread-b" });
      await waitForPhoneState((state) =>
        state.currentThreadId === "thread-b" &&
        Number(state.threadRevision) > Number(primaryRevisionBeforeOpen) &&
      state.messages.some((message) => message.role === "user" && String(message.text || "") === "电脑端其他会话消息")
      );
      await waitFor(
        () => phoneThreadOperationResults.some((result) => result.requestId === primaryOpenRequestId && result.ok === true),
        5000,
        "primary thread B open result"
      );
      await waitForSecondaryPhoneState(secondary, (state) =>
        state.currentThreadId === secondaryCreatedThreadId &&
        state.messages.some((message) => message.role === "user" && String(message.text || "") === secondaryText)
      );

      const secondaryTurnStart = await waitFor(async () => {
        const log = await readFakeLog();
        return log.find((entry) =>
          entry.type === "request" &&
          entry.method === "turn/start" &&
          entry.params?.input?.some((input) => input.type === "text" && input.text === secondaryText)
        ) || null;
      }, 5000, "secondary pending creation turn/start");
      assert(secondaryTurnStart.params?.threadId === secondaryCreatedThreadId, "客户端二发送必须等待并绑定自己的创建 promise");
      const logAfterSecondarySend = await readFakeLog();
      const primaryThreadStart = logAfterSecondarySend.find((entry) =>
        entry.type === "request" &&
        entry.method === "thread/start" &&
        entry.params?.model === "test-race-primary" &&
        entry.params?.ephemeral !== true
      );
      assert(!primaryThreadStart, "客户端一未发送时不能创建真实线程");
      assert(phoneState.currentThreadId === "thread-b", "客户端一打开 B 后必须保持在 B");
      assert(secondary.state.currentThreadId === secondaryCreatedThreadId, "客户端二首次发送只绑定自己的延迟创建线程");
      assert(secondary.state.currentThreadId !== primaryCreatedThreadId, "两个客户端的待创建参数不能串线");

      await parentRequest(1211, "test/complete-phone-turn", { threadId: secondaryCreatedThreadId });
      await waitForSecondaryPhoneState(secondary, (state) =>
        state.currentThreadId === secondaryCreatedThreadId && state.busy === false
      );
    } finally {
      secondary.close();
    }
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a");
  });

  await runStep("旧 hydration 同文用户消息不能误删刚发送的本地消息", async () => {
    const threadId = "thread-same-text-history";
    const text = "完全相同的重复问题";
    await parentRequest(1212, "test/create-same-text-history", { threadId, text });
    await parentRequest(1213, "test/set-resume-delays", { delays: { [threadId]: [550] } });
    const before = await readFakeLog();
    const resumeCountBefore = countRequestsForThread(before, "thread/resume", threadId);

    sendPhone({ type: "thread:open", threadId });
    await waitForPhoneState((state) => state.currentThreadId === threadId);
    await waitForFakeRequestCountForThread("thread/resume", threadId, resumeCountBefore + 1);
    sendPhone({ type: "message:send", text, images: [] });
    const newMessageState = await waitForPhoneState((state) =>
      state.currentThreadId === threadId &&
      state.messages.find((message) => message.role === "user" && message.id !== "user-same-text-old" && String(message.text || "") === text)
    );
    const localMessageId = newMessageState.messages.find((message) =>
      message.role === "user" && message.id !== "user-same-text-old" && String(message.text || "") === text
    )?.id;
    assert(localMessageId, "新发送的同文 user 必须进入当前会话");

    await waitForPhoneState((state) =>
      state.currentThreadId === threadId &&
      state.messages.some((message) => message.id === "user-same-text-old") &&
      state.messages.some((message) => message.id === localMessageId)
    );
    await delay(180);
    assert(countMessages((message) => message.role === "user" && String(message.text || "") === text) === 2, "旧快照与新发送的同文消息都必须保留");
    assert(hasMessage((message) => message.id === localMessageId), "旧 hydration 不能按正文误删新 local user");
    const latestLocalMessage = phoneState.messages.find((message) => message.id === localMessageId);
    assert(messageTurnId(latestLocalMessage) !== "turn-same-text-old", "新 local user 必须属于新 turn");

    await parentRequest(1214, "test/complete-phone-turn", { threadId });
    await waitForPhoneState((state) => state.currentThreadId === threadId && state.busy === false);
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a");
  });

  await runStep("过期 active 和 idle 状态都由权威会话列表修正", async () => {
    let log = await readFakeLog();
    let listCountBefore = countRequests(log, "thread/list");
    await parentRequest(1215, "test/stale-active-canonical-idle");
    sendPhone({ type: "threads:refresh" });
    await waitForFakeRequestCount("thread/list", listCountBefore + 1);
    await waitForPhoneState((state) =>
      state.threads.some((thread) => thread.id === "thread-canonical-idle" && thread.status === "idle")
    );

    log = await readFakeLog();
    listCountBefore = countRequests(log, "thread/list");
    await parentRequest(1216, "test/stale-idle-canonical-active");
    sendPhone({ type: "threads:refresh" });
    await waitForFakeRequestCount("thread/list", listCountBefore + 1);
    await waitForPhoneState((state) =>
      state.threads.some((thread) => thread.id === "thread-canonical-active" && thread.status === "running")
    );
    await delay(220);
    const canonicalActive = phoneState.threads.find((thread) => thread.id === "thread-canonical-active");
    assert(canonicalActive?.status === "running", "过期 idle 不能结束权威列表仍标为 active 的会话");
    await parentRequest(1217, "test/complete-phone-turn", { threadId: "thread-canonical-active" });
    await waitForPhoneState((state) =>
      state.threads.some((thread) => thread.id === "thread-canonical-active" && thread.status === "idle")
    );
  });

  await runStep("明确运行中的 turn 不被短暂 idle 列表清除", async () => {
    const threadId = "thread-running-list-stale-idle";
    const turnId = "turn-running-list-stale-idle";
    await parentRequest(1219, "test/running-turn-list-stale-idle");
    await waitForPhoneState((state) =>
      state.threads.some((thread) => thread.id === threadId && thread.status === "running")
    );
    await delay(140);
    const runningThread = phoneState.threads.find((thread) => thread.id === threadId);
    assert(runningThread?.status === "running", "短暂 idle 列表不能清除已有明确 turnId 的运行态");
    sendPhone({ type: "thread:open", threadId });
    await waitForPhoneState((state) =>
      state.currentThreadId === threadId && state.busy === true && state.activeTurnId === turnId
    );
    await parentRequest(1221, "test/complete-phone-turn", { threadId });
    await waitForPhoneState((state) => state.currentThreadId === threadId && state.busy === false);
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a");
  });

  await runStep("快照与实时消息按 clientId/精确助手别名合并且旧 diff 顺序稳定", async () => {
    const threadId = "thread-snapshot-alias";
    const oldTurnId = "turn-snapshot-alias-old";
    const newerTurnId = "turn-snapshot-alias-newer";
    await parentRequest(1222, "test/create-snapshot-alias-thread");
    sendPhone({ type: "thread:open", threadId });
    await waitForPhoneState((state) => snapshotAliasStateReady(state, {
      threadId,
      oldTurnId,
      newerTurnId,
      userClientId: "snapshot-alias-user-client",
      assistantId: "item-901"
    }));
    const snapshotUserId = phoneState.messages.find((message) =>
      messageTurnId(message) === oldTurnId &&
      message.role === "user" &&
      String(message.meta?.clientUserMessageId || message.meta?.clientId || "") === "snapshot-alias-user-client"
    )?.id;
    assertSnapshotAliasStructure(phoneState, {
      oldTurnId,
      newerTurnId,
      userId: snapshotUserId,
      assistantId: "item-901",
      stage: "首次打开"
    });

    await parentRequest(1223, "test/emit-snapshot-alias-live-items");
    await waitForPhoneState((state) => snapshotAliasStateReady(state, {
      threadId,
      oldTurnId,
      newerTurnId,
      userId: snapshotUserId,
      assistantId: "canonical-alias-assistant"
    }));
    assertSnapshotAliasStructure(phoneState, {
      oldTurnId,
      newerTurnId,
      userId: snapshotUserId,
      assistantId: "canonical-alias-assistant",
      stage: "正式 ID 替换后"
    });
    assert(!hasMessage((message) => message.id === "item-900" || message.id === "item-901"), "正式 ID 到达后必须移除快照占位副本");

    const refreshLog = await readFakeLog();
    const resumeCountBeforeRefresh = countRequestsForThread(refreshLog, "thread/resume", threadId);
    sendPhone({ type: "thread:open", threadId, requestId: "snapshot-alias-refresh" });
    await waitForFakeRequestCountForThread("thread/resume", threadId, resumeCountBeforeRefresh + 1);
    await waitFor(() => phoneThreadOperationResults.some((result) =>
      result.requestId === "snapshot-alias-refresh" && result.ok === true
    ), 5000, "snapshot alias refresh result");
    await waitForPhoneState((state) => snapshotAliasStateReady(state, {
        threadId,
        oldTurnId,
        newerTurnId,
        userId: snapshotUserId,
        assistantId: "canonical-alias-assistant"
      }));
    assertSnapshotAliasStructure(phoneState, {
      oldTurnId,
      newerTurnId,
      userId: snapshotUserId,
      assistantId: "canonical-alias-assistant",
      stage: "刷新后"
    });

    phone.close();
    await delay(120);
    phoneState = null;
    phone = await openPhone(await waitForBridgeUrl());
    await waitForPhoneState((state) => snapshotAliasStateReady(state, {
      threadId,
      oldTurnId,
      newerTurnId,
      userId: snapshotUserId,
      assistantId: "canonical-alias-assistant"
    }));
    assertSnapshotAliasStructure(phoneState, {
      oldTurnId,
      newerTurnId,
      userId: snapshotUserId,
      assistantId: "canonical-alias-assistant",
      stage: "WebSocket 重连后"
    });

    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a");
    sendPhone({ type: "thread:open", threadId });
    await waitForPhoneState((state) => snapshotAliasStateReady(state, {
      threadId,
      oldTurnId,
      newerTurnId,
      userId: snapshotUserId,
      assistantId: "canonical-alias-assistant"
    }));
    assertSnapshotAliasStructure(phoneState, {
      oldTurnId,
      newerTurnId,
      userId: snapshotUserId,
      assistantId: "canonical-alias-assistant",
      stage: "A-B-A 切回后"
    });
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a");
  });

  await runStep("UUIDv7 整秒 resume 保持三轮问答和完成态 diff 顺序", async () => {
    const fixture = (await parentRequest(12990, "test/create-uuidv7-resume-order-thread", {
      threadId: "thread-uuidv7-resume-order"
    })).result;
    assert(fixture.turns?.length === 3, "UUIDv7 顺序回归必须创建三轮完整历史");
    for (const turn of fixture.turns) {
      assert(Number.isInteger(turn.startedAt), "回归前提要求 startedAt 为整秒整数");
      assert(uuidV7TimestampMs(turn.turnId) === turn.uuidTimestampMs, "回归 turnId 必须是可解析的 UUIDv7");
      assert(turn.uuidTimestampMs === (turn.startedAt * 1000) + 900, "UUIDv7 必须稳定保留 startedAt 秒内 900ms 差值");
    }

    const beforeFirstOpen = await readFakeLog();
    const firstResumeCount = countRequestsForThread(beforeFirstOpen, "thread/resume", fixture.threadId);
    sendPhone({ type: "thread:open", threadId: fixture.threadId, requestId: "uuidv7-order-first-open" });
    await waitForFakeRequestCountForThread("thread/resume", fixture.threadId, firstResumeCount + 1);
    await waitForPhoneState((state) => uuidV7ResumeOrderStateReady(state, fixture));
    assertUuidV7ResumeOrder(phoneState, fixture, "首次打开");

    const beforeReopen = await readFakeLog();
    const reopenResumeCount = countRequestsForThread(beforeReopen, "thread/resume", fixture.threadId);
    sendPhone({ type: "thread:open", threadId: fixture.threadId, requestId: "uuidv7-order-reopen" });
    await waitForFakeRequestCountForThread("thread/resume", fixture.threadId, reopenResumeCount + 1);
    await waitFor(() => phoneThreadOperationResults.some((result) =>
      result.requestId === "uuidv7-order-reopen" && result.ok === true
    ), 5000, "UUIDv7 order reopen result");
    await waitForPhoneState((state) => uuidV7ResumeOrderStateReady(state, fixture));
    assertUuidV7ResumeOrder(phoneState, fixture, "再次 resume 后");

    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a");
  });

  await runStep("完整快照后紧凑子序列刷新与重连保持同一 turn 因果顺序", async () => {
    const fixture = (await parentRequest(12992, "test/create-subsequence-order-thread", {
      threadId: "thread-subsequence-order",
      turnId: "turn-subsequence-order"
    })).result;
    const beforeFirstOpen = await readFakeLog();
    const firstResumeCount = countRequestsForThread(beforeFirstOpen, "thread/resume", fixture.threadId);
    sendPhone({ type: "thread:open", threadId: fixture.threadId, requestId: "subsequence-order-first-open" });
    await waitForFakeRequestCountForThread("thread/resume", fixture.threadId, firstResumeCount + 1);
    await waitForPhoneState((state) => subsequenceOrderStateReady(state, fixture));
    assertSubsequenceOrder(phoneState, fixture, "完整快照首次打开");
    assertNoSnapshotOrderMetadata(phoneState, "完整快照首次打开");

    await parentRequest(12993, "test/use-compact-subsequence-snapshot", { threadId: fixture.threadId });
    const beforeCompactRefresh = await readFakeLog();
    const compactReadCount = countRequestsForThread(beforeCompactRefresh, "thread/read", fixture.threadId);
    sendPhone({ type: "threads:refresh", requestId: "subsequence-order-compact-refresh" });
    await waitForFakeRequestCountForThread("thread/read", fixture.threadId, compactReadCount + 1, 10_000);
    await waitFor(() => phoneThreadOperationResults.some((result) =>
      result.requestId === "subsequence-order-compact-refresh" && result.ok === true
    ), 15_000, "compact subsequence refresh result");
    await waitForPhoneState((state) => subsequenceOrderStateReady(state, fixture), 15_000);
    assertSubsequenceOrder(phoneState, fixture, "紧凑子序列刷新后");
    assertNoSnapshotOrderMetadata(phoneState, "紧凑子序列刷新后");

    phone.close();
    await delay(120);
    phoneState = null;
    phone = await openPhone(await waitForBridgeUrl());
    await waitForPhoneState((state) => subsequenceOrderStateReady(state, fixture), 15_000);
    assertSubsequenceOrder(phoneState, fixture, "WebSocket 重连后");
    assertNoSnapshotOrderMetadata(phoneState, "WebSocket 重连后");

    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a");
  });

  await runStep("父端旧 thread/read 晚到不能清掉切回会话的实时事件", async () => {
    sendPhone({ type: "thread:open", threadId: "thread-b" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-b");
    const before = await readFakeLog();
    const readCountBefore = countRequests(before, "thread/read");
    sendParentRequest(1202, "thread/read", {
      threadId: "thread-a",
      testResponseDelayMs: 650
    });
    await waitForFakeRequestCount("thread/read", readCountBefore + 1);

    await parentRequest(1203, "test/live-item-after-read-snapshot", {
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "read-race-live-item-a",
      text: "旧 thread/read 快照之后到达的实时消息"
    });
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-a" &&
      state.messages.some((message) => message.id === "read-race-live-item-a")
    );
    await waitForParentResponse(1202);
    await delay(220);
    assert(phoneState.currentThreadId === "thread-a", "旧 read 回包不能改变手机最后选择的会话");
    assert(hasMessage((message) => message.id === "read-race-live-item-a"), "旧 read 快照不能清掉请求后收到的实时 item");
  });

  await runStep("旧 turn/completed 晚到不能结束同线程的新 turn", async () => {
    await parentRequest(1204, "test/stale-turn-completed");
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-a" &&
      state.threads.some((thread) => thread.id === "thread-stale-completion")
    );
    await delay(180);
    const raceThread = phoneState.threads.find((thread) => thread.id === "thread-stale-completion");
    assert(raceThread?.status === "running", "旧 turn 的 completed 不能把仍有新 turn 的线程标成 idle");
  });

  await runStep("快速切换的乱序响应不能覆盖最后选择", async () => {
    const revisionBeforeRace = Number(phoneState.threadRevision || 0);
    await parentRequest(111, "test/set-resume-delays", {
      delays: {
        "thread-b": [350],
        "thread-a": [20]
      }
    });
    sendPhone({ type: "thread:open", threadId: "thread-b" });
    await delay(20);
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-a" &&
      Number(state.threadRevision || 0) >= revisionBeforeRace + 2 &&
      state.messages.some((message) => String(message.text || "").includes("旧会话后台继续输出"))
    );
    await delay(450);
    assert(phoneState.currentThreadId === "thread-a", "较慢的 B resume 响应不能把最后选择从 A 改回 B");
    assert(!phoneState.messages.some((message) => String(message.text || "").includes("B 后台继续输出")), "乱序响应不能把 B 消息混入 A");
  });

  await runStep("后台会话完成后切回可见完整最终状态", async () => {
    phone.close();
    phone = null;
    phoneState = null;
    await delay(120);
    await parentRequest(112, "test/complete-thread-b");
    await waitFor(async () => {
      const stored = JSON.parse(await fs.readFile(path.join(phoneStateDir, "state.json"), "utf8").catch(() => "{}")).unreadThreads || [];
      return stored.includes("thread-b");
    }, 5000, "persisted unread thread-b");
    phone = await openPhone(await waitForBridgeUrl());
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-a" &&
      state.threads.some((thread) => thread.id === "thread-b" && thread.unread === true)
    );
    sendPhone({ type: "thread:open", threadId: "thread-b" });
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-b" &&
      currentThread()?.unread === false &&
      state.busy === false &&
      state.activeTurnId === null &&
      state.messages.some((message) => String(message.text || "").includes("B 会话已在后台完整结束")) &&
      state.messages.some((message) => String(message.text || "").includes("B 后台继续输出")) &&
      state.messages.filter((message) => isCompletedTurnDiffCard(message) && messageTurnId(message) === "turn-b").length === 1 &&
      !state.messages.some((message) => isAboveComposerTurnDiff(message) && messageTurnId(message) === "turn-b")
    );
    await waitFor(async () => {
      const stored = JSON.parse(await fs.readFile(path.join(phoneStateDir, "state.json"), "utf8").catch(() => "{}")).unreadThreads || [];
      return !stored.includes("thread-b");
    }, 5000, "cleared unread thread-b");
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a" && state.busy === true);
  });

  await runStep("切换后旧页面请求按身份严格拒绝", async () => {
    const text = "切换到 B 后立即发送的消息";
    const before = await readFakeLog();
    const startCountBefore = countRequests(before, "turn/start");
    sendPhone({ type: "thread:open", threadId: "thread-b" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-b");
    const staleRequestId = "stale-page-thread-request";
    // 模拟旧页面还携带切换前的 threadId；服务端必须拒绝，而不是替它猜测目标。
    sendPhone({ type: "message:send", requestId: staleRequestId, threadId: "thread-a", text, images: [] });
    await waitFor(() => phoneSendResults.find((result) => result.requestId === staleRequestId && result.ok === false && result.code === "stale_thread") || null, 5000, "stale page request rejection");
    await delay(120);
    const after = await readFakeLog();
    assert(countRequests(after, "turn/start") === startCountBefore, "过期会话身份不能启动新 turn");
    assert(!phoneState.messages.some((message) => String(message.text || "") === text), "被拒绝的过期消息不能污染任何会话");

    await parentRequest(1218, "test/complete-phone-turn", { threadId: "thread-b" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-b" && state.busy === false);
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a" && state.busy === true);
  });

  await runStep("停止后完成态 diff 和处理时长回到时间线", async () => {
    sendPhone({ type: "turn:interrupt" });
    await parentRequest(105, "test/complete");
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-a" &&
      state.busy === false &&
      countMessages((message) => message.kind === "plan" && messageTurnId(message) === "turn-a") === 0 &&
      countMessages((message) => message.kind === "file" && messageTurnId(message) === "turn-a") === 1 &&
      countMessages((message) => isCompletedTurnDiffCard(message) && messageTurnId(message) === "turn-a") === 1 &&
      state.turnTimings.some((timing) => timing.threadId === "thread-a" && timing.turnId === "turn-a") &&
      hasMessage((message) => message.id === "assistant-final-a")
    );
    const messages = phoneState.messages;
    const commandIndex = messages.findIndex((message) => message.id === "cmd-a");
    const fileChangeIndex = messages.findIndex((message) => message.id === "file-a");
    const cardIndex = messages.findIndex((message) => isCompletedTurnDiffCard(message) && messageTurnId(message) === "turn-a");
    const midAssistantIndex = messages.findIndex((message) => message.id === "assistant-mid-a");
    const finalIndex = messages.findIndex((message) => message.id === "assistant-final-a");
    assert(commandIndex >= 0 && midAssistantIndex > commandIndex && finalIndex > midAssistantIndex, "中间过程回复和最终回复顺序应稳定");
    assert(fileChangeIndex >= 0, "对话流 diff 应使用 fileChange 原消息");
    assert(fileChangeIndex > commandIndex && fileChangeIndex < midAssistantIndex, "对话流 diff 应按拓展 fileChange 原始位置出现在过程流里");
    assert(fileChangeIndex !== cardIndex, "对话流 diff 和完成态 diff 卡片应是独立消息");
    assert(cardIndex > finalIndex, "完成态 diff 卡片应跟在同 turn 最终助手回复之后");
    const timing = phoneState.turnTimings.find((entry) => entry.threadId === "thread-a" && entry.turnId === "turn-a");
    const completedTurn = parentLines.find((line) => line.method === "turn/completed" && line.params?.turn?.id === "turn-a")?.params?.turn;
    assert(completedTurn, "Trae stdout 必须收到当前版完整 turn/completed");
    assert(timing.startedAt > 1e12 && timing.completedAt > 1e12, "当前版秒级 Turn 时间戳必须归一化为手机毫秒时间戳");
    assert(timing.completedAt > timing.startedAt, "turnTimings 完成时间必须晚于开始时间");
    assert(timing.startedAt === completedTurn.startedAt * 1000, "turnTimings.startedAt 必须来自当前版 turn.startedAt");
    assert(timing.completedAt === completedTurn.completedAt * 1000, "turnTimings.completedAt 必须来自当前版 turn.completedAt");
    assert(Math.abs((timing.completedAt - timing.startedAt) - completedTurn.durationMs) < 1000, "turnTimings 必须与当前版 turn.durationMs 一致");
    phone.close();
    await delay(120);
    phone = await openPhone(await waitForBridgeUrl());
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-a" &&
      state.busy === false &&
      countMessages((message) => message.kind === "plan" && messageTurnId(message) === "turn-a") === 0 &&
      countMessages((message) => message.kind === "file" && messageTurnId(message) === "turn-a") === 1 &&
      countMessages((message) => isCompletedTurnDiffCard(message) && messageTurnId(message) === "turn-a") === 1
    );
    const refreshedMessages = phoneState.messages;
    const refreshedCommandIndex = refreshedMessages.findIndex((message) => message.id === "cmd-a");
    const refreshedFileChangeIndex = refreshedMessages.findIndex((message) => message.id === "file-a");
    const refreshedMidAssistantIndex = refreshedMessages.findIndex((message) => message.id === "assistant-mid-a");
    const refreshedFinalIndex = refreshedMessages.findIndex((message) => message.id === "assistant-final-a");
    const refreshedCardIndex = refreshedMessages.findIndex((message) => isCompletedTurnDiffCard(message) && messageTurnId(message) === "turn-a");
    assert(refreshedCommandIndex >= 0 && refreshedMidAssistantIndex > refreshedCommandIndex && refreshedFinalIndex > refreshedMidAssistantIndex, "刷新后中间过程和最终回复顺序应稳定");
    assert(refreshedFileChangeIndex > refreshedCommandIndex && refreshedFileChangeIndex < refreshedMidAssistantIndex, "刷新后对话流 diff 仍应按 fileChange 原始位置展示");
    assert(refreshedCardIndex > refreshedFinalIndex, "刷新后完成态 diff 卡片仍应跟在最终助手回复之后");
  });

  await runStep("电脑端 revert 后修改重发只保留新消息", async () => {
    const fixture = (await parentRequest(1230, "test/create-edit-history", {
      threadId: "thread-edit-desktop",
      oldText: "电脑端修改前文字"
    })).result;
    sendPhone({ type: "thread:open", threadId: fixture.threadId });
    await waitForPhoneState((state) =>
      state.currentThreadId === fixture.threadId &&
      state.busy === false &&
      state.messages.some((message) => message.id === fixture.editMessageId && messageImages(message).length === 1)
    );
    const hydratedImage = phoneState.messages.find((message) => message.id === fixture.editMessageId)?.meta?.images?.[0];
    assert(hydratedImage && !String(hydratedImage.url || "").startsWith("data:image/"), "手机状态不能携带 Base64 图片正文");
    assert(String(hydratedImage?.url || "").includes("/local-image?"), "历史图片必须通过桥的本地图片 URL 提供");
    assert(!JSON.stringify(phoneState.messages.find((message) => message.id === fixture.editMessageId) || {}).includes("data:image/"), "手机消息元数据不能藏入 Base64 图片正文");

    await parentRequest(1231, "thread/revert", { threadId: fixture.threadId, beforeTurnId: fixture.editTurnId });
    const editedText = "电脑端修改后的唯一文字";
    await parentRequest(1232, "turn/start", {
      threadId: fixture.threadId,
      clientUserMessageId: "desktop-edit-regression",
      input: [{ type: "text", text: editedText, text_elements: [] }]
    });
    await waitForPhoneState((state) =>
      state.currentThreadId === fixture.threadId &&
      state.messages.some((message) => message.role === "user" && String(message.text || "") === editedText)
    );
    assert(countMessages((message) => message.role === "user" && String(message.text || "") === fixture.oldText) === 0, "电脑端编辑后不能保留修改前消息");
    assert(!phoneState.messages.some((message) => messageTurnId(message) === fixture.editTurnId), "revert 的旧 turn 普通消息、计划和 diff 必须全部消失");
    assert(!phoneState.messages.some((message) => messageImages(message).some((image) => String(image.name || "") === "old-image.png")), "电脑端编辑后原图片必须消失");
    assert(countMessages((message) => message.role === "user" && String(message.text || "") === editedText) === 1, "电脑端编辑后的文字只能出现一次");
    await parentRequest(1233, "test/complete-phone-turn", { threadId: fixture.threadId });
    await waitForPhoneState((state) => state.currentThreadId === fixture.threadId && state.busy === false);
  });

  await runStep("手机编辑只 revert 一次且丢弃原图片", async () => {
    const fixture = (await parentRequest(1234, "test/create-edit-history", {
      threadId: "thread-edit-phone",
      oldText: "手机端修改前文字"
    })).result;
    sendPhone({ type: "thread:open", threadId: fixture.threadId });
    await waitForPhoneState((state) =>
      state.currentThreadId === fixture.threadId &&
      state.busy === false &&
      state.messages.some((message) => message.id === fixture.editMessageId)
    );
    const before = await readFakeLog();
    const requestId = "phone-edit-idempotent-request";
    const editedText = "手机端修改后的唯一文字";
    const payload = {
      type: "message:edit",
      requestId,
      threadId: fixture.threadId,
      threadRevision: phoneState.threadRevision,
      // 扩展按 turnId 编辑，不因服务器回填后的 messageId 变化而拒绝新文字。
      messageId: `${fixture.editMessageId}-stale-after-hydration`,
      turnId: fixture.editTurnId,
      text: editedText,
      images: []
    };
    sendPhone(payload);
    sendPhone(payload);
    await waitFor(() => phoneEditResults.some((result) => result.requestId === requestId && result.ok), 10_000, "phone edit result");
    await waitForPhoneState((state) =>
      state.currentThreadId === fixture.threadId &&
      state.messages.some((message) => message.role === "user" && String(message.text || "") === editedText)
    );
    const after = await readFakeLog();
    const newRequests = after.slice(before.length).filter((entry) => entry.type === "request" && entry.params?.threadId === fixture.threadId);
    const reverts = newRequests.filter((entry) => entry.method === "thread/revert");
    const starts = newRequests.filter((entry) => entry.method === "turn/start" && entry.params?.input?.some((input) => input?.text === editedText));
    assert(reverts.length === 1 && reverts[0].params?.beforeTurnId === fixture.editTurnId, "同一手机编辑 requestId 必须只 revert 目标轮一次");
    assert(starts.length === 1, "同一手机编辑 requestId 必须只启动一个新 turn");
    assert(starts[0].params.input.length === 1 && starts[0].params.input[0].type === "text", "手机编辑重发只能携带修改后的文字，不能保留图片");
    assert(!phoneState.messages.some((message) => String(message.text || "") === fixture.oldText), "手机编辑后不能保留修改前文字");
    assert(!phoneState.messages.some((message) => messageTurnId(message) === fixture.editTurnId), "手机编辑后旧 turn 的计划、diff 和回复必须消失");
    assert(!phoneState.messages.some((message) => messageImages(message).length), "手机编辑后的新消息不能携带旧图片");
    assert(countMessages((message) => message.role === "user" && String(message.text || "") === editedText) === 1, "手机编辑后的文字只能出现一次");
    await parentRequest(1235, "test/complete-phone-turn", { threadId: fixture.threadId });
    await waitForPhoneState((state) => state.currentThreadId === fixture.threadId && state.busy === false);
  });

  await runStep("手机编辑 revert 后发送失败可重试且不二次 revert", async () => {
    const fixture = (await parentRequest(1236, "test/create-edit-history", {
      threadId: "thread-edit-retry",
      oldText: "编辑重试前文字"
    })).result;
    sendPhone({ type: "thread:open", threadId: fixture.threadId });
    await waitForPhoneState((state) =>
      state.currentThreadId === fixture.threadId &&
      state.busy === false &&
      state.messages.some((message) => message.id === fixture.editMessageId)
    );
    const before = await readFakeLog();
    const requestId = "phone-edit-retry-after-rollback";
    const payload = {
      type: "message:edit",
      requestId,
      threadId: fixture.threadId,
      threadRevision: phoneState.threadRevision,
      messageId: fixture.editMessageId,
      turnId: fixture.editTurnId,
      text: "编辑首发失败后重试",
      images: []
    };
    sendPhone(payload);
    await waitFor(() => phoneEditResults.some((result) =>
      result.requestId === requestId && result.ok === false && result.message.includes("模拟编辑回滚后的首次发送失败")
    ), 10_000, "first edit failure result");
    sendPhone(payload);
    await waitFor(() => phoneEditResults.some((result) => result.requestId === requestId && result.ok), 10_000, "retried edit result");
    const requests = (await readFakeLog()).slice(before.length).filter((entry) => entry.type === "request" && entry.params?.threadId === fixture.threadId);
    assert(requests.filter((entry) => entry.method === "thread/revert").length === 1, "编辑重试不能再次 revert");
    assert(requests.filter((entry) => entry.method === "turn/start" && entry.params?.input?.some((input) => input?.text === payload.text)).length === 2, "首次 turn/start 失败后应使用同一编辑事务重试一次");
    await waitForPhoneState((state) => state.messages.some((message) => message.role === "user" && message.text === payload.text));
    await parentRequest(1237, "test/complete-phone-turn", { threadId: fixture.threadId });
    await waitForPhoneState((state) => state.currentThreadId === fixture.threadId && state.busy === false);
  });

  await runStep("图片发送失败不留下重复本地图文", async () => {
    sendPhone({ type: "thread:new" });
    await waitForPhoneState((state) => state.currentThreadId === null && state.busy === false);
    const image = {
      name: "fail.png",
      type: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
    };
    const requestId = "failed-image-message-request";
    sendPhone({ type: "message:send", requestId, text: "失败图片发送", images: [image] });
    await waitFor(() => phoneSendResults.some((result) =>
      result.requestId === requestId && result.ok === false && result.message.includes("模拟电脑端停止后发送失败")
    ), 5000, "image send failure result");
    await waitForPhoneState((state) =>
      state.messages.filter((message) => message.role === "user" && String(message.text || "").includes("失败图片发送")).length === 0
    );
  });

  await runStep("手机新会话只发图片时 Trae 可显示且保留预览元数据", async () => {
    sendPhone({ type: "thread:new" });
    await waitForPhoneState((state) => state.currentThreadId === null && state.busy === false);
    const uploadsBeforeImageSend = new Set(await fs.readdir(path.join(phoneStateDir, "uploads")));
    const image = {
      name: "complex.png",
      type: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
    };
    const startCountBefore = countRequests(await readFakeLog(), "turn/start");
    sendPhone({ type: "message:send", text: "", images: [image] });
    await waitForPhoneState((state) =>
      state.busy === true &&
      state.messages.filter((message) => message.role === "user" && messageImages(message).length === 1).length === 1
    );
    const uploaded = (await fs.readdir(path.join(phoneStateDir, "uploads")))
      .filter((name) => !uploadsBeforeImageSend.has(name));
    assert(uploaded.length === 1, "图片应写入隔离上传目录");
    const uploadedPath = path.join(phoneStateDir, "uploads", uploaded[0]);
    const outsidePath = path.join(phoneStateDir, "outside.png");
    await fs.writeFile(outsidePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"));
    try {
      const uploadedStatus = await fetchStatus(`${await waitForBridgeUrl()}/local-image?token=${encodeURIComponent(token)}&path=${encodeURIComponent(uploadedPath)}`);
      const outsideStatus = await fetchStatus(`${await waitForBridgeUrl()}/local-image?token=${encodeURIComponent(token)}&path=${encodeURIComponent(outsidePath)}`);
      assert(uploadedStatus === 200, "上传目录内图片应允许手机读取");
      assert(outsideStatus === 404, "上传目录外图片必须拒绝手机读取");
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
    const phoneThreadId = phoneState.currentThreadId;
    const startRequest = await waitFor(async () => {
      const log = await readFakeLog();
      return log.find((entry) =>
        entry.type === "request" &&
        entry.method === "turn/start" &&
        entry.params?.threadId === phoneThreadId &&
        entry.params?.input?.some((input) => input?.type === "localImage")
      );
    }, 5000, "image-only phone turn/start");
    assert(countRequests(await readFakeLog(), "turn/start") >= startCountBefore + 1, "纯图片发送必须启动 turn");
    assert(startRequest.params?.input?.length === 2, "纯图片 turn/start 应包含空 text 和一张图片");
    assert(startRequest.params.input[0]?.type === "text" && startRequest.params.input[0]?.text === "", "纯图片消息必须先补空 text，供 Trae 渲染用户消息");
    assert(startRequest.params.input[1]?.type === "localImage" && startRequest.params.input[1]?.path === uploadedPath, "纯图片消息必须保留实际 localImage 输入");
    await parentRequest(107, "test/complete-phone-turn", { threadId: phoneThreadId });
    await waitForPhoneState((state) =>
      state.currentThreadId === phoneThreadId &&
      state.busy === false &&
      state.messages.filter((message) => message.role === "user" && String(message.text || "") === "" && messageImages(message).length === 1).length === 1
    );
    const imageMessages = phoneState.messages.filter((message) => message.role === "user" && String(message.text || "") === "" && messageImages(message).length === 1);
    assert(imageMessages.length === 1, "完成后历史回填不应重复纯图片用户消息");
    assert(messageImages(imageMessages[0]).length === 1, "去重后应保留一张图片预览");
  });

  await runStep("控制响应不污染 Trae stdout", async () => {
    const leakedControlResponse = parentLines.some((line) =>
      Number(line.id) < 0 ||
      ([9001, 9002, 9003].includes(line.id) && (Object.prototype.hasOwnProperty.call(line, "result") || Object.prototype.hasOwnProperty.call(line, "error")))
    );
    assert(!leakedControlResponse, "control 响应不能进入 Trae stdout");
    const currentProxyState = await waitForProxyState((state) => Boolean(state.updatedAt), 1000);
    assert(currentProxyState.controlUrl === proxyState.controlUrl, "代理 control 地址应保持稳定");
  });

  await runStep("首次只下发最近消息且可按需加载更早历史", async () => {
    const threadId = phoneState.currentThreadId;
    paginationThreadId = threadId;
    await parentRequest(108, "test/many-messages", { threadId });
    await waitForPhoneState((state) =>
      state.sync?.omittedMessages > 0 &&
      state.messages.length <= 200 &&
      hasMessage((message) => message.id === "bulk-message-299") &&
      !hasMessage((message) => message.id === "bulk-message-0")
    );
    const omittedBefore = phoneState.sync.omittedMessages;
    sendPhone({ type: "messages:more" });
    await waitForPhoneState((state) =>
      state.sync?.omittedMessages < omittedBefore &&
      hasMessage((message) => message.id === "bulk-message-0")
    );
    await parentRequest(1205, "test/background-message-burst", {
      threadId,
      turnId: "pagination-growth-turn",
      count: 100,
      idPrefix: "pagination-growth-message",
      textPrefix: "加载更早后的后台新增消息"
    });
    await waitForPhoneState((state) =>
      state.currentThreadId === threadId &&
      state.messages.some((message) => message.id === "pagination-growth-message-99")
    );
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a");
    sendPhone({ type: "thread:open", threadId });
    await waitForPhoneState((state) =>
      state.currentThreadId === threadId &&
      state.messages.some((message) => message.id === "pagination-growth-message-99")
    );
    await delay(180);
    assert(phoneState.sync?.omittedMessages === 0, "后台新增消息后不能重新折叠已经加载的历史窗口");
    assert(hasMessage((message) => message.id === "bulk-message-0"), "后台新增消息后切回仍必须保留已经加载的最早历史");
    assert(hasMessage((message) => message.id === "bulk-message-299"), "切回后必须保留原批量历史末条");
    assert(hasMessage((message) => message.id === "pagination-growth-message-99"), "切回后必须保留后台新增消息末条");
  });

  await runStep("延迟 hydration 期间加载更早后锚点不退回", async () => {
    assert(paginationThreadId, "分页竞态测试缺少目标会话");
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a");
    const secondary = await openSecondaryPhone(await waitForBridgeUrl());
    try {
      await waitForSecondaryPhoneState(secondary, (state) => state.currentThreadId === "thread-a");
      await parentRequest(1219, "test/set-resume-delays", { delays: { [paginationThreadId]: [650] } });
      const before = await readFakeLog();
      const resumeCountBefore = countRequestsForThread(before, "thread/resume", paginationThreadId);

      secondary.send({ type: "thread:open", threadId: paginationThreadId });
      await waitForSecondaryPhoneState(secondary, (state) =>
        state.currentThreadId === paginationThreadId &&
        state.sync?.omittedMessages > 0 &&
        state.messages.length <= 200
      );
      await waitForFakeRequestCountForThread("thread/resume", paginationThreadId, resumeCountBefore + 1);
      const omittedBeforeMore = secondary.state.sync.omittedMessages;
      const revisionAtMore = secondary.state.threadRevision;
      secondary.send({
        type: "messages:more",
        threadId: paginationThreadId,
        threadRevision: revisionAtMore
      });
      await waitForSecondaryPhoneState(secondary, (state) =>
        state.currentThreadId === paginationThreadId &&
        state.sync?.omittedMessages < omittedBeforeMore
      );
      const omittedAfterMore = secondary.state.sync.omittedMessages;
      const loadedAnchorId = secondary.state.messages[0]?.id;
      assert(loadedAnchorId, "加载更早后必须产生可验证的首条锚点消息");

      await delay(750);
      assert(secondary.state.currentThreadId === paginationThreadId, "延迟 resume 回包不能切走当前会话");
      assert(secondary.state.sync?.omittedMessages <= omittedAfterMore, "延迟 hydration 完成后已展开的历史窗口不能退回");
      assert(secondary.state.messages.some((message) => message.id === loadedAnchorId), "延迟 hydration 完成后必须保留加载更早时的锚点");
    } finally {
      secondary.close();
    }
  });

  await runStep("长会话刷新重连及 A-B-A 后计划和 diff 不消失", async () => {
    const threadId = "thread-window-pressure";
    const turnId = "turn-window-pressure";
    const latestItemId = "window-pressure-item-249";
    await parentRequest(1220, "test/create-running-window-pressure", {
      threadId,
      turnId,
      count: 250
    });

    sendPhone({ type: "thread:open", threadId });
    await waitForPhoneState((state) => windowPressureStateReady(state, { threadId, turnId, latestItemId }));
    assert(phoneState.sync?.omittedMessages > 0, "长会话必须实际越过手机默认消息窗口");
    assertWindowPressureStructure(phoneState, { threadId, turnId, latestItemId, stage: "首次打开" });

    let log = await readFakeLog();
    const resumeCountBeforeRefresh = countRequestsForThread(log, "thread/resume", threadId);
    const listCountBeforeRefresh = countRequests(log, "thread/list");
    sendPhone({ type: "state:request" });
    sendPhone({ type: "threads:refresh" });
    await waitForFakeRequestCountForThread("thread/resume", threadId, resumeCountBeforeRefresh + 1);
    await waitForFakeRequestCount("thread/list", listCountBeforeRefresh + 1);
    await waitForPhoneState((state) => windowPressureStateReady(state, { threadId, turnId, latestItemId }));
    assertWindowPressureStructure(phoneState, { threadId, turnId, latestItemId, stage: "刷新后" });

    phone.close();
    await delay(120);
    phoneState = null;
    phone = await openPhone(await waitForBridgeUrl());
    await waitForPhoneState((state) => windowPressureStateReady(state, { threadId, turnId, latestItemId }));
    assertWindowPressureStructure(phoneState, { threadId, turnId, latestItemId, stage: "WebSocket 重连后" });

    sendPhone({ type: "thread:open", threadId: "thread-b" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-b");
    sendPhone({ type: "thread:open", threadId });
    await waitForPhoneState((state) => windowPressureStateReady(state, { threadId, turnId, latestItemId }));
    assertWindowPressureStructure(phoneState, { threadId, turnId, latestItemId, stage: "A-B-A 切回后" });
  });

  await runStep("新连接仅靠 running resume 快照恢复计划和 live diff", async () => {
    const threadId = "thread-snapshot-only";
    const turnId = "turn-snapshot-only";
    await parentRequest(1221, "test/create-running-snapshot-only", { threadId, turnId });

    phone.close();
    await delay(120);
    phoneState = null;
    phone = await openPhone(await waitForBridgeUrl());
    await waitForPhoneState((state) => state.currentThreadId === "thread-window-pressure");
    assert(!phoneState.messages.some((message) => messageThreadId(message) === threadId), "新连接选择快照会话前不能预先混入其结构消息");

    const before = await readFakeLog();
    const resumeCountBefore = countRequestsForThread(before, "thread/resume", threadId);
    sendPhone({ type: "thread:open", threadId });
    await waitForFakeRequestCountForThread("thread/resume", threadId, resumeCountBefore + 1);
    await waitForPhoneState((state) =>
      state.currentThreadId === threadId &&
      state.busy === true &&
      state.activeTurnId === turnId &&
      state.messages.some((message) => message.kind === "plan" && messageTurnId(message) === turnId) &&
      state.messages.some((message) => message.id === "file-snapshot-only") &&
      state.messages.some((message) => isAboveComposerTurnDiff(message) && messageTurnId(message) === turnId)
    );

    const plans = phoneState.messages.filter((message) => message.kind === "plan" && messageTurnId(message) === turnId);
    const liveDiffs = phoneState.messages.filter((message) => isAboveComposerTurnDiff(message) && messageTurnId(message) === turnId);
    assert(plans.length === 1, "resume 快照必须恰好恢复一个结构化计划");
    assert(liveDiffs.length === 1, "resume 快照必须恰好从 fileChange 合成一个 live diff");
    assert(plans[0].meta?.plan?.[0]?.status === "completed" && plans[0].meta?.plan?.[1]?.status === "in_progress", "resume 快照必须保留计划步骤状态");
    assert(liveDiffs[0].meta?.source === "fileChange" && liveDiffs[0].streaming === true, "快照合成 diff 必须保持 fileChange 来源和运行态");
    const change = fileChangesForMessage(liveDiffs[0]).find((entry) => entry.path === "src/snapshot-only.js");
    assert(change?.added === 2 && change?.deleted === 1, "快照合成 live diff 必须保留准确文件统计");
  });

  await runStep("独立 initialTurnsPage 在完成后继续补齐更早 turn", async () => {
    const threadId = "thread-paginated-history";
    const turnId = "turn-paginated-running";
    await parentRequest(1223, "test/create-paginated-history", { threadId, turnId });
    const before = await readFakeLog();
    const listBefore = countRequestsForThread(before, "thread/turns/list", threadId);
    sendPhone({ type: "thread:open", threadId });
    await waitForPhoneState((state) =>
      state.currentThreadId === threadId &&
      state.busy === true &&
      state.activeTurnId === turnId &&
      state.messages.some((message) => message.id === "paged-running-user") &&
      !state.messages.some((message) => message.id === "paged-old-assistant")
    );
    const runningLog = await readFakeLog();
    assert(countRequestsForThread(runningLog, "thread/turns/list", threadId) === listBefore, "运行中的独立 initialTurnsPage 不应提前请求旧分页");

    await parentRequest(1224, "test/complete-paginated-history", { threadId });
    await waitForFakeRequestCountForThread("thread/turns/list", threadId, listBefore + 1, 10_000);
    await waitForPhoneState((state) =>
      state.currentThreadId === threadId &&
      state.busy === false &&
      state.messages.some((message) => message.id === "paged-old-assistant") &&
      !state.messages.some((message) => message.kind === "plan" && messageTurnId(message) === "turn-paginated-old") &&
      state.messages.some((message) => isCompletedTurnDiffCard(message) && messageTurnId(message) === "turn-paginated-old")
    , 15_000);
  });

  await runStep("手机桥重启后保留手机选中的会话", async () => {
    sendPhone({ type: "thread:open", threadId: "thread-b" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-b" && state.busy === false);

    await parentRequest(12990, "thread/resume", { threadId: "thread-a" });
    await waitForProxyState((state) => state.currentThreadId === "thread-a", 10_000);
    await delay(220);
    assert(phoneState.currentThreadId === "thread-b", "桌面切到 A 时手机必须继续停在 B");

    const selectionFile = path.join(phoneStateDir, "state.json");
    await waitFor(async () => {
      try {
        const saved = JSON.parse(await fs.readFile(selectionFile, "utf8"));
        return saved.selection?.threadId === "thread-b" ? saved : null;
      } catch {
        return null;
      }
    }, 5000, "persisted phone selection");

    phone.close();
    phone = null;
    phoneState = null;
    await stopBridge();
    await startBridge();
    phone = await openPhone(await waitForBridgeUrl());
    await waitForPhoneState((state) =>
      state.codex.status === "connected" &&
      state.currentThreadId === "thread-b" &&
      state.messages.some((message) => messageThreadId(message) === "thread-b")
    , 15_000);
    const proxyAfterBridgeRestart = await waitForProxyState((state) => state.currentThreadId === "thread-a", 5000);
    assert(proxyAfterBridgeRestart.currentThreadId === "thread-a", "回归前提要求桌面当前会话仍是 A");
    assert(phoneState.currentThreadId === "thread-b", "桥重启后手机必须自动恢复 B，不能跟随桌面切到 A");

    sendPhone({ type: "thread:open", threadId: "thread-paginated-history" });
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-paginated-history" &&
      state.busy === false &&
      state.messages.some((message) => message.id === "paged-old-assistant") &&
      !state.messages.some((message) => message.kind === "plan")
    , 15_000);
  });

  await runStep("手机桥重启后不从磁盘复活派生计划和 live diff", async () => {
    const threadId = "thread-persisted-only";
    const turnId = "turn-persisted-only";
    await parentRequest(1222, "test/create-running-persisted-only", { threadId, turnId });
    sendPhone({ type: "thread:open", threadId });
    await waitForPhoneState((state) =>
      state.currentThreadId === threadId &&
      state.busy === true &&
      state.activeTurnId === turnId &&
      state.messages.some((message) => message.kind === "plan" && messageTurnId(message) === turnId) &&
      state.messages.some((message) => isAboveComposerTurnDiff(message) && messageTurnId(message) === turnId)
    );

    await delay(120);
    let structuralPersistenceExists = false;
    try {
      await fs.access(path.join(phoneStateDir, "structural-messages.json"));
      structuralPersistenceExists = true;
    } catch {}
    assert(!structuralPersistenceExists, "运行中 plan/live diff 不能写入派生结构文件");

    phone.close();
    phone = null;
    phoneState = null;
    await stopBridge();
    await startBridge();
    phone = await openPhone(await waitForBridgeUrl());
    await waitForPhoneState((state) => state.codex.status === "connected", 15_000);
    sendPhone({ type: "thread:open", threadId });
    await waitForPhoneState((state) =>
      state.currentThreadId === threadId &&
      state.busy === true &&
      state.activeTurnId === turnId &&
      state.messages.some((message) => message.role === "user" && messageThreadId(message) === threadId) &&
      state.messages.some((message) => message.kind === "plan" && messageTurnId(message) === turnId) &&
      state.messages.some((message) => isAboveComposerTurnDiff(message) && messageTurnId(message) === turnId)
    , 15_000);
    const plans = phoneState.messages.filter((message) => message.kind === "plan" && messageTurnId(message) === turnId);
    const liveDiffs = phoneState.messages.filter((message) => isAboveComposerTurnDiff(message) && messageTurnId(message) === turnId);
    assert(plans.length === 1, "桥重启后实时事件只能形成一个当前计划");
    assert(liveDiffs.length === 1, "桥重启后实时事件只能形成一个当前 live diff");
  });

  await runStep("桥重启后不完整快照仍保持过程、最终回复和 diff 顺序", async () => {
    const fixture = (await parentRequest(12991, "test/create-incomplete-order-thread", {
      threadId: "thread-incomplete-order",
      turnId: "turn-incomplete-order"
    })).result;
    sendPhone({ type: "thread:open", threadId: fixture.threadId });
    await waitForPhoneState((state) => incompleteOrderStateReady(state, fixture), 15_000);
    assertIncompleteOrder(phoneState, fixture, "首次打开");

    const beforeRefresh = await readFakeLog();
    const readCountBeforeRefresh = countRequestsForThread(beforeRefresh, "thread/read", fixture.threadId);
    sendPhone({ type: "threads:refresh", requestId: "incomplete-order-refresh" });
    await waitForFakeRequestCountForThread("thread/read", fixture.threadId, readCountBeforeRefresh + 1, 10_000);
    await waitForPhoneState((state) => incompleteOrderStateReady(state, fixture), 15_000);
    assertIncompleteOrder(phoneState, fixture, "不重启桥刷新后");

    sendPhone({ type: "phone:background", seq: 91001 });
    sendPhone({ type: "phone:foreground", seq: 91002 });
    await waitForPhoneState((state) => incompleteOrderStateReady(state, fixture), 15_000);
    assertIncompleteOrder(phoneState, fixture, "后台切回后");

    try {
      await fs.access(path.join(phoneStateDir, "structural-messages.json"));
      assert(false, "完成后的 plan 不能写入派生结构文件");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    phone.close();
    phone = null;
    phoneState = null;
    await stopBridge();
    await startBridge();
    phone = await openPhone(await waitForBridgeUrl());
    sendPhone({ type: "thread:open", threadId: fixture.threadId });
    await waitForPhoneState((state) => incompleteOrderStateReady(state, fixture), 15_000);
    assertIncompleteOrder(phoneState, fixture, "手机桥重启后");
  });

  await runStep("Trae 重启后无需点击会话即可从手机发送", async () => {
    sendPhone({ type: "thread:open", threadId: "thread-a" });
    await waitForPhoneState((state) => state.currentThreadId === "thread-a" && state.busy === false);
    const previousProxyState = await waitForProxyState((state) => Boolean(state.pid));
    await stopProxy();
    await startProxy({ initialThreadIdle: true, requireResumeBeforeTurn: true });
    const nextProxyState = await waitForProxyState((state) => state.pid && state.pid !== previousProxyState.pid, 15_000);
    await waitForPhoneState((state) =>
      state.codex.status === "connected" && state.codex.info?.proxyPid === nextProxyState.pid
    , 15_000);

    const before = await readFakeLog();
    const startCountBefore = countRequestsForThread(before, "turn/start", "thread-a");
    const text = "Trae 重启后手机直接发送";
    sendPhone({ type: "message:send", text, images: [] });
    const log = await waitForFakeRequestCountForThread("turn/start", "thread-a", startCountBefore + 1, 10_000);
    const restartRequests = log.filter((entry) => entry.type === "request" && entry.at >= Number(nextProxyState.startedAt ? Date.parse(nextProxyState.startedAt) : 0));
    const resumeIndex = restartRequests.findIndex((entry) => entry.method === "thread/resume" && entry.params?.threadId === "thread-a");
    const startIndex = restartRequests.findIndex((entry) => entry.method === "turn/start" && entry.params?.threadId === "thread-a");
    assert(resumeIndex >= 0 && startIndex > resumeIndex, "thread/resume 必须发生在 turn/start 之前");
    await waitForPhoneState((state) =>
      state.currentThreadId === "thread-a" &&
      state.messages.some((message) => message.role === "user" && message.text === text)
    );
    assert(!phoneErrors.some((message) => /thread not found/i.test(message)), "手机发送不应再收到 thread not found");
  });

  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  phone?.close();
  if (bridge && !bridge.killed) bridge.kill("SIGKILL");
  if (proxy && !proxy.killed) proxy.kill("SIGKILL");
}

async function startProxy(options = {}) {
  proxy = spawn(proxyExe, ["app-server"], {
    cwd: workDir,
    env: {
      ...process.env,
      ...fakeEnv(fakeSource),
      CODEX_PROXY_REPO_ROOT: root,
      CODEX_PROXY_REGISTRY: proxyStateFile,
      CODEX_PHONE_AUTO_START: "0",
      CODEX_PROXY_LOG: proxyLogFile,
      FAKE_SCENARIO_LOG: fakeLogFile,
      FAKE_INITIAL_THREAD_IDLE: options.initialThreadIdle ? "1" : "0",
      FAKE_REQUIRE_RESUME_BEFORE_TURN: options.requireResumeBeforeTurn ? "1" : "0"
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  proxyOutput = readline.createInterface({ input: proxy.stdout, crlfDelay: Infinity });
  proxyOutput.on("line", (line) => {
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
  proxy.on("exit", (code, signal) => {
    if (code !== null && code !== 0) console.error(`proxy exited code=${code} signal=${signal || ""}`);
  });
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
      CODEX_PHONE_TITLE_TIMEOUT_MS: "500",
      CODEX_PHONE_RELAY_DISABLED: "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  bridge.port = port;
  bridge.stdout.on("data", () => {});
  bridge.stderr.on("data", (chunk) => process.stderr.write(chunk));
  bridge.on("exit", (code, signal) => {
    if (code !== null && code !== 0) console.error(`bridge exited code=${code} signal=${signal || ""}`);
  });
}

async function waitForBridgeUrl() {
  const url = `http://127.0.0.1:${bridge.port}`;
  await waitFor(async () => {
    const state = await fetchJson(`${url}/api/health?token=${encodeURIComponent(token)}`).catch(() => null);
    return state?.codex?.status === "connected" ? state : null;
  }, 15_000, "bridge connected");
  return url;
}

async function openPhone(baseUrl) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws?token=${encodeURIComponent(token)}&streamProtocol=1`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("phone websocket open timeout")), 5000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on("error", reject);
  });
  ws.on("message", (data) => {
    const payload = JSON.parse(data.toString("utf8"));
    if (payload.type === "stream:append") applyStreamAppendToClient(ws, () => phoneState, (next) => { phoneState = next; }, payload);
    if (payload.type === "stream:complete") applyStreamCompleteToClient(() => phoneState, (next) => { phoneState = next; }, payload);
    if (payload.type === "state" && (!phoneState || Number(payload.state?.threadRevision || 0) >= Number(phoneState.threadRevision || 0))) phoneState = payload.state;
    if (payload.type === "state:patch" && (!phoneState || payload.patch?.threadRevision === undefined || Number(payload.patch.threadRevision) >= Number(phoneState.threadRevision || 0))) applyStatePatch(payload.patch);
    if (payload.type === "message:send:result") phoneSendResults.push(payload);
    if (payload.type === "message:edit:result") phoneEditResults.push(payload);
    if (["thread:new:result", "thread:open:result", "threads:refresh:result"].includes(payload.type)) phoneThreadOperationResults.push(payload);
    if (payload.type === "error") phoneErrors.push(payload.message);
  });
  return ws;
}

async function stopProxy() {
  if (!proxy || proxy.killed) return;
  const exiting = new Promise((resolve) => proxy.once("exit", resolve));
  proxy.kill("SIGKILL");
  await exiting;
  // Retain isolated evidence under tests/build; no recursive deletion.
  proxy = null;
}

async function openSecondaryPhone(baseUrl) {
  const client = {
    ws: new WebSocket(`ws://127.0.0.1:${bridge.port}/ws?token=${encodeURIComponent(token)}&streamProtocol=1`),
    state: null,
    errors: []
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("secondary phone websocket open timeout")), 5000);
    client.ws.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
    client.ws.on("error", reject);
  });
  client.ws.on("message", (data) => {
    const payload = JSON.parse(data.toString("utf8"));
    if (payload.type === "stream:append") applyStreamAppendToClient(client.ws, () => client.state, (next) => { client.state = next; }, payload);
    if (payload.type === "stream:complete") applyStreamCompleteToClient(() => client.state, (next) => { client.state = next; }, payload);
    if (payload.type === "state" && (!client.state || Number(payload.state?.threadRevision || 0) >= Number(client.state.threadRevision || 0))) client.state = payload.state;
    if (payload.type === "state:patch" && (!client.state || payload.patch?.threadRevision === undefined || Number(payload.patch.threadRevision) >= Number(client.state.threadRevision || 0))) client.state = applyStatePatchTo(client.state, payload.patch);
    if (payload.type === "error") client.errors.push(payload.message);
  });
  client.send = (payload) => {
    const next = { ...payload };
    if (["message:send", "message:edit", "settings:update"].includes(next.type)) {
      if (!Object.prototype.hasOwnProperty.call(next, "threadId")) next.threadId = client.state?.currentThreadId || "";
      if (!Object.prototype.hasOwnProperty.call(next, "threadRevision")) next.threadRevision = Number(client.state?.threadRevision || 0);
    }
    client.ws.send(JSON.stringify(next));
  };
  client.close = () => client.ws.close();
  client.send({ type: "state:request" });
  return client;
}

function sendPhone(payload) {
  const next = { ...payload };
  if (["message:send", "message:edit", "settings:update"].includes(next.type)) {
    if (!Object.prototype.hasOwnProperty.call(next, "threadId")) {
      next.threadId = phoneState?.currentThreadId || "";
    }
    if (!Object.prototype.hasOwnProperty.call(next, "threadRevision")) {
      next.threadRevision = Number(phoneState?.threadRevision || 0);
    }
  }
  phone.send(JSON.stringify(next));
}

function applyStatePatch(patch = {}) {
  phoneState = applyStatePatchTo(phoneState, patch);
}

function applyStatePatchTo(state, patch = {}) {
  if (!state) return state;
  const previousThreadId = state.currentThreadId || "";
  for (const [key, value] of Object.entries(patch)) {
    if (key !== "messages") state[key] = value;
  }
  const nextThreadId = state.currentThreadId || "";
  const threadChanged = previousThreadId !== nextThreadId;
  if (patch.messages) {
    const existing = threadChanged ? new Map() : new Map((state.messages || []).map((message) => [message.id, message]));
    for (const message of patch.messages.items || []) existing.set(message.id, message);
    state.messages = (patch.messages.ids || (state.messages || []).map((message) => message.id))
      .map((id) => existing.get(id))
      .filter(Boolean);
  } else if (threadChanged) {
    state.messages = [];
  }
  return state;
}

function applyStreamAppendToClient(ws, getState, setState, payload) {
  const state = getState();
  if (!state || String(state.currentThreadId || "") !== String(payload.threadId || "")) return;
  const messages = Array.isArray(state.messages) ? state.messages.slice() : [];
  let index = messages.findIndex((message) => message.id === payload.messageId);
  if (index < 0 && Number(payload.offset) === 0 && payload.message) {
    const afterIndex = payload.afterId ? messages.findIndex((message) => message.id === payload.afterId) : -1;
    const beforeIndex = payload.beforeId ? messages.findIndex((message) => message.id === payload.beforeId) : -1;
    index = beforeIndex >= 0 ? beforeIndex : afterIndex >= 0 ? afterIndex + 1 : messages.length;
    messages.splice(index, 0, { ...payload.message, text: "", streaming: true });
  }
  const previous = messages[index];
  const previousText = String(previous?.text || "");
  if (!previous || previousText.length !== Number(payload.offset)) return;
  const text = `${previousText}${String(payload.delta || "")}`;
  messages[index] = { ...previous, text, streaming: true };
  setState({ ...state, messages });
  ws.send(JSON.stringify({ type: "stream:ack", messageId: payload.messageId, frameId: payload.frameId, offset: text.length, ok: true }));
}

function applyStreamCompleteToClient(getState, setState, payload) {
  const state = getState();
  if (!state || String(state.currentThreadId || "") !== String(payload.threadId || "")) return;
  const messages = (state.messages || []).map((message) => message.id === payload.messageId
    ? { ...message, ...(payload.message || {}), text: message.text, streaming: false, meta: { ...(message.meta || {}), ...(payload.message?.meta || {}) } }
    : message);
  setState({ ...state, messages });
}

async function parentRequest(id, method, params = {}) {
  sendParentRequest(id, method, params);
  return waitFor(() => parentLines.find((line) => line.id === id), 5000, method);
}

function sendParentRequest(id, method, params = {}) {
  proxy.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
}

function waitForParentResponse(id, timeoutMs = 5000) {
  return waitFor(() => parentLines.find((line) => line.id === id), timeoutMs, `parent response ${id}`);
}

function sendParentResponse(id, result) {
  proxy.stdin.write(`${JSON.stringify({ id, result })}\n`);
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

async function waitForPhoneState(predicate, timeoutMs = 8000) {
  return waitFor(() => phoneState && predicate(phoneState) ? phoneState : null, timeoutMs, () => `phone state ${phoneStateSummary()}`);
}

async function waitForSecondaryPhoneState(client, predicate, timeoutMs = 8000) {
  return waitFor(
    () => client.state && predicate(client.state) ? client.state : null,
    timeoutMs,
    () => `secondary phone state ${secondaryPhoneStateSummary(client.state)} errors=${JSON.stringify(client.errors)} primary=${phoneStateSummary()} primaryErrors=${JSON.stringify(phoneErrors)}`
  );
}

async function waitForFakeRequest(method, timeoutMs = 5000) {
  return waitFor(async () => {
    const log = await readFakeLog();
    return log.find((entry) => entry.type === "request" && entry.method === method) || null;
  }, timeoutMs, method);
}

async function waitForFakeRequestCount(method, expectedCount, timeoutMs = 5000) {
  return waitFor(async () => {
    const log = await readFakeLog();
    return countRequests(log, method) >= expectedCount ? log : null;
  }, timeoutMs, `${method} count ${expectedCount}`);
}

async function waitForFakeRequestCountForThread(method, threadId, expectedCount, timeoutMs = 5000) {
  return waitFor(async () => {
    const log = await readFakeLog();
    return countRequestsForThread(log, method, threadId) >= expectedCount ? log : null;
  }, timeoutMs, `${method} ${threadId} count ${expectedCount}`);
}

async function readFakeLog() {
  try {
    const text = await fs.readFile(fakeLogFile, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function countRequests(log, method) {
  return log.filter((entry) => entry.type === "request" && entry.method === method).length;
}

function countRequestsForThread(log, method, threadId) {
  return log.filter((entry) =>
    entry.type === "request" &&
    entry.method === method &&
    entry.params?.threadId === threadId
  ).length;
}

function hasMessage(predicate) {
  return Boolean(phoneState?.messages?.some(predicate));
}

function countMessages(predicate) {
  return (phoneState?.messages || []).filter(predicate).length;
}

function countTextInMessages(text) {
  return (phoneState?.messages || []).reduce((total, message) => {
    return total + countSubstring(String(message.text || ""), text);
  }, 0);
}

function countSubstring(value, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index < value.length) {
    const foundAt = value.indexOf(needle, index);
    if (foundAt < 0) break;
    count++;
    index = foundAt + needle.length;
  }
  return count;
}

function fileChangesForMessage(message) {
  const rawChanges = Array.isArray(message?.meta?.changes) ? message.meta.changes : [];
  return rawChanges.map((change) => {
    const stats = numericDiffStats(change) || diffStats(change?.diff);
    return {
      path: String(change?.path || "").replace(/\\/g, "/"),
      added: stats.added,
      deleted: stats.deleted
    };
  });
}

async function stopBridge() {
  const runningBridge = bridge;
  if (!runningBridge || runningBridge.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    runningBridge.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    runningBridge.kill("SIGKILL");
  });
}

function numericDiffStats(change) {
  const added = Number(change?.added);
  const deleted = Number(change?.deleted);
  if (!Number.isFinite(added) || !Number.isFinite(deleted)) return null;
  return { added: Math.max(0, added), deleted: Math.max(0, deleted) };
}

function diffStats(diff) {
  let added = 0;
  let deleted = 0;
  for (const line of String(diff || "").split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) deleted += 1;
  }
  return { added, deleted };
}

function currentAboveComposerTurnDiffCandidate(state) {
  const messages = state?.messages || [];
  const activeTurnId = String(state?.activeTurnId || "");
  if (state?.busy && activeTurnId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (isAboveComposerTurnDiff(message) && messageTurnId(message) === activeTurnId && fileChangesForMessage(message).length) return message;
    }
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isAboveComposerTurnDiff(message) && fileChangesForMessage(message).length) return message;
    if (message.role === "user") return null;
  }
  return null;
}

function isTimelineRowsTurnDiff(message) {
  if (message?.kind !== "turn_diff") return false;
  if (message?.meta?.display === "timeline_rows" || message?.display === "timeline_rows") return true;
  return String(message?.id || "").endsWith(":turn-diff-rows");
}

function isAboveComposerTurnDiff(message) {
  return Boolean(message?.kind === "turn_diff" && (message?.meta?.display === "above_composer" || message?.display === "above_composer"));
}

function isCompletedTurnDiffCard(message) {
  if (message?.kind !== "turn_diff") return false;
  if (message?.meta?.display === "completed_card" || message?.display === "completed_card") return true;
  return !isTimelineRowsTurnDiff(message) && !isAboveComposerTurnDiff(message);
}

function messageTurnId(message) {
  return String(message?.meta?.turnId || "");
}

function messageThreadId(message) {
  return String(message?.meta?.threadId || "");
}

function uuidV7TimestampMs(value) {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(String(value || ""));
  return match ? Number.parseInt(`${match[1]}${match[2]}`, 16) : 0;
}

function messageImages(message) {
  const images = message?.meta?.images || [];
  return Array.isArray(images) ? images : [];
}

function windowPressureStateReady(state, { threadId, turnId, latestItemId }) {
  return Boolean(
    state?.currentThreadId === threadId &&
    state?.busy === true &&
    state?.activeTurnId === turnId &&
    state?.sync?.omittedMessages > 0 &&
    state?.messages?.some((message) => message.id === latestItemId) &&
    state.messages.some((message) => message.kind === "plan" && messageTurnId(message) === turnId) &&
    state.messages.some((message) => isAboveComposerTurnDiff(message) && messageTurnId(message) === turnId)
  );
}

function assertWindowPressureStructure(state, { threadId, turnId, latestItemId, stage }) {
  const plans = state.messages.filter((message) => message.kind === "plan" && messageTurnId(message) === turnId);
  const diffs = state.messages.filter((message) => isAboveComposerTurnDiff(message) && messageTurnId(message) === turnId);
  assert(plans.length === 1, `${stage}必须恰好保留一个当前 turn 计划`);
  assert(diffs.length === 1, `${stage}必须恰好保留一个输入框上方 diff`);
  assert(state.messages.some((message) => message.id === latestItemId), `${stage}不能为保留结构消息而丢掉最新消息`);
  assert(state.messages.every((message) => !messageThreadId(message) || messageThreadId(message) === threadId), `${stage}不能混入其他会话消息`);

  const planSteps = Array.isArray(plans[0].meta?.plan) ? plans[0].meta.plan : [];
  assert(planSteps.length === 3, `${stage}必须保留最新三步计划`);
  assert(planSteps[0]?.status === "completed" && planSteps[1]?.status === "completed", `${stage}必须保留计划的最新完成状态`);
  assert(planSteps[2]?.status === "in_progress", `${stage}必须保留计划的最新进行中状态，实际为 ${JSON.stringify(planSteps)}`);

  const change = fileChangesForMessage(diffs[0]).find((entry) => entry.path === "src/pressure-final.js");
  assert(change?.added === 3 && change?.deleted === 1, `${stage}必须保留最后一次 diff 更新`);
}

function snapshotAliasStateReady(state, { threadId, oldTurnId, newerTurnId, userId, userClientId, assistantId }) {
  return Boolean(
    state?.currentThreadId === threadId &&
    state.messages?.some((message) => userId
      ? message.id === userId || String(message.meta?.clientUserMessageId || message.meta?.clientId || "") === userId
      : messageTurnId(message) === oldTurnId &&
        message.role === "user" &&
        String(message.meta?.clientUserMessageId || message.meta?.clientId || "") === userClientId) &&
    state.messages.some((message) => message.id === "item-902") &&
    state.messages.some((message) => message.id === assistantId) &&
    state.messages.some((message) => isCompletedTurnDiffCard(message) && messageTurnId(message) === oldTurnId) &&
    state.messages.some((message) => messageTurnId(message) === newerTurnId && message.role === "user")
  );
}

function assertSnapshotAliasStructure(state, { oldTurnId, newerTurnId, userId, assistantId, stage }) {
  const messages = state.messages || [];
  const userIndex = messages.findIndex((message) =>
    message.id === userId || String(message.meta?.clientUserMessageId || message.meta?.clientId || "") === userId
  );
  const fileIndex = messages.findIndex((message) => message.id === "item-902");
  const assistantIndex = messages.findIndex((message) => message.id === assistantId);
  const completedDiffIndex = messages.findIndex((message) => isCompletedTurnDiffCard(message) && messageTurnId(message) === oldTurnId);
  const newerUserIndex = messages.findIndex((message) => messageTurnId(message) === newerTurnId && message.role === "user");

  assert(userIndex >= 0 && fileIndex > userIndex, `${stage}：旧 turn 的对话流 diff 必须位于用户消息之后`);
  assert(assistantIndex > fileIndex, `${stage}：旧 turn 的最终回复必须位于对话流 diff 之后`);
  assert(completedDiffIndex > assistantIndex, `${stage}：旧 turn 的完成态 diff 必须紧跟本 turn 最终回复`);
  assert(newerUserIndex > completedDiffIndex, `${stage}：旧 turn 的完成态 diff 必须位于下一 turn 之前`);
  assert(messages.filter((message) => message.kind === "file" && messageTurnId(message) === oldTurnId).length === 1, `${stage}：旧 turn 的对话流 diff 必须恰好一条`);
  assert(messages.filter((message) => isCompletedTurnDiffCard(message) && messageTurnId(message) === oldTurnId).length === 1, `${stage}：旧 turn 的完成态 diff 必须恰好一条`);
  assert(messages.filter((message) => messageTurnId(message) === oldTurnId && message.role === "user" && String(message.text || "") === "快照重复问题").length === 1, `${stage}：快照与实时用户消息只能保留一条`);
  assert(messages.filter((message) => messageTurnId(message) === oldTurnId && message.role === "assistant" && message.kind === "text" && String(message.text || "") === "快照重复回复").length === 1, `${stage}：快照与实时助手回复只能保留一条`);
  const canonicalUserId = messages[userIndex]?.id;
  assertCanonicalSequence(messages, [canonicalUserId, "item-902", assistantId], `${stage}：旧 turn`);
}

function uuidV7ResumeOrderStateReady(state, fixture) {
  const messages = state?.messages || [];
  const lastTurn = fixture.turns.at(-1);
  return Boolean(
    state?.currentThreadId === fixture.threadId &&
    state?.busy === false &&
    fixture.turns.every((turn) =>
      messages.some((message) => message.id === turn.userId) &&
      messages.some((message) => message.id === turn.assistantId)
    ) &&
    messages.some((message) => message.id === lastTurn.fileId) &&
    messages.some((message) => isCompletedTurnDiffCard(message) && messageTurnId(message) === lastTurn.turnId)
  );
}

function assertUuidV7ResumeOrder(state, fixture, stage) {
  const messages = state.messages || [];
  let previousAssistantIndex = -1;
  for (const [index, turn] of fixture.turns.entries()) {
    const userIndex = messages.findIndex((message) => message.id === turn.userId);
    const assistantIndex = messages.findIndex((message) => message.id === turn.assistantId);
    assert(userIndex >= 0, `${stage}：第 ${index + 1} 轮用户消息必须存在`);
    assert(assistantIndex > userIndex, `${stage}：第 ${index + 1} 轮必须保持 user < assistant`);
    assert(userIndex > previousAssistantIndex, `${stage}：第 ${index + 1} 轮用户消息必须位于上一轮助手回复之后`);
    assertCanonicalSequence(messages, [turn.userId, turn.assistantId], `${stage}：第 ${index + 1} 轮`);
    previousAssistantIndex = assistantIndex;
  }

  const lastTurn = fixture.turns.at(-1);
  const userIndex = messages.findIndex((message) => message.id === lastTurn.userId);
  const fileIndex = messages.findIndex((message) => message.id === lastTurn.fileId);
  const assistantIndex = messages.findIndex((message) => message.id === lastTurn.assistantId);
  const completedDiffIndex = messages.findIndex((message) =>
    isCompletedTurnDiffCard(message) && messageTurnId(message) === lastTurn.turnId
  );
  assert(fileIndex > userIndex && fileIndex < assistantIndex, `${stage}：对话流 diff 必须位于本轮用户消息和最终回复之间`);
  assert(completedDiffIndex === assistantIndex + 1, `${stage}：完成态 diff 必须紧跟本轮最终回复`);
  assert(messages.filter((message) => isCompletedTurnDiffCard(message) && messageTurnId(message) === lastTurn.turnId).length === 1, `${stage}：完成态 diff 必须恰好一条`);
  assertCanonicalSequence(messages, [lastTurn.userId, lastTurn.fileId, lastTurn.assistantId], `${stage}：最后一轮`);
}

function subsequenceOrderStateReady(state, fixture) {
  const ids = Object.entries(fixture?.ids || {}).map(([key, id]) => {
    if (key !== "steerUserId") return id;
    return state?.messages?.find((message) =>
      message.role === "user" &&
      String(message.meta?.clientUserMessageId || message.meta?.clientId || "") === "subsequence-steer-client"
    )?.id || id;
  });
  return Boolean(
    state?.currentThreadId === fixture?.threadId &&
    state?.busy === false &&
    ids.length > 0 &&
    ids.every((id) => state.messages?.some((message) => message.id === id)) &&
    state.messages.some((message) => isCompletedTurnDiffCard(message) && messageTurnId(message) === fixture.turnId)
  );
}

function assertSubsequenceOrder(state, fixture, stage) {
  const messages = state.messages || [];
  const ids = {
    ...fixture.ids,
    steerUserId: messages.find((message) =>
      message.role === "user" &&
      String(message.meta?.clientUserMessageId || message.meta?.clientId || "") === "subsequence-steer-client"
    )?.id || fixture.ids.steerUserId
  };
  const expectedOrder = [
    ids.userId,
    ids.beforeCommentaryId,
    ids.beforeCommandId,
    ids.fileId,
    ids.oldFinalId,
    ids.steerUserId,
    ids.afterCommandId,
    ids.afterCommentaryId,
    ids.newFinalId
  ];
  const indexes = expectedOrder.map((id) => messages.findIndex((message) => message.id === id));
  assert(indexes.every((index) => index >= 0), `${stage}：完整顺序中的每条消息都必须存在，实际 ${JSON.stringify(indexes)}`);
  for (let index = 1; index < indexes.length; index += 1) {
    assert(indexes[index] > indexes[index - 1], `${stage}：消息行为顺序错误 ${expectedOrder[index - 1]} !< ${expectedOrder[index]}`);
  }
  assertCanonicalSequence(messages, expectedOrder, `${stage}：双快照 turn`);

  const oldFinalIndex = indexes[4];
  const steerUserIndex = indexes[5];
  const afterCommandIndex = indexes[6];
  const afterCommentaryIndex = indexes[7];
  const newFinalIndex = indexes[8];
  assert(oldFinalIndex < steerUserIndex, `${stage}：旧回复必须停在中途用户消息之前`);
  assert(steerUserIndex < afterCommandIndex && afterCommandIndex < afterCommentaryIndex, `${stage}：中途用户消息后的命令和过程说明必须保持发生顺序`);
  assert(afterCommentaryIndex < newFinalIndex, `${stage}：新回复必须位于中途插入后的过程项之后`);
  assert(messages[oldFinalIndex]?.meta?.phase === "final_answer", `${stage}：旧回复必须保留 final_answer phase 作为排序无关元数据`);
  assert(messages[afterCommentaryIndex]?.meta?.phase === "commentary", `${stage}：过程说明必须保留 commentary phase 作为排序无关元数据`);
  assert(messages[newFinalIndex]?.meta?.phase === "final_answer", `${stage}：新回复必须保留 final_answer phase 作为排序无关元数据`);

  const completedDiffs = messages.filter((message) =>
    isCompletedTurnDiffCard(message) && messageTurnId(message) === fixture.turnId
  );
  const completedDiffIndex = messages.findIndex((message) => message.id === completedDiffs[0]?.id);
  assert(completedDiffs.length === 1, `${stage}：完成态 diff 必须恰好一条`);
  assert(completedDiffIndex === newFinalIndex + 1, `${stage}：完成态 diff 必须紧跟实际最后一条回复`);
}

function incompleteOrderStateReady(state, fixture) {
  return Boolean(
    state?.currentThreadId === fixture.threadId &&
    state?.busy === false &&
    state.messages?.some((message) => message.id === "incomplete-snapshot-middle") &&
    state.messages.some((message) => message.id === "incomplete-live-command") &&
    state.messages.some((message) => message.id === "incomplete-live-file") &&
    state.messages.some((message) => message.id === "incomplete-snapshot-final") &&
    state.messages.some((message) => isCompletedTurnDiffCard(message) && messageTurnId(message) === fixture.turnId) &&
    !state.messages.some((message) => message.kind === "plan" && messageTurnId(message) === fixture.turnId)
  );
}

function assertIncompleteOrder(state, fixture, stage) {
  const messages = state.messages;
  const middleIndex = messages.findIndex((message) => message.id === "incomplete-snapshot-middle");
  const commandIndex = messages.findIndex((message) => message.id === "incomplete-live-command");
  const fileIndex = messages.findIndex((message) => message.id === "incomplete-live-file");
  const finalIndex = messages.findIndex((message) => message.id === "incomplete-snapshot-final");
  const completedDiffIndex = messages.findIndex((message) =>
    isCompletedTurnDiffCard(message) && messageTurnId(message) === fixture.turnId
  );

  assert(middleIndex >= 0 && commandIndex > middleIndex, `${stage}：实时命令必须位于快照前置过程消息之后`);
  assert(fileIndex > commandIndex, `${stage}：实时文件变更必须位于实时命令之后`);
  const orderFacts = [
    "incomplete-order-user",
    "incomplete-snapshot-middle",
    "incomplete-live-command",
    "incomplete-live-file",
    "incomplete-snapshot-final"
  ].map((id) => {
    const message = messages.find((candidate) => candidate.id === id);
    return {
      id,
      index: messages.indexOf(message),
      ordinal: message?.meta?.canonicalOrdinal,
      origin: message?.meta?.canonicalOrderOrigin,
      eventSeq: message?.meta?.proxyEventSeq,
    };
  });
  assert(finalIndex > fileIndex, `${stage}：最终回复必须位于所有实时过程消息之后，实际 ${JSON.stringify(orderFacts)}`);
  assert(completedDiffIndex === finalIndex + 1, `${stage}：完成态 diff 必须紧跟最终回复`);
  assert(!messages.some((message) => message.kind === "plan" && messageTurnId(message) === fixture.turnId), `${stage}：完成计划不能回到消息状态`);
  assertCanonicalSequence(messages, [
    "incomplete-order-user",
    "incomplete-snapshot-middle",
    "incomplete-live-command",
    "incomplete-live-file",
    "incomplete-snapshot-final"
  ], `${stage}：不完整快照 turn`);
  assert(Number(messages[commandIndex]?.meta?.proxyEventSeq) > 0, `${stage}：实时命令必须保留代理事件顺序锚点`);
  assert(Number(messages[fileIndex]?.meta?.proxyEventSeq) > Number(messages[commandIndex]?.meta?.proxyEventSeq), `${stage}：实时过程消息必须按代理事件顺序排列`);
}

function assertCanonicalSequence(messages, ids, stage) {
  const ordinals = ids.map((id) => {
    const message = messages.find((candidate) => candidate.id === id);
    const ordinal = Number(message?.meta?.canonicalOrdinal);
    return Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : null;
  });
  assert(ordinals.every((ordinal) => ordinal !== null), `${stage}：每条时间线消息都必须有 canonicalOrdinal，实际 ${JSON.stringify(ordinals)}`);
  for (let index = 1; index < ordinals.length; index += 1) {
    assert(ordinals[index] > ordinals[index - 1], `${stage}：canonicalOrdinal 必须严格递增，实际 ${JSON.stringify(ordinals)}`);
  }
}

function assertNoSnapshotOrderMetadata(state, stage) {
  assert(
    state.messages.every((message) => !Object.prototype.hasOwnProperty.call(message?.meta || {}, "snapshotOrders")),
    `${stage}：手机消息不能携带服务端快照排序证据`
  );
}

function currentThread() {
  return phoneState?.threads?.find((thread) => thread.id === phoneState.currentThreadId) || null;
}

function traeVisibleUserTexts(items) {
  const visible = [];
  let initialUserConsumed = false;
  for (const [index, item] of items.entries()) {
    if (item?.type === "steeringUserMessage") {
      visible.push(inputText(item.input));
      continue;
    }
    if (item?.type !== "userMessage") continue;
    if (!initialUserConsumed) {
      initialUserConsumed = true;
      visible.push(inputText(item.content));
      continue;
    }
    const clientId = String(item.clientId || item.clientUserMessageId || "");
    const hasSteeringDisplay = items.slice(0, index).some((candidate) =>
      candidate?.type === "steeringUserMessage" &&
      clientId &&
      candidate.clientUserMessageId === clientId
    );
    // 这正是扩展的归并规则：有 steering 显示项时 canonical userMessage 只作为隐藏确认；
    // 没有显示项的中途 userMessage 会被降为 steered，同样不会产生可见正文。
    if (!hasSteeringDisplay) continue;
  }
  return visible;
}

function inputText(input) {
  return (Array.isArray(input) ? input : [])
    .filter((entry) => entry?.type === "text")
    .map((entry) => String(entry.text || ""))
    .join("\n")
    .trim();
}

async function runStep(name, fn) {
  const startedAt = Date.now();
  await fn();
  results.push({ name, ok: true, durationMs: Date.now() - startedAt });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
    await delay(50);
  }
  const labelText = typeof label === "function" ? label() : label;
  throw lastError || new Error(`${labelText} timeout`);
}

function phoneStateSummary() {
  if (!phoneState) return "(empty)";
  return JSON.stringify({
    codex: phoneState.codex?.status,
    currentThreadId: phoneState.currentThreadId,
    busy: phoneState.busy,
    activeTurnId: phoneState.activeTurnId,
    approvals: phoneState.approvals?.length || 0,
    messages: (phoneState.messages || []).map((message) => ({
      id: message.id,
      role: message.role,
      kind: message.kind,
      streaming: Boolean(message.streaming),
      threadId: messageThreadId(message),
      turnId: messageTurnId(message),
      text: String(message.text || "").slice(0, 40)
    }))
  });
}

function secondaryPhoneStateSummary(state) {
  if (!state) return "(empty)";
  return JSON.stringify({
    currentThreadId: state.currentThreadId,
    busy: state.busy,
    activeTurnId: state.activeTurnId,
    messages: (state.messages || []).map((message) => ({
      id: message.id,
      threadId: messageThreadId(message),
      text: String(message.text || "").slice(0, 40)
    }))
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => body += chunk);
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${body}`));
          return;
        }
        resolve(JSON.parse(body));
      });
    });
    request.on("error", reject);
    request.setTimeout(3000, () => request.destroy(new Error("HTTP timeout")));
  });
}

function fetchStatus(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const statusCode = response.statusCode;
      response.resume();
      response.on("end", () => resolve(statusCode));
    });
    request.on("error", reject);
    request.setTimeout(3000, () => request.destroy(new Error("HTTP timeout")));
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
