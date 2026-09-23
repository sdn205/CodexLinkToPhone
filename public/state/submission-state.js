export function createSubmissionState() {
  let entry = null;
  let status = "idle";

  return {
    get pending() { return status === "pending" ? entry : null; },
    get recoverable() { return status === "recoverable" ? entry : null; },
    get current() { return entry; },
    start(submission) {
      entry = submission;
      status = "pending";
    },
    recover(submission) {
      if (entry && entry.payload.requestId !== submission?.payload.requestId) return false;
      entry = submission;
      status = submission ? "recoverable" : "idle";
      return true;
    },
    find(requestId) {
      return entry?.payload.requestId === requestId ? entry : null;
    },
    confirmation(messages, threadId) {
      if (entry?.payload.type !== "message:send" || !entry.payload.clientUserMessageId) return null;
      const expectedThreadId = entry.threadId || threadId;
      const message = messages.find((message) => message.role === "user" &&
        message.meta?.threadId === expectedThreadId && message.meta?.clientUserMessageId === entry.payload.clientUserMessageId);
      if (!message) return null;
      if (message.meta.submissionState === "uncertain") return { uncertain: true };
      if (message.meta.submissionState && message.meta.submissionState !== "accepted") return null;
      if (!message.meta.turnId || String(message.meta.turnId).startsWith("pending-turn-")) return null;
      return { requestId: entry.payload.requestId, ok: true, threadId: message.meta.threadId, turnId: message.meta.turnId };
    },
    settle(requestId) {
      if (entry?.payload.requestId !== requestId) return null;
      const settled = entry;
      entry = null;
      status = "idle";
      return settled;
    }
  };
}
