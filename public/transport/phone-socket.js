export function createPhoneSocket({
  getUrl,
  onSocketChange = () => {},
  onBeforeConnect = null,
  onOpen = null,
  onMessage = null,
  onClose = null,
  onError = null,
  connectTimeoutMs = 8000
}) {
  let socket = null;
  let generation = 0;
  let connectTimer = null;

  function isCurrent(candidate, expectedGeneration) {
    return generation === expectedGeneration && socket === candidate;
  }

  function connect() {
    clearTimeout(connectTimer);
    const currentGeneration = ++generation;
    onBeforeConnect?.({ generation: currentGeneration });
    const nextSocket = new WebSocket(getUrl());
    socket = nextSocket;
    onSocketChange(nextSocket);
    connectTimer = setTimeout(() => {
      if (!isCurrent(nextSocket, currentGeneration) || nextSocket.readyState !== WebSocket.CONNECTING) return;
      try { nextSocket.close(); } catch {}
    }, connectTimeoutMs);

    if (onOpen) nextSocket.addEventListener("open", () => {
      if (!isCurrent(nextSocket, currentGeneration)) return;
      clearTimeout(connectTimer);
      onOpen({ socket: nextSocket, generation: currentGeneration });
    });
    if (onMessage) nextSocket.addEventListener("message", (event) => {
      if (isCurrent(nextSocket, currentGeneration)) onMessage(event, { socket: nextSocket, generation: currentGeneration });
    });
    if (onClose) nextSocket.addEventListener("close", (event) => {
      if (!isCurrent(nextSocket, currentGeneration)) return;
      onClose(event, { socket: nextSocket, generation: currentGeneration });
    });
    if (onError) nextSocket.addEventListener("error", (event) => {
      if (isCurrent(nextSocket, currentGeneration)) onError(event, { socket: nextSocket, generation: currentGeneration });
    });
    return nextSocket;
  }

  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function invalidate() {
    generation += 1;
    clearTimeout(connectTimer);
    connectTimer = null;
    const stale = socket;
    socket = null;
    onSocketChange(null);
    try { stale?.close(); } catch {}
  }

  function close() {
    invalidate();
  }

  return {
    connect,
    send,
    invalidate,
    close,
    isCurrent,
    get socket() { return socket; },
    get generation() { return generation; }
  };
}
