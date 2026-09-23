import { createSubmissionState } from "../state/submission-state.js";

export function createSubmissionController({
  timeoutMs,
  send,
  persistSubmission,
  deletePersistedSubmission,
  captureSubmission,
  getCurrentThreadId,
  getThreadRevision,
  getMessages,
  belongsToCurrentThread,
  validateRetry,
  publicErrorMessage,
  onStart,
  onRetryStart,
  onRecoverable,
  onActivate,
  onDefiniteFailure,
  onAccepted,
  onThreadBound,
  dismissNotice
}) {
  const state = createSubmissionState();
  let confirmationTimer = null;
  let activatedNoticeKey = "";

  function begin(payload, threadId, textSnapshotOverride = null, imageSnapshotOverride = null) {
    if (state.recoverable) dismissNotice(state.recoverable.payload.requestId);
    const submission = captureSubmission(payload, threadId, textSnapshotOverride, imageSnapshotOverride);
    state.start(submission);
    activatedNoticeKey = "";
    onStart(submission);
    if (!send(payload)) {
      markRecoverable("消息尚未发出，请检查连接", submission);
      return submission;
    }
    void persistSubmission(submission);
    armConfirmationTimeout(submission);
    return submission;
  }

  function handleResult(payload) {
    const requestId = String(payload.requestId || "");
    const submission = state.find(requestId);
    if (!submission) return false;
    clearTimeout(confirmationTimer);
    const responseThreadId = String(payload.threadId || "");
    if (!submission.threadId && responseThreadId) bindThread(submission, responseThreadId);

    if (!payload.ok) {
      if (payload.retryable === false) {
        state.settle(requestId);
        activatedNoticeKey = "";
        void deletePersistedSubmission(requestId);
        onDefiniteFailure(submission, payload);
      } else {
        state.recover(submission);
        activatedNoticeKey = "";
        onRecoverable(submission, publicErrorMessage(payload, "消息发送失败"));
      }
      return true;
    }

    state.settle(requestId);
    activatedNoticeKey = "";
    void deletePersistedSubmission(requestId);
    dismissNotice(requestId);
    onAccepted(submission, payload);
    return true;
  }

  function markRecoverable(message, submission = state.pending) {
    if (!submission || !state.recover(submission)) return false;
    clearTimeout(confirmationTimer);
    activatedNoticeKey = "";
    onRecoverable(submission, message);
    return true;
  }

  function activateForCurrentThread() {
    const submission = state.recoverable;
    if (!submission || !belongsToCurrentThread(submission)) return false;
    onActivate(submission);
    const noticeKey = `${submission.payload.requestId}:${submission.threadId || "new"}`;
    if (activatedNoticeKey === noticeKey) return true;
    activatedNoticeKey = noticeKey;
    onRecoverable(submission, "上次发送结果未知，请确认会话后手动重试");
    return true;
  }

  function retry(submission = state.recoverable) {
    if (!submission || state.recoverable !== submission) return false;
    const validationMessage = validateRetry(submission);
    if (validationMessage) {
      onRecoverable(submission, validationMessage, { warning: true, restore: false });
      return false;
    }
    state.start(submission);
    activatedNoticeKey = "";
    dismissNotice(submission.payload.requestId);
    submission.payload.threadRevision = getThreadRevision();
    onRetryStart(submission);
    if (!send(submission.payload)) {
      markRecoverable("重试失败，草稿仍保留", submission);
      return false;
    }
    armConfirmationTimeout(submission);
    return true;
  }

  function bindPendingThread(threadId) {
    const submission = state.pending;
    if (!submission || submission.threadId || !threadId) return false;
    bindThread(submission, threadId);
    return true;
  }

  function bindThread(submission, threadId) {
    submission.threadId = threadId;
    void persistSubmission(submission);
    onThreadBound(submission, threadId);
  }

  function restorePersisted(submission) {
    if (!submission || state.pending) return false;
    if (!state.recover(submission)) return false;
    activatedNoticeKey = "";
    activateForCurrentThread();
    return true;
  }

  function settleFromAuthoritativeState() {
    const confirmation = state.confirmation(getMessages(), getCurrentThreadId());
    if (confirmation?.uncertain && state.pending) {
      markRecoverable("发送未被确认，草稿已恢复", state.pending);
      return true;
    }
    if (confirmation?.ok) return handleResult(confirmation);
    return false;
  }

  function armConfirmationTimeout(submission) {
    clearTimeout(confirmationTimer);
    confirmationTimer = setTimeout(() => {
      if (state.pending === submission) markRecoverable("发送确认超时，草稿仍保留", submission);
    }, timeoutMs);
  }

  function queryResultPayload() {
    const submission = state.pending || state.recoverable;
    return submission ? { type: "message:send:result:query", requestId: submission.payload.requestId } : null;
  }

  return {
    begin,
    handleResult,
    markRecoverable,
    activateForCurrentThread,
    retry,
    bindPendingThread,
    restorePersisted,
    settleFromAuthoritativeState,
    queryResultPayload,
    get pending() { return state.pending; },
    get recoverable() { return state.recoverable; },
    get current() { return state.current; }
  };
}
