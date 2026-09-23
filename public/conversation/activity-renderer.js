import { renderMarkdown } from "../shared/markdown.js";

export function createActivityRenderer({
  expandedMessages,
  itemField,
  activityStatusKey,
  activityStatusLabel,
  dynamicToolName,
  dynamicToolOutput,
  dynamicToolContentItems,
  collabActionLabel,
  agentStateLabel,
  agentStateClass,
  shortAgentId,
  agentPathDisplay,
  generatedImageSources,
  imagePathToUrl,
  imageGenerationStatusLabel,
  reviewStateLabel,
  systemActivityLabel,
  systemActivityDetail,
  isDisplayableImageUrl,
  formatStructuredValue,
  formatDuration,
  cleanDisplayText,
  displayTextForMessage,
  escapeAttribute,
  escapeHtml,
  openImage,
  thinkingShimmer
}) {
  function render(message, options = {}) {
    switch (message?.kind) {
      case "dynamic_tool": return renderDynamicTool(message);
      case "collab_agent": return renderCollabAgent(message);
      case "subagent_activity": return renderSubagentActivity(message);
      case "image_generation": return renderImageGeneration(message);
      case "review_state": return renderReviewState(message);
      case "hook_prompt":
      case "image_view":
      case "sleep":
      case "context_compaction":
        return renderSystemActivity(message);
      default:
        return options.unknown ? renderSystemActivity(message, { unknown: true }) : null;
    }
  }

  function renderDynamicTool(message) {
    const statusKey = activityStatusKey(message);
    const expanded = expandedMessages.has(message.id);
    const name = dynamicToolName(message);
    const outputText = dynamicToolOutput(message);
    const contentItems = dynamicToolContentItems(message).filter((item) => !outputText || item?.type !== "inputText");
    const argumentText = formatStructuredValue(itemField(message, "arguments"));
    const hasDetails = Boolean(argumentText || outputText || contentItems.length || itemField(message, "durationMs"));
    const block = document.createElement("div");
    block.className = `activityBlock dynamicToolBlock ${statusKey}${expanded ? " expanded" : ""}`;
    block.innerHTML = `
      <button class="activityHeader" type="button" data-toggle-message="${escapeAttribute(message.id)}" aria-expanded="${String(expanded)}">
        <span class="activityIcon" aria-hidden="true">${toolIconSvg()}</span>
        <span class="activityTitle">${escapeHtml(name)}</span>
        <span class="activityStatus ${statusKey}">${escapeHtml(activityStatusLabel(statusKey))}</span>
        ${hasDetails ? `<span class="activityChevron${expanded ? " expanded" : ""}" aria-hidden="true">${activityChevronIconSvg()}</span>` : ""}
      </button>
      <div class="activityDetails${expanded ? " expanded" : ""}">${expanded ? `
        ${argumentText ? `<div class="activityDetailGroup"><span class="activityDetailLabel">参数</span><pre>${escapeHtml(argumentText)}</pre></div>` : ""}
        ${outputText ? `<div class="activityDetailGroup"><span class="activityDetailLabel">结果</span><pre>${escapeHtml(outputText)}</pre></div>` : ""}
        ${contentItems.length ? renderDynamicContentItems(contentItems) : ""}
        ${itemField(message, "durationMs") != null ? `<span class="activityDuration">${escapeHtml(formatDuration(itemField(message, "durationMs")))}</span>` : ""}
      ` : ""}</div>
    `;
    const contentImages = contentItems
      .filter((item) => item?.type === "inputImage" && isDisplayableImageUrl(item.imageUrl))
      .map((item) => item.imageUrl);
    block.querySelectorAll(".activityInlineImages .messageImage").forEach((button, index) => {
      button.addEventListener("click", () => openImage(contentImages[index]));
    });
    if (!hasDetails) block.querySelector(".activityHeader")?.removeAttribute("data-toggle-message");
    return block;
  }

  function renderDynamicContentItems(items) {
    const images = items
      .filter((item) => item?.type === "inputImage" && isDisplayableImageUrl(item.imageUrl))
      .map((item) => ({ url: item.imageUrl, name: "工具图片" }));
    const text = items
      .filter((item) => item?.type === "inputText")
      .map((item) => String(item.text || "").trim())
      .filter(Boolean)
      .join("\n");
    return `
      <div class="activityDetailGroup dynamicContentItems">
        <span class="activityDetailLabel">工具输出</span>
        ${text ? `<pre>${escapeHtml(cleanDisplayText(text))}</pre>` : ""}
        ${images.length ? `<div class="activityInlineImages">${images.map((image) => `<button class="messageImage" type="button" aria-label="查看工具图片"><img loading="lazy" decoding="async" src="${escapeAttribute(image.url)}" alt="工具图片" /></button>`).join("")}</div>` : ""}
      </div>
    `;
  }

  function renderCollabAgent(message) {
    const statusKey = activityStatusKey(message);
    const expanded = expandedMessages.has(message.id);
    const agentStates = itemField(message, "agentsStates") || {};
    const receiverIds = Array.isArray(itemField(message, "receiverThreadIds")) ? itemField(message, "receiverThreadIds") : [];
    const ids = Array.from(new Set([...receiverIds, ...Object.keys(agentStates)])).filter(Boolean);
    const hasDetails = ids.length > 0 || Boolean(itemField(message, "prompt") || itemField(message, "model") || itemField(message, "reasoningEffort"));
    const block = document.createElement("div");
    block.className = `activityBlock collabAgentBlock ${statusKey}${expanded ? " expanded" : ""}`;
    block.innerHTML = `
      <button class="activityHeader" type="button" data-toggle-message="${escapeAttribute(message.id)}" aria-expanded="${String(expanded)}">
        <span class="activityIcon" aria-hidden="true">${agentsIconSvg()}</span>
        <span class="activityTitle">${escapeHtml(collabActionLabel(message))}</span>
        <span class="activityStatus ${statusKey}">${escapeHtml(activityStatusLabel(statusKey))}</span>
        ${hasDetails ? `<span class="activityChevron${expanded ? " expanded" : ""}" aria-hidden="true">${activityChevronIconSvg()}</span>` : ""}
      </button>
      <div class="activityDetails${expanded ? " expanded" : ""}">
        ${ids.length ? `<div class="agentStateList">${ids.map((id) => {
          const state = agentStates[id] || {};
          return `<div class="agentStateRow"><span class="agentStateDot ${agentStateClass(state.status)}" aria-hidden="true"></span><span class="agentStateName">子代理 ${escapeHtml(shortAgentId(id))}</span><span class="agentStateLabel">${escapeHtml(agentStateLabel(state.status))}</span>${state.message ? `<span class="agentStateMessage">${escapeHtml(state.message)}</span>` : ""}</div>`;
        }).join("")}</div>` : ""}
        ${itemField(message, "prompt") ? `<div class="activityDetailGroup"><span class="activityDetailLabel">指令</span><div class="activityDetailText">${escapeHtml(String(itemField(message, "prompt")))}</div></div>` : ""}
        ${itemField(message, "model") ? `<span class="activityMetaLine">模型：${escapeHtml(itemField(message, "model"))}</span>` : ""}
        ${itemField(message, "reasoningEffort") ? `<span class="activityMetaLine">推理强度：${escapeHtml(itemField(message, "reasoningEffort"))}</span>` : ""}
      </div>
    `;
    if (!hasDetails) block.querySelector(".activityHeader")?.removeAttribute("data-toggle-message");
    return block;
  }

  function renderSubagentActivity(message) {
    const kind = String(itemField(message, "kind") || "started");
    const stateClass = kind === "interrupted" ? "interrupted" : kind === "started" ? "running" : "completed";
    const path = String(itemField(message, "agentPath") || "").trim();
    const name = agentPathDisplay(path);
    const statusLabel = kind === "interrupted" ? "已中断" : kind === "interacted" ? "有新进展" : "进行中";
    const row = document.createElement("div");
    row.className = `activityRow subagentActivityRow ${stateClass}`;
    row.innerHTML = `
      <span class="activityIcon" aria-hidden="true">${agentsIconSvg()}</span>
      <span class="activityTitle">${escapeHtml(name ? `子代理 · ${name}` : "子代理")}</span>
      <span class="activityStatus ${stateClass}">${escapeHtml(statusLabel)}</span>
    `;
    return row;
  }

  function renderImageGeneration(message) {
    const statusKey = activityStatusKey(message);
    const sources = generatedImageSources(message);
    const rawResult = itemField(message, "result");
    const resultEntries = (Array.isArray(rawResult) ? rawResult : [rawResult])
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
    const revisedPrompt = String(itemField(message, "revisedPrompt") || "").trim();
    const block = document.createElement("div");
    block.className = `imageGenerationBlock ${statusKey}`;
    const imageMarkup = sources.length
      ? `<div class="generatedImageGrid">${sources.map((source, index) => `<button class="generatedImageButton" type="button" aria-label="查看生成图片"><img loading="lazy" decoding="async" src="${escapeAttribute(source)}" alt="生成图片 ${index + 1}" /></button>`).join("")}</div>`
      : "";
    const resultText = cleanDisplayText(resultEntries
      .filter((entry) => !isDisplayableImageUrl(imagePathToUrl(entry)))
      .join("\n"));
    block.innerHTML = `
      <div class="imageGenerationHeader">
        <span class="activityIcon" aria-hidden="true">${imageIconSvg()}</span>
        <strong>${escapeHtml(imageGenerationStatusLabel(statusKey))}</strong>
        ${itemField(message, "durationMs") != null ? `<span class="activityDuration">${escapeHtml(formatDuration(itemField(message, "durationMs")))}</span>` : ""}
      </div>
      ${imageMarkup}
      ${resultText ? `<div class="imageGenerationResult">${renderMarkdown(String(resultText || ""))}</div>` : ""}
      ${revisedPrompt ? `<details class="imageGenerationPrompt"><summary>修订后的提示词</summary><div>${escapeHtml(revisedPrompt)}</div></details>` : ""}
    `;
    block.querySelectorAll(".generatedImageButton").forEach((button, index) => button.addEventListener("click", () => openImage(sources[index])));
    return block;
  }

  function renderReviewState(message) {
    const type = String(itemField(message, "type") || message.meta?.reviewState || "").toLowerCase();
    const status = String(itemField(message, "status") || message.meta?.status || "").toLowerCase();
    const review = String(itemField(message, "review") || displayTextForMessage(message) || "").trim();
    const label = reviewStateLabel(type, status);
    const block = document.createElement("div");
    block.className = `reviewStateBlock ${status ? `status-${escapeAttribute(status)}` : ""}`;
    block.innerHTML = `
      <span class="activityIcon" aria-hidden="true">${shieldIconSvg()}</span>
      <div class="reviewStateCopy"><strong>${escapeHtml(label)}</strong>${review && review !== label ? `<span>${escapeHtml(review)}</span>` : ""}</div>
    `;
    return block;
  }

  function renderSystemActivity(message, options = {}) {
    const sourceType = String(itemField(message, "type") || message.kind || "未知事件");
    const label = systemActivityLabel(message, options);
    const detail = systemActivityDetail(message);
    const statusKey = activityStatusKey(message);
    const showsStatus = message.kind === "sleep";
    const isContextCompaction = message.kind === "context_compaction";
    const runningCompaction = isContextCompaction && statusKey === "running";
    const icon = isContextCompaction ? compressIconSvg() : systemIconSvg();
    const titleHtml = runningCompaction ? thinkingShimmer.html(label) : escapeHtml(label);
    const row = document.createElement("div");
    row.className = `activityRow systemActivityRow ${statusKey}${isContextCompaction ? " contextCompactionRow" : ""}${options.unknown ? " unknown" : ""}`;
    row.innerHTML = `
      <span class="activityIcon${isContextCompaction ? " contextCompactionIcon" : ""}" aria-hidden="true">${icon}</span>
      <span class="activityTitle">${titleHtml}</span>
      ${showsStatus ? `<span class="activityStatus ${statusKey}">${escapeHtml(activityStatusLabel(statusKey))}</span>` : ""}
      ${detail ? `<span class="activityMetaLine">${escapeHtml(detail)}</span>` : options.unknown ? `<span class="activityMetaLine">${escapeHtml(sourceType)}</span>` : ""}
    `;
    if (runningCompaction) thinkingShimmer.start(row);
    return row;
  }

  return { render };
}

