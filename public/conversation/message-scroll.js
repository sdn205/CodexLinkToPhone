/**
 * Owns message viewport state and user scroll gestures.
 * Rendering code only asks whether to stick and schedules a scroll; it does
 * not need to know how pointer/touch gestures change that decision.
 */
export function createMessageScrollController({
  messages,
  scrollBottomButton,
  composer,
  getState,
  hasActiveSelection = () => false,
  isMobileView = () => false,
  getMessageCount = () => 0
} = {}) {
  if (!messages || !scrollBottomButton || !composer) throw new TypeError("message scroll elements are required");

  let needsInitialScroll = true;
  let autoStick = true;
  let requestVersion = 0;
  let pointerActive = false;
  let lastScrollTop = 0;
  let touchStartY = null;
  let gesturePaused = false;
  let gestureWasAutoStick = false;
  let bottomFrame = null;

  function scrollToLatest() {
    const lastMessage = messages.querySelector(".message:last-of-type");
    if (!lastMessage) {
      messages.scrollTop = 0;
      return;
    }
    const composerHeight = composer.getBoundingClientRect().height || 0;
    const bottomInset = Math.min(180, composerHeight + 24);
    const target = lastMessage.offsetTop + lastMessage.offsetHeight - messages.clientHeight + bottomInset;
    messages.scrollTop = Math.max(0, target);
  }

  function scrollToBottomFromButton() {
    resumeAutoStick();
    const previousScrollBehavior = messages.style.scrollBehavior;
    messages.style.scrollBehavior = "auto";
    messages.scrollTop = messages.scrollHeight;
    scrollBottomButton.classList.remove("show");
    scrollBottomButton.setAttribute("aria-hidden", "true");
    scrollBottomButton.tabIndex = -1;
    updateBottomButton();
    requestAnimationFrame(() => {
      messages.style.scrollBehavior = previousScrollBehavior;
    });
  }

  function nearBottom() {
    return !hasActiveSelection() && (needsInitialScroll || autoStick);
  }

  function stickToBottomSoon(afterScroll) {
    const scheduledVersion = requestVersion;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (
          scheduledVersion !== requestVersion ||
          hasActiveSelection() ||
          gestureActive() ||
          (!needsInitialScroll && !autoStick)
        ) return;
        const distanceFromBottom = Math.max(0, messages.scrollHeight - messages.scrollTop - messages.clientHeight);
        if (distanceFromBottom > 8 && !autoStick && !needsInitialScroll) return;
        if (isMobileView()) messages.scrollTop = messages.scrollHeight;
        else scrollToLatest();
        updateBottomButton();
        afterScroll?.();
      });
    });
  }

  function beginPointerGesture(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointerActive = true;
    lastScrollTop = messages.scrollTop;
    pauseAutoStickForGesture();
  }

  function endPointerGesture() {
    pointerActive = false;
    finishAutoStickGesture();
  }

  function beginTouchGesture(event) {
    touchStartY = event.touches[0]?.clientY ?? null;
    pauseAutoStickForGesture();
  }

  function trackTouchGesture(event) {
    const currentY = event.touches[0]?.clientY;
    if (touchStartY === null || currentY === undefined) return;
    if (currentY > touchStartY + 3 || event.target?.closest?.(".cmdOutputWrap")) suspendAutoStick();
    touchStartY = currentY;
  }

  function endTouchGesture() {
    touchStartY = null;
    finishAutoStickGesture();
  }

  function handleScroll(event) {
    if (event?.target && event.target !== messages) return;
    const currentScrollTop = messages.scrollTop;
    if (pointerActive && currentScrollTop < lastScrollTop - 1) suspendAutoStick();
    lastScrollTop = currentScrollTop;
    const distance = Math.max(0, messages.scrollHeight - currentScrollTop - messages.clientHeight);
    if (distance <= 2 && !gestureActive()) {
      autoStick = true;
    } else if (distance > 2 && (gestureActive() || !needsInitialScroll)) {
      needsInitialScroll = false;
      autoStick = false;
    }
    scheduleBottomButtonUpdate();
  }

  function gestureActive() {
    return pointerActive || touchStartY !== null;
  }

  function pauseAutoStickForGesture() {
    if (gesturePaused) return;
    gesturePaused = true;
    gestureWasAutoStick = nearBottom();
    suspendAutoStick();
  }

  function finishAutoStickGesture() {
    if (gestureActive() || !gesturePaused) return;
    const shouldResume = gestureWasAutoStick && atBottom();
    gesturePaused = false;
    gestureWasAutoStick = false;
    if (shouldResume) resumeAutoStick();
  }

  function atBottom(threshold = 2) {
    const distance = Math.max(0, messages.scrollHeight - messages.scrollTop - messages.clientHeight);
    return distance <= threshold;
  }

  function suspendAutoStick() {
    if (!needsInitialScroll && !autoStick) return;
    needsInitialScroll = false;
    autoStick = false;
    requestVersion += 1;
  }

  function resumeAutoStick() {
    autoStick = true;
    requestVersion += 1;
  }

  function setInitialScrollPending(value) {
    needsInitialScroll = Boolean(value);
  }

  function autoStickEnabled() {
    return autoStick;
  }

  function resetGestureState() {
    pointerActive = false;
    touchStartY = null;
    gesturePaused = false;
    gestureWasAutoStick = false;
  }

  function scheduleBottomButtonUpdate() {
    if (bottomFrame) return;
    bottomFrame = requestAnimationFrame(updateBottomButton);
  }

  function updateBottomButton() {
    if (bottomFrame) {
      cancelAnimationFrame(bottomFrame);
      bottomFrame = null;
    }
    const distance = Math.max(0, messages.scrollHeight - messages.scrollTop - messages.clientHeight);
    const canScroll = messages.scrollHeight > messages.clientHeight + 12;
    const shouldShow = Boolean(getMessageCount() && canScroll && distance > (isMobileView() ? 156 : 220));
    scrollBottomButton.classList.toggle("show", shouldShow);
    scrollBottomButton.setAttribute("aria-hidden", shouldShow ? "false" : "true");
    scrollBottomButton.tabIndex = shouldShow ? 0 : -1;
  }

  return {
    scrollToLatest,
    scrollToBottomFromButton,
    nearBottom,
    stickToBottomSoon,
    beginPointerGesture,
    endPointerGesture,
    beginTouchGesture,
    trackTouchGesture,
    endTouchGesture,
    handleScroll,
    suspendAutoStick,
    resumeAutoStick,
    atBottom,
    scheduleBottomButtonUpdate,
    updateBottomButton,
    setInitialScrollPending,
    autoStickEnabled,
    resetGestureState
  };
}
