export function createMessageEditor({
  messagesElement,
  getState,
  getMessages,
  isMobileView,
  isConnected,
  isThreadRunning,
  getPendingSubmission,
  getRecoverableSubmission,
  hasPendingImageReads,
  hasPendingSettings,
  messageThreadId,
  messageTurnId,
  displayTextForMessage,
  encodeResponseAnnotations,
  decodeResponseAnnotations,
  createClientId,
  submissionMatchesCurrentDraft,
  retrySubmission,
  beginSubmission,
  onRenderChange
}) {
  let current = null;

  function latestEditableMessage() {
    const messages = getMessages();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "user" || message?.kind !== "text") continue;
      if (!messageTurnId(message) || !displayTextForMessage(message).trim()) continue;
      return message;
    }
    return null;
  }

  function matches(message) {
    const state = getState();
    if (!current || !message || message.role !== "user") return false;
    const editingThreadId = String(current.threadId || state?.currentThreadId || "");
    const messageThread = String(messageThreadId(message) || state?.currentThreadId || "");
    return Boolean(current.turnId && editingThreadId === messageThread && String(messageTurnId(message) || "") === String(current.turnId));
  }

  function shouldReserveAction(message) {
    if (!isMobileView() || message?.role !== "user" || message?.kind !== "text") return false;
    const latest = latestEditableMessage();
    return Boolean(latest && messageTurnId(latest) === messageTurnId(message));
  }

  function canEdit(message) {
    return Boolean(
      shouldReserveAction(message) &&
      isConnected() &&
      !isThreadRunning() &&
      !message.streaming &&
      !getPendingSubmission() &&
      !getRecoverableSubmission() &&
      !hasPendingImageReads() &&
      !hasPendingSettings()
    );
  }

  function begin(message) {
    if (!canEdit(message)) return;
    const state = getState();
    current = {
      threadId: state?.currentThreadId || messageThreadId(message),
      turnId: messageTurnId(message),
      text: displayTextForMessage(message),
      annotations: message.meta?.responseAnnotations || []
    };
    onRenderChange();
    requestAnimationFrame(() => {
      const editor = messagesElement.querySelector(".inlineMessageEditor textarea");
      if (!editor) return;
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(editor.value.length, editor.value.length);
      autosize(editor);
    });
  }

  function renderAction(message) {
    const editable = canEdit(message);
    const active = matches(message);
    const actions = document.createElement("div");
    actions.className = "userMessageActions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `editMessageButton${editable ? "" : " isHidden"}${active ? " active" : ""}`;
    button.dataset.editMessage = message.id;
    button.disabled = !editable;
    button.tabIndex = editable ? 0 : -1;
    button.setAttribute("aria-label", "编辑消息");
    button.setAttribute("title", "编辑消息");
    button.setAttribute("aria-hidden", editable ? "false" : "true");
    button.dataset.editTurnId = messageTurnId(message);
    button.innerHTML = editIconSvg();
    button.addEventListener("click", () => begin(message));
    actions.append(button);
    return actions;
  }

  function renderInline(message) {
    const editor = document.createElement("form");
    editor.className = "inlineMessageEditor";
    editor.setAttribute("aria-label", "编辑消息");
    const textarea = document.createElement("textarea");
    textarea.className = "inlineMessageEditorInput";
    textarea.rows = 1;
    textarea.value = String(current?.text ?? displayTextForMessage(message));
    textarea.setAttribute("aria-label", "编辑消息");
    textarea.placeholder = "编辑消息";
    textarea.autocomplete = "off";
    textarea.spellcheck = false;
    textarea.addEventListener("input", () => {
      if (current) current.text = textarea.value;
      autosize(textarea);
    });
    const actions = document.createElement("div");
    actions.className = "inlineMessageEditorActions";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "inlineMessageEditorCancel";
    cancelButton.textContent = "取消";
    cancelButton.addEventListener("click", cancel);
    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.className = "inlineMessageEditorSubmit";
    submitButton.textContent = "发送";
    submitButton.disabled = Boolean(getPendingSubmission() || !textarea.value.trim());
    if (getPendingSubmission()?.payload?.type === "message:edit") {
      submitButton.textContent = "发送中";
      submitButton.disabled = true;
    }
    actions.append(cancelButton, submitButton);
    editor.append(textarea, actions);
    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      submit(textarea.value);
    });
    requestAnimationFrame(() => autosize(textarea));
    return editor;
  }

  function cancel() {
    if (!current || getPendingSubmission()?.payload?.type === "message:edit") return;
    current = null;
    onRenderChange();
  }

  function submit(text) {
    if (!current || getPendingSubmission()) return;
    const normalizedText = String(text || "").trim();
    if (!normalizedText) return;
    current.text = String(text || "");
    const recoverable = getRecoverableSubmission();
    if (recoverable?.payload?.type === "message:edit" && submissionMatchesCurrentDraft(recoverable)) {
      retrySubmission(recoverable);
      return;
    }
    const state = getState();
    const payload = {
      type: "message:edit",
      requestId: createClientId(),
      threadId: current.threadId || state?.currentThreadId || "",
      threadRevision: state?.threadRevision,
      text: encodeResponseAnnotations(String(text || ""), current.annotations || []),
      images: [],
      turnId: current.turnId
    };
    void beginSubmission(payload, payload.threadId, String(text || ""), []);
  }

  function autosize(textarea) {
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxHeight = Math.max(120, Math.round((window.visualViewport?.height || window.innerHeight || 640) * 0.42));
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 28), maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function restoreSubmission(submission) {
    if (current || submission?.payload?.type !== "message:edit") return;
    current = {
      threadId: submission.threadId,
      turnId: String(submission.payload.turnId || ""),
      text: String(submission.textSnapshot || ""),
      annotations: decodeResponseAnnotations(submission.payload.text)?.annotations || []
    };
  }

  function clear() {
    current = null;
  }

  return {
    begin,
    cancel,
    clear,
    restoreSubmission,
    matches,
    shouldReserveAction,
    canEdit,
    renderAction,
    renderInline,
    get current() { return current; },
    get active() { return Boolean(current); }
  };
}

