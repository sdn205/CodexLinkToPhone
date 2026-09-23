import { escapeHtml } from "../shared/text-utils.js";

export function createThinkingShimmer({
  messages,
  initialDelayMs = 600,
  activeMs = 1000,
  cadenceMs = 4000
} = {}) {
  if (!messages) throw new TypeError("messages element is required");
  const cleanups = new WeakMap();

  function html(label) {
    const safeLabel = escapeHtml(label);
    return `<span class="thinkingText cadencedShimmer">${safeLabel}<span class="thinkingSweepBar" aria-hidden="true"><span class="thinkingSweepHighlight">${safeLabel}</span></span></span>`;
  }

  function start(node) {
    if (!node) return;
    const target = node.querySelector(".thinkingText.cadencedShimmer");
    if (!target || cleanups.has(target)) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let activeTimer = null;
    let intervalTimer = null;
    const trigger = () => {
      if (!node.isConnected) return;
      target.classList.remove("thinkingShimmerActive");
      target.classList.add("thinkingShimmerActive");
      clearTimeout(activeTimer);
      activeTimer = setTimeout(() => {
        target.classList.remove("thinkingShimmerActive");
        activeTimer = null;
      }, activeMs);
    };
    let initialTimer = setTimeout(() => {
      initialTimer = null;
      trigger();
      intervalTimer = setInterval(trigger, cadenceMs);
    }, initialDelayMs);

    cleanups.set(target, () => {
      clearTimeout(initialTimer);
      clearTimeout(activeTimer);
      clearInterval(intervalTimer);
      target.classList.remove("thinkingShimmerActive");
      cleanups.delete(target);
    });
  }

  function dispose(node) {
    if (!(node instanceof Element)) return;
    const targets = [];
    if (node.matches(".thinkingText.cadencedShimmer")) targets.push(node);
    targets.push(...node.querySelectorAll(".thinkingText.cadencedShimmer"));
    for (const target of targets) cleanups.get(target)?.();
  }

  function disposeCurrent() {
    const node = messages.querySelector("[data-static-node='turn-activity']");
    if (!node) return;
    dispose(node);
    node.remove();
  }

  return { html, start, dispose, disposeCurrent };
}
