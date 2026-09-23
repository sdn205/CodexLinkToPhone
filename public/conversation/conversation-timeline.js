export function createConversationTimeline({
  getState,
  isMobileView,
  isThreadRunning,
  currentFixedTurnDiff,
  messageThreadId,
  messageTurnId,
  messageIsInProgress,
  isAboveComposerTurnDiff,
  isTimelineRowsTurnDiff,
  isCompletedTurnDiffCard,
  formatElapsed
}) {
  function messages() {
    const state = getState();
    return (state?.messages || []).filter((message) => {
      const threadId = messageThreadId(message);
      if (!state.currentThreadId || threadId !== state.currentThreadId) return false;
      return message?.role !== "system" && message?.kind !== "system";
    });
  }

  function renderable(sourceMessages) {
    const timelineMessages = sourceMessages.filter((message) => message.kind !== "plan" && message.kind !== "reasoning");
    if (!isMobileView()) return timelineMessages;
    const fixedTurnDiffId = currentFixedTurnDiff()?.id || "";
    return timelineMessages.filter((message) => {
      if (isAboveComposerTurnDiff(message)) return fixedTurnDiffId !== message.id;
      return !isTimelineRowsTurnDiff(message);
    });
  }

  function renderItems(sourceMessages) {
    const dividers = turnDividers(sourceMessages);
    const groupCommands = isMobileView();
    const items = [];
    for (let index = 0; index < sourceMessages.length;) {
      const message = sourceMessages[index];
      const divider = dividers.get(message.id);
      if (divider) items.push(divider);
      const commandGroup = groupCommands ? collectCommandGroup(sourceMessages, index) : null;
      if (commandGroup) {
        items.push(commandGroup);
        index = commandGroup.endIndex;
      } else {
        items.push({ type: "message", message });
        index += 1;
      }
    }
    return items;
  }

  function collectCommandGroup(sourceMessages, startIndex) {
    const first = sourceMessages[startIndex];
    if (!isCommand(first)) return null;
    const turnId = messageTurnId(first);
    const groupedMessages = [first];
    let endIndex = startIndex + 1;
    while (turnId && endIndex < sourceMessages.length) {
      const candidate = sourceMessages[endIndex];
      if (!isCommand(candidate) || messageTurnId(candidate) !== turnId) break;
      groupedMessages.push(candidate);
      endIndex += 1;
    }
    const state = getState();
    const threadId = messageThreadId(first) || state?.currentThreadId || "";
    return {
      type: "commandGroup",
      id: `command-group:${encodeURIComponent(threadId)}:${encodeURIComponent(turnId || "message")}:${encodeURIComponent(first.id)}`,
      messages: groupedMessages,
      startIndex,
      endIndex
    };
  }

  function isCommand(message) {
    return message?.role === "tool" && message?.kind === "command";
  }

  function turnDividers(sourceMessages) {
    const dividers = new Map();
    if (sourceMessages.length < 2) return dividers;
    const state = getState();
    const turns = collectTurns(sourceMessages);
    const firstWorkByTurnId = new Map();
    for (const message of sourceMessages) {
      const turnId = messageTurnId(message);
      if (turnId && isTurnWorkMessage(message) && !firstWorkByTurnId.has(turnId)) firstWorkByTurnId.set(turnId, message);
    }
    for (const timing of authoritativeTurnTimings(state)) {
      if (isTurnRunning(timing.turnId, turns, state)) continue;
      const turn = turns.get(String(timing.turnId || ""));
      const anchor = turnDividerAnchor(turn) || firstWorkByTurnId.get(String(timing.turnId || ""));
      if (!anchor || dividers.has(anchor.id)) continue;
      const elapsedMs = Math.max(0, timing.completedAt - timing.startedAt);
      dividers.set(anchor.id, {
        type: "turnDivider",
        id: `turn-divider-${state.currentThreadId || "thread"}-${timing.turnId || anchor.id}`,
        beforeMessageId: anchor.id,
        label: `已处理 ${formatElapsed(elapsedMs)}`
      });
    }
    return dividers;
  }

  function authoritativeTurnTimings(state) {
    return (Array.isArray(state?.turnTimings) ? state.turnTimings : [])
      .filter((timing) => timing?.turnId && (!timing.threadId || !state.currentThreadId || timing.threadId === state.currentThreadId))
      .map((timing) => ({
        ...timing,
        startedAt: normalizeTimestamp(timing.startedAt),
        completedAt: normalizeTimestamp(timing.completedAt)
      }))
      .filter((timing) => timing.startedAt && timing.completedAt && timing.completedAt >= timing.startedAt);
  }

  function collectTurns(sourceMessages) {
    const turns = new Map();
    let fallbackTurnId = "";
    let previousUser = null;
    for (const message of sourceMessages) {
      const explicitTurnId = messageTurnId(message);
      if (message.role === "user") {
        fallbackTurnId = explicitTurnId || message.id;
        previousUser = message;
      }
      const turnId = explicitTurnId || fallbackTurnId;
      if (!turnId) continue;
      const turn = turns.get(turnId) || {
        turnId,
        user: null,
        firstWorkMessage: null,
        finalAssistantMessage: null,
        completedTurnDiffMessage: null,
        hasRunningWork: false
      };
      if (messageIsInProgress(message)) turn.hasRunningWork = true;
      if (message.role === "user" && !turn.user) turn.user = message;
      if (message.role === "assistant" && explicitTurnId && !turn.user && previousUser &&
          (!messageTurnId(previousUser) || messageTurnId(previousUser) === explicitTurnId)) turn.user = previousUser;
      if (isTurnWorkMessage(message) && !turn.firstWorkMessage) turn.firstWorkMessage = message;
      if (message.role === "assistant" && message.kind === "text") turn.finalAssistantMessage = message;
      if (isCompletedTurnDiffCard(message)) turn.completedTurnDiffMessage = message;
      turns.set(turnId, turn);
    }
    return turns;
  }

  function isTurnWorkMessage(message) {
    return Boolean(message && message.kind !== "file" && (message.role === "assistant" || message.role === "tool"));
  }

  function isTurnRunning(turnId, turns, state) {
    if (turns.get(String(turnId || ""))?.hasRunningWork) return true;
    return Boolean(isThreadRunning() && turnId && state.activeTurnId && String(turnId) === String(state.activeTurnId));
  }

  function turnDividerAnchor(turn) {
    return turn?.finalAssistantMessage || turn?.completedTurnDiffMessage || turn?.firstWorkMessage || null;
  }

  function normalizeTimestamp(value) {
    const timestamp = Number(value || 0);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
    return timestamp < 1e12 ? timestamp * 1000 : timestamp;
  }

  return { messages, renderable, renderItems, turnDividers };
}
