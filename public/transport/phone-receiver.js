// Large logical messages share the same ordered stream as small messages.
// Acknowledgements bound the sender's lead; partial data never reaches the UI.
export function createPhoneReceiver({ send, receive }) {
  const transfers = new Map();
  function reset() { transfers.clear(); }
  function accept(message) {
    if (message.type === "transport:pong") return;
    if (message.type === "transport:cancel") {
      transfers.delete(message.id);
      return;
    }
    if (message.type !== "transport:chunk") { receive(message); return; }
    const { id, offset, total, data } = message;
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(total)
        || offset < 0 || total <= 0 || typeof data !== "string" || !data.length || offset + data.length > total) {
      throw new Error("Invalid transfer frame");
    }
    let current = transfers.get(id);
    if (!current) {
      if (offset !== 0) throw new Error("Missing transfer start");
      current = { id, total, offset: 0, parts: [] };
      transfers.set(id, current);
    }
    if (current.id !== id || current.total !== total || current.offset !== offset) throw new Error("Transfer order mismatch");
    current.parts.push(data);
    current.offset += data.length;
    if (current.offset === total) {
      const payload = JSON.parse(current.parts.join(""));
      transfers.delete(id);
      receive(payload);
    }
    send({ type: "transport:ack", id, offset: offset + data.length });
  }
  return { accept, reset };
}
