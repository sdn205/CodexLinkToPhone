import { escapeHtml } from "../shared/text-utils.js";

export function createMessageListRenderer({
  messages,
  getState,
  getVisibleMessages,
  getRenderableMessages,
  getRenderItems,
  getActivityKey,
  getOmittedMessages,
  getExpansionKey,
  getEditingMessage,
  isEditingTargetVisible,
  isThreadRunning,
  hasCurrentPlan,
  getCurrentThreadName,
  isEarlierMessagesPending,
  renderInlineEditor,
  renderEarlierButton,
  renderTurnDivider,
  renderCommandGroup,
  renderMessageNode,
  renderActivity,
  itemKey,
  annotationUI,
  pendingToolScrollRestore,
  disposeThinkingShimmer,
  nearBottom,
  stickToBottomSoon,
  scheduleBottomButtonUpdate,
  updateBottomButton,
  updateMessageDensity,
  setInitialScrollPending,
  getLastKey,
  setLastKey,
  getPendingScrollRestore,
  setPendingScrollRestore,
  getEarlierMessagesAnchor,
  setEarlierMessagesAnchor,
  getPendingEarlierMessages,
  getCurrentThreadId
} = {}) {
  if (!messages) throw new TypeError("messages element is required");
  if (!(pendingToolScrollRestore instanceof Map)) throw new TypeError("pendingToolScrollRestore must be a Map");

  function indexExistingNodes() {
    const messageNodes = new Map();
    const turnDividers = new Map();
    const commandGroups = new Map();
    const staticNodes = new Map();
    for (const node of messages.children) {
      if (node.dataset.messageId) messageNodes.set(node.dataset.messageId, node);
      if (node.dataset.turnDividerId) turnDividers.set(node.dataset.turnDividerId, node);
      if (node.dataset.commandGroupId) commandGroups.set(node.dataset.commandGroupId, node);
      if (node.dataset.staticNode) staticNodes.set(node.dataset.staticNode, node);
    }
    return { messages: messageNodes, turnDividers, commandGroups, staticNodes };
  }

  function detachedEditor(existingNodes = new Map()) {
    const editing = getEditingMessage?.();
    const key = `${editing?.threadId || ""}:${editing?.turnId || ""}`;
    const existing = existingNodes.get("inline-message-editor");
    if (existing?.dataset.renderKey === key) return existing;
    const item = document.createElement("article");
    item.className = "message user isEditingUserMessage";
    item.dataset.staticNode = "inline-message-editor";
    item.dataset.renderKey = key;
    item.append(renderInlineEditor?.(null));
    return item;
  }

  function earlierButton(omittedMessages) {
    const existing = messages.querySelector("[data-static-node='earlier-messages']");
    if (existing?.dataset.omittedMessages === String(omittedMessages)) {
      const button = existing.querySelector("button");
      if (button) button.disabled = Boolean(isEarlierMessagesPending?.());
      return existing;
    }
    const wrap = document.createElement("div");
    wrap.className = "earlierMessages";
    wrap.dataset.staticNode = "earlier-messages";
    wrap.dataset.omittedMessages = String(omittedMessages);
    wrap.innerHTML = `<button type="button" data-load-earlier-messages>加载更早消息（还有 ${omittedMessages} 条）</button>`;
    wrap.querySelector("button").disabled = Boolean(isEarlierMessagesPending?.());
    return wrap;
  }

  function syncChildren(desiredNodes) {
    const lastDesired = desiredNodes.at(-1);
    const desiredActivity = lastDesired instanceof Element && lastDesired.dataset.staticNode === "turn-activity"
      ? lastDesired
      : null;
    const contentNodes = desiredActivity ? desiredNodes.slice(0, -1) : desiredNodes;
    const stableActivity = desiredActivity?.parentNode === messages ? desiredActivity : null;
    let current = messages.firstChild;
    for (const desired of contentNodes) {
      if (current === desired) {
        current = current.nextSibling;
        continue;
      }
      if (desired instanceof Element) {
        const pre = desired.querySelector(".cmdOutputWrap pre");
        const saved = pre && desired.isConnected
          ? pre.scrollTop
          : desired.dataset?.messageId ? pendingToolScrollRestore.get(desired.dataset.messageId) : undefined;
        messages.insertBefore(desired, current);
        if (pre && saved !== undefined) pre.scrollTop = saved;
        if (desired.dataset?.messageId) pendingToolScrollRestore.delete(desired.dataset.messageId);
      } else {
        messages.insertBefore(desired, current);
      }
    }
    while (current && current !== stableActivity) {
      const next = current.nextSibling;
      disposeThinkingShimmer?.(current);
      current.remove();
      current = next;
    }

    annotationUI?.restoreAnchor();
    if (!desiredActivity) return;
    if (!stableActivity) {
      messages.append(desiredActivity);
      return;
    }
    let trailing = stableActivity.nextSibling;
    while (trailing) {
      const next = trailing.nextSibling;
      disposeThinkingShimmer?.(trailing);
      trailing.remove();
      trailing = next;
    }
  }

  function render() {
    const state = getState?.();
    if (!state) return;
    const visibleMessages = getVisibleMessages();
    const renderableMessages = getRenderableMessages(visibleMessages);
    const editingTargetVisible = Boolean(getEditingMessage?.() && isEditingTargetVisible(renderableMessages));
    const renderItems = getRenderItems(renderableMessages);
    const activityKey = getActivityKey(visibleMessages);
    const omittedMessages = Math.max(0, Number(getOmittedMessages?.() || 0));
    const key = `${activityKey}|omitted:${omittedMessages}|${renderItems.map(itemKey).join("|")}|${getExpansionKey?.() || ""}`;
    if (key === getLastKey()) return;
    setLastKey(key);

    const shouldStick = !getPendingScrollRestore() && nearBottom();
    const existingNodes = indexExistingNodes();
    const desiredNodes = [];
    if (omittedMessages > 0) desiredNodes.push((renderEarlierButton || earlierButton)(omittedMessages));

    if (!renderableMessages.length && !getEditingMessage?.() && !isThreadRunning() && !hasCurrentPlan()) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.dataset.staticNode = "empty";
      empty.innerHTML = `<div class="emptyHero"><span>${escapeHtml(getCurrentThreadName?.() || "新会话")}</span></div>`;
      syncChildren(desiredNodes.concat(empty));
      setPendingScrollRestore(null);
      messages.scrollTop = 0;
      updateBottomButton();
      return;
    }

    for (const item of renderItems) {
      if (item.type === "turnDivider") desiredNodes.push(renderTurnDivider(item, existingNodes.turnDividers));
      else if (item.type === "commandGroup") desiredNodes.push(renderCommandGroup(item, existingNodes.commandGroups));
      else desiredNodes.push(renderMessageNode(item.message, existingNodes.messages));
    }
    if (getEditingMessage?.() && !editingTargetVisible) desiredNodes.push(detachedEditor(existingNodes.staticNodes));
    if (activityKey !== "idle") desiredNodes.push(renderActivity(activityKey, existingNodes.staticNodes));
    syncChildren(desiredNodes);

    const pendingRestore = getPendingScrollRestore();
    if (pendingRestore) {
      setPendingScrollRestore(null);
      requestAnimationFrame(() => {
        if ((getCurrentThreadId?.() || "") !== pendingRestore.threadId) return;
        messages.scrollTop = pendingRestore.atBottom ? messages.scrollHeight : Math.max(0, pendingRestore.top);
        updateBottomButton();
      });
    }

    const anchor = getEarlierMessagesAnchor();
    if (anchor && !getPendingEarlierMessages()) {
      setEarlierMessagesAnchor(null);
      requestAnimationFrame(() => {
        if (anchor.threadId !== getCurrentThreadId?.()) return;
        const addedHeight = messages.scrollHeight - anchor.scrollHeight;
        messages.scrollTop = anchor.scrollTop + Math.max(0, addedHeight);
        updateBottomButton();
      });
    }

    if (shouldStick) {
      stickToBottomSoon(() => {
        updateMessageDensity?.();
        updateBottomButton();
        setInitialScrollPending(false);
      });
    } else {
      scheduleBottomButtonUpdate?.();
    }
  }

  return { render, invalidate: () => setLastKey("") };
}
