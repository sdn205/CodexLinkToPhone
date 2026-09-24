export function createStreamDomUpdater({
  messages,
  getState,
  annotationUI,
  roleLabel,
  messagesNearBottom,
  stickMessagesToBottomSoon,
  scheduleScrollBottomButtonUpdate
}) {
  const pending = new Map();
  let frame = null;

  function queue(messageId, offset, delta) {
    const existing = pending.get(messageId);
    if (existing && existing.endOffset === offset) {
      existing.delta += delta;
      existing.endOffset += delta.length;
    } else {
      pending.set(messageId, { offset, delta, endOffset: offset + delta.length });
    }
    if (frame === null) frame = requestAnimationFrame(flush);
  }

  function flush() {
    frame = null;
    for (const [messageId, update] of pending) {
      pending.delete(messageId);
      const message = getState()?.messages?.find((entry) => String(entry.id || "") === messageId);
      const node = messages.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
      const bubble = node?.querySelector(".bubble");
      if (!message?.streaming || !node || !bubble) continue;
      node.classList.add("streaming");
      if (annotationUI.renderStreaming(bubble, message)) continue;
      const currentOffset = Number(bubble.dataset.streamOffset);
      if (currentOffset === update.offset) {
        bubble.append(document.createTextNode(update.delta));
        bubble.dataset.streamOffset = String(update.endOffset);
      } else if (currentOffset !== String(message.text || "").length && !annotationUI.protectsMessage(messageId)) {
        bubble.textContent = String(message.text || "");
        bubble.dataset.streamOffset = String(message.text || "").length;
      }
      const metaLabel = node.querySelector(".messageMeta span");
      if (metaLabel) metaLabel.textContent = `${roleLabel(message)} · 生成中`;
    }
    if (messagesNearBottom()) stickMessagesToBottomSoon();
    else scheduleScrollBottomButtonUpdate();
  }

  function discardCompleted(patch) {
    for (const message of patch?.messages?.items || []) {
      if (!message?.streaming && message?.id) pending.delete(String(message.id));
    }
  }

  function reset() {
    pending.clear();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function discardMessage(messageId) {
    pending.delete(String(messageId || ""));
  }

  return { queue, discardCompleted, discardMessage, reset };
}
