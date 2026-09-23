export function createAboveComposer({
  container,
  getState,
  getMessages,
  isMobileView,
  isThreadRunning,
  isAboveComposerTurnDiff,
  messageThreadId,
  messageTurnId,
  fileChangesForMessage,
  planStepsForMessage,
  displayTextForMessage,
  messageRenderKey,
  renderInProgressTurnDiff,
  escapeAttribute,
  formatInlineMarkdown,
  nearBottom,
  stickToBottomSoon,
  updateViewportSizing,
  getPendingInterruptPlanKey,
  onPlanToggle
}) {
  const collapsedPlanIds = new Set();
  const interruptedPlanTurns = new Set();
  let lastRenderKey = "";

  function render() {
    const plan = currentPlan();
    const turnDiff = currentTurnDiff();
    container.classList.toggle("hasPlan", Boolean(plan));
    container.classList.toggle("hasTurnDiff", Boolean(turnDiff));
    const key = [
      plan ? planRenderKey(plan) : "no-plan",
      turnDiff ? messageRenderKey(turnDiff) : "no-diff"
    ].join("||");
    if (key === lastRenderKey) return;
    lastRenderKey = key;

    const shouldStick = nearBottom();
    const previousPlan = container.querySelector(".fixedPlanItem");
    const previousPlanScroller = previousPlan?.querySelector(".fixedPlanScroll");
    const preservedPlanScrollTop = plan && previousPlan?.dataset.messageId === plan.message.id && previousPlanScroller
      ? previousPlanScroller.scrollTop
      : null;
    container.replaceChildren();
    if (plan) container.append(renderPlan(plan, { preservedScrollTop: preservedPlanScrollTop }));
    if (turnDiff) container.append(renderTurnDiff(turnDiff));
    updateViewportSizing();
    if (shouldStick) stickToBottomSoon();
  }

  function currentTurnDiff() {
    const state = getState();
    if (!isMobileView() || !state?.messages?.length) return null;
    const messages = getMessages();
    const activeTurnId = String(state.activeTurnId || "");
    if (isThreadRunning() && activeTurnId) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (isAboveComposerTurnDiff(message) && messageTurnId(message) === activeTurnId && fileChangesForMessage(message).length) return message;
      }
      return null;
    }
    if (isThreadRunning()) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (isAboveComposerTurnDiff(message) && fileChangesForMessage(message).length) return message;
      }
    }
    return null;
  }

  function currentPlan() {
    const state = getState();
    if (!isMobileView() || !state?.messages?.length || !isThreadRunning()) return null;
    const activeTurnId = String(state.activeTurnId || "");
    if (!activeTurnId) return null;
    const messages = getMessages();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.kind !== "plan" || isPlanSuppressed(message) || messageTurnId(message) !== activeTurnId) continue;
      const steps = planStepsForMessage(message, displayTextForMessage(message));
      if (steps.length) return { message, steps };
    }
    return null;
  }

  function isPlanFixed(message) {
    const state = getState();
    if (!isMobileView() || !isThreadRunning() || message?.kind !== "plan" || isPlanSuppressed(message)) return false;
    const steps = planStepsForMessage(message, displayTextForMessage(message));
    if (!steps.length) return false;
    const activeTurnId = String(state?.activeTurnId || "");
    return Boolean(activeTurnId && messageTurnId(message) === activeTurnId);
  }

  function isPlanSuppressed(message) {
    if (message?.kind !== "plan") return false;
    const state = getState();
    const key = planTurnKey(messageThreadId(message) || state?.currentThreadId, messageTurnId(message));
    return Boolean(key && (key === getPendingInterruptPlanKey() || interruptedPlanTurns.has(key)));
  }

  function planTurnKey(threadId, turnId) {
    const normalizedThreadId = String(threadId || "").trim();
    const normalizedTurnId = String(turnId || "").trim();
    return normalizedThreadId && normalizedTurnId ? `${normalizedThreadId}\u0000${normalizedTurnId}` : "";
  }

  function rememberInterruptedPlanTurn(key) {
    if (!key) return;
    interruptedPlanTurns.add(key);
    while (interruptedPlanTurns.size > 200) interruptedPlanTurns.delete(interruptedPlanTurns.values().next().value);
    invalidate();
  }

  function planRenderKey({ message, steps }) {
    return [
      message.id,
      message.streaming ? 1 : 0,
      isThreadRunning() ? 1 : 0,
      collapsedPlanIds.has(message.id) ? 1 : 0,
      steps.map((step) => `${step.index}:${step.status}:${step.text}`).join("||")
    ].join("::");
  }

  function renderTurnDiff(message) {
    const node = document.createElement("article");
    node.className = "fixedTurnDiffItem";
    node.dataset.messageId = message.id;
    node.append(renderInProgressTurnDiff(message));
    return node;
  }

  function renderPlan({ message, steps }, options = {}) {
    const completed = steps.filter((step) => step.status === "completed").length;
    const total = steps.length;
    const isExpanded = !collapsedPlanIds.has(message.id);
    const isComplete = !isThreadRunning();
    const inProgressIndex = steps.findIndex((step) => step.status === "in_progress");
    const scrollIndex = completed === total ? total - 1 : inProgressIndex;
    const block = document.createElement("article");
    block.className = `fixedPlanItem${isExpanded ? " expanded" : " collapsed"}`;
    block.dataset.messageId = message.id;
    block.innerHTML = `
      <div class="fixedPlanHeader" role="button" tabindex="0" aria-expanded="${String(isExpanded)}">
        <div class="fixedPlanTitle">
          <span class="fixedPlanTaskIcon" aria-hidden="true">${taskIconSvg()}</span>
          <span class="fixedPlanSummary">共 ${total} 个任务，已经完成 ${completed} 个</span>
        </div>
        <button class="fixedPlanToggle" type="button" aria-label="${isExpanded ? "折叠任务计划" : "展开任务计划"}" aria-expanded="${String(isExpanded)}">
          ${isExpanded ? collapseIconSvg() : expandIconSvg()}
        </button>
      </div>
      <div class="fixedPlanContent">
        <div class="fixedPlanContentInner">
          <div class="fixedPlanScroll">
            ${steps.map((step, index) => `
              <div class="${escapeAttribute(`fixedPlanStep ${step.status}${index === scrollIndex ? " current" : ""}`)}">
                <span class="fixedPlanStatus" aria-hidden="true">${renderPlanStatusBadge(step.status, isComplete)}</span>
                <span class="fixedPlanIndex">${step.index}.</span>
                <span class="fixedPlanText">${formatInlineMarkdown(step.text)}</span>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;

    const toggle = () => toggleCollapsed(message.id);
    const header = block.querySelector(".fixedPlanHeader");
    header.addEventListener("click", (event) => {
      if (!event.target.closest(".fixedPlanToggle")) toggle();
    });
    header.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    });
    block.querySelector(".fixedPlanToggle").addEventListener("click", toggle);
    requestAnimationFrame(() => {
      const current = block.querySelector(".fixedPlanStep.current");
      const scroller = block.querySelector(".fixedPlanScroll");
      if (!scroller) return;
      if (Number.isFinite(options.preservedScrollTop)) {
        scroller.scrollTop = options.preservedScrollTop;
        return;
      }
      if (current) scroller.scrollTop = Math.max(0, current.offsetTop - scroller.clientHeight / 2 + current.clientHeight / 2);
    });
    return block;
  }

  function renderPlanStatusBadge(status, isComplete) {
    if (status === "completed") return `<span class="fixedPlanBadge done">${checkCircleIconSvg()}</span>`;
    if (status === "in_progress" && !isComplete) return `<span class="fixedPlanBadge active"><span class="fixedPlanSpinner"></span></span>`;
    if (isComplete) return `<span class="fixedPlanBadge skipped">${xCircleFilledIconSvg()}</span>`;
    return `<span class="fixedPlanBadge pending">${unselectedCircleIconSvg()}</span>`;
  }

  function toggleCollapsed(id) {
    if (!id) return;
    if (collapsedPlanIds.has(id)) collapsedPlanIds.delete(id);
    else collapsedPlanIds.add(id);
    invalidate();
    onPlanToggle();
  }

  function isCollapsed(id) {
    return collapsedPlanIds.has(id);
  }

  function expansionKey() {
    return [...collapsedPlanIds].join(",");
  }

  function invalidate() {
    lastRenderKey = "";
  }

  function reset() {
    collapsedPlanIds.clear();
    invalidate();
  }

  return {
    render,
    currentPlan,
    currentTurnDiff,
    isPlanFixed,
    isPlanSuppressed,
    planTurnKey,
    rememberInterruptedPlanTurn,
    toggleCollapsed,
    isCollapsed,
    expansionKey,
    invalidate,
    reset
  };
}

