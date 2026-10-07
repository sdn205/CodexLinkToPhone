import { proxyExe, fakeEnv } from "../fixtures/native-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readProxyInstances } from "../fixtures/instance-registry.mjs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { chromium } from "@playwright/test";
import { decodeResponseAnnotations } from "../../public/overlays/response-annotations.js";
import { createPhoneReceiver } from "../../public/transport/phone-receiver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const workDir = process.env.BRIDGE_TEST_DIR || path.join(root, "tests/build", `ui-${Date.now()}`);
const fakeSource = path.join(__dirname, "../fixtures/fake-scenario-app-server.mjs");
const bridgeExecutable = process.env.BRIDGE_TEST_EXE || path.join(root, "server", "dist", "codex-phone-bridge.exe");
const proxyStateFile = path.join(workDir, "proxy-state.json");
const proxyLogFile = path.join(workDir, "proxy.log");
const fakeLogFile = path.join(workDir, "fake.log");
const phoneStateDir = path.join(workDir, "phone-state");
const imageFixture = path.join(workDir, "phone-ui-test.png");
const screenshotDir = process.env.BRIDGE_SCREENSHOT_DIR || path.join(workDir, "screenshots");
const token = "codex-phone-ui-test";

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
await fs.mkdir(screenshotDir, { recursive: true });
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

  await runStep("手机首屏结构、运行态 plan/diff 和布局稳定", async () => {
    await waitForUiReady();
    await page.waitForSelector("#aboveComposer .fixedPlanItem");
    await page.waitForSelector("#aboveComposer .fixedTurnDiffItem");
    await page.waitForFunction(() => {
      const composer = document.querySelector("#composer")?.getBoundingClientRect();
      const diff = document.querySelector("#aboveComposer .fixedTurnDiffItem")?.getBoundingClientRect();
      if (!composer || !diff) return false;
      const join = diff.bottom - composer.top;
      return join >= -0.25 && join <= 2;
    }, null, { timeout: 3000 });
    const facts = await page.evaluate(() => {
      const composer = document.querySelector("#composer").getBoundingClientRect();
      const above = document.querySelector("#aboveComposer").getBoundingClientRect();
      const plan = document.querySelector("#aboveComposer .fixedPlanItem").getBoundingClientRect();
      const diff = document.querySelector("#aboveComposer .fixedTurnDiffItem").getBoundingClientRect();
      return {
        fixedPlanCount: document.querySelectorAll("#aboveComposer .fixedPlanItem").length,
        fixedDiffCount: document.querySelectorAll("#aboveComposer .fixedTurnDiffItem").length,
        fixedInsideTimeline: document.querySelectorAll("#messages .fixedPlanItem, #messages .fixedTurnDiffItem").length,
        timelinePlanCount: document.querySelectorAll('#messages [data-kind="plan"], #messages .planBlock').length,
        visibleEditButtons: document.querySelectorAll(".editMessageButton:not(.isHidden)").length,
        scrollBehavior: getComputedStyle(document.querySelector("#messages")).scrollBehavior,
        bodyWidth: document.body.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        hasVisibleReviewText: /审核更改|Review/i.test(document.body.innerText),
        leftInset: above.left - composer.left,
        rightInset: composer.right - above.right,
        planWidth: plan.width,
        diffWidth: diff.width,
        planDiffGap: diff.top - plan.bottom,
        composerJoin: diff.bottom - composer.top,
        aboveLeft: above.left,
        aboveRight: above.right
      };
    });
    assert.equal(facts.fixedPlanCount, 1, "运行态固定计划应恰好出现一次");
    assert.equal(facts.fixedDiffCount, 1, "运行态固定 diff 应恰好出现一次");
    assert.equal(facts.fixedInsideTimeline, 0, "固定 plan/diff 不能混入消息时间线");
    assert.equal(facts.timelinePlanCount, 0, "运行中的计划也不能进入消息时间线");
    assert.equal(facts.visibleEditButtons, 0, "运行中的消息不能显示画笔");
    assert.equal(facts.scrollBehavior, "auto", "会话消息区不应使用平滑滚动");
    assert.equal(facts.bodyWidth, facts.viewportWidth, "手机页面不能横向溢出");
    assert.equal(facts.hasVisibleReviewText, false, "完成态审核入口不能出现在手机 UI");
    assert(Math.abs(facts.leftInset - 11) <= 0.75 && Math.abs(facts.rightInset - 11) <= 0.75, `固定区应相对输入框左右各内收 11px，实际 ${facts.leftInset}/${facts.rightInset}`);
    assert(Math.abs(facts.planWidth - facts.diffWidth) <= 0.75, "固定 plan 与固定 diff 必须同宽");
    assert(Math.abs(facts.planDiffGap) <= 0.75, `固定 plan 与 diff 之间不能留缝，实际 ${facts.planDiffGap}px`);
    assert(facts.composerJoin >= -0.25 && facts.composerJoin <= 2, `固定区与输入框应重叠 0-2px，实际 ${facts.composerJoin}px`);
    assert(facts.aboveLeft >= 0 && facts.aboveRight <= facts.viewportWidth, "固定区不能横向溢出视口");
    await page.screenshot({ path: path.join(screenshotDir, "after-plan-diff-composer.png") });
  });

  await runStep("权限请求不再显示手机审批界面或锁定发送", async () => {
    await waitFor(() => parentLines.some((line) => line.method === "item/commandExecution/requestApproval"), 5000, "desktop permission request");
    assert.equal(await page.locator("#approvalDock, .approvalActions, .approval").count(), 0);
    assert.equal(await page.getByRole("button", { name: "允许一次", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "停止生成", exact: true }).isEnabled(), true);
    await page.locator("#promptInput").fill("检查发送按钮");
    assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isEnabled(), true);
    await page.locator("#promptInput").fill("");
  });

  await runStep("高视口高度不产生顶部空白且动态重算布局", async () => {
    const readLayout = () => page.evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const value = node.getBoundingClientRect();
        return { top: value.top, bottom: value.bottom, height: value.height };
      };
      const topbar = rect(".topbar");
      const messages = rect("#messages");
      const composer = rect("#composer");
      return {
        viewportHeight: window.visualViewport?.height || window.innerHeight,
        topbar,
        messages,
        composer,
        topbarVar: getComputedStyle(document.documentElement).getPropertyValue("--topbar-height").trim()
      };
    });

    const before = await readLayout();
    await page.setViewportSize({ width: 360, height: 1200 });
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--visual-viewport-height").trim() === "1200px");
    const after = await readLayout();
    assert.equal(after.viewportHeight, 1200, "动态视口高度必须更新");
    assert(Math.abs(after.topbar.top) <= 1, `顶栏必须从视口顶端开始，实际 ${after.topbar.top}px`);
    assert(Math.abs(after.messages.top - after.topbar.bottom - 2) <= 1, `消息区必须紧跟顶栏，实际间距 ${after.messages.top - after.topbar.bottom}px`);
    assert(Math.abs(after.composer.bottom - 1200) <= 1, `输入框必须贴合可视视口底部，实际 ${after.composer.bottom}px`);
    assert(Number.parseFloat(after.topbarVar) === after.topbar.height, "顶栏动态变量必须等于实际高度");
    assert(after.messages.height > before.messages.height, "视口变高时消息区必须实际扩展");
    await page.setViewportSize({ width: 360, height: 780 });
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--visual-viewport-height").trim() === "780px");
  });

  await runStep("Android 顶部安全区不被重复计入内容布局", async () => {
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { top: 40, right: 0, bottom: 0, left: 0 }
      });
      await page.waitForTimeout(50);
      const facts = await page.evaluate(() => {
        const topbar = document.querySelector(".topbar").getBoundingClientRect();
        const messages = document.querySelector("#messages").getBoundingClientRect();
        const sidebarStyle = getComputedStyle(document.querySelector("#sidebar"));
        return {
          topbarTop: topbar.top,
          topbarBottom: topbar.bottom,
          topbarHeight: topbar.height,
          topbarPaddingTop: getComputedStyle(document.querySelector(".topbar")).paddingTop,
          sidebarPaddingTop: sidebarStyle.paddingTop,
          messagesTop: messages.top
        };
      });
      assert(Math.abs(facts.topbarTop) <= 1, `顶栏不能重复避让系统状态栏，实际 top=${facts.topbarTop}px`);
      assert(Math.abs(facts.topbarHeight - 56) <= 1, `顶栏不能叠加安全区高度，实际 ${facts.topbarHeight}px`);
      assert.equal(facts.topbarPaddingTop, "0px", "顶栏不能重复添加顶部安全区内边距");
      assert.equal(facts.sidebarPaddingTop, "14px", "会话列表不能重复添加顶部安全区内边距");
      assert(Math.abs(facts.messagesTop - facts.topbarBottom - 2) <= 1, `消息区必须紧跟顶栏，实际间距 ${facts.messagesTop - facts.topbarBottom}px`);
    } finally {
      await cdp.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { top: 0, right: 0, bottom: 0, left: 0 }
      });
      await cdp.detach();
    }
  });

  await runStep("手机会话列表顶部采用搜索与紧凑新会话布局", async () => {
    await openSidebar();
    await page.waitForTimeout(260);
    const facts = await page.evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        const value = node?.getBoundingClientRect();
        return value ? { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height } : null;
      };
      const style = (selector) => getComputedStyle(document.querySelector(selector));
      const searchStyle = style(".threadSearch");
      const newButtonStyle = style("#newThreadBtn");
      const dividerStyle = style(".threadListDivider > span");
      const firstItem = document.querySelector(".threadItem");
      return {
        brandDisplay: style(".sidebarHeader .brand").display,
        closeButton: rect("#sidebarCloseBtn"),
        toolbar: rect(".threadToolbar"),
        search: rect(".threadSearch"),
        newButton: rect("#newThreadBtn"),
        divider: rect(".threadListDivider"),
        dividerLine: rect(".threadListDivider > span"),
        refresh: rect("#refreshBtn"),
        list: rect("#threadList"),
        firstItem: rect(".threadItem"),
        firstItemColumns: firstItem ? style(".threadItem").gridTemplateColumns : "",
        searchBackground: searchStyle.backgroundColor,
        searchBorderWidth: searchStyle.borderTopWidth,
        searchRadius: searchStyle.borderRadius,
        placeholder: document.querySelector("#threadSearchInput")?.placeholder || "",
        searchIconCount: document.querySelectorAll(".threadSearch > svg").length,
        newButtonText: document.querySelector("#newThreadBtn")?.textContent?.trim() || "",
        newButtonBackground: newButtonStyle.backgroundColor,
        newButtonColor: newButtonStyle.color,
        newButtonFontSize: Number.parseFloat(newButtonStyle.fontSize),
        dividerBackground: dividerStyle.backgroundImage
      };
    });
    assert.equal(facts.brandDisplay, "none", "手机会话列表首行不能再显示大号品牌头");
    assert.equal(facts.closeButton, null, "手机会话列表不应显示叉号关闭按钮");
    assert.equal(facts.placeholder, "搜索", "搜索框占位文案应与豆包式搜索一致");
    assert.equal(facts.searchIconCount, 1, "搜索框左侧必须有搜索图标");
    assert.equal(facts.searchBackground, "rgb(237, 237, 240)", "搜索框应使用浅灰填充");
    assert.equal(facts.searchBorderWidth, "0px", "搜索框不能使用明显边框");
    assert.equal(facts.newButtonText, "新会话", "紧凑主按钮文案必须为新会话");
    assert.equal(facts.newButtonBackground, "rgb(24, 24, 27)", "新会话按钮必须为黑底");
    assert.equal(facts.newButtonColor, "rgb(255, 255, 255)", "新会话按钮必须为白字");
    assert(facts.newButton.height <= 34 && facts.newButton.height >= facts.newButtonFontSize + 14, `新会话按钮应只比文字大一圈，实际 ${facts.newButton.width}x${facts.newButton.height}`);
    assert(Math.abs((facts.search.top + facts.search.bottom) / 2 - (facts.newButton.top + facts.newButton.bottom) / 2) <= 1, "搜索框和新会话按钮必须垂直居中");
    assert(facts.search.right < facts.newButton.left && facts.newButton.right <= facts.toolbar.right + 1, "首行必须左侧搜索、右侧新会话且不溢出");
    assert(facts.dividerBackground.includes("linear-gradient"), "列表分隔线必须使用柔和渐隐线");
    assert(facts.dividerLine.height === 1 && facts.dividerLine.width >= facts.toolbar.width - 1, "分隔线必须为贯穿整行的细线");
    assert.equal(facts.refresh, null, "手机会话列表不应显示刷新按钮");
    assert(facts.list.top > facts.divider.bottom && facts.firstItem.width === facts.list.width, "原有会话条目必须在分隔线下方保持整行宽度");
    assert(facts.firstItemColumns.includes("20px"), "原有会话状态列结构不能改变");

    for (const viewportWidth of [320, 360, 390, 412, 430]) {
      await page.setViewportSize({ width: viewportWidth, height: 780 });
      const layout = await page.evaluate(() => {
        const rect = (selector) => {
          const value = document.querySelector(selector)?.getBoundingClientRect();
          return value ? { left: value.left, right: value.right, width: value.width } : null;
        };
        return {
          sidebar: rect("#sidebar"),
          toolbar: rect(".threadToolbar"),
          search: rect(".threadSearch"),
          newButton: rect("#newThreadBtn"),
          bodyWidth: document.body.scrollWidth,
          viewportWidth: document.documentElement.clientWidth
        };
      });
      const expectedWidth = Math.min(300, Math.max(240, viewportWidth * 0.8));
      assert(Math.abs(layout.sidebar.width - expectedWidth) <= 0.75, `${viewportWidth}px 视口下会话列表宽度应为 ${expectedWidth}px，实际 ${layout.sidebar.width}px`);
      assert(layout.search.right < layout.newButton.left && layout.newButton.right <= layout.toolbar.right + 1, `${viewportWidth}px 视口下搜索与新会话按钮不能挤压或溢出`);
      assert.equal(layout.bodyWidth, layout.viewportWidth, `${viewportWidth}px 视口下会话列表不能造成横向溢出`);
    }
    await page.setViewportSize({ width: 360, height: 780 });
    await page.evaluate(() => document.querySelector("#sidebarBackdrop")?.click());
    await page.waitForFunction(() => !document.querySelector("#sidebar")?.classList.contains("open"));
  });

  await runStep("思考摘要任何情况下都不显示", async () => {
    await parentRequest("test/reasoning-summary");
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".reasoningBlock").count(), 0, "reasoning 消息不能渲染成思考摘要卡片");
    assert.equal(await page.locator(".reasoningHeader").count(), 0, "不能出现思考摘要标题");
    assert.equal(await page.getByText("思考摘要").count(), 0, "页面不能出现“思考摘要”字样");
  });

  await runStep("手机返回键关闭会话列表且保留当前对话", async () => {
    const readMainState = () => page.evaluate(() => ({
      url: location.href,
      title: document.querySelector("#mobileThreadTitle")?.textContent || "",
      activeThreadId: document.querySelector(".threadItem.active")?.dataset.threadId || "",
      input: document.querySelector("#promptInput")?.value || "",
      messageIds: Array.from(document.querySelectorAll("#messages .message"), (node) => node.dataset.messageId || "")
    }));

    await page.locator("#promptInput").fill("返回会话列表后保留这条草稿");
    const before = await readMainState();
    const fakeLogOffset = (await readFakeLog()).length;

    await openSidebar();
    const opened = await page.evaluate(() => ({
      sidebarOpen: document.querySelector("#sidebar")?.classList.contains("open"),
      expanded: document.querySelector("#menuBtn")?.getAttribute("aria-expanded"),
      historyOpen: history.state?.__codexPhoneSidebarOpen === true
    }));
    assert.deepEqual(opened, { sidebarOpen: true, expanded: "true", historyOpen: true }, "打开列表时应建立唯一的手机返回状态");

    await page.evaluate(() => history.back());
    await page.waitForFunction(() => !document.querySelector("#sidebar")?.classList.contains("open"));
    assert.deepEqual(await readMainState(), before, "手机返回只能关闭列表，不能改变当前对话、消息或草稿");
    assert.equal(await page.locator("#menuBtn").getAttribute("aria-expanded"), "false", "手机返回后列表按钮应恢复关闭状态");
    assert.equal(await page.evaluate(() => history.state?.__codexPhoneSidebarOpen === true), false, "手机返回后不能残留列表历史状态");

    await openSidebar();
    await page.locator("#sidebarBackdrop").evaluate((button) => {
      button.click();
      button.click();
    });
    await page.waitForFunction(() => !document.querySelector("#sidebar")?.classList.contains("open"));
    assert.deepEqual(await readMainState(), before, "重复关闭调用不能连续返回或离开当前页面");
    assert.equal(await page.evaluate(() => history.state?.__codexPhoneSidebarOpen === true), false, "遮罩关闭必须消费列表历史状态");

    const navigationRequests = (await readFakeLog()).slice(fakeLogOffset).filter((entry) =>
      entry.type === "request" && ["thread/open", "thread/read"].includes(entry.method)
    );
    assert.deepEqual(navigationRequests, [], "打开或返回会话列表不能触发后端会话操作");
    await page.locator("#promptInput").fill("");
  });

  await runStep("页面回到前台主动同步且保留当前会话", async () => {
    const beforeMessageCount = await page.locator("#messages .message").count();
    const titleBefore = await page.locator("#mobileThreadTitle").textContent();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const immediate = await page.evaluate(() => ({
      messageCount: document.querySelectorAll("#messages .message").length,
      title: document.querySelector("#mobileThreadTitle")?.textContent || ""
    }));
    assert(immediate.messageCount >= beforeMessageCount && immediate.messageCount > 0, "回到前台时已确认消息不能被清空");
    assert.equal(immediate.title, titleBefore, "回到前台时当前会话不能变化");
    await page.waitForFunction((title) => document.querySelector("#mobileThreadTitle")?.textContent === title, titleBefore);
    assert.equal(await page.locator("body").evaluate((node) => node.classList.contains("codexDisconnected")), false, "前台同步成功后应保持连接状态");
  });

  await runStep("Enter 只换行且图文草稿按会话隔离", async () => {
    await parentRequest("test/pc-other-thread");
    await openSidebar();
    await page.getByRole("button", { name: /电脑端其他会话/ }).waitFor();
    const steerBefore = countFakeRequests("turn/steer", await readFakeLog());

    await page.locator("#promptInput").fill("第一行");
    await page.locator("#promptInput").press("Enter");
    await page.locator("#promptInput").type("第二行");
    await page.locator("#imageInput").setInputFiles(imageFixture);
    await page.waitForSelector("#attachmentTray .attachmentItem");
    assert.equal(await page.locator("#promptInput").inputValue(), "第一行\n第二行", "Enter 应插入换行");
    assert.equal(countFakeRequests("turn/steer", await readFakeLog()), steerBefore, "Enter 不能提交消息");

    await openSidebar();
    await page.getByRole("button", { name: /电脑端其他会话/ }).click();
    await waitForThreadTitle("电脑端其他会话");
    assert.equal(await page.locator("#promptInput").inputValue(), "", "其他会话不能继承文字草稿");
    assert.equal(await page.locator("#attachmentTray .attachmentItem").count(), 0, "其他会话不能继承图片草稿");

    await openSidebar();
    await page.getByRole("button", { name: /电脑正在运行的会话/ }).click();
    await waitForThreadTitle("电脑正在运行的会话");
    assert.equal(await page.locator("#promptInput").inputValue(), "第一行\n第二行", "切回后应恢复原会话文字草稿");
    assert.equal(await page.locator("#attachmentTray .attachmentItem").count(), 1, "切回后应恢复原会话图片草稿");

    await page.locator("#promptInput").fill("");
    await page.getByRole("button", { name: "移除图片" }).click();
  });

  await runStep("会话列表顶部下拉清除所有未读消息", async () => {
    await parentRequest("test/complete-thread-b");
    await page.waitForSelector('.threadItem[data-thread-id="thread-b"] .threadStatusIndicator.unread', { state: "attached", timeout: 5000 });
    await openSidebar();
    await page.evaluate(() => {
      const list = document.querySelector("#threadList");
      const event = (type, y) => {
        const next = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(next, "touches", { value: [{ clientY: y }] });
        list.dispatchEvent(next);
      };
      list.scrollTop = 0;
      event("touchstart", 100);
      event("touchmove", 190);
    });
    await page.waitForFunction(() => {
      const reveal = document.querySelector("#clearUnreadReveal");
      return Number.parseFloat(getComputedStyle(reveal).height) >= 52 && reveal.getAttribute("aria-hidden") === "false";
    });
    await page.evaluate(() => {
      const list = document.querySelector("#threadList");
      const event = new Event("touchend", { bubbles: true });
      Object.defineProperty(event, "touches", { value: [] });
      list.dispatchEvent(event);
    });
    await page.waitForFunction(() => {
      const reveal = document.querySelector("#clearUnreadReveal");
      return Number.parseFloat(getComputedStyle(reveal).height) >= 52 && reveal.getAttribute("aria-hidden") === "false";
    });
    await page.locator("#clearUnreadBtn").click();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll(".threadStatusIndicator.unread")).length, null, { timeout: 5000 });
    await page.waitForFunction(() => Number.parseFloat(getComputedStyle(document.querySelector("#clearUnreadReveal")).height) === 0);
    await page.locator("#sidebarBackdrop").evaluate((backdrop) => backdrop.click());
    await page.waitForFunction(() => !document.querySelector("#sidebar")?.classList.contains("open"));
  });

  await runStep("用户上滑后流式更新不抢滚动位置", async () => {
    await parentRequest("test/long-text");
    await page.getByText("LONG_TEXT_SYNC_END", { exact: false }).waitFor();
    const before = await page.evaluate(() => {
      const messages = document.querySelector("#messages");
      messages.scrollTop = messages.scrollHeight;
      messages.scrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight - 420);
      messages.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      messages.dispatchEvent(new Event("scroll", { bubbles: true }));
      return {
        scrollTop: messages.scrollTop,
        scrollHeight: messages.scrollHeight,
        distance: messages.scrollHeight - messages.scrollTop - messages.clientHeight
      };
    });
    assert(before.distance > 150, "测试必须先离开消息底部");

    await parentRequest("test/reconnect-delta");
    await page.getByText("断线期间输出。", { exact: false }).waitFor();
    await page.waitForTimeout(220);
    const after = await page.evaluate(() => {
      const messages = document.querySelector("#messages");
      return {
        scrollTop: messages.scrollTop,
        scrollHeight: messages.scrollHeight,
        distance: messages.scrollHeight - messages.scrollTop - messages.clientHeight,
        bottomButtonVisible: document.querySelector("#scrollBottomBtn").classList.contains("show")
      };
    });
    assert(Math.abs(after.scrollTop - before.scrollTop) < 12, `流式更新不能把用户拉回底部 beforeTop=${before.scrollTop} afterTop=${after.scrollTop} beforeDistance=${before.distance} afterDistance=${after.distance} beforeHeight=${before.scrollHeight} afterHeight=${after.scrollHeight}`);
    assert(after.distance > 150, `流式更新后仍应保持离开底部 beforeDistance=${before.distance} afterDistance=${after.distance} beforeTop=${before.scrollTop} afterTop=${after.scrollTop}`);
    assert.equal(after.bottomButtonVisible, true, "离开底部后应显示回到底部按钮");

    await page.locator("#scrollBottomBtn").click();
    await page.waitForTimeout(100);
    const distanceAfterClick = await page.locator("#messages").evaluate((messages) =>
      messages.scrollHeight - messages.scrollTop - messages.clientHeight
    );
    assert(distanceAfterClick < 80, "回到底部按钮应立即贴近底部");
  });

  await runStep("完成态 diff 位于最终回复之后且固定区域清空", async () => {
    await parentRequest("test/complete");
    await page.getByText("复杂场景已完成", { exact: false }).waitFor();
    await page.waitForSelector("#messages .completedTurnDiffMessage");
    const facts = await page.evaluate(() => {
      const finalReply = document.querySelector(`[data-message-id="${window.__recoveryTest.messageIds["assistant-final-a"]}"]`);
      const completedDiff = document.querySelector("#messages .completedTurnDiffMessage");
      const timelineFile = document.querySelector(`[data-message-id="${window.__recoveryTest.messageIds["file-a"]}"]`);
      const commandGroup = document.querySelector("#messages .commandGroupMessage");
      const commandRow = commandGroup?.querySelector(".commandGroupRow");
      const commandBody = commandGroup?.querySelector(".commandGroupBody");
      return {
        fixedPlanCount: document.querySelectorAll("#aboveComposer .fixedPlanItem").length,
        fixedDiffCount: document.querySelectorAll("#aboveComposer .fixedTurnDiffItem").length,
        completedPlanCount: document.querySelectorAll('#messages [data-kind="plan"], #messages .completedPlanMessage, #messages .planBlock').length,
        completedDiffCount: document.querySelectorAll("#messages .completedTurnDiffMessage").length,
        commandGroupCount: document.querySelectorAll("#messages .commandGroupMessage").length,
        commandLabel: commandGroup?.querySelector(".commandGroupLabel")?.textContent?.trim() || "",
        commandIconCount: commandGroup?.querySelectorAll(".commandGroupIcon svg").length || 0,
        commandChevronCount: commandGroup?.querySelectorAll(".commandGroupChevron svg").length || 0,
        commandExpanded: commandRow?.getAttribute("aria-expanded"),
        commandBodyHidden: Boolean(commandBody?.hidden),
        ungroupedCommandCount: document.querySelectorAll(`#messages > [data-message-id="${window.__recoveryTest.messageIds["cmd-a"]}"]`).length,
        timelineBeforeFinal: Boolean(timelineFile && finalReply && (timelineFile.compareDocumentPosition(finalReply) & Node.DOCUMENT_POSITION_FOLLOWING)),
        completedAfterFinal: Boolean(finalReply && completedDiff && (finalReply.compareDocumentPosition(completedDiff) & Node.DOCUMENT_POSITION_FOLLOWING))
      };
    });
    assert.equal(facts.fixedPlanCount, 0, "完成后固定计划应移出输入框上方");
    assert.equal(facts.fixedDiffCount, 0, "完成后固定 diff 应移出输入框上方");
    assert.equal(facts.completedPlanCount, 0, "完成后的计划不能进入消息时间线");
    assert.equal(facts.completedDiffCount, 1, "完成态 diff 卡片应恰好出现一次");
    assert.equal(facts.commandGroupCount, 1, "即使只有一条命令，也必须显示一个命令折叠组");
    assert.equal(facts.commandLabel, "运行了命令", "命令折叠组收起态只能显示运行了命令");
    assert.equal(facts.commandIconCount, 1, "命令折叠组必须显示终端图标");
    assert.equal(facts.commandChevronCount, 1, "命令折叠组必须显示右箭头");
    assert.equal(facts.commandExpanded, "false", "命令折叠组必须默认收起");
    assert.equal(facts.commandBodyHidden, true, "默认状态不能显示原命令块");
    assert.equal(facts.ungroupedCommandCount, 0, "命令不能绕过折叠组直接出现在时间线");
    assert.equal(facts.timelineBeforeFinal, true, "对话流文件变更应保留在最终回复之前的原始位置");
    assert.equal(facts.completedAfterFinal, true, "完成态 diff 应跟在最终回复之后");

    await page.getByRole("button", { name: "运行了命令", exact: true }).click();
    const expandedCommand = await page.evaluate(() => {
      const group = document.querySelector("#messages .commandGroupMessage");
      const command = group?.querySelector(`[data-message-id="${window.__recoveryTest.messageIds["cmd-a"]}"]`);
      return {
        expanded: group?.querySelector(".commandGroupRow")?.getAttribute("aria-expanded"),
        bodyHidden: Boolean(group?.querySelector(".commandGroupBody")?.hidden),
        commandCount: group?.querySelectorAll(".commandGroupBody > .toolBlock").length || 0,
        commandTitle: command?.querySelector(".cmdLabel")?.textContent?.trim() || "",
        originalCommandExpanded: command?.classList.contains("expanded") || false
      };
    });
    assert.equal(expandedCommand.expanded, "true", "点击命令折叠组后箭头和展开状态必须同步");
    assert.equal(expandedCommand.bodyHidden, false, "展开后必须显示原命令块");
    assert.equal(expandedCommand.commandCount, 1, "单条命令展开后仍必须复用一个原命令块");
    assert.equal(expandedCommand.commandTitle, "npm test", "原有单条命令标题不能改变");
    assert.equal(expandedCommand.originalCommandExpanded, false, "原有单条命令自己的折叠状态不能改变");
  });

  await runStep("返回历史会话后各 turn 的对话流 diff 与完成态 diff 顺序稳定", async () => {
    const fixture = (await parentRequest("test/create-snapshot-alias-thread")).result;
    await openSidebar();
    await page.locator(`.threadItem[data-thread-id="${fixture.threadId}"]`).click();
    await waitForThreadTitle("快照实时消息合并");
    const snapshotUser = page.locator("#messages .message").filter({ hasText: "快照重复问题" }).first();
    await snapshotUser.waitFor();
    const snapshotUserId = await snapshotUser.getAttribute("data-message-id");
    assert(snapshotUserId, "快照用户消息必须具有稳定 canonical ID");
    await page.locator(await messageSelector("item-902")).waitFor();
    await page.locator(await messageSelector("canonical-alias-assistant")).waitFor();
    await page.locator(await messageSelector("item-903")).waitFor();
    await page.locator("#messages .completedTurnDiffMessage").waitFor();
    await assertSnapshotAliasDomOrder({ userId: snapshotUserId, assistantId: "canonical-alias-assistant", stage: "首次打开" });

    await parentRequest("test/emit-snapshot-alias-live-items");
    await page.locator(`[data-message-id="${snapshotUserId}"]`).waitFor();
    await page.locator(await messageSelector("canonical-alias-assistant")).waitFor();
    await assertSnapshotAliasDomOrder({
      userId: snapshotUserId,
      assistantId: "canonical-alias-assistant",
      stage: "迟到实时事件后"
    });

    await openSidebar();
    await page.locator('.threadItem[data-thread-id="thread-a"]').click();
    await waitForThreadTitle("电脑正在运行的会话");
    await openSidebar();
    await page.locator(`.threadItem[data-thread-id="${fixture.threadId}"]`).click();
    await waitForThreadTitle("快照实时消息合并");
    await page.locator(await messageSelector("canonical-alias-assistant")).waitFor();
    await assertSnapshotAliasDomOrder({
      userId: snapshotUserId,
      assistantId: "canonical-alias-assistant",
      stage: "A-B-A 切回后"
    });

    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(250);
    await page.locator(await messageSelector("canonical-alias-assistant")).waitFor();
    await assertSnapshotAliasDomOrder({
      userId: snapshotUserId,
      assistantId: "canonical-alias-assistant",
      stage: "回到前台后"
    });
    await page.screenshot({ path: path.join(screenshotDir, "historical-diff-order.png") });
  });

  await runStep("停止后画笔编辑文字并丢弃原图片", async () => {
    const fixture = (await parentRequest("test/create-edit-history", {
      threadId: "thread-edit-ui",
      oldText: "手机画笔修改前文字"
    })).result;
    await openSidebar();
    await page.locator(`.threadItem[data-thread-id="${fixture.threadId}"]`).click();
    await waitForThreadTitle("消息编辑回归");
    await page.getByText(fixture.oldText, { exact: true }).waitFor();
    await page.locator(".message.user .messageImage").waitFor();
    const editButton = page.getByRole("button", { name: "编辑消息" });
    await editButton.waitFor();
    assert.equal(await editButton.isVisible(), true, "停止后最新用户消息必须显示画笔");
    await page.screenshot({ path: path.join(screenshotDir, "message-edit-pencil.png") });

    await editButton.click();
    const inlineEditor = page.locator(".inlineMessageEditor");
    const inlineInput = inlineEditor.locator(".inlineMessageEditorInput");
    await inlineInput.waitFor();
    assert.equal(await inlineInput.inputValue(), fixture.oldText, "点击画笔后应在原消息位置回填原文字");
    assert.equal(await page.locator("#attachmentTray .attachmentItem").count(), 0, "进入编辑后必须清空原图片");
    assert.equal(await page.locator("#uploadBtn").isDisabled(), true, "编辑重发期间不能重新携带原图片");

    const editedText = "手机画笔修改后的唯一文字";
    const before = await readFakeLog();
    await inlineInput.fill(editedText);
    await inlineEditor.locator(".inlineMessageEditorSubmit").click();
    await page.waitForFunction(({ oldText, editedText }) => {
      const bodyText = document.querySelector("#messages")?.innerText || "";
      return bodyText.includes(editedText) && !bodyText.includes(oldText) && document.querySelectorAll(".message.user .messageImage").length === 0;
    }, { oldText: fixture.oldText, editedText }, { timeout: 10_000 });
    const requests = (await readFakeLog()).slice(before.length).filter((entry) => entry.type === "request" && entry.params?.threadId === fixture.threadId);
    const reverts = requests.filter((entry) => entry.method === "thread/revert");
    const starts = requests.filter((entry) => entry.method === "turn/start" && entry.params?.input?.some((input) => input?.text === editedText));
    assert.equal(reverts.length, 1, "UI 编辑只能 revert 一次");
    assert.equal(reverts[0].params?.beforeTurnId, fixture.editTurnId, "UI 编辑必须从目标 turn 开始回退");
    assert.equal(starts.length, 1, "UI 编辑只能启动一个新 turn");
    assert.equal(starts[0].params.input.length, 1, "UI 编辑重发不能携带旧图片 input");
    assert.equal(starts[0].params.input[0].type, "text", "UI 编辑重发只发送文字 input");
    assert.equal(await page.getByText(editedText, { exact: true }).count(), 1, "修改后的消息在手机端只能显示一条");
    await parentRequest("test/complete-phone-turn", { threadId: fixture.threadId });
    await page.waitForFunction(() => !document.body.classList.contains("isBusy"));
  });

  await runStep("画笔编辑 revert 后发送失败可直接重试", async () => {
    const fixture = (await parentRequest("test/create-edit-history", {
      threadId: "thread-edit-ui-retry",
      oldText: "画笔重试前文字"
    })).result;
    await openSidebar();
    await page.locator(`.threadItem[data-thread-id="${fixture.threadId}"]`).click();
    await waitForThreadTitle("消息编辑回归");
    await page.getByText(fixture.oldText, { exact: true }).waitFor();
    await page.getByRole("button", { name: "编辑消息" }).click();
    const editedText = "编辑首发失败后重试";
    const before = await readFakeLog();
    const inlineEditor = page.locator(".inlineMessageEditor");
    const inlineInput = inlineEditor.locator(".inlineMessageEditorInput");
    await inlineInput.fill(editedText);
    await inlineEditor.locator(".inlineMessageEditorSubmit").click();
    await page.waitForFunction((text) => {
      const input = document.querySelector(".inlineMessageEditorInput");
      const button = document.querySelector(".inlineMessageEditorSubmit");
      return input?.value === text && !input.readOnly && !button?.disabled && !button?.classList.contains("isSending");
    }, editedText, { timeout: 10_000 });
    await inlineEditor.locator(".inlineMessageEditorSubmit").click();
    await page.waitForFunction((text) => {
      const bodyText = document.querySelector("#messages")?.innerText || "";
      return bodyText.includes(text) && document.querySelector("#promptInput")?.value === "";
    }, editedText, { timeout: 10_000 });
    await waitFor(async () => {
      const log = (await readFakeLog()).slice(before.length);
      return log.filter((entry) =>
        entry.type === "request" &&
        entry.method === "turn/start" &&
        entry.params?.threadId === fixture.threadId &&
        entry.params?.input?.some((input) => input?.text === editedText)
      ).length >= 2;
    }, 5000, "重试的第二次 turn/start 必须到达 fake server");
    const requests = (await readFakeLog()).slice(before.length).filter((entry) => entry.type === "request" && entry.params?.threadId === fixture.threadId);
    assert.equal(requests.filter((entry) => entry.method === "thread/revert").length, 1, "UI 重试不能再次 revert");
    assert.equal(requests.filter((entry) => entry.method === "turn/start" && entry.params?.input?.some((input) => input?.text === editedText)).length, 2, "UI 应在首次发送失败后只重试 turn/start");
    await parentRequest("test/complete-phone-turn", { threadId: fixture.threadId });
    await page.waitForFunction(() => !document.body.classList.contains("isBusy"));
  });

  await runStep("新会话先显示首条消息摘要并自动替换为模型标题", async () => {
    await createNewThreadFromUi();
    const prompt = "请帮我验证手机标题会被模型自动替换";
    await page.locator("#promptInput").fill(prompt);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction((expected) => document.querySelector("#mobileThreadTitle")?.textContent === expected, prompt, { timeout: 5000 });
    await waitForThreadTitle("修复手机端会话标题");
    const titleRequest = (await readFakeLog()).find((entry) =>
      entry.type === "request" &&
      entry.method === "turn/start" &&
      entry.params?.input?.some((input) => input?.type === "text" && input.text === prompt)
    );
    assert(titleRequest?.params?.threadId, "标题 UI 回归必须找到手机首条 turn");
    await parentRequest("test/complete-phone-turn", { threadId: titleRequest.params.threadId });
    await page.waitForFunction(() => !document.body.classList.contains("isBusy"));
  });

  await runStep("新建会话重连恢复发送，完整输出跨前台恢复、分页和会话切换保留", async () => {
    for (let index = 0; index < 3; index++) {
      const before = await page.evaluate(() => window.__recoveryTest.states.length);
      await createNewThreadFromUi();
      await page.waitForFunction((count) => window.__recoveryTest.states.length > count, before);
    }
    const prompt = "recovery contract initial message";
    await page.locator("#promptInput").fill(prompt);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const start = await waitFor(async () => (await readFakeLog()).find((entry) =>
      entry.method === "turn/start" && entry.params?.input?.some((input) => input.text === prompt)), 5000, "recovery thread start");
    const threadId = start.params.threadId;
    await parentRequest("test/complete-phone-turn", { threadId });
    await page.waitForFunction(() => !document.body.classList.contains("isBusy"));

    const output = "HEAD\n" + "命令输出甲\n".repeat(1000) + "\nMIDDLE-ORIGINAL\n" + "命令输出乙\n".repeat(750) + "\nTAIL";
    await parentRequest("test/set-command-output", { threadId, output, earlierCount: 220 });
    const tool = page.locator(".toolBlock").filter({ has: page.locator(".cmdLabel", { hasText: "recovery-output" }) });
    const readOutput = () => tool.locator(".cmdOutputWrap pre").textContent();
    async function expandCommand() {
      const group = page.locator(".commandGroupMessage").filter({ has: tool }).locator(".commandGroupRow");
      if (await group.getAttribute("aria-expanded") !== "true") await group.click();
      const row = tool.locator(".cmdRow");
      if (await row.getAttribute("aria-expanded") !== "true") await row.click();
    }
    await tool.waitFor({ state: "attached" });
    await expandCommand();
    await tool.locator(".cmdLoadFull").click();
    await waitFor(async () => await readOutput() === output, 5000, "full command output");

    const beforeForeground = await page.evaluate(() => window.__recoveryTest.states.length);
    await page.evaluate(() => {
      for (const visibility of ["hidden", "visible"]) {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
        document.dispatchEvent(new Event("visibilitychange"));
      }
      delete document.visibilityState;
    });
    await page.waitForFunction((count) => window.__recoveryTest.states.length > count, beforeForeground);
    assert.equal(await readOutput(), output, "切回前台的全量状态不能覆盖完整输出");
    const beforePaging = await page.evaluate(() => window.__recoveryTest.states.length);
    await page.locator("[data-load-earlier-messages]").click();
    await page.waitForFunction((count) => window.__recoveryTest.states.length > count, beforePaging);
    assert.equal(await readOutput(), output, "加载旧消息不能覆盖完整输出");

    await openSidebar();
    await page.locator('.threadItem[data-thread-id="thread-a"]').click();
    await waitForThreadTitle("电脑正在运行的会话");
    await openSidebar();
    await page.locator(`.threadItem[data-thread-id="${threadId}"]`).click();
    await tool.waitFor({ state: "attached" });
    await expandCommand();
    assert.equal(await readOutput(), output, "切回会话应使用缓存的完整输出");

    const beforeReconnect = await page.evaluate(() => {
      const test = window.__recoveryTest;
      const before = { ...test.states.at(-1), count: test.states.length, connections: test.sockets.length };
      test.sockets.at(-1).close(1000, "recovery regression");
      return before;
    });
    await page.waitForFunction((before) => window.__recoveryTest.sockets.length > before.connections && window.__recoveryTest.states.length > before.count, beforeReconnect);
    const afterReconnect = await page.evaluate(() => window.__recoveryTest.states.at(-1));
    assert.equal(afterReconnect.epoch, beforeReconnect.epoch, "手机桥没有重启");
    assert(afterReconnect.revision < beforeReconnect.revision, "必须覆盖新连接版本号比旧连接低的场景");
    assert.equal(await readOutput(), output, "断线重连后完整输出仍然可读");

    const corrected = output.replace("MIDDLE-ORIGINAL", "MIDDLE-CORRECT!");
    await parentRequest("test/set-command-output", { threadId, output: corrected });
    await tool.locator(".cmdLoadFull").waitFor();
    await tool.locator(".cmdLoadFull").click();
    await waitFor(async () => await readOutput() === corrected, 5000, "corrected hidden output");
    await page.locator("#promptInput").fill("recovery contract after reconnect");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await waitFor(async () => (await readFakeLog()).find((entry) => entry.method === "turn/start" && entry.params?.threadId === threadId && entry.params.input.some((input) => input.text === "recovery contract after reconnect")), 5000, "send after reconnect");
    await parentRequest("test/complete-phone-turn", { threadId });
  });

  await runStep("发送后立即清空且确认前不转圈，断线只提交一次", async () => {
    await createNewThreadFromUi();
    const emptyTitle = await page.locator(".emptyHero span").textContent();
    assert(emptyTitle && !emptyTitle.endsWith("⌄"), "起始页会话名后不能出现字符箭头");

    await page.locator("#promptInput").fill("断线重发只发送一次");
    await page.locator("#imageInput").setInputFiles(imageFixture);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await assertClearedComposer();

    await context.setOffline(true);
    await page.waitForTimeout(520);
    await assertClearedComposer();
    await context.setOffline(false);

    await page.waitForFunction(() => {
      const input = document.querySelector("#promptInput");
      const button = document.querySelector("#sendBtn");
      return input.value === "" && document.querySelectorAll("#attachmentTray .attachmentItem").length === 0 && !button.disabled && !button.classList.contains("isSending");
    }, null, { timeout: 10_000 });

    const matchingStarts = (await readFakeLog()).filter((entry) =>
      entry.type === "request" &&
      entry.method === "turn/start" &&
      entry.params?.input?.some((input) => input?.type === "text" && input.text === "断线重发只发送一次")
    );
    assert.equal(matchingStarts.length, 1, "断线重连后同一 UI 提交只能启动一个 turn");
    await parentRequest("test/complete-phone-turn", { threadId: matchingStarts[0].params.threadId });
  });

  await runStep("提交回执独立于消息事件，长输入发送和历史恢复保持同一消息", async () => {
    await createNewThreadFromUi();
    const input = page.locator("#promptInput");
    const emptyHeight = await input.evaluate(node => node.getBoundingClientRect().height);
    const text = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行：提交后消息立即可见，输入框恢复高度`).join("\n");
    await input.fill(text);
    const expandedHeight = await input.evaluate(node => node.getBoundingClientRect().height);
    assert(expandedHeight > emptyHeight + 60);
    await parentRequest("test/hold-next-user-event");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#promptInput").value === "");
    assert(Math.abs(await input.evaluate(node => node.getBoundingClientRect().height) - emptyHeight) <= 1, "发送清空必须同步恢复高度");
    await page.waitForFunction(text => [...document.querySelectorAll("#messages .message.user")].some(node => node.innerText.includes(text)), text);
    const start = await waitFor(async () => (await readFakeLog()).find(entry => entry.method === "turn/start" && entry.params?.input?.some(input => input.text === text)), 5000, "receipt before user event");
    const tid = start.params.threadId;
    const identity = await page.locator("#messages .message.user").last().getAttribute("data-message-id");
    await selectThread("thread-b");
    await selectThread(tid);
    await page.reload();
    await waitForUiReady();
    await page.waitForFunction(text => [...document.querySelectorAll("#messages .message.user")].filter(node => node.innerText.includes(text)).length === 1, text);
    assert(Math.abs(await input.evaluate(node => node.getBoundingClientRect().height) - emptyHeight) <= 1);
    await parentRequest("test/release-user-event", { threadId: tid });
    await parentRequest("test/complete-phone-turn", { threadId: tid });
    await page.waitForFunction(() => !document.body.classList.contains("isBusy"));
    const users = await page.locator("#messages .message.user").evaluateAll((nodes, text) => nodes.filter(node => node.innerText.includes(text)).map(node => node.dataset.messageId), text);
    assert.deepEqual(users, [identity]);
    await page.screenshot({ path: path.join(screenshotDir, "accepted-message-and-empty-composer.png") });

    // The same draft render path must grow again on failure and shrink on retry.
    const failedText = `失败图片发送\n${text}`;
    await input.fill(failedText);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#promptInput").value === "");
    assert(Math.abs(await input.evaluate(node => node.getBoundingClientRect().height) - emptyHeight) <= 1);
    await page.waitForFunction(text => document.querySelector("#promptInput").value === text, failedText);
    assert.equal(await input.evaluate(node => node.getBoundingClientRect().height), expandedHeight);
    await input.fill("");
    assert(Math.abs(await input.evaluate(node => node.getBoundingClientRect().height) - emptyHeight) <= 1);
  });

  await runStep("发送成功后延迟草稿读取不能把原文灌回输入框", async () => {
    const fixture = (await parentRequest("test/create-edit-history", {
      threadId: "thread-draft-clear-race",
      oldText: "草稿竞态历史消息"
    })).result;
    await page.evaluate(() => {
      const delayedRequests = new WeakSet();
      const originalGet = IDBObjectStore.prototype.get;
      const successDescriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess");
      if (!successDescriptor?.get || !successDescriptor?.set) throw new Error("浏览器不支持草稿竞态测试");

      IDBObjectStore.prototype.get = function delayedDraftGet(...args) {
        const request = originalGet.apply(this, args);
        if (this.name === "drafts") delayedRequests.add(request);
        return request;
      };
      Object.defineProperty(IDBRequest.prototype, "onsuccess", {
        ...successDescriptor,
        set(handler) {
          if (!delayedRequests.has(this) || typeof handler !== "function") {
            successDescriptor.set.call(this, handler);
            return;
          }
          successDescriptor.set.call(this, function delayedDraftSuccess(event) {
            setTimeout(() => handler.call(this, event), 700);
          });
        }
      });
      window.__restoreDraftRaceDelay = () => {
        IDBObjectStore.prototype.get = originalGet;
        Object.defineProperty(IDBRequest.prototype, "onsuccess", successDescriptor);
        delete window.__restoreDraftRaceDelay;
      };
    });

    try {
      await openSidebar();
      const threadButton = page.locator(`[data-thread-id="${fixture.threadId}"]`);
      await threadButton.waitFor();
      await threadButton.click();
      await waitForThreadTitle("消息编辑回归");

      const text = "这条消息发送后不能重新出现在输入框";
      await page.locator("#promptInput").fill(text);
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("#promptInput")?.value === "");
      const startRequest = await waitFor(async () => {
        const log = await readFakeLog();
        return log.find((entry) =>
          entry.type === "request" &&
          entry.method === "turn/start" &&
          entry.params?.threadId === fixture.threadId &&
          entry.params?.input?.some((input) => input?.type === "text" && input.text === text)
        ) || null;
      }, 5000, "draft clear race turn/start");
      assert(startRequest, "草稿竞态回归必须真实发送消息");

      await page.waitForTimeout(900);
      await parentRequest("test/complete-phone-turn", { threadId: fixture.threadId });
      await page.waitForFunction(() => !document.body.classList.contains("isBusy"));

      await openSidebar();
      await page.locator('[data-thread-id="thread-a"]').click();
      await waitForThreadTitle("电脑正在运行的会话");
      await openSidebar();
      await page.locator(`[data-thread-id="${fixture.threadId}"]`).click();
      await waitForThreadTitle("消息编辑回归");
      assert.equal(await page.locator("#promptInput").inputValue(), "", "切走再返回后已发送原文不能恢复到输入框");
      assert.equal(await page.locator("#attachmentTray .attachmentItem").count(), 0, "切走再返回后已发送附件不能恢复");
    } finally {
      await page.evaluate(() => window.__restoreDraftRaceDelay?.());
    }
  });

  await runStep("失败发送的草稿清空后，刷新和切换会话都保持为空", async () => {
    const fixture = (await parentRequest("test/create-edit-history", {
      threadId: "thread-discarded-draft", oldText: "草稿删除回归"
    })).result;
    await openSidebar();
    await page.locator(`[data-thread-id="${fixture.threadId}"]`).click();
    await waitForThreadTitle("消息编辑回归");
    await page.locator("#promptInput").fill("模拟双窗口写入冲突");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#promptInput")?.value === "模拟双窗口写入冲突");
    await page.locator("#promptInput").fill("");
    for (let reload = 0; reload < 3; reload++) {
      await page.reload();
      await waitForUiReady();
      await page.waitForTimeout(300);
      assert.equal(await page.locator("#promptInput").inputValue(), "", "显式清空不能被失败发送记录复活");
      assert.equal(await page.locator('.toastMessage').filter({ hasText: "上次发送结果未知" }).count(), 0, "已清空草稿的旧重试提示不能复活并遮挡操作");
    }
    await openSidebar();
    await page.locator('[data-thread-id="thread-a"]').click();
    await waitForThreadTitle("电脑正在运行的会话");
    await openSidebar();
    await page.locator(`[data-thread-id="${fixture.threadId}"]`).click();
    await waitForThreadTitle("消息编辑回归");
    assert.equal(await page.locator("#promptInput").inputValue(), "");
    await page.locator("#promptInput").fill("这是清空后重新写的草稿");
    await page.reload();
    await waitForUiReady();
    await page.waitForFunction(() => document.querySelector("#promptInput")?.value === "这是清空后重新写的草稿");
    await page.locator("#promptInput").fill("");
  });

  await runStep("回复注释：选区、键盘布局、返回键、会话隔离及草稿重载", async () => {
    async function assertAnnotationCentered() {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const distance = await page.locator("#responseAnnotationEditor").evaluate(node => {
        const box = node.getBoundingClientRect();
        const viewport = window.visualViewport;
        const pane = document.querySelector("#messages").getBoundingClientRect();
        const left = Math.max(viewport.offsetLeft, pane.left);
        const right = Math.min(viewport.offsetLeft + viewport.width, pane.right);
        const selection = CSS.highlights.get("codex-response-annotation").values().next().value.getBoundingClientRect();
        const minTop = Math.max(viewport.offsetTop + 12, pane.top + 8);
        const expectedTop = viewport.offsetTop + viewport.height - 12 - box.height;
        return {
          x: box.left + box.width / 2 - (left + right) / 2,
          y: box.top - expectedTop,
          selectionVisible: selection.top >= minTop - 1 && selection.bottom <= box.top - 15
        };
      });
      assert(Math.abs(distance.x) <= 1 && Math.abs(distance.y) <= 1, `注释框须左右居中、固定在键盘上方 12px：${JSON.stringify(distance)}`);
      assert(distance.selectionVisible, "注释时原文不能留在键盘遮挡区域");
    }
    const fixture = (await parentRequest("test/create-edit-history", {
      threadId: "thread-annotations", assistantText: "第一段原文。\n\n**这段需要解释**，后面还有文字。\n\n第二处需要修改。"
    })).result;
    await openSidebar();
    await page.locator(`[data-thread-id="${fixture.threadId}"]`).click();
    await waitForThreadTitle("消息编辑回归");
    await page.locator("#promptInput").fill("主输入框里的草稿必须保留");
    await selectResponseText(`${fixture.threadId}-assistant-edit`, "这段需要解释");
    assert.deepEqual(await page.locator("#responseSelectionToolbar button").allTextContents(), ["复制", "注释"]);
    await page.getByRole("button", { name: "复制", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#responseSelectionToolbar button").textContent.includes("已复制"));
    await page.getByRole("button", { name: "注释", exact: true }).click();
    const originalComposerBottom = await page.locator("#composer").evaluate(node => node.getBoundingClientRect().bottom);
    const compactEditor = await page.locator("#responseAnnotationEditor").boundingBox();
    assert.equal(compactEditor.width, 294, "注释框沿用扩展的固定宽度");
    assert.equal(compactEditor.height, 44, "新建注释沿用扩展的单行初态");
    await assertAnnotationCentered();
    assert.equal(await page.locator("#responseAnnotationEditor blockquote").count(), 0, "原版注释框不额外显示原文预览");
    assert.equal(await page.locator("#responseAnnotationEditor button:visible").count(), 1, "新建注释只显示一个评论提交按钮");
    await page.locator("#responseAnnotationInput").fill("第一行\n第二行");
    assert.equal((await page.locator("#responseAnnotationEditor").boundingBox()).height, 120);
    await assertAnnotationCentered();
    await page.locator("#responseAnnotationInput").fill("为什么要这样做？");
    assert.equal((await page.locator("#responseAnnotationEditor").boundingBox()).height, 44);
    await page.screenshot({ path: path.join(screenshotDir, "response-annotation-editor.png") });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(80);
    await page.locator("#responseAnnotationEditor").evaluate(node => {
      node.style.zoom = "1.25";
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(80);
    assert.equal(await page.locator("#responseAnnotationEditor").evaluate(node => getComputedStyle(node).height), "44px", "界面缩放不能把单行注释误判成多行");
    await assertAnnotationCentered();
    await page.locator("#responseAnnotationInput").fill("第一行\n第二行");
    assert.equal(await page.locator("#responseAnnotationEditor").evaluate(node => getComputedStyle(node).height), "120px");
    await page.locator("#responseAnnotationInput").fill("");
    assert.equal(await page.locator("#responseAnnotationEditor").evaluate(node => getComputedStyle(node).height), "44px", "清空内容后必须恢复单行初态");
    await page.locator("#responseAnnotationInput").fill("为什么要这样做？");
    await page.locator("#responseAnnotationEditor").evaluate(node => {
      node.style.removeProperty("zoom");
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(80);
    const desktopEditor = await page.locator("#responseAnnotationEditor").boundingBox();
    assert(desktopEditor.x >= 0 && desktopEditor.x + desktopEditor.width <= 1280 && desktopEditor.y >= 0 && desktopEditor.y + desktopEditor.height <= 900);
    const desktopPane = await page.locator("#messages").boundingBox();
    assert(desktopEditor.x >= desktopPane.x, "桌面浮窗不能漂到会话列表上");
    await assertAnnotationCentered();
    await page.screenshot({ path: path.join(screenshotDir, "response-annotation-desktop.png") });
    await page.setViewportSize({ width: 360, height: 420 });
    await page.waitForTimeout(60);
    const rect = await page.locator("#responseAnnotationEditor").boundingBox();
    assert(rect.x >= 0 && rect.x + rect.width <= 360 && rect.y >= 0 && rect.y + rect.height <= 420, "注释浮窗必须完整位于键盘上方的可视区内");
    await assertAnnotationCentered();
    const coveredComposer = await page.locator("#composer").boundingBox();
    assert(Math.abs(coveredComposer.y + coveredComposer.height - originalComposerBottom) <= 1, "注释时主输入框须留在键盘弹出前的位置");
    assert(coveredComposer.y >= 420, "键盘上方不能出现主输入框");
    assert.equal(await page.locator("#composer").evaluate(node => node.inert), true);
    assert.equal(await page.locator("#promptInput").inputValue(), "主输入框里的草稿必须保留");
    await page.waitForFunction(() => document.querySelector("#sidebar").getBoundingClientRect().right <= 1);
    await page.screenshot({ path: path.join(screenshotDir, "response-annotation-editor.png") });
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 300 });
      Object.defineProperty(window.visualViewport, "offsetTop", { configurable: true, value: 20 });
      window.visualViewport.dispatchEvent(new Event("resize"));
      window.visualViewport.dispatchEvent(new Event("scroll"));
    });
    await assertAnnotationCentered();
    assert.equal(await page.locator("#composer").evaluate(node => Math.round(node.getBoundingClientRect().bottom)), Math.round(originalComposerBottom));
    await page.evaluate(() => {
      delete window.visualViewport.height;
      delete window.visualViewport.offsetTop;
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    await assertAnnotationCentered();
    await page.goBack();
    await page.waitForSelector("#responseAnnotationEditor", { state: "hidden" });
    assert.equal(await page.locator("#composer").evaluate(node => node.inert), false);
    assert.equal(await page.locator("#promptInput").inputValue(), "主输入框里的草稿必须保留");
    assert.equal(await page.locator("#responseAnnotationTray .responseAnnotationChip").count(), 1);
    await page.setViewportSize({ width: 360, height: 780 });
    await openSidebar();
    await page.locator('[data-thread-id="thread-b"]').click();
    await waitForThreadTitle("电脑端其他会话");
    assert.equal(await page.locator("#responseAnnotationTray .responseAnnotationChip").count(), 0, "注释不能串到另一个会话");
    await openSidebar();
    await page.locator('[data-thread-id="thread-annotations"]').click();
    await waitForThreadTitle("消息编辑回归");
    await page.waitForFunction(() => document.querySelectorAll("#responseAnnotationTray .responseAnnotationChip").length === 1);
    await page.waitForTimeout(250);
    await page.reload();
    await waitForUiReady();
    await page.waitForSelector("#responseAnnotationTray .responseAnnotationChip");
    await page.locator("#responseAnnotationTray .annotationAttachmentTrigger").click();
    await page.waitForSelector("#responseAnnotationPopover");
    assert(await page.locator("#responseAnnotationPopover").innerText().then(text => text.includes("所选文本：") && text.includes("用户评论：")));
    await page.goBack();
    await page.waitForSelector("#responseAnnotationPopover", { state: "hidden" });
    await page.locator("#responseAnnotationTray .annotationAttachmentTrigger").click();
    await page.getByRole("button", { name: "编辑注释 1", exact: true }).click();
    assert.equal((await page.locator("#responseAnnotationEditor").boundingBox()).height, 120);
    await assertAnnotationCentered();
    assert.deepEqual(await page.locator("#responseAnnotationEditor button:visible").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))), ["删除", "取消", "保存"]);
    assert.notEqual(await page.locator("#responseAnnotationEditor .annotationDelete path").evaluate(node => getComputedStyle(node).fill), "none", "原版删除图标必须有实际填充");
    await page.screenshot({ path: path.join(screenshotDir, "response-annotation-edit-existing.png") });
    assert.equal(await page.locator("#responseAnnotationInput").inputValue(), "为什么要这样做？");
    await page.locator("#responseAnnotationInput").fill("取消时不得覆盖原注释");
    await page.locator("#responseAnnotationEditor").getByRole("button", { name: "取消", exact: true }).click();
    await page.waitForFunction(() => !history.state?.__codexPhoneAnnotationEditor);
    await page.locator("#responseAnnotationTray .annotationAttachmentTrigger").click();
    await page.getByRole("button", { name: "编辑注释 1", exact: true }).click();
    assert.equal(await page.locator("#responseAnnotationInput").inputValue(), "为什么要这样做？");
    await page.locator("#saveResponseAnnotation").click();
    await page.waitForFunction(() => !history.state?.__codexPhoneAnnotationEditor);
    await page.locator("#promptInput").fill("");
  });

  await runStep("注释固定键盘上方，长原文自由滚动，主输入框焦点切换保留原位置", async () => {
    const text = "这是一段需要注释的长回复内容。".repeat(80);
    await parentRequest("test/create-edit-history", { threadId: "thread-annotation-layout", assistantText: text });
    await openSidebar();
    await page.locator('[data-thread-id="thread-annotation-layout"]').click();
    await waitForThreadTitle("消息编辑回归");
    await page.locator("#promptInput").fill("保留主输入框草稿");
    const baseline = await page.locator("#composer").evaluate(node => node.getBoundingClientRect().bottom);
    await page.setViewportSize({ width: 360, height: 420 });
    await selectResponseText("thread-annotation-layout-assistant-edit", text);
    await page.getByRole("button", { name: "注释", exact: true }).click();
    await page.waitForTimeout(100);
    const box = await page.locator("#responseAnnotationEditor").boundingBox();
    assert(Math.abs(box.y + box.height - 408) <= 1);
    const main = await page.locator("#composer").boundingBox();
    assert(Math.abs(main.y + main.height - baseline) <= 1 && main.y >= 420, "从已打开的主键盘切换注释仍须恢复主输入框原底部位置");
    const selectedBottom = await page.evaluate(() => CSS.highlights.get("codex-response-annotation").values().next().value.getBoundingClientRect().bottom);
    assert(Math.abs(selectedBottom - (box.y - 16)) <= 1, "长选区优先显示末尾，距注释框 16px");
    const scroll = await page.locator("#messages").evaluate(node => { node.scrollTop -= 120; return node.scrollTop; });
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#messages").evaluate(node => node.scrollTop), scroll, "手动查看原文不能被自动滚动拉回");
    assert.deepEqual(await page.locator("#responseAnnotationEditor").boundingBox(), box, "滚动原文不能移动固定注释框");
    await page.locator("#responseAnnotationInput").press("Escape");
    await page.waitForFunction(() => !history.state?.__codexPhoneAnnotationEditor);
    await page.setViewportSize({ width: 360, height: 780 });
    assert.equal(await page.locator("#promptInput").inputValue(), "保留主输入框草稿");
    assert.equal(await page.locator("#composer").evaluate(node => node.inert), false);
    await openSidebar();
    await page.locator('[data-thread-id="thread-annotations"]').click();
    await waitForThreadTitle("消息编辑回归");
  });

  await runStep("回复注释：直接提交原生格式、编号引用及中途插入确认", async () => {
    await selectResponseText("thread-annotations-assistant-edit", "第二处需要修改");
    await page.getByRole("button", { name: "注释", exact: true }).click();
    await page.locator("#responseAnnotationInput").fill("这里改一下");
    await page.locator("#saveResponseAnnotation").click();
    await page.waitForFunction(() => !history.state?.__codexPhoneAnnotationEditor);
    assert.equal(await page.locator("#responseAnnotationTray .responseAnnotationChip").count(), 1, "多条注释合并为原版汇总附件");
    assert.equal(await page.locator("#responseAnnotationTray .annotationAttachmentTrigger").textContent(), "2 条注释");
    assert.equal((await readFakeLog()).filter(entry => entry.method === "turn/start" && entry.params?.threadId === "thread-annotations").length, 0, "点击勾号只添加注释，不发出对话");
    await page.locator("#responseAnnotationTray .annotationAttachmentTrigger").click();
    assert.equal(await page.locator("#responseAnnotationPopover li").count(), 2);
    await page.screenshot({ path: path.join(screenshotDir, "response-annotation-list.png") });
    await page.goBack();
    await page.waitForSelector("#responseAnnotationPopover", { state: "hidden" });
    await page.locator("#sendBtn").click();
    const start = await waitFor(async () => (await readFakeLog()).find(entry => entry.method === "turn/start" && entry.params?.threadId === "thread-annotations"), 5000, "annotation turn/start");
    const wire = start.params.input.find(input => input.type === "text").text;
    const decoded = decodeResponseAnnotations(wire);
    assert(decoded, "上游收到的原始文本必须能被扩展的注释格式解析");
    assert.equal(decoded.annotations.length, 2);
    assert.equal(decoded.annotations[0].annotation, "为什么要这样做？");
    assert.equal(decoded.annotations[1].annotation, "这里改一下");
    assert.equal(decoded.annotations[0].source.messageId, await resolveMessageId("thread-annotations-assistant-edit"));
    await page.waitForFunction(() => document.querySelectorAll("#responseAnnotationTray .responseAnnotationChip").length === 0);
    await page.waitForSelector(".message.user .responseAnnotationAttachments");
    assert.equal(await page.locator(".message.user:has(.responseAnnotationAttachments) .bubble").count(), 0, "纯注释不能出现空正文气泡");
    assert(!await page.locator("#messages").innerText().then(text => text.includes("<response-annotations>")), "协议内容不能泄露到消息正文");
    await parentRequest("test/annotation-item", { threadId: "thread-annotations", itemId: "annotation-reply", text: '处理第一项 :codex-annotation{index="1"}，处理第二项 :codex-annotation{index="2"}。\n\n` :codex-annotation{index="1"} ` 是代码示例。' });
    await page.waitForSelector((await messageSelector("annotation-reply")) + " .responseAnnotationReference");
    assert.equal(await page.locator((await messageSelector("annotation-reply")) + " .responseAnnotationReference").count(), 2, "代码示例内的标记不能被替换");
    await page.locator((await messageSelector("annotation-reply")) + " .responseAnnotationReference").first().hover();
    await page.waitForSelector("#responseAnnotationPopover.isReference");
    assert(await page.locator("#responseAnnotationPopover").innerText().then(text => text.includes("为什么要这样做？")));
    assert.equal(await page.evaluate(() => Boolean(history.state?.__codexPhoneAnnotationEditor)), false, "悬停预览不能污染返回历史");
    await page.locator((await messageSelector("annotation-reply")) + " .responseAnnotationReference").first().click();
    await parentRequest("test/set-steer-user-delay", { delayMs: 1200 });
    await selectResponseText("thread-annotations-assistant-edit", "这段需要解释");
    await page.getByRole("button", { name: "注释", exact: true }).click();
    await page.locator("#responseAnnotationInput").fill("中途补充解释");
    await page.locator("#responseAnnotationInput").press("Control+Enter");
    const steer = await waitFor(async () => (await readFakeLog()).find(entry => entry.method === "turn/steer" && entry.params?.threadId === "thread-annotations"), 5000, "annotation turn/steer");
    assert.equal(decodeResponseAnnotations(steer.params.input[0].text).annotations[0].annotation, "中途补充解释");
    await page.waitForFunction(() => document.querySelectorAll(".message.user .responseAnnotationAttachments").length === 2, null, { timeout: 1000 });
    await parentRequest("test/annotation-delta", { threadId: "thread-annotations", itemId: "annotation-stream", delta: '正在解释 :codex-annotation{index="' });
    await page.waitForSelector(await messageSelector("annotation-stream"));
    assert(!await page.locator(await messageSelector("annotation-stream")).innerText().then(text => text.includes(":codex-annotation")), "分片中的注释协议不能闪到正文");
    await parentRequest("test/annotation-delta", { threadId: "thread-annotations", itemId: "annotation-stream", delta: '1"}。完整解释正文。' });
    await page.waitForSelector((await messageSelector("annotation-stream")) + " .responseAnnotationReference");
    await selectResponseText("annotation-stream", "完整解释正文");
    const selectedScrollTop = await page.locator("#messages").evaluate(node => node.scrollTop);
    await parentRequest("test/annotation-delta", { threadId: "thread-annotations", itemId: "annotation-stream", delta: "\n继续输出的新文字".repeat(15) });
    await page.waitForFunction(() => document.querySelector('[data-message-id="' + window.__recoveryTest.messageIds["annotation-stream"] + '"]').textContent.includes("继续输出的新文字"));
    assert.equal(await page.evaluate(() => getSelection().toString()), "完整解释正文", "继续流式输出不能清空正在选择的原文");
    assert(Math.abs(await page.locator("#messages").evaluate(node => node.scrollTop) - selectedScrollTop) <= 1, "注释选区激活时不能被新输出拉到底部");
    await page.getByRole("button", { name: "注释", exact: true }).click();
    await page.locator("#responseAnnotationInput").fill("这段稍后继续");
    await page.locator("#saveResponseAnnotation").click();
    await page.waitForFunction(() => !history.state?.__codexPhoneAnnotationEditor);
    await page.locator("#responseAnnotationTray .annotationAttachmentTrigger").click();
    await page.getByRole("button", { name: "移除注释 1", exact: true }).click();
    await page.waitForFunction(() => !history.state?.__codexPhoneAnnotationEditor);
    await parentRequest("test/complete-phone-turn", { threadId: "thread-annotations" });
    await page.waitForTimeout(1300);
    assert.equal(await page.locator(".message.user .responseAnnotationAttachments").count(), 2, "权威 userMessage 到达后不能重复出现注释消息");
    await page.reload();
    await waitForUiReady();
    await page.waitForSelector(".message.user .responseAnnotationAttachments");
    assert.equal(await page.locator(".message.user .responseAnnotationAttachments").count(), 2, "重新加载历史仍保留注释");
    await page.screenshot({ path: path.join(screenshotDir, "response-annotation-history.png") });
  });

  await runStep("回复注释：断网保留图文注释草稿并只提交一次", async () => {
    await selectResponseText("thread-annotations-assistant-edit", "第二处需要修改");
    await page.getByRole("button", { name: "注释", exact: true }).click();
    await page.locator("#responseAnnotationInput").fill("断线注释必须保留");
    await page.locator("#saveResponseAnnotation").click();
    await page.waitForFunction(() => !history.state?.__codexPhoneAnnotationEditor);
    await page.locator("#promptInput").fill("断线重发只发送一次");
    await page.locator("#imageInput").setInputFiles(imageFixture);
    await page.waitForSelector("#attachmentTray .attachmentItem");
    await context.setOffline(true);
    await page.locator("#composer").evaluate(node => node.requestSubmit());
    await page.waitForFunction(() => document.querySelectorAll("#responseAnnotationTray .responseAnnotationChip").length === 1 && document.querySelector("#promptInput").value === "断线重发只发送一次");
    assert.equal(await page.locator("#attachmentTray .attachmentItem").count(), 1);
    await context.setOffline(false);
    await page.waitForFunction(() => !document.querySelector("#sendBtn").disabled);
    await page.locator("#sendBtn").click();
    await waitFor(async () => (await readFakeLog()).find(entry => entry.method === "turn/start" && entry.params?.threadId === "thread-annotations" && entry.params.input.some(input => input.text?.includes("断线注释必须保留"))), 5000, "annotation retry");
    await parentRequest("test/complete-phone-turn", { threadId: "thread-annotations" });
    const starts = (await readFakeLog()).filter(entry => entry.method === "turn/start" && entry.params?.threadId === "thread-annotations" && entry.params.input.some(input => input.text?.includes("断线注释必须保留")));
    assert.equal(starts.length, 1);
    assert.equal(starts[0].params.input.filter(input => input.type === "localImage").length, 1);
    await page.waitForFunction(() => document.querySelectorAll("#responseAnnotationTray .responseAnnotationChip").length === 0);
  });

  await runStep("发送失败后恢复图文草稿并可重试", async () => {
    await createNewThreadFromUi();
    await page.locator("#promptInput").fill("失败图片发送");
    await page.locator("#imageInput").setInputFiles(imageFixture);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await assertClearedComposer();

    await page.waitForFunction(() => {
      const button = document.querySelector("#sendBtn");
      return !button.classList.contains("isSending") && !button.disabled;
    }, null, { timeout: 5000 });
    const facts = await page.evaluate(() => ({
      text: document.querySelector("#promptInput").value,
      readOnly: document.querySelector("#promptInput").readOnly,
      imageCount: document.querySelectorAll("#attachmentTray .attachmentItem").length,
      spinnerDisplay: getComputedStyle(document.querySelector("#sendBtn .sendSpinner")).display,
      sendDisabled: document.querySelector("#sendBtn").disabled
    }));
    assert.equal(facts.text, "失败图片发送", "失败后文字草稿必须保留");
    assert.equal(facts.imageCount, 1, "失败后图片草稿必须保留");
    assert.equal(facts.readOnly, false, "失败后输入框应恢复编辑");
    assert.equal(facts.spinnerDisplay, "none", "失败后发送旋转圈应停止");
    assert.equal(facts.sendDisabled, false, "失败后应允许用户重试");
    await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  });

  await runStep("新会话创建中列表可点，迟到回执不改绑或清空另一个会话草稿", async () => {
    await selectThread("thread-b");
    const otherDraft = "B 会话独立保留的草稿";
    await page.locator("#promptInput").fill(otherDraft);
    await createNewThreadFromUi();
    await parentRequest("test/pause-thread-start");
    const text = "创建尚未结束时切走，消息仍属于新会话";
    await page.locator("#promptInput").fill(text);
    await page.locator("#sendBtn").click();
    await assertClearedComposer();
    try {
      await openSidebar();
      assert.equal(await page.locator(".threadItem:disabled").count(), 0);
      assert.equal(await page.locator('[data-thread-id="thread-b"]').evaluate(node => getComputedStyle(node).opacity), "1");
      await selectThread("thread-b");
      assert.equal(await page.locator("#promptInput").inputValue(), otherDraft);
      assert.equal(await page.locator("#promptInput").getAttribute("readonly"), "", "回执未到时就必须能切换列表");
    } finally {
      await parentRequest("test/release-thread-start");
    }
    const start = await waitFor(async () => (await readFakeLog()).find(entry =>
      entry.method === "turn/start" && entry.params?.input?.some(input => input.text === text)), 5000, "background new turn");
    await page.waitForFunction(() => !document.querySelector("#promptInput").readOnly);
    assert.equal(await selectedThread(), "thread-b");
    assert.equal(await page.locator("#promptInput").inputValue(), otherDraft);
    await parentRequest("test/complete-phone-turn", { threadId: start.params.threadId });
    await selectThread(start.params.threadId);
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
    assert.equal(await page.locator("#promptInput").inputValue(), "");
    await selectThread("thread-b");
    assert.equal(await page.locator("#promptInput").inputValue(), otherDraft);
    await page.locator("#promptInput").fill("");
  });

  await runStep("切到其他会话后发送失败，原会话草稿保存且重试只归属原会话", async () => {
    const tid = "thread-navigation-failure";
    await parentRequest("test/create-edit-history", { threadId: tid, oldText: "原会话历史" });
    await selectThread(tid);
    const text = "切换后失败的待发文字";
    await parentRequest("test/pause-turn-start", { text, fail: true });
    await page.locator("#promptInput").fill(text);
    await page.locator("#sendBtn").click();
    await assertClearedComposer();
    try { await selectThread("thread-b"); }
    finally { await parentRequest("test/release-turn-start", { text }); }
    await page.waitForFunction(() => !document.querySelector("#promptInput").readOnly);
    assert.equal(await selectedThread(), "thread-b");
    assert.equal(await page.locator("#promptInput").inputValue(), "");
    await waitFor(async () => (await readBrowserDraft(tid))?.text === text, 3000, "original failure draft");
    await selectThread(tid);
    await page.waitForFunction(expected => document.querySelector("#promptInput").value === expected, text);
    await page.locator("#promptInput").fill(`${text}，修改后又改回`);
    await page.locator("#promptInput").fill(text);
    await page.locator("#sendBtn").click();
    await page.waitForFunction(() => !document.querySelector("#promptInput").readOnly);
    const starts = (await readFakeLog()).filter(entry => entry.method === "turn/start" && entry.params?.input?.some(input => input.text === text));
    assert.equal(starts.length, 2);
    assert(starts.every(entry => entry.params.threadId === tid));
    assert.equal(await page.locator("#promptInput").inputValue(), "");
    await parentRequest("test/complete-phone-turn", { threadId: tid });
  });

  await runStep("读图中列表可点，图片和注释保留在原会话", async () => {
    const tid = "thread-navigation-image";
    await parentRequest("test/create-edit-history", { threadId: tid, oldText: "读图切换历史", assistantText: "用于图片草稿的注释原文" });
    await selectThread(tid);
    await selectResponseText(`${tid}-assistant-edit`, "用于图片草稿的注释原文");
    await page.getByRole("button", { name: "注释", exact: true }).click();
    await page.locator("#responseAnnotationInput").fill("读图切换后保留这条注释");
    await page.locator("#saveResponseAnnotation").click();
    await page.waitForFunction(() => !history.state?.__codexPhoneAnnotationEditor);
    await page.locator("#promptInput").fill("原会话图文草稿");
    await page.evaluate(() => {
      const original = FileReader.prototype.readAsDataURL;
      window.__releaseImageRead = null;
      FileReader.prototype.readAsDataURL = function(file) {
        window.__releaseImageRead = () => original.call(this, file);
      };
      window.__restoreImageRead = () => { FileReader.prototype.readAsDataURL = original; };
    });
    await page.locator("#imageInput").setInputFiles(imageFixture);
    await page.waitForFunction(() => Boolean(window.__releaseImageRead));
    try {
      await openSidebar();
      assert.equal(await page.locator(".threadItem:disabled").count(), 0);
      await selectThread("thread-b");
      assert.equal(await page.locator("#attachmentTray .attachmentItem").count(), 0);
      await page.evaluate(() => window.__releaseImageRead());
      await waitFor(async () => (await readBrowserDraft(tid))?.images?.length === 1, 3000, "original image draft");
      assert.equal((await readBrowserDraft(tid)).annotations[0].annotation, "读图切换后保留这条注释");
      assert.equal(await page.locator("#attachmentTray .attachmentItem").count(), 0);
      assert.equal(await page.locator("#responseAnnotationTray .responseAnnotationChip").count(), 0);
      assert.equal(await page.locator("#promptInput").inputValue(), "");
      await selectThread(tid);
      await page.waitForSelector("#attachmentTray .attachmentItem");
      assert.equal(await page.locator("#promptInput").inputValue(), "原会话图文草稿");
      assert.equal(await page.locator("#responseAnnotationTray .responseAnnotationChip").count(), 1);
    } finally { await page.evaluate(() => window.__restoreImageRead()); }
    await page.locator("#attachmentTray .attachmentRemove").click();
    await page.locator("#promptInput").fill("");
  });

  await runStep("发送中切换后重连保留所选会话，断线才禁用列表", async () => {
    const tid = "thread-navigation-disconnect";
    await parentRequest("test/create-edit-history", { threadId: tid, oldText: "重连切换历史" });
    await selectThread(tid);
    const text = "切走并重连后只发一次";
    await parentRequest("test/pause-turn-start", { text });
    await page.locator("#promptInput").fill(text);
    await page.locator("#sendBtn").click();
    await assertClearedComposer();
    await selectThread("thread-b");
    await context.setOffline(true);
    await page.evaluate(() => window.__recoveryTest.sockets.at(-1).close());
    await page.waitForFunction(() => [...document.querySelectorAll(".threadItem")].every(node => node.disabled));
    try {
      await parentRequest("test/release-turn-start", { text });
      await parentRequest("test/complete-phone-turn", { threadId: tid });
    } finally { await context.setOffline(false); }
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(() => !document.querySelector('.threadItem[data-thread-id="thread-b"]').disabled);
    await waitFor(async () => await selectedThread() === "thread-b", 5000, "reconnect preserves selection");
    const starts = (await readFakeLog()).filter(entry => entry.method === "turn/start" && entry.params?.input?.some(input => input.text === text));
    assert.equal(starts.length, 1);
    assert.equal(starts[0].params.threadId, tid);
    assert.equal(await page.locator("#promptInput").inputValue(), "");
  });

  assert.deepEqual(pageErrors, [], `页面脚本错误：${pageErrors.join(" | ")}`);
  const unexpectedConsoleErrors = consoleErrors.filter((message) => !message.includes("net::ERR_INTERNET_DISCONNECTED"));
  assert.deepEqual(unexpectedConsoleErrors, [], `浏览器控制台错误：${unexpectedConsoleErrors.join(" | ")}`);
  console.log(JSON.stringify({
    ok: true,
    browser: "msedge",
    viewport: { width: 360, height: 780 },
    results
  }, null, 2));
} finally {
  await context?.setOffline(false).catch(() => {});
  await browser?.close().catch(() => {});
  await stopChild(bridge);
  await stopChild(proxy);
  // Retain isolated evidence under tests/build; no recursive deletion.
}

async function selectResponseText(messageId, text) {
  await page.waitForFunction(() => !document.querySelector("#sidebar").classList.contains("open") && getComputedStyle(document.querySelector("#sidebar")).visibility === "hidden");
  messageId = await resolveMessageId(messageId);
  const bubble = page.locator(`[data-message-id="${messageId}"] .bubble`);
  await bubble.scrollIntoViewIfNeeded();
  await bubble.evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const start = node.textContent.indexOf(text);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error(`找不到选区：${text}`);
  }, text);
  await page.waitForSelector("#responseSelectionToolbar");
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
  await page.addInitScript((receiverSource) => {
    const createReceiver = new Function(`return (${receiverSource})`)();
    const NativeWebSocket = window.WebSocket;
    const observed = window.__recoveryTest = { sockets: [], states: [], messageIds: {} };
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        observed.sockets.push(this);
        const receiver = createReceiver({ send: () => {}, receive: value => {
          for (const message of [...(value.state?.messages || []), ...(value.patch?.messages?.items || []), ...(value.message ? [value.message] : [])]) {
            if (message.meta?.sourceItemId) observed.messageIds[message.meta.sourceItemId] = message.id;
          }
          if (value.type === "state") observed.states.push({ revision: value.state.threadRevision, epoch: value.state.app.bridgeEpoch, threadId: value.state.currentThreadId });
        } });
        this.addEventListener("message", (event) => receiver.accept(JSON.parse(event.data)));
      }
    };
  }, createPhoneReceiver.toString());
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

async function waitForThreadTitle(title) {
  await page.waitForFunction((expected) => document.querySelector("#mobileThreadTitle")?.textContent === expected, title);
}

async function selectedThread() {
  return page.locator(".threadItem.active").getAttribute("data-thread-id");
}

async function selectThread(threadId) {
  await openSidebar();
  await page.locator(`.threadItem[data-thread-id="${threadId}"]`).click();
  await page.waitForFunction(id => window.__recoveryTest.states.at(-1)?.threadId === id &&
    document.querySelector(".threadItem.active")?.dataset.threadId === id, threadId);
  await page.waitForFunction(() => !document.querySelector("#sidebar").classList.contains("open"));
}

async function readBrowserDraft(key) {
  return page.evaluate(key => new Promise((resolve, reject) => {
    const open = indexedDB.open("codex-phone-ui", 2);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction("drafts", "readonly").objectStore("drafts").get(key);
      read.onsuccess = () => { db.close(); resolve(read.result || null); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  }), key);
}

async function assertSnapshotAliasDomOrder({ userId, assistantId, stage }) {
  const facts = await page.evaluate(({ userId: expectedUserId, assistantId: expectedAssistantId }) => {
    const nodes = Array.from(document.querySelectorAll("#messages .message"));
    const ids = nodes.map((node) => node.dataset.messageId || "");
    return {
      userIndex: ids.indexOf(expectedUserId),
      fileIndex: ids.indexOf(window.__recoveryTest.messageIds["item-902"]),
      assistantIndex: ids.indexOf(window.__recoveryTest.messageIds[expectedAssistantId]),
      completedDiffIndex: nodes.findIndex((node) => node.classList.contains("completedTurnDiffMessage")),
      newerUserIndex: ids.indexOf(window.__recoveryTest.messageIds["item-903"]),
      fileCount: nodes.filter((node) => node.dataset.kind === "file").length,
      completedDiffCount: nodes.filter((node) => node.classList.contains("completedTurnDiffMessage")).length,
      timelinePlanCount: document.querySelectorAll('#messages [data-kind="plan"], #messages .completedPlanMessage, #messages .planBlock').length,
      oldUserTextCount: nodes.filter((node) => node.textContent.includes("快照重复问题")).length,
      oldAssistantTextCount: nodes.filter((node) => node.textContent.includes("快照重复回复")).length
    };
  }, { userId, assistantId });

  assert.equal(facts.fileIndex, facts.userIndex + 1, `${stage}：对话流 diff 必须紧跟旧 turn 用户消息`);
  assert.equal(facts.assistantIndex, facts.fileIndex + 1, `${stage}：旧 turn 最终回复必须跟在对话流 diff 后`);
  assert.equal(facts.completedDiffIndex, facts.assistantIndex + 1, `${stage}：完成态 diff 必须紧跟旧 turn 最终回复`);
  assert.equal(facts.newerUserIndex, facts.completedDiffIndex + 1, `${stage}：下一 turn 必须从完成态 diff 之后开始`);
  assert.equal(facts.fileCount, 1, `${stage}：对话流 diff 不能重复`);
  assert.equal(facts.completedDiffCount, 1, `${stage}：完成态 diff 不能重复`);
  assert.equal(facts.timelinePlanCount, 0, `${stage}：历史计划不能进入消息时间线`);
  assert.equal(facts.oldUserTextCount, 1, `${stage}：旧 turn 用户消息不能重复`);
  assert.equal(facts.oldAssistantTextCount, 1, `${stage}：旧 turn 最终回复不能重复`);
}

async function createNewThreadFromUi() {
  await openSidebar();
  await page.locator("#newThreadBtn").click();
  await page.waitForFunction(() =>
    Boolean(document.querySelector(".emptyHero")) &&
    document.querySelector("#promptInput")?.value === "" &&
    document.querySelectorAll("#messages .message").length === 0
  , null, { timeout: 8000 });
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

function countFakeRequests(method, log) {
  return log.filter((entry) => entry.type === "request" && entry.method === method).length;
}

async function runStep(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, durationMs: Date.now() - startedAt });
  } catch (error) {
    const diagnostics = await collectDiagnostics();
    throw new Error(`${name}: ${error.message}\n${JSON.stringify(diagnostics, null, 2)}`, { cause: error });
  }
}

async function collectDiagnostics() {
  const ui = page ? await page.evaluate(() => ({
    title: document.querySelector("#mobileThreadTitle")?.textContent || "",
    connection: document.querySelector("#connectionText")?.textContent || "",
    input: document.querySelector("#promptInput")?.value || "",
    imageCount: document.querySelectorAll("#attachmentTray .attachmentItem").length,
    sendClass: document.querySelector("#sendBtn")?.className || "",
    visibleTextTail: (document.body?.innerText || "").slice(-1200)
  })).catch((error) => ({ pageError: error.message })) : null;
  const fakeLog = await readFakeLog();
  return {
    ui,
    pageErrors,
    consoleErrors,
    fakeLogTail: fakeLog.slice(-12),
    proxyStderr: proxyStderr.slice(-1200),
    bridgeStderr: bridgeStderr.slice(-1200)
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
    await delay(100);
  }
  throw lastError || new Error(`${label} timeout`);
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
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
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

async function resolveMessageId(sourceId) {
  await page.waitForFunction(id => Boolean(window.__recoveryTest.messageIds[id]), sourceId);
  return page.evaluate(id => window.__recoveryTest.messageIds[id], sourceId);
}
async function messageSelector(sourceId) {
  return '[data-message-id="' + await resolveMessageId(sourceId) + '"]';
}
