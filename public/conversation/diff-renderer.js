import { escapeHtml } from "../shared/text-utils.js";

export function createDiffRenderer({
  fileChangesForMessage,
  displayTextForMessage,
  summarizeFileChanges,
  displayDiffFileName,
  displayFilePath
} = {}) {
  function renderFileChangeMessage(message, options = {}) {
    const changes = fileChangesForMessage(message);
    if (!changes.length) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = displayTextForMessage(message) || "文件已更改";
      return bubble;
    }
    if (!options.completed) return renderInProgressTurnDiffRows(changes);
    return renderFileChangeCard(changes, options);
  }

  function renderInProgressTurnDiffMessage(message, options = {}) {
    const changes = fileChangesForMessage(message);
    if (!changes.length) {
      const block = document.createElement("div");
      block.className = "turnDiffInline empty";
      block.hidden = true;
      return block;
    }
    if (options.rows) return renderInProgressTurnDiffRows(changes);
    const summary = summarizeFileChanges(changes);
    const block = document.createElement("div");
    block.className = "turnDiffInline";
    block.innerHTML = `
      <div class="turnDiffInlineStats">
        <span class="turnDiffInlineSummary">${changes.length} 个文件已更改</span>
        <span class="diffAdded">+${summary.added}</span>
        <span class="diffDeleted">-${summary.deleted}</span>
      </div>
    `;
    return block;
  }

  function renderInProgressTurnDiffRows(changes) {
    const block = document.createElement("div");
    block.className = "turnDiffRows";
    const fileNameCounts = new Map();
    for (const change of changes) {
      const name = displayDiffFileName(change.path);
      fileNameCounts.set(name, (fileNameCounts.get(name) || 0) + 1);
    }
    block.innerHTML = changes.map((change) => `
      <div class="turnDiffRow">
        <span class="turnDiffFileName">${escapeHtml(fileNameCounts.get(displayDiffFileName(change.path)) > 1 ? displayFilePath(change.path) : displayDiffFileName(change.path))}</span>
        <span class="turnDiffStats">
          <span class="diffAdded">+${change.added}</span>
          <span class="diffDeleted">-${change.deleted}</span>
        </span>
      </div>
    `).join("");
    return block;
  }

  function renderFileChangeCard(changes, options = {}) {
    const summary = summarizeFileChanges(changes);
    const showTopLevelDiffStats = changes.length > 1;
    const block = document.createElement("div");
    block.className = `fileChangeBlock${options.completed ? " completedTurnDiffBlock" : ""}`;
    block.innerHTML = `
      <div class="fileChangeHeader">
        <div class="fileChangeHeaderMain">
          <span class="fileChangeSummary">${changes.length} 个文件已更改</span>
          ${showTopLevelDiffStats ? `
            <span class="diffAdded">+${summary.added}</span>
            <span class="diffDeleted">-${summary.deleted}</span>
          ` : ""}
        </div>
      </div>
      <div class="fileChangeList">
        ${changes.map((change) => `
          <div class="fileChangeRow">
            <span class="filePath">${escapeHtml(change.path)}</span>
            <span class="fileStats">
              <span class="diffAdded">+${change.added}</span>
              <span class="diffDeleted">-${change.deleted}</span>
            </span>
          </div>
        `).join("")}
      </div>
    `;
    return block;
  }

  return {
    renderFileChangeMessage,
    renderInProgressTurnDiffMessage,
    renderInProgressTurnDiffRows,
    renderFileChangeCard
  };
}