function taskIconSvg() {
  return `<svg viewBox="0 0 21 21" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.09967 11.3164C7.57143 11.3164 8.76458 12.5098 8.76471 13.9815C8.76471 15.4533 7.57151 16.6465 6.09967 16.6465C4.62798 16.6463 3.43463 15.4532 3.43463 13.9815C3.43476 12.5099 4.62806 11.3166 6.09967 11.3164ZM6.09967 12.6465C5.3626 12.6467 4.76484 13.2444 4.76471 13.9815C4.76471 14.7187 5.36252 15.3163 6.09967 15.3164C6.83697 15.3164 7.43463 14.7188 7.43463 13.9815C7.4345 13.2443 6.83689 12.6465 6.09967 12.6465Z"/><path d="M17.7335 13.3301C18.0365 13.392 18.2646 13.6602 18.2647 13.9815C18.2647 14.3029 18.0366 14.5709 17.7335 14.6328L17.5997 14.6465H11.5997C11.2326 14.6463 10.9346 14.3486 10.9346 13.9815C10.9348 13.6144 11.2326 13.3166 11.5997 13.3164H17.5997L17.7335 13.3301Z"/><path d="M7.89752 3.78207C8.11783 3.48849 8.53542 3.42922 8.82916 3.64925C9.12284 3.86964 9.1823 4.28713 8.96198 4.58089L5.96198 8.58089C5.84631 8.73502 5.66885 8.8309 5.47662 8.84457C5.28452 8.85806 5.09523 8.78836 4.95905 8.65218L3.45905 7.15218L3.37409 7.04769C3.20382 6.78961 3.23191 6.43795 3.45905 6.21078C3.68622 5.98361 4.03786 5.95556 4.29596 6.12582L4.40045 6.21078L5.35748 7.16781L7.89752 3.78207Z"/><path d="M17.7335 5.73011C18.0365 5.79203 18.2646 6.06015 18.2647 6.38148C18.2647 6.70291 18.0366 6.97091 17.7335 7.03285L17.5997 7.04652H11.5997C11.2326 7.04634 10.9346 6.74864 10.9346 6.38148C10.9348 6.01443 11.2326 5.71662 11.5997 5.71644H17.5997L17.7335 5.73011Z"/></svg>`;
}

