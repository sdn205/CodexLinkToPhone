export function createThreadNavigation({
  elements,
  getState,
  isMobileView,
  annotationUI,
  send,
  createClientId,
  threadListPullMaxPx = 76,
  threadListPullTriggerPx = 52
}) {
  let historyBackPending = false;
  let historyReopenPending = false;
  let clearUnreadPending = false;
  let pullStartY = null;
  let pullDistance = 0;
  const historyStateKey = "__codexPhoneSidebarOpen";

  function toggleSidebar() {
    if (elements.sidebar.classList.contains("open")) closeSidebar();
    else openSidebar();
  }

  function openSidebar() {
    if (historyBackPending) {
      historyReopenPending = true;
      return;
    }
    setSidebarOpen(true);
    if (!isMobileView() || sidebarIsOpenInHistory()) return;
    const currentHistoryState = history.state && typeof history.state === "object" ? history.state : {};
    history.pushState({ ...currentHistoryState, [historyStateKey]: true }, "", location.href);
  }

  function closeSidebar() {
    historyReopenPending = false;
    if (isMobileView() && sidebarIsOpenInHistory()) {
      if (!historyBackPending) {
        historyBackPending = true;
        history.back();
      }
      return;
    }
    setSidebarOpen(false);
  }

  function handleSidebarPopState(event) {
    const reopenAfterBack = historyReopenPending;
    historyBackPending = false;
    historyReopenPending = false;
    syncSidebarFromHistory(event.state);
    if (reopenAfterBack) openSidebar();
  }

  function syncSidebarFromHistory(historyState) {
    setSidebarOpen(Boolean(isMobileView() && sidebarIsOpenInHistory(historyState)));
  }

  function sidebarIsOpenInHistory(historyState = history.state) {
    return Boolean(
      historyState &&
      typeof historyState === "object" &&
      historyState[historyStateKey] === true
    );
  }

  function setSidebarOpen(open) {
    elements.sidebar.classList.toggle("open", open);
    elements.sidebarBackdrop.classList.toggle("open", open);
    elements.menuBtn.setAttribute("aria-expanded", String(open));
    syncSidebarAccessibility();
    annotationUI.updateControls();
  }

  function syncSidebarAccessibility() {
    const hidden = isMobileView() && !elements.sidebar.classList.contains("open");
    elements.sidebar.inert = hidden;
    elements.sidebar.setAttribute("aria-hidden", String(hidden));
  }

  function unreadThreadCount() {
    return (getState()?.threads || []).filter((thread) => thread?.unread).length;
  }

  function renderClearUnreadControl() {
    const count = unreadThreadCount();
    const reveal = elements.clearUnreadReveal;
    const button = elements.clearUnreadBtn;
    if (!reveal || !button) return;
    button.disabled = clearUnreadPending || count === 0;
    reveal.dataset.unreadCount = String(count);
    reveal.setAttribute("aria-hidden", String(count === 0 && pullDistance === 0));
    reveal.style.height = `${pullDistance}px`;
    reveal.classList.toggle("isPulling", pullDistance > 0);
  }

  function beginThreadListPull(event) {
    if (!isMobileView() || event.touches?.length !== 1) return;
    pullStartY = event.touches[0].clientY;
    pullDistance = 0;
    renderClearUnreadControl();
  }

  function updateThreadListPull(event) {
    if (pullStartY === null || event.touches?.length !== 1) return;
    if (elements.threadList.scrollTop > 0) {
      pullStartY = null;
      pullDistance = 0;
      renderClearUnreadControl();
      return;
    }
    const distance = event.touches[0].clientY - pullStartY;
    if (distance <= 0) return;
    const count = unreadThreadCount();
    if (count === 0) return;
    pullDistance = Math.min(threadListPullMaxPx, Math.round(distance * 0.72));
    if (pullDistance > 0) event.preventDefault();
    renderClearUnreadControl();
  }

  function endThreadListPull(event) {
    if (pullStartY === null) return;
    const shouldReveal = event?.type !== "touchcancel" && pullDistance >= threadListPullTriggerPx && unreadThreadCount() > 0;
    pullStartY = null;
    if (!shouldReveal) pullDistance = 0;
    renderClearUnreadControl();
  }

  function clearAllUnreadThreads() {
    if (clearUnreadPending || unreadThreadCount() === 0) return;
    clearUnreadPending = true;
    pullStartY = null;
    pullDistance = 0;
    renderClearUnreadControl();
    if (!send({ type: "threads:mark-all-read", requestId: createClientId() })) {
      clearUnreadPending = false;
      renderClearUnreadControl();
    }
  }

  function resetUnreadRequestState() {
    clearUnreadPending = false;
    pullStartY = null;
    pullDistance = 0;
    renderClearUnreadControl();
  }

  return {
    toggleSidebar,
    openSidebar,
    closeSidebar,
    handleSidebarPopState,
    syncSidebarFromHistory,
    sidebarIsOpenInHistory,
    setSidebarOpen,
    syncSidebarAccessibility,
    unreadThreadCount,
    renderClearUnreadControl,
    beginThreadListPull,
    updateThreadListPull,
    endThreadListPull,
    clearAllUnreadThreads,
    resetUnreadRequestState,
    isHistoryBackPending: () => historyBackPending
  };
}
