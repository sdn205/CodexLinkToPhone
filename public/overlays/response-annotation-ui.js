import { renderMarkdown } from "../shared/markdown.js";
import { annotationIcon as icon } from "./response-annotation-icons.js";

function button(label, name, text = "") {
  const node = document.createElement("button");
  node.type = "button";
  node.title = label;
  node.setAttribute("aria-label", label);
  if (name) node.innerHTML = icon(name);
  if (text) node.append(document.createTextNode(text));
  return node;
}

export function createResponseAnnotationUI(options) {
  const { messages, composer, getDraft, getThreadId, getMessages, setDraft } = options;
  const HISTORY_KEY = "__codexPhoneAnnotationEditor";
  let selected = null;
  let editing = null;
  let protectedId = "";
  let historyBackPending = false;
  let renderKey = "";
  let repositionFrame = null;
  let highlightRange = null;
  let popover = null;
  let popoverCloseTimer = null;
  let directMode = false;
  const toolbar = document.createElement("div");
  toolbar.id = "responseSelectionToolbar";
  toolbar.className = "responseSelectionToolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "所选文本");
  toolbar.hidden = true;
  const copy = button("复制", "copy", "复制");
  const annotate = button("注释", "quote", "注释");
  toolbar.append(copy, annotate);
  const editorLayer = document.createElement("div");
  editorLayer.className = "responseAnnotationLayer";
  editorLayer.hidden = true;
  const editor = document.createElement("form");
  editor.id = "responseAnnotationEditor";
  editor.className = "responseAnnotationEditor";
  editor.setAttribute("role", "dialog");
  editor.setAttribute("aria-label", "回复注释");
  editor.hidden = true;
  const input = document.createElement("textarea");
  input.id = "responseAnnotationInput";
  input.rows = 1;
  input.placeholder = "添加可选评论…";
  input.setAttribute("aria-label", "备注");
  const actions = document.createElement("div");
  actions.className = "annotationEditorActions";
  const discard = button("删除", "trash");
  discard.className = "annotationDelete";
  const cancel = button("取消", null, "取消");
  cancel.className = "annotationCancel";
  const save = button("评论", "check");
  save.className = "annotationSubmit";
  save.id = "saveResponseAnnotation";
  actions.append(discard, cancel, save);
  const sizingText = document.createElement("span");
  sizingText.className = "annotationSizingText";
  sizingText.setAttribute("aria-hidden", "true");
  editor.append(input, actions, sizingText);
  const popup = document.createElement("div");
  popup.id = "responseAnnotationPopover";
  popup.className = "responseAnnotationPopover";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "注释");
  popup.hidden = true;
  const tray = document.createElement("div");
  tray.id = "responseAnnotationTray";
  tray.className = "responseAnnotationTray";
  tray.setAttribute("aria-label", "待发送注释");
  tray.hidden = true;
  composer.querySelector(".composerText").prepend(tray);
  editorLayer.append(editor);
  document.body.append(toolbar, editorLayer, popup);

  function changed(values) {
    setDraft(values);
    renderDraft();
  }
  function releaseSelection() {
    selected = null;
    toolbar.hidden = true;
    protectedId = "";
    if (!editing) setHighlight(null);
    queueMicrotask(options.onSelectionEnd);
  }
  function cancelPopoverClose() {
    clearTimeout(popoverCloseTimer);
    popoverCloseTimer = null;
  }
  function schedulePopoverClose() {
    cancelPopoverClose();
    if (popover && !popover.tracked) popoverCloseTimer = setTimeout(() => closePopover(), 100);
  }
  function bindPopoverPreview(anchor, values, draft, reference = false) {
    anchor.addEventListener("pointerenter", event => {
      cancelPopoverClose();
      if (event.pointerType === "mouse" && !selected && !editing && !popover?.tracked) openPopover(values, anchor, draft, reference, false);
    });
    anchor.addEventListener("pointerleave", schedulePopoverClose);
  }
  popup.addEventListener("pointerenter", cancelPopoverClose);
  popup.addEventListener("pointerleave", schedulePopoverClose);
  function captureSelection() {
    if (editing || popover || historyBackPending) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) {
      if (selected) releaseSelection();
      return;
    }
    const range = selection.getRangeAt(0);
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const root = start?.closest(".message.assistant[data-kind='text'] .bubble");
    if (!root || !messages.contains(root) || !root.contains(range.endContainer) || !range.toString().trim()) {
      if (selected) releaseSelection();
      return;
    }
    const messageId = root.closest("[data-message-id]").dataset.messageId;
    const prefix = document.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(range.startContainer, range.startOffset);
    const startOffset = prefix.toString().length;
    prefix.setEnd(range.endContainer, range.endOffset);
    const endOffset = prefix.toString().length;
    selected = {
      threadId: getThreadId(),
      text: range.toString(),
      source: { messageId, startOffset, endOffset },
      range: range.cloneRange(),
      rect: range.getBoundingClientRect()
    };
    protectedId = messageId;
    annotate.disabled = !options.canEdit();
    toolbar.hidden = false;
    position(toolbar, selected.rect);
  }
  function position(node, rect) {
    const viewport = window.visualViewport;
    const pane = messages.getBoundingClientRect();
    const left = Math.max(viewport?.offsetLeft || 0, pane.left);
    const top = viewport?.offsetTop || 0;
    const right = Math.min((viewport?.offsetLeft || 0) + (viewport?.width || window.innerWidth), pane.right);
    const width = right - left;
    const height = viewport?.height || window.innerHeight;
    node.style.maxWidth = `${Math.max(180, width - 24)}px`;
    if (node === editor || node === popup) node.style.maxHeight = `${Math.min(node === popup ? 320 : 120, Math.max(100, height - 24))}px`;
    if (node === editor) {
      Object.assign(editorLayer.style, { left: `${left}px`, width: `${width}px` });
      const box = editor.getBoundingClientRect();
      const y = top + height - 12 - box.height;
      Object.assign(editorLayer.style, {
        top: `${y}px`,
        height: `${box.height}px`
      });
      document.documentElement.style.setProperty("--annotation-dock-height", `${box.height + 12}px`);
      const layoutKey = `${left}:${width}:${top}:${height}:${box.height}:${messages.clientHeight}`;
      // Position the selection once per layout change; manual scrolling stays free.
      if (editing?.range && editing.layoutKey !== layoutKey) {
        editing.layoutKey = layoutKey;
        const passage = editing.range.getBoundingClientRect();
        messages.scrollTop += passage.bottom - (y - 16);
      }
      return;
    }
    const box = node.getBoundingClientRect();
    const above = rect.top - box.height - 10;
    const below = rect.bottom + 10;
    const y = above >= top + 12 ? above : below;
    node.style.left = `${Math.max(left + 12, Math.min(rect.right - box.width, left + width - box.width - 12))}px`;
    node.style.top = `${Math.max(top + 12, Math.min(y, top + height - box.height - 12))}px`;
  }
  function reposition() {
    if (!editing && !selected && !popover) return;
    if (repositionFrame !== null) return;
    repositionFrame = requestAnimationFrame(() => {
      repositionFrame = null;
      if (popover) {
        if (!popover.anchor.isConnected) closePopover();
        else position(popup, popover.anchor.getBoundingClientRect());
      }
      if (editing) {
        sizeEditor();
        const annotation = getDraft().find(value => value.id === editing.id);
        const range = boundRange(annotation);
        if (range) { editing.range = range; setHighlight(range); }
        position(editor, range?.getBoundingClientRect() || editing.rect);
      }
      else if (selected) position(toolbar, selected.range.getBoundingClientRect());
    });
  }
  function boundRange(annotation) {
    const source = annotation?.source;
    if (!source) return null;
    const root = messages.querySelector(`[data-message-id="${CSS.escape(source.messageId)}"] .bubble`);
    const range = root && rangeAtOffsets(root, source.startOffset, source.endOffset);
    return range?.toString() === annotation.text ? range : null;
  }
  function restoreAnchor() {
    if (selected && selected.threadId === getThreadId()) {
      const range = boundRange(selected);
      if (range) {
        selected.range = range;
        const selection = window.getSelection();
        if (selection?.toString() !== selected.text) { selection.removeAllRanges(); selection.addRange(range); }
      }
    }
    reposition();
  }
  function setHighlight(range) {
    highlightRange = range;
    if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
    if (range) CSS.highlights.set("codex-response-annotation", new Highlight(range));
    else CSS.highlights.delete("codex-response-annotation");
  }
  function openEditor(annotation, anchor) {
    if (!options.canEdit() || historyBackPending) return;
    closePopover({ preserveHistory: true });
    const rect = anchor?.rect || tray.getBoundingClientRect();
    const sourceRoot = annotation.source && messages.querySelector(`[data-message-id="${CSS.escape(annotation.source.messageId)}"] .bubble`);
    const sourceRange = sourceRoot && rangeAtOffsets(sourceRoot, annotation.source.startOffset, annotation.source.endOffset);
    const range = anchor?.range || (sourceRange?.toString() === annotation.text ? sourceRange : null);
    editing = { id: annotation.id, threadId: getThreadId(), rect, range, mode: anchor?.create ? "create" : "edit", original: annotation };
    protectedId = annotation.source?.messageId || "";
    options.onEditorChange(true);
    selected = null;
    toolbar.hidden = true;
    input.value = annotation.annotation || "";
    setHighlight(range);
    editorLayer.hidden = false;
    editor.hidden = false;
    directMode = false;
    sizeEditor();
    updateControls();
    position(editor, range?.getBoundingClientRect() || rect);
    if (!history.state?.[HISTORY_KEY]) history.pushState({ ...history.state, [HISTORY_KEY]: true }, "", location.href);
    window.getSelection()?.removeAllRanges();
    input.focus({ preventScroll: true });
  }
  function sizeEditor() {
    if (!editing) return;
    sizingText.textContent = input.value + "\u200b";
    // Compare layout pixels; viewport measurements include display scaling.
    const lineHeight = Number.parseFloat(getComputedStyle(sizingText).lineHeight);
    const expanded = editing.mode === "edit" || input.value.includes("\n") || sizingText.scrollHeight > Math.ceil(lineHeight);
    editor.classList.toggle("isExpanded", expanded);
    editor.classList.toggle("isEditing", editing.mode === "edit");
  }
  function closeHistory() {
    if (history.state?.[HISTORY_KEY] && !historyBackPending) {
      historyBackPending = true;
      history.back();
    }
  }
  function closeEditor({ fromHistory = false } = {}) {
    editing = null;
    editor.hidden = true;
    editorLayer.hidden = true;
    document.documentElement.style.removeProperty("--annotation-dock-height");
    if (editor.contains(document.activeElement)) document.activeElement.blur();
    options.onEditorChange(false);
    setHighlight(null);
    releaseSelection();
    if (!fromHistory) closeHistory();
  }
  function updateNote() {
    if (!editing || editing.threadId !== getThreadId()) return;
    changed(getDraft().map(item => item.id === editing.id ? { ...item, annotation: input.value } : item));
  }
  function remove(id) {
    if (!options.canEdit()) return;
    changed(getDraft().filter(item => item.id !== id));
    if (editing?.id === id) closeEditor();
  }
  annotate.addEventListener("click", () => {
    if (!selected || !options.canEdit() || selected.threadId !== getThreadId()) return;
    const { range, rect, threadId, ...value } = selected;
    const annotation = { ...value, id: options.createId(), annotation: "" };
    changed([...getDraft(), annotation]);
    openEditor(annotation, { range, rect, create: true });
  });
  copy.addEventListener("click", async () => {
    if (!selected) return;
    try {
      await options.onCopy(selected.text);
      copy.innerHTML = `${icon("check")}已复制`;
      setTimeout(() => { copy.innerHTML = `${icon("copy")}复制`; }, 1200);
    } catch { options.onError("复制失败，浏览器没有授权剪贴板"); }
  });
  toolbar.addEventListener("pointerdown", event => event.preventDefault());
  function commitNote(direct = false) {
    if (!editing || !options.canEdit() || (direct && (!options.canSend() || !input.value.trim()))) return;
    if (editing.mode === "edit" && !input.value.trim()) return;
    updateNote();
    closeEditor();
    if (direct) options.onSend();
  }
  input.addEventListener("input", () => { updateNote(); sizeEditor(); reposition(); });
  input.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing || event.shiftKey || event.altKey) return;
    event.preventDefault();
    commitNote(editing?.mode === "create" && (event.ctrlKey || event.metaKey));
  });
  editor.addEventListener("submit", event => { event.preventDefault(); commitNote(); });
  save.addEventListener("pointerdown", event => event.preventDefault());
  save.addEventListener("click", event => commitNote(editing?.mode === "create" && (event.ctrlKey || event.metaKey)));
  discard.addEventListener("click", () => { if (editing) remove(editing.id); });
  cancel.addEventListener("click", () => {
    if (!editing || !options.canEdit()) return;
    changed(getDraft().map(item => item.id === editing.id ? editing.original : item));
    closeEditor();
  });
  function updateModifier(event) {
    const next = Boolean(event.ctrlKey || event.metaKey);
    if (next === directMode) return;
    directMode = next;
    updateControls();
  }
  document.addEventListener("keydown", updateModifier);
  document.addEventListener("keyup", updateModifier);
  window.addEventListener("blur", () => { directMode = false; updateControls(); });
  document.addEventListener("selectionchange", captureSelection);
  messages.addEventListener("contextmenu", event => {
    captureSelection();
    if (selected) event.preventDefault();
  });
  document.addEventListener("pointerdown", event => {
    if (editing && !editor.contains(event.target) && !tray.contains(event.target)) {
      updateNote();
      closeEditor();
    }
    if (popover && !popup.contains(event.target) && !popover.anchor.contains(event.target)) closePopover();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && (editing || selected || popover)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (editing) closeEditor();
      else if (popover) closePopover();
      else { window.getSelection()?.removeAllRanges(); releaseSelection(); }
    }
  }, true);
  window.addEventListener("popstate", event => {
    historyBackPending = false;
    if (editing && !event.state?.[HISTORY_KEY]) { updateNote(); closeEditor({ fromHistory: true }); }
    if (popover && !event.state?.[HISTORY_KEY]) closePopover({ preserveHistory: true });
    // Forward navigation must not resurrect an editor without a bound draft.
    if (!editing && !popover && event.state?.[HISTORY_KEY]) {
      const next = { ...event.state };
      delete next[HISTORY_KEY];
      history.replaceState(next, "", location.href);
    }
  });
  if (history.state?.[HISTORY_KEY]) {
    const next = { ...history.state };
    delete next[HISTORY_KEY];
    history.replaceState(next, "", location.href);
  }
  messages.addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("resize", reposition);
  window.visualViewport?.addEventListener("resize", reposition);
  window.visualViewport?.addEventListener("scroll", reposition);
  new ResizeObserver(reposition).observe(messages);

  function renderDraft() {
    const values = getDraft();
    const key = JSON.stringify(values);
    if (key === renderKey) return;
    renderKey = key;
    if (popover?.draft) closePopover();
    tray.replaceChildren();
    tray.hidden = values.length === 0;
    if (values.length) tray.append(attachmentPill(values, true));
    updateControls();
  }
  function updateControls() {
    annotate.disabled = !options.canEdit();
    for (const control of tray.querySelectorAll("button")) control.disabled = !options.canEdit();
    if (popover?.draft) for (const control of popup.querySelectorAll(".annotationRowActions button")) control.disabled = !options.canEdit();
    input.readOnly = !options.canEdit();
    const isEdit = editing?.mode === "edit";
    discard.hidden = cancel.hidden = !isEdit;
    save.innerHTML = isEdit ? "保存" : icon(directMode ? "send" : "check");
    save.setAttribute("aria-label", isEdit ? "保存" : directMode ? "发送" : "评论");
    save.title = isEdit ? "保存" : directMode ? "发送" : "添加";
    cancel.disabled = discard.disabled = !options.canEdit();
    save.disabled = !options.canEdit() || (isEdit && !input.value.trim()) || (!isEdit && directMode && (!options.canSend() || !input.value.trim()));
  }
  function attachmentPill(values, draft) {
    const pill = document.createElement("div");
    pill.className = "responseAnnotationChip";
    const label = `${values.length} 条注释`;
    const trigger = button(label, "quote", label);
    trigger.className = "annotationAttachmentTrigger";
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    trigger.addEventListener("click", () => {
      if (popover?.anchor === trigger && popover.tracked) closePopover();
      else openPopover(values, trigger, draft);
    });
    bindPopoverPreview(trigger, values, draft);
    pill.append(trigger);
    if (draft) {
      const clear = button("移除注释附件", "remove");
      clear.className = "annotationClear";
      clear.addEventListener("click", () => {
        if (!options.canEdit()) return;
        if (editing) closeEditor();
        closePopover();
        changed([]);
      });
      pill.append(clear);
    }
    return pill;
  }
  function annotationField(label, value, multiline = false) {
    const field = document.createElement("span");
    field.className = "annotationField";
    const caption = document.createElement("span");
    caption.className = "annotationFieldLabel";
    caption.textContent = label;
    const text = document.createElement(multiline ? "pre" : "span");
    text.className = "annotationFieldValue";
    text.textContent = value;
    field.append(caption, text);
    return field;
  }
  function openPopover(values, anchor, draft = false, reference = false, tracked = true) {
    if (editing || historyBackPending) return;
    closePopover({ preserveHistory: true });
    releaseSelection();
    popover = { anchor, threadId: getThreadId(), draft, tracked };
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", popup.id);
    popup.replaceChildren();
    popup.classList.toggle("isReference", reference);
    const content = document.createElement("ol");
    values.forEach((annotation, index) => {
      const row = document.createElement("li");
      const link = document.createElement(annotation.source ? "button" : "div");
      link.className = "annotationQuoteLink";
      if (annotation.source) {
        link.type = "button";
        link.title = "查看原文";
        link.addEventListener("click", () => { closePopover(); void navigate(annotation); });
      }
      if (!reference) {
        const ordinal = document.createElement("span");
        ordinal.className = "annotationOrdinal";
        ordinal.textContent = `${index + 1}.`;
        link.append(ordinal);
      }
      const fields = document.createElement("span");
      fields.className = "annotationFields";
      fields.append(annotationField("所选文本：", annotation.text, reference && annotation.text.includes("\n")));
      if (annotation.annotation?.trim()) fields.append(annotationField("用户评论：", annotation.annotation));
      link.append(fields);
      row.append(link);
      if (draft) {
        const controls = document.createElement("div");
        controls.className = "annotationRowActions";
        const edit = button(`编辑注释 ${index + 1}`, "edit");
        edit.addEventListener("click", () => openEditor(annotation, { rect: popup.getBoundingClientRect() }));
        const discard = button(`移除注释 ${index + 1}`, "remove");
        discard.addEventListener("click", () => remove(annotation.id));
        controls.append(edit, discard);
        row.append(controls);
      }
      content.append(row);
    });
    popup.append(content);
    popup.hidden = false;
    position(popup, anchor.getBoundingClientRect());
    if (tracked && !history.state?.[HISTORY_KEY]) history.pushState({ ...history.state, [HISTORY_KEY]: true }, "", location.href);
    updateControls();
  }
  function closePopover({ preserveHistory = false } = {}) {
    cancelPopoverClose();
    if (!popover) return;
    const tracked = popover.tracked;
    popover.anchor.setAttribute("aria-expanded", "false");
    popover = null;
    popup.hidden = true;
    if (!preserveHistory && tracked) closeHistory();
  }
  function renderAttachments(values) {
    const list = document.createElement("div");
    list.className = "responseAnnotationAttachments";
    list.append(attachmentPill(values, false));
    return list;
  }
  function responseContext(message) {
    if (message.meta?.responseAnnotations) return message.meta.responseAnnotations;
    let context = [];
    for (const item of getMessages()) {
      if (item.role === "user") context = item.meta?.responseAnnotations || [];
      if (item.id === message.id) return context;
    }
    return [];
  }
  function decorateResponse(root, message) {
    const values = responseContext(message);
    if (!values.length) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (!walker.currentNode.parentElement.closest("pre, code")) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const matches = [...node.textContent.matchAll(/:codex-annotation\{index="([1-9]\d*)"\}/g)];
      if (!matches.length) continue;
      const fragment = document.createDocumentFragment();
      let end = 0;
      for (const match of matches) {
        const annotation = values[Number(match[1]) - 1];
        if (!annotation) continue;
        fragment.append(document.createTextNode(node.textContent.slice(end, match.index)));
        const marker = button(`注释 ${match[1]}：${annotation.text}`, null, `注释 ${match[1]}`);
        marker.className = "responseAnnotationReference";
        bindPopoverPreview(marker, [annotation], false, true);
        marker.addEventListener("click", () => {
          if (annotation.source) { closePopover(); void navigate(annotation); }
          else openPopover([annotation], marker, false, true);
        });
        fragment.append(marker);
        end = match.index + match[0].length;
      }
      if (end) { fragment.append(document.createTextNode(node.textContent.slice(end))); node.replaceWith(fragment); }
    }
  }
  function renderStreaming(root, message) {
    if (protectedId === message.id || !responseContext(message).length || !message.text.includes(":codex")) return false;
    let text = message.text;
    const index = text.lastIndexOf(":codex");
    const tail = text.slice(index);
    if (index >= 0 && !tail.includes("}") &&
        (':codex-annotation{index="'.startsWith(tail) || /^:codex-annotation\{index="\d*"?$/.test(tail))) text = text.slice(0, index);
    root.innerHTML = renderMarkdown(text);
    decorateResponse(root, message);
    root.dataset.streamOffset = String(message.text.length);
    return true;
  }
  async function navigate(annotation) {
    const threadId = getThreadId();
    const messageId = annotation.source?.messageId;
    if (!messageId) return;
    let root = messages.querySelector(`[data-message-id="${CSS.escape(messageId)}"] .bubble`);
    while (!root && messages.querySelector("[data-load-earlier-messages]")) {
      const first = messages.querySelector("[data-message-id]")?.dataset.messageId;
      options.onLoadEarlier();
      const changed = await new Promise(resolve => {
        const observer = new MutationObserver(() => {
          if (threadId !== getThreadId() || messages.querySelector("[data-message-id]")?.dataset.messageId !== first) finish(true);
        });
        const timer = setTimeout(() => finish(false), 10000);
        function finish(result) { clearTimeout(timer); observer.disconnect(); resolve(result); }
        observer.observe(messages, { childList: true });
      });
      if (!changed || threadId !== getThreadId()) break;
      root = messages.querySelector(`[data-message-id="${CSS.escape(messageId)}"] .bubble`);
    }
    if (threadId !== getThreadId()) return;
    if (!root) { options.onError("原消息尚未加载"); return; }
    root.scrollIntoView({ block: "center", behavior: "instant" });
    const range = rangeAtOffsets(root, annotation.source.startOffset, annotation.source.endOffset);
    if (range?.toString() === annotation.text) {
      setHighlight(range);
      setTimeout(() => { if (highlightRange === range && !editing) setHighlight(null); }, 1800);
    }
    root.animate([{ backgroundColor: "#128dff33" }, { backgroundColor: "transparent" }], { duration: 1000 });
  }
  return {
    renderDraft, updateControls, renderAttachments, decorateResponse, renderStreaming, restoreAnchor,
    hasActiveSelection: () => Boolean(selected || editing || popover),
    protectsMessage: id => Boolean(protectedId && protectedId === id),
    closeForThreadChange: () => {
      if (editing && editing.threadId !== getThreadId()) closeEditor();
      if (selected && selected.threadId !== getThreadId()) releaseSelection();
      if (popover && popover.threadId !== getThreadId()) closePopover();
    }
  };
}

function rangeAtOffsets(root, start, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let foundStart = false;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const next = offset + node.textContent.length;
    if (!foundStart && start <= next) { range.setStart(node, start - offset); foundStart = true; }
    if (foundStart && end <= next) { range.setEnd(node, end - offset); return range; }
    offset = next;
  }
  return null;
}