function toolIconSvg() {
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.2 3.3 3.3 7.2l2.1 2.1-2.1 2.1 3.9 3.9 2.1-2.1 2.1 2.1 3.9-3.9-2.1-2.1 2.1-2.1-3.9-3.9-2.1 2.1-2.1-2.1Z"/><path d="m10 7.4 2.6 2.6-2.6 2.6-2.6-2.6L10 7.4Z"/></svg>`;
}

function agentsIconSvg() {
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7" cy="7" r="2.5"/><circle cx="14" cy="8" r="2"/><path d="M2.8 16c.4-2.5 1.9-3.8 4.2-3.8s3.8 1.3 4.2 3.8M11.4 15.4c.3-1.8 1.3-2.7 2.9-2.7 1.5 0 2.5.9 2.8 2.7"/></svg>`;
}

function imageIconSvg() {
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2"/><circle cx="7" cy="7.3" r="1.2"/><path d="m4.5 14 3.5-3.5 2.6 2.4 1.8-1.7 3.1 2.8"/></svg>`;
}

export function shieldIconSvg() {
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.4 16 4.7v4.6c0 3.8-2.2 6.4-6 8.3-3.8-1.9-6-4.5-6-8.3V4.7l6-2.3Z"/><path d="m7.2 10 1.8 1.8 3.8-4"/></svg>`;
}

