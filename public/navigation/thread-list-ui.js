export function createThreadListUI(options = {}) {
  const {
    getState, getElements, getSearchQuery, setSearchQuery, getDisabled,
    displayThreadName, escapeHtml, formatTime, createClientId,
    snapshotDraft, saveDraft, optimisticSwitchThread, closeSidebar,
    send, showThreadContextMenu, currentThreadIsRunning
  } = options;
  let lastKey = "";
  let longPressTriggered = false;

  function render() {
    const state = getState();
    const elements = getElements();
    if (!state) return;
    const threads = Array.isArray(state.threads) ? state.threads : [];
    const query = getSearchQuery();
    const key = [state.currentThreadId || "", query, getDisabled() ? "disabled" : "ready",
      threads.map((thread) => [thread.id, thread.name, thread.updatedAt, thread.status, thread.unread ? 1 : 0].join(":")).join("|")].join("::");
    if (key === lastKey) return;
    lastKey = key;
    const previousScrollTop = elements.threadList.scrollTop;
    const focusedThreadId = document.activeElement?.closest?.(".threadItem")?.dataset.threadId || "";
    elements.threadList.replaceChildren();
    const filtered = threads.filter((thread) => !query || displayThreadName(thread, "未命名会话").toLowerCase().includes(query));
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "threadEmpty";
      empty.textContent = query ? "没有匹配的会话。" : "暂无历史会话，点“新会话”开始。";
      elements.threadList.append(empty);
      elements.threadList.scrollTop = previousScrollTop;
      return;
    }
    for (const thread of filtered) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "threadItem" + (thread.id === state.currentThreadId ? " active" : "");
      button.dataset.threadId = thread.id;
      button.disabled = getDisabled();
      const name = displayThreadName(thread, "未命名会话");
      button.innerHTML = "<span class=\"threadName\">" + escapeHtml(name) + "</span>" +
        renderStatusIndicator(thread, state, currentThreadIsRunning) +
        "<span class=\"threadMeta\"><span>" + formatTime(thread.updatedAt) + "</span></span>";
      let longPressTimer = null;
      const cancelLongPress = () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } };
      button.addEventListener("touchstart", (event) => {
        if (button.disabled) return;
        cancelLongPress();
        const touch = event.touches?.[0];
        const rect = button.getBoundingClientRect();
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          longPressTriggered = true;
          showThreadContextMenu(thread, touch?.clientX ?? rect.left, touch?.clientY ?? rect.top);
        }, 500);
      }, { passive: true });
      button.addEventListener("touchend", cancelLongPress, { passive: true });
      button.addEventListener("touchmove", cancelLongPress, { passive: true });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (!button.disabled) showThreadContextMenu(thread, event.clientX, event.clientY);
      });
      button.addEventListener("click", () => {
        if (longPressTriggered) { longPressTriggered = false; return; }
        if (getDisabled()) return;
        if (thread.id === getState()?.currentThreadId) {
          if (thread.unread) send({ type: "thread:read", threadId: thread.id });
          closeSidebar();
          return;
        }
        const previousDraft = snapshotDraft();
        saveDraft();
        optimisticSwitchThread(thread.id, previousDraft);
        closeSidebar();
        send({ type: "thread:open", threadId: thread.id, requestId: createClientId() });
      });
      elements.threadList.append(button);
    }
    elements.threadList.scrollTop = previousScrollTop;
    if (focusedThreadId) {
      const focused = Array.from(elements.threadList.querySelectorAll(".threadItem")).find((button) => button.dataset.threadId === focusedThreadId);
      focused?.focus({ preventScroll: true });
    }
  }

  function setQuery(value) { setSearchQuery(String(value || "").trim().toLowerCase()); lastKey = ""; render(); }
  return { render, setQuery, invalidate: () => { lastKey = ""; } };
}

function renderStatusIndicator(thread, state, currentThreadIsRunning) {
  const status = String(thread?.status || "").toLowerCase();
  const running = status === "running" || status === "active" || status === "in_progress" ||
    (thread?.id === state?.currentThreadId && currentThreadIsRunning());
  if (running) return "<span class=\"threadStatusIndicator running\" aria-label=\"正在运行\" title=\"正在运行\"><span></span></span>";
  if (thread.unread) return "<span class=\"threadStatusIndicator unread\" aria-label=\"有新的回复\" title=\"有新的回复\"><span></span></span>";
  return "<span class=\"threadStatusIndicator\" aria-hidden=\"true\"></span>";
}
