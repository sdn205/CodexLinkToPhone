import { proxyExe, fakeEnv } from "../fixtures/native-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readProxyInstances } from "../fixtures/instance-registry.mjs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { chromium } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const workDir = path.join(root, "tests/build", `todo-regression-test-${process.pid}`);
const fakeSource = path.join(__dirname, "../fixtures/fake-scenario-app-server.mjs");
const bridgeExecutable = process.env.BRIDGE_TEST_EXE || path.join(root, "server", "dist", "codex-phone-bridge.exe");
const proxyStateFile = path.join(workDir, "proxy-state.json");
const proxyLogFile = path.join(workDir, "proxy.log");
const fakeLogFile = path.join(workDir, "fake.log");
const phoneStateDir = path.join(workDir, "phone-state");
const imageFixture = path.join(workDir, "todo-regression.png");
const token = "codex-phone-todo-regression";

const results = [];
const parentLines = [];
const pageErrors = [];
const consoleErrors = [];
let proxy = null;
let bridge = null;
let browser = null;
let context = null;
let page = null;
let requestId = 7000;
let proxyStderr = "";
let bridgeStderr = "";

  // Retain isolated evidence under tests/build; no recursive deletion.
await fs.mkdir(workDir, { recursive: true });
await fs.writeFile(imageFixture, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
));

