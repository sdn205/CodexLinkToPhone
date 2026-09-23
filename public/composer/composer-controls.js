import { escapeHtml } from "../shared/text-utils.js";

export function createComposerControls({
  modelButton,
  modelButtonLabel,
  modelMenu,
  effortButton,
  effortButtonLabel,
  effortMenu,
  contextRingButton,
  contextRing,
  composer,
  getState,
  isAwaitingState,
  hasPendingSubmission,
  getPendingSettings,
  isSocketOpen,
  onCompact
} = {}) {
  const required = [modelButton, modelButtonLabel, modelMenu, effortButton, effortButtonLabel, effortMenu, contextRingButton, contextRing, composer];
  if (required.some((element) => !element)) throw new TypeError("composer control elements are required");

  let contextPanel = null;

  function reasoningEffortLabel(value) {
    const normalized = String(value || "").toLowerCase();
    return {
      none: "无推理",
      minimal: "最小",
      low: "低",
      medium: "中",
      high: "高",
      xhigh: "超高"
    }[normalized] || value || "推理强度";
  }

  function settingOption({ label, value, selected, dataName }) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `composerSettingOption${selected ? " selected" : ""}`;
    option.dataset[dataName] = value;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", selected ? "true" : "false");
    option.innerHTML = `<span>${escapeHtml(label)}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8 3 3 6-6" /></svg>`;
    return option;
  }

  function renderSettings() {
    const state = getState?.();
    const modelOptions = Array.isArray(state?.models) ? state.models : [];
    const pendingSettings = getPendingSettings?.() || {};
    const settingsDisabled = Boolean(isAwaitingState?.() || pendingSettings.model || pendingSettings.effort || hasPendingSubmission?.() || state?.codex?.status !== "connected" || !isSocketOpen?.());
    const selectedModel = pendingSettings.model || state?.threadSettings?.model || modelOptions.find((model) => model.isDefault)?.model || modelOptions[0]?.model || "";
    const modelKey = `${selectedModel}|${modelOptions.map((model) => `${model.model}:${model.displayName}`).join("|")}`;
    const selectedModelOption = modelOptions.find((entry) => entry.model === selectedModel);
    modelButtonLabel.textContent = selectedModelOption?.displayName || selectedModel || "模型";
    modelButton.disabled = modelOptions.length === 0 || settingsDisabled;
    if (modelMenu.dataset.renderKey !== modelKey) {
      modelMenu.dataset.renderKey = modelKey;
      modelMenu.replaceChildren(...modelOptions.map((model) => settingOption({
        label: model.displayName || model.model,
        value: model.model,
        selected: model.model === selectedModel,
        dataName: "model"
      })));
    }

    const efforts = selectedModelOption?.supportedReasoningEfforts || [];
    const selectedEffort = pendingSettings.effort || state?.threadSettings?.effort || selectedModelOption?.defaultReasoningEffort || efforts[0]?.reasoningEffort || "";
    const effortKey = `${selectedEffort}|${efforts.map((effort) => `${effort.reasoningEffort}:${effort.label || ""}`).join("|")}`;
    effortButtonLabel.textContent = selectedEffort ? reasoningEffortLabel(selectedEffort) : "推理强度";
    effortButton.disabled = efforts.length === 0 || settingsDisabled;
    if (effortMenu.dataset.renderKey !== effortKey) {
      effortMenu.dataset.renderKey = effortKey;
      effortMenu.replaceChildren(...efforts.map((effort) => settingOption({
        label: reasoningEffortLabel(effort.label || effort.reasoningEffort),
        value: effort.reasoningEffort,
        selected: effort.reasoningEffort === selectedEffort,
        dataName: "effort"
      })));
    }
  }

  function closeSettingMenus() {
    modelMenu.hidden = true;
    effortMenu.hidden = true;
    modelButton.setAttribute("aria-expanded", "false");
    effortButton.setAttribute("aria-expanded", "false");
  }

  function toggleSettingMenu(type) {
    const openMenu = type === "model" ? modelMenu : effortMenu;
    const openButton = type === "model" ? modelButton : effortButton;
    const shouldOpen = openMenu.hidden;
    closeSettingMenus();
    if (!shouldOpen || openButton.disabled) return;
    openMenu.hidden = false;
    openButton.setAttribute("aria-expanded", "true");
  }

  function tokenK(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) return "0K";
    return number >= 1000 ? `${Math.round(number / 1000)}K` : `${number}`;
  }

  function tokenUsage() {
    const usage = getState?.()?.threadTokenUsage;
    const last = usage?.last || usage || {};
    const used = Number(last.totalTokens || 0)
      || (Number(last.inputTokens || 0) + Number(last.cachedInputTokens || 0) + Number(last.outputTokens || 0));
    const total = Number(usage?.modelContextWindow || usage?.contextWindow || last?.contextWindow || 0) || 0;
    return { used, total };
  }

  function renderContextRing() {
    const { used, total } = tokenUsage();
    if (total <= 0 || used <= 0) {
      contextRingButton.style.display = "none";
      return;
    }
    contextRingButton.style.display = "";
    const percent = Math.min(100, Math.round((used / total) * 100));
    contextRing.style.setProperty("--context-used-pct", `${percent}%`);
    contextRingButton.setAttribute("aria-label", `上下文已用 ${tokenK(used)} / ${tokenK(total)}`);
  }

  function toggleContextPanel() {
    if (contextPanel) closeContextPanel();
    else showContextPanel();
  }

  function closeContextPanel() {
    contextPanel?.remove();
    contextPanel = null;
    contextRingButton.setAttribute("aria-expanded", "false");
  }

  function showContextPanel() {
    closeContextPanel();
    const { used, total } = tokenUsage();
    const panel = document.createElement("div");
    panel.className = "contextRingPanel";
    panel.innerHTML = `
      <div class="contextPanelRow">
        <span class="contextPanelLabel">上下文</span>
        <span class="contextPanelText">${tokenK(used)} / ${tokenK(total)}</span>
      </div>
      <button type="button" class="contextCompactBtn">压缩会话</button>
    `;
    panel.querySelector(".contextCompactBtn").addEventListener("click", () => onCompact?.());
    const actions = composer.querySelector(".composerActions");
    (actions || document.body).append(panel);
    contextPanel = panel;
    contextRingButton.setAttribute("aria-expanded", "true");
  }

  return {
    renderSettings,
    toggleSettingMenu,
    closeSettingMenus,
    renderContextRing,
    toggleContextPanel,
    closeContextPanel,
    tokenUsage,
    reasoningEffortLabel
  };
}
