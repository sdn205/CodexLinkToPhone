export function createPhoneHeartbeat({
  isVisible,
  getSocket,
  send,
  requestFullState,
  reconnect,
  getVisibilitySeq,
  getStateRevision,
  getLastStateResponseAt,
  intervalMs = 30000,
  responseTimeoutMs = 12000
}) {
  let heartbeatTimer = null;
  let responseTimer = null;

  function schedule() {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      if (!isVisible() || !getSocket()) {
        schedule();
        return;
      }
      send({ type: "phone:foreground", seq: getVisibilitySeq() });
      if (Date.now() - getLastStateResponseAt() < 45000) {
        schedule();
        return;
      }
      const revision = getStateRevision();
      if (!requestFullState()) {
        reconnect();
        return;
      }
      responseTimer = setTimeout(() => {
        if (getStateRevision() === revision && isVisible()) reconnect();
      }, responseTimeoutMs);
    }, intervalMs);
  }

  function markHealthy() {
    clearTimeout(responseTimer);
    schedule();
  }

  function clear() {
    clearTimeout(heartbeatTimer);
    clearTimeout(responseTimer);
    heartbeatTimer = null;
    responseTimer = null;
  }

  return { schedule, markHealthy, clear };
}