function collapseIconSvg() {
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.0299 3.0293C16.2896 2.76996 16.7107 2.76988 16.9703 3.0293C17.23 3.28899 17.23 3.711 16.9703 3.9707L13.2731 7.66797H16.9996L17.1344 7.68164C17.4372 7.74375 17.6645 8.01192 17.6647 8.33301C17.6647 8.65421 17.4372 8.92219 17.1344 8.98438L16.9996 8.99805H11.6666C11.2994 8.99801 11.0016 8.70026 11.0016 8.33301V3C11.0016 2.63275 11.2994 2.33499 11.6666 2.33496C12.0339 2.33496 12.3317 2.63273 12.3317 3V6.72754L16.0299 3.0293ZM8.99475 17C8.99475 17.3673 8.69698 17.665 8.32971 17.665C7.96258 17.6649 7.66467 17.3672 7.66467 17V13.2725L3.96741 16.9707C3.70771 17.2304 3.2857 17.2304 3.026 16.9707C2.7663 16.711 2.7663 16.289 3.026 16.0293L6.72424 12.332H2.9967C2.62955 12.332 2.33185 12.0341 2.33167 11.667C2.33167 11.2997 2.62943 11.002 2.9967 11.002H8.32971C8.69698 11.002 8.99475 11.2997 8.99475 11.667V17Z"/></svg>`;
}

