import { streamTextHash } from "../transport/stream-protocol.js";

export function isValidStatePayload(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && value.codex && typeof value.codex === "object"
    && Array.isArray(value.threads) && Array.isArray(value.messages)
    && Array.isArray(value.models) && Array.isArray(value.approvals)
    && value.sync && typeof value.sync === "object");
}

export function getBridgeEpoch(value) {
  const epoch = value?.app?.bridgeEpoch;
  return typeof epoch === "string" && epoch.trim() ? epoch.trim() : "";
}

// Pure protocol reducer. DOM, drafts, navigation, and socket recovery are effects
// of the returned result; none may partially apply a rejected state transition.
export function reducePhoneState(state, event, options = {}) {
  const unchanged = (status, extra = {}) => ({ state, status, ...extra });
  if (event.type === "state") {
    const next = event.state;
    if (!isValidStatePayload(next)) return unchanged("invalid");
    const epochChanged = options.firstForConnection && (
      !getBridgeEpoch(state) || !getBridgeEpoch(next) || getBridgeEpoch(state) !== getBridgeEpoch(next)
    );
    if (state && !epochChanged && Number(next.threadRevision || 0) < Number(state.threadRevision || 0)) return unchanged("ignored");
    return { state: next, status: "applied" };
  }
  if (!state) return unchanged("gap");
  if (event.type === "state:patch") {
    const patch = event.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return unchanged("invalid");
    if (patch.threadRevision !== undefined && Number(patch.threadRevision) < Number(state.threadRevision || 0)) return unchanged("ignored");
    if (patch.currentThreadId !== undefined && patch.currentThreadId !== state.currentThreadId) return unchanged("gap");
    let messages = state.messages;
    if (patch.messages) {
      const existing = new Map(messages.map((message) => [message.id, message]));
      for (const message of patch.messages.items || []) existing.set(message.id, message);
      const ids = patch.messages.ids || messages.map((message) => message.id);
      if (ids.some((id) => !existing.has(id))) return unchanged("gap");
      messages = ids.map((id) => existing.get(id));
    }
    return { state: { ...state, ...patch, messages }, status: "applied" };
  }

  const messageId = String(event.messageId || "");
  if (!messageId || String(event.threadId || "") !== String(state.currentThreadId || "")) return unchanged("ignored");
  const messages = state.messages.slice();
  let index = messages.findIndex((message) => String(message.id || "") === messageId);
  if (event.type === "stream:append") {
    const offset = Number(event.offset);
    if (!Number.isSafeInteger(Number(event.frameId)) || !Number.isSafeInteger(offset) || offset < 0) return unchanged("ignored");
    let inserted = false;
    if (index < 0) {
      if (offset !== 0 || !validStreamMessage(event.message, messageId, event.threadId)) {
        return unchanged("rejected", { ack: { ok: false, offset: 0 } });
      }
      const afterId = String(event.afterId || "");
      const beforeId = String(event.beforeId || "");
      const afterIndex = afterId ? messages.findIndex((message) => message.id === afterId) : -1;
      const beforeIndex = beforeId ? messages.findIndex((message) => message.id === beforeId) : -1;
      if ((afterId && afterIndex < 0) || (beforeId && beforeIndex < 0)) {
        return unchanged("gap", { ack: { ok: false, offset: 0 } });
      }
      index = beforeIndex >= 0 ? beforeIndex : afterIndex >= 0 ? afterIndex + 1 : messages.length;
      messages.splice(index, 0, {
        ...event.message, id: messageId, role: "assistant", kind: "text", text: "", streaming: true,
        meta: { ...(event.message.meta || {}), threadId: String(event.threadId), turnId: String(event.turnId || event.message.meta?.turnId || "") }
      });
      inserted = true;
    }
    const previous = messages[index];
    const text = String(previous.text || "");
    if (text.length !== offset) return unchanged("rejected", { ack: { ok: false, offset: text.length } });
    const delta = String(event.delta || "");
    messages[index] = {
      ...previous, text: text + delta, streaming: true,
      revision: Math.max(Number(previous.revision || 0), Number(event.revision || 0))
    };
    return { state: { ...state, messages }, status: "applied", inserted, delta, offset, ack: { ok: true, offset: offset + delta.length } };
  }
  if (event.type === "stream:complete") {
    if (index < 0) return unchanged("gap");
    const previous = messages[index];
    const text = String(previous.text || "");
    if (text.length !== Number(event.offset) || (event.textHash && streamTextHash(text) !== String(event.textHash))) return unchanged("gap");
    const metadata = event.message && typeof event.message === "object" ? event.message : {};
    messages[index] = {
      ...previous, ...metadata, id: messageId, role: "assistant", kind: "text", text, streaming: false,
      meta: { ...(previous.meta || {}), ...(metadata.meta || {}) }
    };
    return { state: { ...state, messages }, status: "applied" };
  }
  return unchanged("ignored");
}

function validStreamMessage(message, messageId, threadId) {
  return Boolean(message && String(message.id || "") === messageId && message.role === "assistant"
    && message.kind === "text" && String(message.meta?.threadId || "") === String(threadId || ""));
}
