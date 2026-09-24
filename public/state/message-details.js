import { getBridgeEpoch } from "./phone-state.js";

// Full output is content-addressed data, independent of the compact message
// window. Rendering and request eligibility use textTruncated on the projected
// message; there is no separate "already loaded" flag that can outlive its text.
export function createMessageDetails({ send, createRequestId, onChange, onError, timeoutMs = 15000 }) {
  const content = new Map();
  const requests = new Map();
  let epoch = "";

  function key(message) {
    return JSON.stringify([message?.meta?.threadId || "", message?.id || ""]);
  }

  function version(message) {
    return JSON.stringify([
      message?.meta?.turnId || "", message?.role, message?.kind,
      message?.textHash, message?.originalLength
    ]);
  }

  function clearRequest(requestId) {
    const request = requests.get(requestId);
    if (!request) return null;
    clearTimeout(request.timer);
    requests.delete(requestId);
    return request;
  }

  function disconnect() {
    for (const requestId of requests.keys()) clearRequest(requestId);
  }

  function projectState(state) {
    const nextEpoch = getBridgeEpoch(state);
    if (epoch !== nextEpoch) {
      content.clear();
      disconnect();
      epoch = nextEpoch;
    }
    const versions = new Map(state.messages.map((message) => [key(message), version(message)]));
    for (const [requestId, pending] of requests) {
      if (versions.has(pending.key) && versions.get(pending.key) !== pending.version) clearRequest(requestId);
    }
    let changed = false;
    const messages = state.messages.map((message) => {
      const entry = content.get(key(message));
      if (!entry) return message;
      if (entry.version !== version(message)) {
        content.delete(key(message));
        return message;
      }
      if (!message.textTruncated) return message;
      changed = true;
      const full = { ...message, text: entry.text, textTruncated: false };
      if (entry.aggregatedOutput !== undefined) full.meta = { ...message.meta, aggregatedOutput: entry.aggregatedOutput };
      return full;
    });
    return changed ? { ...state, messages } : state;
  }

  function request(message) {
    if (!message?.textTruncated || !message.textHash || !message.meta?.threadId) return false;
    const messageKey = key(message);
    if ([...requests.values()].some((pending) => pending.key === messageKey)) return false;
    const requestId = createRequestId();
    const timer = setTimeout(() => {
      if (clearRequest(requestId)) onError("加载完整输出超时，请重新展开");
    }, timeoutMs);
    requests.set(requestId, { key: messageKey, version: version(message), timer });
    if (!send({ type: "message:detail", id: message.id, threadId: message.meta.threadId, requestId })) {
      clearRequest(requestId);
      return false;
    }
    return true;
  }

  function receive(payload) {
    const pending = clearRequest(payload.requestId);
    if (!pending) return false;
    if (!payload.ok || !payload.message) {
      onError(payload.message || "加载完整输出失败，请重试");
      return false;
    }
    const message = payload.message;
    if (key(message) !== pending.key || version(message) !== pending.version || message.textTruncated ||
        typeof message.text !== "string" || message.text.length !== message.originalLength) {
      onError("消息内容已更新，请重新展开完整输出");
      return false;
    }
    content.set(pending.key, {
      version: pending.version,
      text: message.text,
      aggregatedOutput: message.kind === "command" ? message.meta?.aggregatedOutput : undefined
    });
    onChange();
    return true;
  }

  return { projectState, request, receive, disconnect };
}