function expandIconSvg() {
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.33496 11C4.33496 10.6327 4.63273 10.335 5 10.335C5.36727 10.335 5.66504 10.6327 5.66504 11V14.335H9L9.13379 14.3486C9.43692 14.4106 9.66504 14.6786 9.66504 15C9.66504 15.3214 9.43692 15.5894 9.13379 15.6514L9 15.665H5C4.63273 15.665 4.33496 15.3673 4.33496 15V11ZM14.335 9V5.66504H11C10.6327 5.66504 10.335 5.36727 10.335 5C10.335 4.63273 10.6327 4.33496 11 4.33496H15L15.1338 4.34863C15.4369 4.41057 15.665 4.67857 15.665 5V9C15.665 9.36727 15.3673 9.66504 15 9.66504C14.6327 9.66504 14.335 9.36727 14.335 9Z"/></svg>`;
}

function checkCircleIconSvg() {
  return `<svg viewBox="0 0 20 21" aria-hidden="true"><path d="M12.1599 7.63617C12.3713 7.33596 12.7863 7.26372 13.0866 7.47504C13.3867 7.68642 13.4589 8.10153 13.2477 8.40179L9.28876 14.0268C9.17264 14.1917 8.98808 14.2954 8.7868 14.308C8.61044 14.319 8.43764 14.2592 8.30634 14.144L8.25262 14.0912L6.16962 11.7993L6.08954 11.6918C5.93136 11.4259 5.97666 11.0761 6.21454 10.8598C6.45225 10.6439 6.80379 10.6326 7.05341 10.8149L7.15399 10.9047L8.67841 12.5815L12.1599 7.63617Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M9.99506 2.81226C14.3664 2.81226 17.9101 6.35596 17.9101 10.7273C17.9101 15.0986 14.3664 18.6423 9.99506 18.6423C5.62372 18.6423 2.08002 15.0986 2.08002 10.7273C2.08002 6.35596 5.62372 2.81226 9.99506 2.81226ZM9.99506 4.14233C6.35826 4.14233 3.4101 7.0905 3.4101 10.7273C3.4101 14.3641 6.35826 17.3123 9.99506 17.3123C13.6319 17.3123 16.58 14.3641 16.58 10.7273C16.58 7.0905 13.6319 4.14233 9.99506 4.14233Z"/></svg>`;
}

function unselectedCircleIconSvg() {
  return `<svg viewBox="0 0 20 21" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 2.9032C14.3713 2.9032 17.915 6.4469 17.915 10.8182C17.915 15.1896 14.3713 18.7333 10 18.7333C5.62867 18.7333 2.08496 15.1896 2.08496 10.8182C2.08496 6.4469 5.62867 2.9032 10 2.9032ZM10 4.23328C6.3632 4.23328 3.41504 7.18144 3.41504 10.8182C3.41504 14.455 6.3632 17.4032 10 17.4032C13.6368 17.4032 16.585 14.455 16.585 10.8182C16.585 7.18144 13.6368 4.23328 10 4.23328Z"/></svg>`;
}

function xCircleFilledIconSvg() {
  return `<svg viewBox="0 0 21 21" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.7997 2.48486C15.4019 2.48486 19.1335 6.21565 19.1337 10.8179C19.1337 15.4202 15.4021 19.1519 10.7997 19.1519C6.19746 19.1517 2.46667 15.4201 2.46667 10.8179C2.46685 6.21576 6.19757 2.48504 10.7997 2.48486ZM8.97253 8.05029C8.71284 7.79059 8.29083 7.79059 8.03113 8.05029C7.77189 8.31002 7.77162 8.73117 8.03113 8.99072L9.85925 10.8179L8.03113 12.646C7.77173 12.9056 7.77178 13.3268 8.03113 13.5864C8.29083 13.8461 8.71284 13.8461 8.97253 13.5864L10.7997 11.7583L12.6278 13.5864C12.8875 13.8461 13.3085 13.8461 13.5682 13.5864C13.8279 13.3267 13.8279 12.9057 13.5682 12.646L11.7401 10.8179L13.5682 8.99072L13.6532 8.88623C13.8237 8.62817 13.7953 8.27758 13.5682 8.05029C13.341 7.82301 12.9904 7.79478 12.7323 7.96533L12.6278 8.05029L10.7997 9.87744L8.97253 8.05029Z"/></svg>`;
}