function editIconSvg() {
  return `<svg width="20" height="21" viewBox="0 0 20 21" aria-hidden="true"><path d="M11.3312 4.20472C12.7488 2.92391 14.9377 2.96644 16.3039 4.33265L16.4318 4.46742C17.6713 5.8393 17.6713 7.93343 16.4318 9.30531L16.3039 9.44007L10.0119 15.7311C9.68839 16.0546 9.45384 16.2917 9.22185 16.4821L8.98748 16.6588C8.78233 16.799 8.56429 16.9196 8.33709 17.0192L8.10759 17.1119C7.92582 17.1785 7.73843 17.2266 7.52166 17.2711L6.75701 17.4069L4.36345 17.8053C4.22059 17.8291 4.06914 17.8552 3.9406 17.8649C3.84183 17.8723 3.70833 17.875 3.56267 17.8395L3.41423 17.7907C3.19121 17.695 3.00747 17.5271 2.89177 17.316L2.84588 17.2223C2.75958 17.0209 2.76174 16.8276 2.77166 16.6959C2.78136 16.5674 2.80742 16.4159 2.83123 16.2731L3.22966 13.8795L3.36443 13.1149C3.40899 12.898 3.45795 12.7108 3.52459 12.5289L3.61736 12.2985C3.71691 12.0715 3.83772 11.854 3.97771 11.6491L4.15349 11.4147C4.34392 11.1825 4.58171 10.9484 4.90545 10.6246L11.1965 4.33265L11.3312 4.20472ZM5.84588 11.5651C5.49671 11.9142 5.31258 12.0998 5.1867 12.2526L5.07537 12.3991C4.98194 12.5358 4.90157 12.6812 4.83513 12.8327L4.77361 12.9869C4.73328 13.0971 4.70248 13.2125 4.66814 13.3815L4.54119 14.0983L4.14275 16.4918L4.14177 16.4938H4.1447L6.53826 16.0944L7.25505 15.9684C7.42406 15.9341 7.53946 15.9033 7.64959 15.8629L7.80291 15.8014C7.95461 15.7349 8.09953 15.6538 8.2365 15.5602L8.38396 15.4498C8.53674 15.3239 8.72231 15.1398 9.07146 14.7907L14.0588 9.80238L10.8332 6.57679L5.84588 11.5651ZM15.3635 5.27308C14.5281 4.43776 13.2058 4.38573 12.3097 5.11683L12.1369 5.27308L11.7736 5.63636L15.0002 8.86195L15.3635 8.49964L15.5197 8.32581C16.2015 7.48961 16.2015 6.28311 15.5197 5.44691L15.3635 5.27308Z"/></svg>`;
}
