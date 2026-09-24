import { createPhoneHeartbeat } from "./phone-heartbeat.js";
import { createPhoneReceiver } from "./phone-receiver.js";
import { createPhoneSocket } from "./phone-socket.js";

const AUTH_CLOSE_CODES = new Set([1008, 4001, 4003, 4401, 4403]);

export function createPhoneConnection({
  getUrl,
  isVisible,
  getVisibilitySeq,
  onConnecting,
  onOpen,
  onMessage,
  onClose,
  onAuthFailure,
  onRepeatedFailure,
  onHealthy,
  onProtocolError,
  onTransportError,
  onProgress = () => {},
  connectTimeoutMs = 8000,
  foregroundDebounceMs = 2000
}) {
  let reconnectTimer = null;
  let reconnectFailureCount = 0;
  let lastForegroundSyncAt = 0;

  const transport = createPhoneSocket({
    getUrl,
    connectTimeoutMs,
    onOpen: handleOpen,
    onMessage: handleRawMessage,
    onClose: handleClose,
    onError: handleError
  });
  const heartbeat = createPhoneHeartbeat({
    isVisible,
    getSocket: () => isOpen() ? transport.socket : null,
    send,
    reconnect,
    getVisibilitySeq
  });

  function connect() {
    clearTimeout(reconnectTimer);
    heartbeat.clear();
    receiver.reset();
    onConnecting();
    transport.connect();
  }

  function handleOpen(context) {
    heartbeat.probe();
    onOpen(context);
  }

  let messageContext;
  const receiver = createPhoneReceiver({ send, receive: payload => onMessage(payload, messageContext) });
  function handleRawMessage(event, context) {
    heartbeat.markHealthy();
    reconnectFailureCount = 0;
    messageContext = context;
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "transport:chunk") onProgress(payload.requestId);
      receiver.accept(payload);
    } catch (error) {
      onProtocolError(error);
      reconnect();
      return;
    }
  }

  function handleClose(event, context) {
    heartbeat.clear();
    onClose(event, context);
    if (isAuthFailure(event)) {
      onAuthFailure(event);
      return;
    }
    reconnectFailureCount += 1;
    if (reconnectFailureCount >= 3) onRepeatedFailure(reconnectFailureCount);
    if (!isVisible()) return;
    const retryDelay = Math.min(30000, 1200 * (2 ** Math.min(5, Math.max(0, reconnectFailureCount - 1))));
    reconnectTimer = setTimeout(connect, retryDelay);
  }

  function handleError(event, context) {
    onTransportError(event);
    context.socket.close();
  }

  function send(payload) {
    return transport.send(payload);
  }

  function isOpen() {
    return transport.socket?.readyState === WebSocket.OPEN;
  }

  function markHealthy() {
    reconnectFailureCount = 0;
    heartbeat.markHealthy();
    onHealthy();
  }

  function reconnect() {
    clearTimeout(reconnectTimer);
    heartbeat.clear();
    transport.invalidate();
    connect();
  }

  function syncAfterForeground() {
    if (!isVisible()) return;
    const now = Date.now();
    if (now - lastForegroundSyncAt < foregroundDebounceMs) return;
    lastForegroundSyncAt = now;
    clearTimeout(reconnectTimer);
    if (isOpen()) heartbeat.probe();
    else reconnect();
  }

  function networkRestored() {
    if (!isVisible()) return;
    if (isOpen()) heartbeat.probe();
    else reconnect();
  }

  function invalidate() {
    clearTimeout(reconnectTimer);
    heartbeat.clear();
    transport.invalidate();
  }

  function isAuthFailure(event) {
    return AUTH_CLOSE_CODES.has(Number(event.code)) || /auth|token|口令|unauthor/i.test(String(event.reason || ""));
  }

  return {
    connect,
    reconnect,
    syncAfterForeground,
    networkRestored,
    invalidate,
    send,
    isOpen,
    markHealthy,
    get generation() { return transport.generation; }
  };
}
