import { escapeHtml, textHash } from "../shared/text-utils.js";

export function createApprovalUI({
  approvalDock,
  getState,
  getPendingApprovalId,
  stringifyForDisplay,
  formatStructuredValue,
  shieldIconSvg,
  onResolve
} = {}) {
  if (!approvalDock) throw new TypeError("approval dock is required");
  let lastKey = "";

  function kindLabel(method) {
    switch (String(method || "")) {
      case "item/commandExecution/requestApproval": return "运行命令";
      case "item/fileChange/requestApproval": return "修改文件";
      case "item/permissions/requestApproval": return "请求额外权限";
      case "item/tool/requestUserInput": return "需要你的输入";
      case "mcpServer/elicitation/request": return "MCP 请求信息";
      default: return "Codex 请求确认";
    }
  }

  function summary(approval) {
    const method = String(approval.method || "");
    const params = approval.params || {};
    if (method === "item/commandExecution/requestApproval") {
      const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
      return [`命令：${command || "未知命令"}`, params.cwd ? `目录：${params.cwd}` : "", params.reason ? `原因：${params.reason}` : ""].filter(Boolean).join("\n");
    }
    if (method === "item/fileChange/requestApproval") {
      return ["Codex 准备修改文件", params.reason ? `原因：${params.reason}` : "", params.grantRoot ? `授权目录：${params.grantRoot}` : ""].filter(Boolean).join("\n");
    }
    if (method === "item/permissions/requestApproval") {
      return [params.reason ? `原因：${params.reason}` : "请求当前任务所需的额外权限", params.cwd ? `目录：${params.cwd}` : "", formatStructuredValue(params.permissions)].filter(Boolean).join("\n");
    }
    if (method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      return questions.map((question, index) => `${index + 1}. ${question.question || question.header || "需要输入"}`).join("\n") || "Codex 需要补充信息";
    }
    if (method === "mcpServer/elicitation/request") {
      return [params.message || params.prompt || "MCP 服务需要补充信息", params.serverName ? `服务：${params.serverName}` : ""].filter(Boolean).join("\n");
    }
    return [kindLabel(method), formatStructuredValue(params)].filter(Boolean).join("\n");
  }

  function render() {
    const state = getState?.();
    if (!state) return;
    const approvals = Array.isArray(state.approvals) ? state.approvals : [];
    const pendingId = getPendingApprovalId?.() || "";
    const key = approvals
      .map((approval) => `${approval.id}:${approval.method}:${approval.createdAt}:${textHash(stringifyForDisplay(approval.params))}`)
      .join("|") + `|pending:${pendingId}`;
    if (key === lastKey) return;
    lastKey = key;

    approvalDock.replaceChildren();
    approvalDock.classList.toggle("open", approvals.length > 0);
    for (const approval of approvals) {
      const box = document.createElement("article");
      box.className = "approval";
      box.innerHTML = `
        <div class="approvalHeading">
          <span class="approvalIcon" aria-hidden="true">${shieldIconSvg()}</span>
          <div>
            <strong>等待你的确认</strong>
            <span>${escapeHtml(kindLabel(approval.method))}</span>
          </div>
        </div>
        <pre>${escapeHtml(summary(approval))}</pre>
        <div class="approvalActions">
          <button type="button" data-decision="accept">允许一次</button>
          <button type="button" data-decision="acceptForSession">本会话允许</button>
          <button type="button" data-decision="decline">拒绝</button>
        </div>
      `;
      box.querySelectorAll("button").forEach((button) => {
        button.disabled = Boolean(pendingId);
        button.addEventListener("click", () => onResolve?.(approval.id, button.dataset.decision));
      });
      approvalDock.append(box);
    }
  }

  return {
    render,
    invalidate: () => { lastKey = ""; },
    kindLabel,
    summary
  };
}
