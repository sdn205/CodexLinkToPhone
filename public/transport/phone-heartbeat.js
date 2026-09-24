// Transport liveness is independent of snapshot size, revision and rendering.
export function createPhoneHeartbeat({ isVisible, getSocket, send, reconnect,
  getVisibilitySeq, intervalMs = 30000, responseTimeoutMs = 12000 }) {
  let heartbeatTimer = null;
  let responseTimer = null;
  let nonce = 0;
  function schedule() {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(probe, intervalMs);
  }
  function probe() {
    clearTimeout(heartbeatTimer);
    clearTimeout(responseTimer);
    if (!isVisible() || !getSocket()) { schedule(); return; }
    send({ type: "phone:foreground", seq: getVisibilitySeq() });
    if (!send({ type: "transport:ping", nonce: ++nonce })) { reconnect(); return; }
    responseTimer = setTimeout(() => { if (isVisible()) reconnect(); else schedule(); }, responseTimeoutMs);
  }
  function markHealthy() {
    clearTimeout(responseTimer);
    schedule();
  }
  function clear() {
    clearTimeout(heartbeatTimer);
    clearTimeout(responseTimer);
    heartbeatTimer = responseTimer = null;
  }
  return { schedule, probe, markHealthy, clear };
}