try {
  await startProxy();
  await waitForProxyState((state) => state.mode === "stdio-tee" && state.upstreamConnected && state.initialized && state.controlUrl);
  await startBridge();
  const baseUrl = await waitForBridgeUrl();
  await startBrowser(`${baseUrl}/?token=${encodeURIComponent(token)}`);
  await waitForUiReady();

  // ---------- TODO 8：文件路径渲染为文件名，点击查看完整路径 ----------
  await runStep("TODO8 文件路径渲染为文件名并点击显示完整路径", async () => {
    await parentRequest("test/assistant-path-message", {
      text: "查看 [app.js](/E:/codexlinktophone/src/app.js) 和 [guide.md](E:\\codexlinktophone\\docs\\guide.md) 的修改"
    });
    await page.waitForSelector(".fileRef", { timeout: 5000 });
    const names = await page.locator(".fileRef").allTextContents();
    assert(names.some((name) => name.includes("app.js")), `应只显示文件名 app.js，实际 ${names.join(" | ")}`);
    assert(!names.some((name) => name.includes("codexlinktophone")), "文件名按钮不能包含完整路径");
    const fileRef = page.locator(".fileRef").first();
    await fileRef.click();
    await page.waitForSelector(".fileRefBubble");
    const bubbleText = await page.locator(".fileRefBubbleText").textContent();
    assert(bubbleText.includes("codexlinktophone") && bubbleText.includes("app.js"), `气泡应显示完整路径，实际 ${bubbleText}`);
  });

  // ---------- TODO 15：命令状态从“正在运行命令”更新为“已运行” ----------
  await runStep("TODO15 命令状态更新为已运行且不依赖重建", async () => {
    await parentRequest("test/long-command");
    await page.locator('.commandGroupRow[aria-expanded="false"]').first().click();
    await page.waitForSelector(".toolBlock .cmdState", { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector(".toolBlock .cmdState")?.textContent === "正在运行命令", null, { timeout: 5000 });
    await page.waitForFunction(() => {
      const tool = document.querySelector(".toolBlock")?.closest(".message.tool");
      return tool?.nextElementSibling?.classList.contains("turnActivity");
    }, null, { timeout: 5000 });
    const thinkingGap = await page.evaluate(() => {
      const tool = document.querySelector(".toolBlock")?.closest(".message.tool");
      const activity = tool?.nextElementSibling;
      if (!tool || !activity) return null;
      return activity.getBoundingClientRect().top - tool.getBoundingClientRect().bottom;
    });
    assert(typeof thinkingGap === "number" && thinkingGap >= 7, `运行命令后正在思考至少保留 8px 间距，实际 ${thinkingGap}`);
    const node = await page.evaluate(() => {
      const state = document.querySelector(".toolBlock .cmdState");
      const block = state?.closest(".toolBlock");
      return state ? { stateText: state.textContent, blockClass: block?.className || "" } : null;
    });
    assert.equal(node.stateText, "正在运行命令");
    await page.waitForFunction(() => document.querySelector(".toolBlock .cmdState")?.textContent === "已运行", null, { timeout: 8000 });
    const after = await page.evaluate(() => {
      const state = document.querySelector(".toolBlock .cmdState");
      const block = state?.closest(".toolBlock");
      return state ? { stateText: state.textContent, blockClass: block?.className || "" } : null;
    });
    assert.equal(after.stateText, "已运行", "命令完成后必须显示已运行");
  });

  // ---------- 上下文压缩：唯一过程 UI，无额外 toast 或“正在思考” ----------
  await runStep("上下文压缩只显示扩展式过程行", async () => {
    const appSource = await fs.readFile(path.join(root, "public", "app.js"), "utf8");
    assert(!appSource.includes('toast("正在压缩会话'), "压缩开始提示不能重新出现");
    assert(!appSource.includes('toast("会话已压缩'), "压缩成功提示不能重新出现");
    assert(/if \(!payload.ok\) toast\(.*"压缩失败，请重试"/.test(appSource), "压缩失败提示必须保留");

    await parentRequest("test/context-compaction", { threadId: "thread-a", turnId: "turn-a" });
    await page.waitForSelector(".contextCompactionRow .thinkingText.cadencedShimmer", { timeout: 5000 });
    const facts = await page.evaluate(() => {
      const row = document.querySelector(".contextCompactionRow");
      const icon = row?.querySelector(".contextCompactionIcon");
      const svg = icon?.querySelector("svg");
      const title = row?.querySelector(".activityTitle");
      const shimmer = title?.querySelector(".thinkingText.cadencedShimmer");
      const style = row ? getComputedStyle(row) : null;
      const iconRect = icon?.getBoundingClientRect();
      const rowRect = row?.getBoundingClientRect();
      const messageRect = row?.closest(".message")?.getBoundingClientRect();
      return {
        label: shimmer?.firstChild?.textContent || "",
        display: style?.display || "",
        justifySelf: style?.justifySelf || "",
        gap: style?.gap || "",
        borderTopWidth: style?.borderTopWidth || "",
        backgroundColor: style?.backgroundColor || "",
        titleFontSize: title ? getComputedStyle(title).fontSize : "",
        iconWidth: iconRect?.width || 0,
        iconHeight: iconRect?.height || 0,
        rowWidth: rowRect?.width || 0,
        messageWidth: messageRect?.width || 0,
        pathCount: svg?.querySelectorAll("path").length || 0,
        hasSweep: Boolean(shimmer?.querySelector(".thinkingSweepBar .thinkingSweepHighlight"))
      };
    });
    assert.equal(facts.label, "正在压缩上下文", `上下文压缩标签错误：${facts.label}`);
    assert.equal(facts.display, "flex", `Grid 子项块化后应保持 flex 行，实际 ${facts.display}`);
    assert.equal(facts.justifySelf, "start", `上下文压缩必须靠左收缩，实际 ${facts.justifySelf}`);
    assert(facts.rowWidth > 0 && facts.rowWidth < facts.messageWidth, `上下文压缩不能拉伸成整行：${JSON.stringify(facts)}`);
    assert.equal(facts.gap, "4px", `图标与文字间距应为扩展的 4px，实际 ${facts.gap}`);
    assert.equal(facts.borderTopWidth, "0px", `上下文压缩不能保留系统卡片边框，实际 ${facts.borderTopWidth}`);
    assert(["transparent", "rgba(0, 0, 0, 0)"].includes(facts.backgroundColor), `上下文压缩背景必须透明，实际 ${facts.backgroundColor}`);
    assert.equal(facts.titleFontSize, "14px", `上下文压缩文字尺寸错误：${facts.titleFontSize}`);
    assert.equal(facts.iconWidth, 16, `上下文压缩图标宽度必须为 16px，实际 ${facts.iconWidth}`);
    assert.equal(facts.iconHeight, 16, `上下文压缩图标高度必须为 16px，实际 ${facts.iconHeight}`);
    assert.equal(facts.pathCount, 4, `上下文压缩必须使用扩展的四路径图标，实际 ${facts.pathCount}`);
    assert.equal(facts.hasSweep, true, "运行中的上下文压缩必须使用同一套双层 shimmer");
    const turnActivityLabels = await page.locator(".turnActivity").allTextContents();
    assert(!turnActivityLabels.some((label) => label.trim() === "正在思考"), `上下文压缩运行中不能同时显示正在思考，实际 ${turnActivityLabels.join(" | ")}`);
  });

  // ---------- TODO 13：系统通知不进对话流 ----------
  await runStep("TODO13 系统通知不进入对话流", async () => {
    const beforeText = await page.locator("#messages").innerText();
    await parentRequest("test/system-error", { message: "代理连接断开测试通知", threadId: "thread-a" });
    await page.waitForTimeout(400);
    const afterText = await page.locator("#messages").innerText();
    assert.equal(afterText, beforeText, "系统通知不能改变对话流内容");
    assert(!afterText.includes("代理连接断开测试通知"), "系统通知文本不能出现在对话流");
    assert.equal(await page.locator('#messages [role="system"], #messages .message.system').count(), 0, "对话流不能有 system 消息节点");
  });

  // ---------- TODO 18：重命名弹窗布局（一行齐平，取消左确认右） ----------
  await runStep("TODO18 重命名弹窗按钮一行齐平且取消在左确认在右", async () => {
    await openThreadMenuForName("电脑正在运行的会话");
    await page.getByRole("menuitem", { name: "重命名会话" }).click();
    await page.waitForSelector("#renameDialog[open]");
    const layout = await page.evaluate(() => {
      const input = document.querySelector("#renameInput").getBoundingClientRect();
      const cancel = document.querySelector("#renameCancelBtn").getBoundingClientRect();
      const save = document.querySelector("#renameSaveBtn").getBoundingClientRect();
      return {
        sameRow: Math.abs(cancel.top - save.top) < 1,
        cancelLeft: cancel.left,
        saveLeft: save.left,
        cancelWidth: cancel.width,
        saveWidth: save.width,
        inputHeight: input.height,
        inputRadius: getComputedStyle(document.querySelector("#renameInput")).borderRadius,
        saveRightOfCancel: save.left >= cancel.right - 1
      };
    });
    assert.equal(layout.sameRow, true, `取消/确认必须在同一行，实际 top ${layout.cancelLeft}/${layout.saveLeft}`);
    assert(layout.saveRightOfCancel, "确认必须在取消右边");
    assert(layout.inputHeight >= 44, `输入框应足够高，实际 ${layout.inputHeight}`);
    assert(Number.parseFloat(layout.inputRadius) >= 10, `输入框应圆润，实际 ${layout.inputRadius}`);
    await page.locator("#renameCancelBtn").click();
  });

  // ---------- 准备：thread-b（空闲）与运行中会话 A ----------
  await parentRequest("test/pc-other-thread");
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".threadItem")).some((node) => node.textContent.includes("电脑端其他会话")));
  await parentRequest("test/create-running-window-pressure", { threadId: "thread-running-pressure", count: 85 });
  await parentRequest("test/stream-burst", { count: 60 });
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".threadItem")).some((node) => node.textContent.includes("长会话结构消息回归")));

  // ---------- 切到运行中会话 A：停在最新位置 ----------
  await runStep("TODO10 切到运行中会话后停在最新消息位置", async () => {
    await page.evaluate(() => {
      const el = document.querySelector("#messages");
      window.__scrollLog = [];
      el.addEventListener("scroll", () => {
        window.__scrollLog.push({ t: Date.now(), st: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight });
      }, { passive: true });
    });
    const startedAt = Date.now();
    await openSidebar();
    // 确保重连/状态稳定后再点击，避免乐观切换被 pending 状态吞掉。
    await page.waitForTimeout(400);
    const buttonDiag = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll(".threadItem")).find((node) => node.textContent.includes("长会话结构消息回归"));
      return { disabled: button?.disabled, cls: button?.className, sidebarOpen: document.querySelector("#sidebar")?.classList.contains("open"), dialogs: Array.from(document.querySelectorAll("dialog[open]")).map((d) => d.id) };
    });
    await clickThreadButton(page.getByRole("button", { name: /长会话结构消息回归/ }));
    await page.waitForTimeout(300);
    const afterClick = await page.evaluate(() => ({
      title: document.querySelector("#mobileThreadTitle")?.textContent || "",
      messageCount: document.querySelectorAll("#messages .message").length,
      sidebarOpen: document.querySelector("#sidebar")?.classList.contains("open"),
      menuHidden: document.querySelector("#threadContextMenu")?.hidden
    }));
    assert.equal(afterClick.title, "长会话结构消息回归", `乐观切换应立即更新标题（点击前诊断：${JSON.stringify(buttonDiag)}，点击后：${JSON.stringify(afterClick)}）`);
    const resumeRequest = (await readFakeLog()).find((entry) =>
      entry.type === "request" && entry.method === "thread/resume" && entry.params?.threadId === "thread-running-pressure");
    assert(resumeRequest, `点击后必须向扩展侧发出 thread/resume（点击后：${JSON.stringify(afterClick)}）`);
    await page.waitForFunction(() => document.querySelector("#mobileThreadTitle")?.textContent === "长会话结构消息回归", null, { timeout: 8000 });
    await page.waitForTimeout(800);
    assert.equal(await page.locator("#mobileThreadTitle").textContent(), "长会话结构消息回归", "切到运行中会话后标题必须稳定不回跳");
    assert(Date.now() - startedAt < 13000, `切到运行中会话耗时过长 ${Date.now() - startedAt}ms`);
    try {
      await page.waitForFunction(() => {
        const el = document.querySelector("#messages");
        return el.scrollHeight > el.clientHeight && el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
      }, null, { timeout: 5000 });
    } catch (error) {
      const facts = await page.evaluate(() => {
        const el = document.querySelector("#messages");
        return {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          messageCount: document.querySelectorAll("#messages .message").length,
          firstText: document.querySelector("#messages .message")?.textContent?.slice(0, 40) || "",
          lastText: Array.from(document.querySelectorAll("#messages .message")).at(-1)?.textContent?.slice(0, 40) || "",
          scrollLog: window.__scrollLog || []
        };
      });
      throw new Error(`切到运行中会话未停在最新位置：${JSON.stringify(facts)}`);
    }
  });

  // ---------- TODO 3/11/14：中途插入消息立即出现、位置固定、刷新保留 ----------
  await runStep("TODO3/11/14 中途插入消息立即出现在对话流且位置固定", async () => {
    await page.locator("#promptInput").fill("中途插入的消息必须固定位置");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction(() => {
      const input = document.querySelector("#promptInput");
      const spinner = document.querySelector("#sendBtn .sendSpinner");
      return input?.value === "" && getComputedStyle(spinner).display === "none" &&
        Array.from(document.querySelectorAll("#messages .message")).some((node) => node.textContent.includes("中途插入的消息必须固定位置"));
    }, null, { timeout: 4000 });
    const positionOf = () => page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("#messages .message"));
      const index = nodes.findIndex((node) => node.textContent.includes("中途插入的消息必须固定位置"));
      const count = nodes.filter((node) => node.textContent.includes("中途插入的消息必须固定位置")).length;
      return { index, count, total: nodes.length };
    });
    const before = await positionOf();
    assert(before.index >= 0, "中途消息必须出现在对话流");
    await page.waitForTimeout(1200);
    const after = await positionOf();
    assert.equal(after.index, before.index, `中途消息位置必须固定，从 ${before.index}/${before.total} 变成 ${after.index}/${after.total}`);
    assert.equal(after.count, 1, `中途消息只能保留一条，实际 ${JSON.stringify(after)}`);
  });

  // ---------- TODO 4：中途插入消息到达扩展侧（turn/steer 携带完整内容） ----------
  await runStep("TODO4 中途插入消息以 turn/steer 完整送达扩展侧", async () => {
    const log = await readFakeLog();
    const steer = log.find((entry) => entry.type === "request" && entry.method === "turn/steer" &&
      entry.params?.input?.some((input) => String(input?.text || "").includes("中途插入的消息必须固定位置")));
    assert(steer, "扩展侧必须收到携带中途消息文本的 turn/steer");
    assert(steer.params.threadId, "turn/steer 必须携带 threadId");
    assert(steer.params.expectedTurnId, "turn/steer 必须携带 expectedTurnId");
    assert(steer.params.clientUserMessageId, "turn/steer 必须携带 clientUserMessageId 以便回显去重");
  });

  // ---------- TODO 5：发送后立即清空不转圈，刷新后消息保留 ----------
  await runStep("TODO5 发送后立即清空不转圈且刷新后消息保留", async () => {
    await page.waitForFunction(() => {
      const input = document.querySelector("#promptInput");
      const button = document.querySelector("#sendBtn");
      return input?.value === "" && !button.classList.contains("isSending") && button.getAttribute("aria-label") !== "正在停止";
    }, null, { timeout: 3000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForUiReady();
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#messages .message")).some((node) => node.textContent.includes("中途插入的消息必须固定位置")), null, { timeout: 8000 });
  });

  // ---------- TODO 9/12：正在思考固定动画，不随摘要逐字输出变化 ----------
  await runStep("TODO9/12 正在思考固定节点与固定动画不随摘要逐字输出变化", async () => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForSelector(".turnActivity .thinkingText.cadencedShimmer", { timeout: 5000 });
    await page.evaluate(() => {
      const activity = document.querySelector(".turnActivity");
      const text = activity?.querySelector(".thinkingText.cadencedShimmer");
      const sweep = text?.querySelector(".thinkingSweepBar");
      const highlight = sweep?.querySelector(".thinkingSweepHighlight");
      const messages = document.querySelector("#messages");
      if (!activity || !text || !sweep || !highlight || !messages) throw new Error("缺少正在思考扫光节点");
      const probe = { activity, text, sweep, highlight, removedCount: 0, transitions: [] };
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "attributes" && record.target === text) {
            const active = text.classList.contains("thinkingShimmerActive");
            const previous = probe.transitions.at(-1);
            if (!previous || previous.active !== active) probe.transitions.push({ active, at: performance.now() });
          }
          if (record.type !== "childList") continue;
          for (const removed of record.removedNodes) {
            if (removed === activity || (removed instanceof Element && removed.contains(activity))) probe.removedCount += 1;
          }
        }
      });
      observer.observe(messages, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
      probe.observer = observer;
      window.__thinkingProbe = probe;
    });

    try {
      // 先等到一个完整扫光起点，避免在上个周期的随机时刻取样。
      await page.waitForFunction(() => !document.querySelector(".turnActivity .thinkingText")?.classList.contains("thinkingShimmerActive"), null, { timeout: 2500 });
      await page.waitForFunction(() => document.querySelector(".turnActivity .thinkingText")?.classList.contains("thinkingShimmerActive"), null, { timeout: 5000 });
      await page.waitForTimeout(50);
      const snapshot = await page.evaluate(() => {
        const probe = window.__thinkingProbe;
        const style = getComputedStyle(probe.sweep);
        probe.animation = probe.sweep.getAnimations().find((animation) => animation.animationName === "cadencedThinkingSweep") || null;
        return {
          label: probe.text.firstChild?.textContent || "",
          fontSize: getComputedStyle(probe.activity).fontSize,
          hasHighlight: Boolean(probe.highlight),
          animationName: style.animationName,
          animationDuration: style.animationDuration,
          animationIteration: style.animationIterationCount,
          animationTiming: style.animationTimingFunction,
          currentTime: probe.animation?.currentTime ?? null
        };
      });
      assert.equal(snapshot.label, "正在思考", `活动标签必须是正在思考，实际 ${snapshot.label}`);
      assert.equal(snapshot.fontSize, "14px", `正在思考字号应与过程行协调，实际 ${snapshot.fontSize}`);
      assert.equal(snapshot.hasHighlight, true, "扫光必须使用独立的高亮文字层");
      assert.equal(snapshot.animationName, "cadencedThinkingSweep", `扫光动画名称错误：${snapshot.animationName}`);
      assert.equal(snapshot.animationDuration, "1s", `扫光应持续 1 秒，实际 ${snapshot.animationDuration}`);
      assert.equal(snapshot.animationIteration, "1", `扫光必须单次播放，实际 ${snapshot.animationIteration}`);
      assert(snapshot.animationTiming.includes("steps(48"), `扫光必须使用 48 步节拍，实际 ${snapshot.animationTiming}`);
      assert.equal(typeof snapshot.currentTime, "number", "扫光激活时必须存在 CSS 动画实例");

      const stream = parentRequest("test/reasoning-many-deltas", {
        threadId: "thread-running-pressure",
        turnId: "turn-running-pressure",
        count: 42,
        intervalMs: 100,
        text: "这段思考摘要会一个一个字蹦出来用来验证正在思考动画完全不受影响而且节点不会重建"
      });
      await page.waitForTimeout(320);
      const during = await page.evaluate(() => {
        const probe = window.__thinkingProbe;
        const current = document.querySelector(".turnActivity");
        const sweep = current?.querySelector(".thinkingSweepBar");
        const highlight = sweep?.querySelector(".thinkingSweepHighlight");
        const animation = sweep?.getAnimations().find((entry) => entry.animationName === "cadencedThinkingSweep") || null;
        return {
          sameActivity: current === probe.activity,
          sameSweep: sweep === probe.sweep,
          sameHighlight: highlight === probe.highlight,
          sameAnimation: animation === probe.animation,
          currentTime: animation?.currentTime ?? null,
          transitions: probe.transitions.slice(),
          removedCount: probe.removedCount
        };
      });
      assert.equal(during.sameActivity, true, "推理流式期间正在思考根节点不能被替换");
      assert.equal(during.sameSweep, true, "推理流式期间扫光节点不能被替换");
      assert.equal(during.sameHighlight, true, "推理流式期间高亮文字节点不能被替换");
      assert.equal(during.sameAnimation, true, `推理流式期间扫光动画不能重启：${JSON.stringify(during)}`);
      assert.equal(during.removedCount, 0, "推理流式期间正在思考节点不能被移除后重插");
      assert(typeof during.currentTime === "number" && during.currentTime > snapshot.currentTime, "推理流式期间动画时间轴必须持续前进");

      await stream;
      const after = await page.evaluate(() => {
        const probe = window.__thinkingProbe;
        const firstActiveIndex = probe.transitions.findIndex((entry) => entry.active);
        const firstActive = firstActiveIndex >= 0 ? probe.transitions[firstActiveIndex] : null;
        const firstInactive = firstActive ? probe.transitions.slice(firstActiveIndex + 1).find((entry) => !entry.active) : null;
        const nextActive = firstInactive ? probe.transitions.slice(firstActiveIndex + 1).find((entry) => entry.active && entry.at > firstInactive.at) : null;
        return {
          sameActivity: document.querySelector(".turnActivity") === probe.activity,
          removedCount: probe.removedCount,
          activeMs: firstActive && firstInactive ? firstInactive.at - firstActive.at : null,
          cadenceMs: firstActive && nextActive ? nextActive.at - firstActive.at : null
        };
      });
      assert.equal(after.sameActivity, true, "摘要逐字输出后活动节点仍必须是原节点");
      assert.equal(after.removedCount, 0, "摘要逐字输出后活动节点不能被移除后重插");
      assert(typeof after.activeMs === "number" && after.activeMs >= 700 && after.activeMs <= 1500, `扫光有效时长应约 1 秒，实际 ${after.activeMs}`);
      assert(typeof after.cadenceMs === "number" && after.cadenceMs >= 3400 && after.cadenceMs <= 4700, `扫光周期应约 4 秒，实际 ${after.cadenceMs}`);
    } finally {
      await page.evaluate(() => {
        const probe = window.__thinkingProbe;
        probe?.observer?.disconnect();
        delete window.__thinkingProbe;
      });
    }
  });

  // ---------- TODO 16：运行中不显示“已处理”，完成后才显示 ----------
  await runStep("TODO16 运行中不闪现已处理，完成后才显示", async () => {
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".turnDivider").count(), 0, "运行中的 turn 不能显示已处理分隔条");
    await parentRequest("test/complete-running-thread", { threadId: "thread-running-pressure" });
    await page.waitForFunction(() => document.querySelectorAll(".turnDivider").length > 0, null, { timeout: 8000 });
    const label = await page.locator(".turnDivider span").first().textContent();
    assert(label.includes("已处理"), `完成后应显示已处理分隔条，实际 ${label}`);
  });

  // ---------- 运行中会话 B：暂停立即恢复 ----------
  await parentRequest("test/create-running-window-pressure", { threadId: "thread-running-pause", count: 81 });
  await runStep("TODO6 暂停后 UI 立即恢复不等代理回执", async () => {
    await openSidebar();
    await clickThreadButton(page.locator('[data-thread-id="thread-running-pause"]'));
    await page.waitForFunction(() => document.querySelector("#mobileThreadTitle")?.textContent === "长会话结构消息回归", null, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelector("#sendBtn")?.getAttribute("aria-label") === "停止生成", null, { timeout: 5000 });
    await parentRequest("test/set-interrupt-delay", { respondMs: 1500 });
    const startedAt = Date.now();
    await page.getByRole("button", { name: "停止生成" }).click();
    await page.waitForFunction(() => {
      const button = document.querySelector("#sendBtn");
      return button && !button.classList.contains("isSending") && button.getAttribute("aria-label") !== "正在停止";
    }, null, { timeout: 1200 });
    assert(Date.now() - startedAt < 1200, `暂停后 UI 应在 1.2s 内恢复（不等 1.5s 的代理回执），实际 ${Date.now() - startedAt}ms`);
  });

  // ---------- 运行中会话 C：归档其他会话直接成功；重命名无提示 ----------
  await parentRequest("test/create-running-window-pressure", { threadId: "thread-running-archive", count: 81 });
  await runStep("TODO17 运行中归档其他会话直接成功且无正在归档提示", async () => {
    await openSidebar();
    await clickThreadButton(page.locator('[data-thread-id="thread-running-archive"]'));
    await page.waitForFunction(() => document.querySelector("#mobileThreadTitle")?.textContent === "长会话结构消息回归", null, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelector("#sendBtn")?.getAttribute("aria-label") === "停止生成", null, { timeout: 5000 });
    await dismissToasts();
    await openSidebar();
    await longPressThread("电脑端其他会话");
    await page.getByRole("menuitem", { name: "归档会话" }).click();
    await page.waitForTimeout(300);
    const during = await toastTexts();
    assert(!during.some((text) => text.includes("正在归档")), `点击归档后不能出现“正在归档”提示，实际 ${during.join(" | ")}`);
    await waitFor(() => toastTexts().then((texts) => texts.some((text) => text.includes("对话已归档"))), 5000, "对话已归档 toast");
    await page.waitForFunction(() => !Array.from(document.querySelectorAll(".threadItem")).some((node) => node.textContent.includes("电脑端其他会话")), null, { timeout: 5000 });
    const archiveRequest = (await readFakeLog()).find((entry) => entry.type === "request" && entry.method === "thread/archive" && entry.params?.threadId === "thread-b");
    assert(archiveRequest, "运行中归档请求必须真实到达扩展侧");
  });

  await runStep("TODO17 重命名对话不显示任何提示", async () => {
    await dismissToasts();
    await openSidebar();
    await longPressThread("电脑正在运行的会话");
    await page.getByRole("menuitem", { name: "重命名会话" }).click();
    await page.waitForSelector("#renameDialog[open]");
    await page.locator("#renameInput").fill("重命名回归测试会话");
    await page.locator("#renameSaveBtn").click();
    await page.waitForTimeout(800);
    const texts = await toastTexts();
    assert.equal(texts.length, 0, `重命名不能显示任何提示，实际 ${texts.join(" | ")}`);
  });

  // ---------- TODO 1/7：积压下切换会话/新建会话立即生效且不跳回 ----------
  await runStep("TODO1/7 积压下切到其他会话立即生效且不跳回", async () => {
    await parentRequest("test/stream-burst", { count: 80 });
    const startedAt = Date.now();
    await openSidebar();
    await clickThreadButton(page.getByRole("button", { name: /重命名回归测试会话/ }));
    await page.waitForFunction(() => document.querySelector("#mobileThreadTitle")?.textContent === "重命名回归测试会话", null, { timeout: 3000 });
    assert(Date.now() - startedAt < 2500, `积压下切换会话不应卡，实际 ${Date.now() - startedAt}ms`);
    await page.waitForTimeout(1500);
    assert.equal(await page.locator("#mobileThreadTitle").textContent(), "重命名回归测试会话", "切换后不能跳回原会话");
  });

  await runStep("TODO1/7 运行中新建会话立即生效且不跳回", async () => {
    const startedAt = Date.now();
    await openSidebar();
    await page.locator("#newThreadBtn").evaluate((node) => node.click());
    await page.waitForTimeout(400);
    const afterClick = await page.evaluate(() => ({
      empty: Boolean(document.querySelector(".emptyHero")),
      messageCount: document.querySelectorAll("#messages .message").length,
      toasts: Array.from(document.querySelectorAll(".toast .toastMessage")).map((node) => node.textContent || ""),
      title: document.querySelector("#mobileThreadTitle")?.textContent || "",
      newBtnDisabled: document.querySelector("#newThreadBtn")?.disabled
    }));
    assert.equal(afterClick.empty, true, `新建会话应乐观显示空会话：${JSON.stringify(afterClick)}`);
    await page.waitForFunction(() => Boolean(document.querySelector(".emptyHero")) && document.querySelectorAll("#messages .message").length === 0, null, { timeout: 3000 });
    const afterWait = await page.evaluate(() => ({
      title: document.querySelector("#mobileThreadTitle")?.textContent || "",
      empty: Boolean(document.querySelector(".emptyHero")),
      messageCount: document.querySelectorAll("#messages .message").length,
      disconnected: document.body.classList.contains("codexDisconnected")
    }));
    assert.equal(afterWait.empty, true, `空会话应保持显示：${JSON.stringify(afterWait)}`);
    assert(Date.now() - startedAt < 40000, `新建会话不应卡，实际 ${Date.now() - startedAt}ms`);
    await page.waitForTimeout(1200);
    assert(Boolean(await page.locator(".emptyHero").count()), "新建会话后不能跳回原会话");
  });

  assert.deepEqual(pageErrors, [], `页面脚本错误：${pageErrors.join(" | ")}`);
  const unexpectedConsoleErrors = consoleErrors.filter((message) => !message.includes("net::ERR_INTERNET_DISCONNECTED"));
  assert.deepEqual(unexpectedConsoleErrors, [], `浏览器控制台错误：${unexpectedConsoleErrors.join(" | ")}`);
  console.log(JSON.stringify({ ok: true, browser: "msedge", viewport: { width: 360, height: 780 }, results }, null, 2));
} finally {
  await context?.setOffline(false).catch(() => {});
  await browser?.close().catch(() => {});
  await stopChild(bridge);
  await stopChild(proxy);
  // Retain isolated evidence under tests/build; no recursive deletion.
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
      FAKE_SCENARIO_LOG: fakeLogFile,
      FAKE_TITLE_RESULT_DELAY_MS: "450"
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  readline.createInterface({ input: proxy.stdout, crlfDelay: Infinity }).on("line", (line) => {
    try {
      parentLines.push(JSON.parse(line));
    } catch {}
  });
  proxy.stderr.on("data", (chunk) => proxyStderr += chunk.toString("utf8"));
  proxy.stdin.write(`${JSON.stringify({
    id: "1",
    method: "initialize",
    params: {
      clientInfo: { name: "Trae CN", title: "Codex Extension", version: "26.901.22334" },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true, requestAttestation: false }
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
  bridge.stderr.on("data", (chunk) => bridgeStderr += chunk.toString("utf8"));
}

async function startBrowser(url) {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  context = await browser.newContext({
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN"
  });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

async function waitForBridgeUrl() {
  const url = `http://127.0.0.1:${bridge.port}`;
  await waitFor(async () => {
    const state = await fetchJson(`${url}/api/health?token=${encodeURIComponent(token)}`).catch(() => null);
    return state?.codex?.status === "connected" ? state : null;
  }, 15_000, "bridge connected");
  return url;
}

async function waitForUiReady() {
  await page.waitForFunction(() =>
    !document.body.classList.contains("codexDisconnected") &&
    document.querySelectorAll(".threadItem").length > 0
  , null, { timeout: 15_000 });
}

async function openSidebar() {
  const sidebar = page.locator("#sidebar");
  if (!await sidebar.evaluate((node) => node.classList.contains("open"))) {
    await page.locator("#menuBtn").click();
  }
  await page.waitForFunction(() => document.querySelector("#sidebar").classList.contains("open"));
}

async function openThreadMenuForName(name) {
  await longPressThread(name);
}

async function longPressThread(name) {
  await openSidebar();
  const button = page.getByRole("button", { name: new RegExp(name) });
  await button.waitFor();
  const dispatched = await button.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const menu = document.querySelector("#threadContextMenu");
    const beforeHidden = menu?.hidden;
    const result = node.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }));
    return { beforeHidden, afterHidden: menu?.hidden, childCount: menu?.children.length, defaultPrevented: result, disabled: node.disabled, text: node.textContent?.slice(0, 40) };
  });
  if (!dispatched || dispatched.afterHidden !== false || dispatched.childCount !== 2) {
    throw new Error(`长按菜单未弹出：${JSON.stringify(dispatched)}`);
  }
  await page.getByRole("menuitem", { name: "重命名会话" }).waitFor();
  // 菜单有 140ms 入场动画，等待稳定后再点击。
  await page.waitForTimeout(300);
}

