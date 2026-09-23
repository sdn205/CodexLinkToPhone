import { createPhoneHeartbeat } from "./phone-heartbeat.js";
import { createPhoneSocket } from "./phone-socket.js";

const AUTH_CLOSE_CODES = new Set([1008, 4001, 4003, 4401, 4403]);

export function createPhoneConnection({
  getUrl,
  isVisible,
  getStateRevision,
  getVisibilitySeq,
  requestFullState,
  onConnecting,
  onOpen,
  onMessage,
  onClose,
  onAuthFailure,
  onRepeatedFailure,
  onHealthy,
  onProtocolError,
  onTransportError,
  connectTimeoutMs = 8000,
  initialStateTimeoutMs = 12000,
  foregroundDebounceMs = 2000
}) {
  let reconnectTimer = null;
  let initialStateTimer = null;
  let reconnectFailureCount = 0;
  let lastStateResponseAt = 0;
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
    requestFullState,
    reconnect,
    getVisibilitySeq,
    getStateRevision,
    getLastStateResponseAt: () => lastStateResponseAt
  });

  function connect() {
    clearTimeout(reconnectTimer);
    clearTimeout(initialStateTimer);
    heartbeat.clear();
    onConnecting();
    transport.connect();
  }

  function handleOpen(context) {
    lastStateResponseAt = Date.now();
    heartbeat.schedule();
    onOpen(context);
    const openedAtRevision = getStateRevision();
    initialStateTimer = setTimeout(() => {
      if (transport.isCurrent(context.socket, context.generation) && getStateRevision() === openedAtRevision) reconnect();
    }, initialStateTimeoutMs);
  }

  function handleRawMessage(event, context) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      onProtocolError(error);
      requestFullState();
      return;
    }
    onMessage(payload, context);
  }

  function handleClose(event, context) {
    clearTimeout(initialStateTimer);
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
    lastStateResponseAt = Date.now();
    reconnectFailureCount = 0;
    clearTimeout(initialStateTimer);
    heartbeat.markHealthy();
    onHealthy();
  }

  function reconnect() {
    clearTimeout(reconnectTimer);
    clearTimeout(initialStateTimer);
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
    clearTimeout(initialStateTimer);
    if (isOpen()) requestFullState();
    else reconnect();
  }

  function networkRestored() {
    if (!isVisible()) return;
    if (isOpen()) requestFullState();
    else reconnect();
  }

  function invalidate() {
    clearTimeout(reconnectTimer);
    clearTimeout(initialStateTimer);
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
