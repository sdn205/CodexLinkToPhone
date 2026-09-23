import { escapeAttribute, textHash } from "../shared/text-utils.js";
import { formatInlineMarkdown, renderMarkdown } from "../shared/markdown.js";

export function createMessageRenderer({
  getState,
  expandedMessages,
  aboveComposer,
  activityRenderer,
  commandGroups,
  diffRenderer,
  annotationUI,
  messagePhase,
  displayTextForMessage,
  isUnknownCurrentActivity,
  isTimelineRowsTurnDiff,
  isCompletedTurnDiffCard,
  roleLabel,
  isToolLike,
  imagesForMessage,
  imageSignature,
  unifiedDiffForMessage,
  planStepsForMessage,
  stringifyForDisplay,
  itemField,
  editingMessageMatches,
  renderInlineMessageEditor,
  shouldReserveMessageEditAction,
  renderMessageEditAction,
  canEditMessage,
  openImage,
  togglePlan
}) {
  const renderKeyCache = new WeakMap();

  function render(message) {
    const item = document.createElement("article");
    item.className = `message ${message.role}${message.streaming ? " streaming" : ""}`;
    item.dataset.kind = message.kind || "text";
    const phase = messagePhase(message);
    if (phase) item.dataset.phase = phase;
    if (phase === "commentary") item.classList.add("phaseCommentary");

    if (message.kind === "plan") {
      if (!aboveComposer.isPlanFixed(message)) item.classList.add("completedPlanMessage");
      item.append(renderPlan(message, displayTextForMessage(message)));
      return item;
    }
    const activityNode = activityRenderer.render(message, { unknown: isUnknownCurrentActivity(message) });
    if (activityNode) {
      item.append(activityNode);
      return item;
    }
    if (message.kind === "file") {
      item.append(diffRenderer.renderFileChangeMessage(message));
      return item;
    }
    if (message.kind === "turn_diff") {
      if (isTimelineRowsTurnDiff(message)) item.append(diffRenderer.renderInProgressTurnDiffMessage(message, { rows: true }));
      else if (isCompletedTurnDiffCard(message)) {
        item.classList.add("completedTurnDiffMessage");
        item.append(diffRenderer.renderFileChangeMessage(message, { completed: true }));
      } else {
        item.append(diffRenderer.renderInProgressTurnDiffMessage(message));
      }
      return item;
    }

    const meta = document.createElement("div");
    meta.className = "messageMeta";
    meta.innerHTML = `<span>${roleLabel(message)}${message.streaming ? " · 生成中" : ""}</span>`;
    item.append(meta);
    if (isToolLike(message)) {
      item.append(commandGroups.renderToolMessage(message));
      return item;
    }
    if (message.streaming && message.role === "assistant" && message.kind === "text") {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = String(message.text || "");
      bubble.dataset.streamOffset = String(message.text || "").length;
      annotationUI.renderStreaming(bubble, message);
      item.append(bubble);
      return item;
    }

    const originalText = String(message.text || "");
    const text = displayTextForMessage(message);
    const images = imagesForMessage(message, originalText);
    if (editingMessageMatches(message)) {
      item.classList.add("isEditingUserMessage");
      item.append(renderInlineMessageEditor(message));
      return item;
    }
    if (images.length) item.append(renderImageGrid(images));
    const annotations = message.role === "user" ? message.meta?.responseAnnotations : null;
    if (annotations?.length) item.append(annotationUI.renderAttachments(annotations));
    if (text || (!images.length && !annotations?.length)) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.innerHTML = renderMarkdown(String(text || ""));
      if (message.role === "assistant") annotationUI.decorateResponse(bubble, message);
      item.append(bubble);
    }
    if (shouldReserveMessageEditAction(message)) item.append(renderMessageEditAction(message));
    return item;
  }

  function renderPlan(message, text) {
    const actualSteps = planStepsForMessage(message, text);
    if (!actualSteps.length) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.innerHTML = renderMarkdown(String(text || ""));
      return bubble;
    }
    const completed = actualSteps.filter((step) => step.status === "completed").length;
    const total = actualSteps.length;
    const isFixed = aboveComposer.isPlanFixed(message);
    const isExpanded = isFixed ? !aboveComposer.isCollapsed(message.id) : expandedMessages.has(message.id);
    const block = document.createElement("div");
    block.className = `planBlock${isFixed ? "" : " completed"}`;
    block.innerHTML = `
      <button class="planHeader" type="button" data-toggle-plan="${escapeAttribute(message.id)}" aria-expanded="${String(isExpanded)}">
        <span class="planGlyph" aria-hidden="true"></span>
        <span class="planSummary">${completed === 0 ? `已创建 ${total} 个任务` : `共 ${total} 个任务，已经完成 ${completed} 个`}</span>
        <span class="planChevron" aria-hidden="true">${isExpanded ? "⌃" : "⌄"}</span>
      </button>
      <ol class="planList${isExpanded ? "" : " collapsed"}">
        ${actualSteps.map((step) => `
          <li class="${escapeAttribute(`planStep ${step.status}`)}">
            <span class="planCheck" aria-hidden="true"></span>
            <span class="planIndex">${step.index}.</span>
            <span class="planText">${formatInlineMarkdown(step.text)}</span>
          </li>
        `).join("")}
      </ol>
    `;
    block.querySelector("[data-toggle-plan]")?.addEventListener("click", () => togglePlan(message.id));
    return block;
  }

  function renderImageGrid(images) {
    const grid = document.createElement("div");
    grid.className = "messageImages";
    for (const image of images) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "messageImage";
      button.innerHTML = `<img loading="lazy" decoding="async" src="${escapeAttribute(image.url)}" alt="${escapeAttribute(image.name || "图片")}" />`;
      button.addEventListener("click", () => openImage(image.url));
      grid.append(button);
    }
    return grid;
  }

  function renderKey(message) {
    let cached = renderKeyCache.get(message);
    if (!cached) {
      const hasImages = Boolean(message?.meta?.images?.length || message?.images?.length || /<image\b|!\[[^\]]*]\(|data:image\//i.test(String(message?.text || "")));
      const hasFileChanges = message?.kind === "file" || message?.kind === "turn_diff";
      const hasActivity = ["dynamic_tool", "collab_agent", "subagent_activity", "image_generation", "review_state", "hook_prompt", "image_view", "sleep", "context_compaction"].includes(message?.kind);
      cached = [
        message.id,
        message.role,
        message.kind,
        message.streaming ? 1 : 0,
        message.revision || 0,
        message.updatedAt || 0,
        message.text?.length || 0,
        hasFileChanges ? fileChangeRenderSignature(message) : "",
        hasImages ? imageSignature(message) : "",
        hasActivity ? activityRenderSignature(message) : "",
        message.textTruncated ? 1 : 0,
        message.originalLength || 0
      ].join(":");
      renderKeyCache.set(message, cached);
    }
    const state = getState();
    return `${cached}:cwd:${state?.app?.cwd || ""}:edit-slot:${shouldReserveMessageEditAction(message) ? 1 : 0}:edit-ready:${canEditMessage(message) ? 1 : 0}:edit-active:${editingMessageMatches(message) ? 1 : 0}`;
  }

  function activityRenderSignature(message) {
    if (!message) return "";
    const keys = [
      "type", "phase", "status", "success", "namespace", "tool", "durationMs", "savedPath", "result",
      "revisedPrompt", "review", "reviewState", "kind", "agentPath", "agentThreadId", "agentsStates",
      "receiverThreadIds", "prompt", "model", "reasoningEffort", "contentItems", "fragments", "path"
    ];
    return textHash(keys.map((key) => `${key}=${stringifyForDisplay(itemField(message, key))}`).join("|"));
  }

  function fileChangeRenderSignature(message) {
    const changes = Array.isArray(message?.meta?.changes) ? message.meta.changes : [];
    const unifiedDiff = unifiedDiffForMessage(message);
    return [
      textHash(unifiedDiff),
      changes.map((change) => `${change.path || ""}:${change.added || 0}:${change.deleted || 0}:${String(change.diff || "").length}`).join(",")
    ].join("|");
  }

  return { render, renderKey };
}