async function clickThreadButton(locator) {
  // 手机长按误触发的边界：Playwright 移动端点击会先 touchstart，
  // 按钮上停留超过 500ms 会触发“长按弹菜单”把点击吞掉。
  // 这里直接派发 click，等价于手机上的快速点击（<500ms）。
  await locator.waitFor();
  await locator.evaluate((node) => node.click());
}

async function parentRequest(method, params = {}) {
  const id = ++requestId;
  proxy.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return waitFor(() => parentLines.find((line) => Number(line.id) === id), 8000, method);
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

async function readFakeLog() {
  try {
    const text = await fs.readFile(fakeLogFile, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function assertClearedComposer() {
  await page.waitForFunction(() => {
    const input = document.querySelector("#promptInput");
    const button = document.querySelector("#sendBtn");
    const spinner = button?.querySelector(".sendSpinner");
    return input?.value === "" && document.querySelectorAll("#attachmentTray .attachmentItem").length === 0 &&
      button?.disabled && getComputedStyle(spinner).display === "none";
  }, null, { timeout: 3000 });
}

async function toastTexts() {
  return page.evaluate(() => Array.from(document.querySelectorAll(".toast .toastMessage")).map((node) => node.textContent || ""));
}

async function dismissToasts() {
  await page.evaluate(() => {
    document.querySelectorAll(".toast").forEach((node) => node.remove());
  });
}

async function runStep(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, durationMs: Date.now() - startedAt });
  } catch (error) {
    throw new Error(`${name}: ${error.message}\n${JSON.stringify(await collectDiagnostics(), null, 2)}`, { cause: error });
  }
}

async function collectDiagnostics() {
  const ui = page ? await page.evaluate(() => ({
    title: document.querySelector("#mobileThreadTitle")?.textContent || "",
    input: document.querySelector("#promptInput")?.value || "",
    sendLabel: document.querySelector("#sendBtn")?.getAttribute("aria-label") || "",
    sendClass: document.querySelector("#sendBtn")?.className || "",
    toasts: Array.from(document.querySelectorAll(".toast .toastMessage")).map((node) => node.textContent || ""),
    visibleTextTail: (document.body?.innerText || "").slice(-800)
  })).catch((error) => ({ pageError: error.message })) : null;
  const fakeLog = await readFakeLog();
  return {
    ui,
    pageErrors,
    consoleErrors,
    fakeLogTail: fakeLog.slice(-10),
    proxyStderr: proxyStderr.slice(-800),
    bridgeStderr: bridgeStderr.slice(-800)
  };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGKILL");
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
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`等待超时：${label}（${timeoutMs}ms）${lastError ? `，最后一次错误：${lastError.message}` : ""}`);
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

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