function systemIconSvg() {
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><path d="M10 6.2v4.2l2.7 1.7"/></svg>`;
}

function compressIconSvg() {
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.666 3.50098C13.3549 3.50098 13.9121 3.50133 14.3623 3.53809C14.8202 3.5755 15.2268 3.65483 15.6035 3.84668C16.1988 4.15007 16.6829 4.63424 16.9863 5.22949C17.1782 5.60603 17.2575 6.01205 17.2949 6.46973C17.3317 6.91983 17.3311 7.47721 17.3311 8.16602V15.1377C17.9209 15.3944 18.333 15.9827 18.333 16.667C18.3328 17.5872 17.5872 18.3328 16.667 18.333C15.7466 18.333 15.0002 17.5873 15 16.667C15 15.9832 15.4119 15.3957 16.001 15.1387V8.16602C16.001 7.45532 16.0011 6.96153 15.9697 6.57812C15.939 6.20279 15.8822 5.99093 15.8018 5.83301C15.6258 5.4879 15.3442 5.20711 14.999 5.03125C14.8411 4.95091 14.6291 4.89394 14.2539 4.86328C13.8705 4.83199 13.3767 4.83105 12.666 4.83105H7.5C7.13284 4.83092 6.83496 4.5332 6.83496 4.16602C6.8353 3.79912 7.13305 3.50111 7.5 3.50098H12.666Z"/><path d="M3.33301 1.66699C4.25337 1.66699 4.99981 2.41269 5 3.33301C5 4.01711 4.58759 4.60453 3.99805 4.86133V11.833C3.99805 12.5438 3.99896 13.0374 4.03027 13.4209C4.06095 13.7963 4.11783 14.008 4.19824 14.166C4.37411 14.5112 4.6549 14.7918 5 14.9678C5.15797 15.0483 5.36958 15.105 5.74512 15.1357C6.12859 15.1671 6.6221 15.168 7.33301 15.168H12.5L12.6338 15.1816C12.9367 15.2437 13.1649 15.5118 13.165 15.833C13.165 16.1543 12.9368 16.4223 12.6338 16.4844L12.5 16.498H7.33301C6.64403 16.498 6.08691 16.4987 5.63672 16.4619C5.17904 16.4245 4.77303 16.3451 4.39648 16.1533C3.8011 15.8499 3.31608 15.365 3.0127 14.7695C2.82102 14.393 2.7415 13.987 2.7041 13.5293C2.66734 13.0791 2.66797 12.5219 2.66797 11.833V4.86035C2.07898 4.60332 1.66699 4.0167 1.66699 3.33301C1.66718 2.41283 2.41284 1.66721 3.33301 1.66699Z"/><path d="M10.1338 11.0146C10.4366 11.0766 10.6647 11.345 10.665 11.666C10.665 11.9873 10.4367 12.2553 10.1338 12.3174L10 12.3311H7.5C7.13284 12.3309 6.83496 12.0332 6.83496 11.666C6.8353 11.2991 7.13305 11.0011 7.5 11.001H10L10.1338 11.0146Z"/><path d="M12.6338 7.68164C12.9367 7.74367 13.1649 8.01182 13.165 8.33301C13.165 8.65433 12.9368 8.92232 12.6338 8.98438L12.5 8.99805H7.5C7.13284 8.99791 6.83496 8.7002 6.83496 8.33301C6.83513 7.96596 7.13294 7.6681 7.5 7.66797H12.5L12.6338 7.68164Z"/></svg>`;
}

function activityChevronIconSvg() {
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.25 3.5 3.5 3.5-3.5"/></svg>`;
}
