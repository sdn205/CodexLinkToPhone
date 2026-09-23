export function createMessagePresentation({ getState, getToken, formatElapsed }) {
  function isAboveComposerTurnDiff(message) {
    return Boolean(message?.kind === "turn_diff" && message?.meta?.display === "above_composer");
  }

  function messageTurnId(message) {
    return String(message?.meta?.turnId || "");
  }

  function messageThreadId(message) {
    return String(message?.meta?.threadId || "");
  }

  function systemActivityLabel(message, options = {}) {
    switch (message.kind) {
      case "hook_prompt": return "已加载钩子指令";
      case "image_view": return "已查看图片";
      case "sleep": return "等待";
      case "context_compaction": return activityStatusKey(message) === "running" ? "正在压缩上下文" : "上下文已压缩";
      default: return options.unknown ? `收到 ${itemField(message, "type") || "未知事件"}` : "系统活动";
    }
  }

  function systemActivityDetail(message) {
    if (message.kind === "image_view") return displayFilePath(itemField(message, "path"));
    if (message.kind === "sleep") return formatDuration(itemField(message, "durationMs"));
    if (message.kind === "hook_prompt") {
      const fragments = itemField(message, "fragments");
      return Array.isArray(fragments) ? `${fragments.length} 段补充指令` : "";
    }
    return "";
  }

  function isUnknownCurrentActivity(message) {
    const sourceType = String(itemField(message, "type") || "");
    if (!sourceType || message.kind === "text" || message.kind === "error") return false;
    return !["plan", "reasoning", "commandExecution", "fileChange", "mcpToolCall", "webSearch", "agentMessage"].includes(sourceType);
  }

  function summarizeFileChanges(changes) {
    return changes.reduce((stats, change) => {
      stats.added += change.added;
      stats.deleted += change.deleted;
      return stats;
    }, { added: 0, deleted: 0 });
  }

  function fileChangesForMessage(message) {
    const rawChanges = Array.isArray(message.meta?.changes) ? message.meta.changes : [];
    if (!rawChanges.length) {
      return changesFromUnifiedDiff(unifiedDiffForMessage(message)).map((change) => ({
        path: displayFilePath(change.path),
        added: change.added,
        deleted: change.deleted
      })).filter((change) => change.path);
    }

    return rawChanges.map((change) => {
      const stats = numericDiffStats(change) || diffStats(change.diff, change.kind?.type);
      return {
        path: displayFilePath(change.path || ""),
        added: stats.added,
        deleted: stats.deleted
      };
    }).filter((change) => change.path);
  }

  function unifiedDiffForMessage(message) {
    return String(
      message?.unifiedDiff ||
      message?.meta?.unifiedDiff ||
      ""
    );
  }

  function changesFromUnifiedDiff(unifiedDiff) {
    const byPath = new Map();
    let current = null;

    const finishCurrent = () => {
      if (!current?.path) return;
      const filePath = normalizePath(current.path);
      const existing = byPath.get(filePath) || { path: filePath, added: 0, deleted: 0 };
      existing.added += current.added;
      existing.deleted += current.deleted;
      byPath.set(filePath, existing);
    };

    for (const line of String(unifiedDiff || "").split(/\r?\n/)) {
      const gitHeader = gitDiffHeaderPaths(line);
      if (gitHeader.length >= 2) {
        finishCurrent();
        current = {
          path: diffPathFromHeader(gitHeader[1]) || diffPathFromHeader(gitHeader[0]),
          added: 0,
          deleted: 0
        };
        continue;
      }

      if (!current && (line.startsWith("--- ") || line.startsWith("+++ "))) {
        current = { path: "", added: 0, deleted: 0 };
      }

      if (!current) continue;

      if (line.startsWith("+++ ")) {
        current.path = diffPathFromHeader(line.slice(4)) || current.path;
        continue;
      }
      if (line.startsWith("--- ")) {
        current.path = current.path || diffPathFromHeader(line.slice(4));
        continue;
      }
      if (line.startsWith("rename to ")) {
        current.path = diffPathFromHeader(line.slice("rename to ".length)) || current.path;
        continue;
      }
      if (line.startsWith("+")) current.added++;
      else if (line.startsWith("-")) current.deleted++;
    }

    finishCurrent();
    return Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
  }

  function gitDiffHeaderPaths(line) {
    if (!String(line || "").startsWith("diff --git ")) return [];
    return String(line).slice("diff --git ".length).match(/"(?:\\.|[^"])*"|\S+/g) || [];
  }

  function diffPathFromHeader(value) {
    let filePath = String(value || "").trim();
    const quotedToken = filePath.match(/^"(?:\\.|[^"])*"/);
    if (quotedToken) filePath = quotedToken[0];
    else filePath = filePath.split("\t", 1)[0];
    if (!filePath || filePath === "/dev/null") return "";
    filePath = decodeGitPath(filePath);
    return normalizePath(filePath.replace(/^(?:a|b)\//, ""));
  }

  function decodeGitPath(value) {
    let source = String(value || "");
    if (!(source.startsWith("\"") && source.endsWith("\""))) return source;
    source = source.slice(1, -1);
    let output = "";
    let bytes = [];
    const flushBytes = () => {
      if (!bytes.length) return;
      try {
        output += new TextDecoder("utf-8").decode(new Uint8Array(bytes));
      } catch {
        output += String.fromCharCode(...bytes);
      }
      bytes = [];
    };
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character !== "\\") {
        flushBytes();
        output += character;
        continue;
      }
      const octal = source.slice(index + 1, index + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(parseInt(octal, 8));
        index += 3;
        continue;
      }
      flushBytes();
      const escaped = source[++index] || "";
      output += { n: "\n", r: "\r", t: "\t", "\\": "\\", "\"": "\"" }[escaped] ?? escaped;
    }
    flushBytes();
    return output;
  }

  function numericDiffStats(change) {
    const added = Number(change?.added);
    const deleted = Number(change?.deleted);
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) return null;
    return {
      added: Math.max(0, added),
      deleted: Math.max(0, deleted)
    };
  }

  function displayFilePath(filePath) {
    const cwd = normalizePath(getState()?.app?.cwd || "");
    const normalized = normalizePath(filePath);
    if (cwd && normalized.toLowerCase().startsWith(`${cwd.toLowerCase()}/`)) {
      return normalized.slice(cwd.length + 1);
    }
    return normalized;
  }

  function displayDiffFileName(filePath) {
    const normalized = normalizePath(filePath);
    return normalized.split("/").filter(Boolean).pop() || normalized;
  }

  function normalizePath(filePath) {
    const replaced = String(filePath || "").replace(/\\/g, "/");
    const isUnc = replaced.startsWith("//");
    const collapsed = replaced.replace(/\/+/g, "/");
    return isUnc ? `//${collapsed.replace(/^\/+/, "")}` : collapsed;
  }

  function diffStats(diff, kind = "") {
    const lines = String(diff || "").split(/\r?\n/);
    let added = 0;
    let deleted = 0;
    for (const line of lines) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) deleted++;
    }
    if (!added && !deleted && kind === "add") added = lines.filter(Boolean).length;
    return { added, deleted };
  }

  function planStepsForMessage(message, text) {
    const structuredSteps = message.meta?.plan || message.plan?.steps || message.plan || [];
    if (Array.isArray(structuredSteps) && structuredSteps.length) {
      return structuredSteps
        .map((step, index) => ({
          index: index + 1,
          text: String(step.step || step.text || "").trim(),
          status: normalizePlanStepStatus(step.status)
        }))
        .filter((step) => step.text);
    }
    return parsePlanSteps(text);
  }

  function parsePlanSteps(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const checkbox = line.match(/^[-*]\s+\[([ xX~>|-])]\s+(.+)$/);
        if (checkbox) return { status: planStatusFromMarker(checkbox[1]), text: checkbox[2].trim() };

        const numbered = line.match(/^\d+[.)]\s+(.+)$/);
        if (numbered) return { status: "pending", text: numbered[1].trim() };

        const bullet = line.match(/^[-*+]\s+(.+)$/);
        if (bullet) return { status: "pending", text: bullet[1].trim() };

        return null;
      })
      .filter(Boolean)
      .map((step, index) => ({ ...step, index: index + 1 }));
  }

  function planStatusFromMarker(marker) {
    const value = String(marker || " ").toLowerCase();
    if (value === "x") return "completed";
    if (value === "~" || value === ">" || value === "-") return "in_progress";
    return "pending";
  }

  function normalizePlanStepStatus(status) {
    if (status === "completed") return "completed";
    if (status === "inProgress" || status === "in_progress") return "in_progress";
    return "pending";
  }

  function imagesForMessage(message, text = "") {
    const images = [];
    for (const image of message.meta?.images || message.images || []) {
      const url = image.url || image.dataUrl || image.src;
      if (isDisplayableImageUrl(url)) images.push({ url, name: image.name || "图片" });
    }

    for (const url of inlineImageUrls(text)) {
      if (!images.some((image) => image.url === url)) images.push({ url, name: "图片" });
    }
    return images;
  }

  function imageSignature(message) {
    return imagesForMessage(message, String(message.text || ""))
      .map((image) => `${image.name || ""}:${image.url.length}:${image.url.slice(0, 32)}`)
      .join(",");
  }

  function inlineImageUrls(text) {
    const urls = [];
    const source = markdownTextOutsideCode(String(text || ""));
    source.replace(/<image\b[^>]*>\s*([\s\S]*?)\s*<\/image>/gi, (_, url) => {
      urls.push(url.trim());
      return "";
    });
    source.replace(/!\[[^\]]*]\(\s*(data:image\/[^)\s]+|https?:\/\/[^)\s]+)\s*\)/gi, (_, url) => {
      urls.push(url);
      return "";
    });
    source.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+/gi, (url) => {
      urls.push(url.replace(/\s+/g, ""));
      return "";
    });
    return urls.filter(isDisplayableImageUrl);
  }

  function removeInlineImages(text) {
    return transformOutsideMarkdownCode(String(text || ""), (segment) => segment
      .replace(/<image\b[^>]*>\s*([\s\S]*?)\s*<\/image>/gi, (match, source) => (
        isDisplayableImageUrl(imagePathToUrl(String(source || "").trim())) ? "" : match
      ))
      .replace(/!\[[^\]]*]\(\s*(?:data:image\/[^)\s]+|https?:\/\/[^)\s]+)\s*\)/gi, "")
      .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+/gi, "")
      .replace(/\[图片]\s*$/g, ""))
      .trim();
  }

  function transformOutsideMarkdownCode(text, transform) {
    const source = String(text || "");
    const pattern = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
    let result = "";
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
      result += transform(source.slice(cursor, match.index));
      result += match[0];
      cursor = Number(match.index || 0) + match[0].length;
    }
    return result + transform(source.slice(cursor));
  }

  function markdownTextOutsideCode(text) {
    return transformOutsideMarkdownCode(text, (segment) => segment)
      .replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, "\n");
  }

  function isDisplayableImageUrl(url) {
    return /^data:image\//i.test(String(url || "")) || /^https?:\/\//i.test(String(url || "")) || /^\/local-image\?/i.test(String(url || ""));
  }

  function itemField(message, key) {
    if (message?.meta && Object.prototype.hasOwnProperty.call(message.meta, key)) return message.meta[key];
    if (message && Object.prototype.hasOwnProperty.call(message, key)) return message[key];
    return null;
  }

  function messagePhase(message) {
    return String(itemField(message, "phase") || "").trim().toLowerCase();
  }

  function messageIsInProgress(message) {
    if (!message) return false;
    if (message.streaming) return true;
    return activityStatusKey(message) === "running";
  }

  function activityStatusKey(message) {
    if (message?.streaming) return "running";
    const raw = String(itemField(message, "status") || itemField(message, "state") || "").trim().toLowerCase();
    if (["inprogress", "in_progress", "running", "active", "pending", "pendinginit"].includes(raw)) return "running";
    if (["failed", "error", "errored", "declined", "denied", "timedout", "aborted", "interrupted", "notfound"].includes(raw)) return "failed";
    if (["completed", "complete", "done", "success", "succeeded", "shutdown"].includes(raw)) return "completed";
    return raw ? "unknown" : "completed";
  }

  function activityStatusLabel(statusKey) {
    if (statusKey === "running") return "进行中";
    if (statusKey === "failed") return "失败";
    if (statusKey === "unknown") return "状态未知";
    return "已完成";
  }

  function dynamicToolName(message) {
    const namespace = String(itemField(message, "namespace") || "").trim();
    const tool = String(itemField(message, "tool") || "动态工具").trim();
    return namespace ? `${namespace}.${tool}` : tool;
  }

  function dynamicToolContentItems(message) {
    const items = itemField(message, "contentItems");
    return Array.isArray(items) ? items : [];
  }

  function dynamicToolOutput(message) {
    const text = String(message?.text || "").trim();
    if (text && text !== dynamicToolName(message)) return cleanDisplayText(text);
    const items = dynamicToolContentItems(message);
    return items.filter((item) => item?.type === "inputText").map((item) => String(item.text || "")).join("\n").trim();
  }

  function collabActionLabel(message, active = false) {
    const tool = String(itemField(message, "tool") || "").trim();
    const status = String(itemField(message, "status") || "").toLowerCase();
    const failed = status === "failed";
    const labels = {
      spawnAgent: "创建子代理",
      sendInput: "向子代理发送消息",
      resumeAgent: "恢复子代理",
      wait: "等待子代理",
      closeAgent: "关闭子代理"
    };
    const label = labels[tool] || "协调子代理";
    if (!active) return label;
    const prefix = status === "inprogress" || messageIsInProgress(message) ? "正在" : failed ? "操作失败：" : "已";
    return `${prefix}${label}`;
  }

  function agentStateLabel(status) {
    switch (String(status || "")) {
      case "pendingInit": return "准备中";
      case "running": return "工作中";
      case "interrupted": return "已中断";
      case "completed": return "已完成";
      case "errored": return "出错";
      case "shutdown": return "已关闭";
      case "notFound": return "未找到";
      default: return "状态未知";
    }
  }

  function agentStateClass(status) {
    const value = String(status || "").toLowerCase();
    if (value === "running" || value === "pendinginit") return "running";
    if (["errored", "notfound", "interrupted"].includes(value)) return "failed";
    return "completed";
  }

  function shortAgentId(value) {
    const text = String(value || "");
    return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
  }

  function agentPathDisplay(path) {
    const normalized = String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
    if (!normalized) return "子代理";
    const parts = normalized.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || normalized;
  }

  function formatStructuredValue(value) {
    if (value == null || value === "") return "";
    if (typeof value === "string") return cleanDisplayText(value);
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function stringifyForDisplay(value) {
    try {
      return JSON.stringify(value || null);
    } catch {
      return String(value || "");
    }
  }

  function formatDuration(milliseconds) {
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) return "";
    if (value < 1000) return `${Math.round(value)} 毫秒`;
    return formatElapsed(value);
  }

  function generatedImageSources(message) {
    const candidates = [];
    const result = itemField(message, "result");
    const savedPath = itemField(message, "savedPath");
    if (typeof result === "string" && result.trim()) candidates.push(result.trim());
    if (Array.isArray(result)) candidates.push(...result.filter((entry) => typeof entry === "string"));
    if (typeof savedPath === "string" && savedPath.trim()) candidates.push(savedPath.trim());
    return Array.from(new Set(candidates.map(imagePathToUrl).filter(isDisplayableImageUrl)));
  }

  function imagePathToUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (isDisplayableImageUrl(text)) return text;
    if (/^data:image\//i.test(text)) return text;
    if (/\.(png|jpe?g|webp|gif|svg)(?:\?.*)?$/i.test(text)) {
      return `/local-image?token=${encodeURIComponent(getToken())}&path=${encodeURIComponent(text)}`;
    }
    return text;
  }

  function imageGenerationStatusLabel(statusKey) {
    if (statusKey === "running") return "正在生成图片";
    if (statusKey === "failed") return "图片生成失败";
    if (statusKey === "unknown") return "图片状态未知";
    return "已生成图片";
  }

  function reviewStateLabel(type, status) {
    if (status) {
      const labels = {
        inprogress: "正在自动审核请求",
        approved: "自动审核已允许",
        denied: "自动审核已拒绝",
        timedout: "自动审核超时",
        aborted: "自动审核已终止"
      };
      if (labels[status]) return labels[status];
    }
    if (type.includes("exit")) return "退出审核模式";
    if (type.includes("enter")) return "进入审核模式";
    return "审核状态已更新";
  }

  function isTimelineRowsTurnDiff(message) {
    if (message?.kind !== "turn_diff") return false;
    if (message?.meta?.display === "timeline_rows" || message?.display === "timeline_rows") return true;
    return String(message?.id || "").endsWith(":turn-diff-rows");
  }

  function isCompletedTurnDiffCard(message) {
    if (message?.kind !== "turn_diff") return false;
    if (message?.meta?.display === "completed_card" || message?.display === "completed_card") return true;
    return !isTimelineRowsTurnDiff(message) && !isAboveComposerTurnDiff(message);
  }

  function displayTextForMessage(message) {
    const text = cleanDisplayText(removeInlineImages(String(message.text || "")), {
      stripIdeContext: message.role === "user"
    });
    if (text === "[内容已过滤]" && imagesForMessage(message, String(message.text || "")).length) return "";
    return text;
  }

  function cleanDisplayText(text, options = {}) {
    let cleaned = String(text || "");
    const hadContent = cleaned.trim().length > 0;

    if (options.stripIdeContext) {
      cleaned = stripIdeContext(cleaned);
    }

    cleaned = transformOutsideMarkdownCode(cleaned, (segment) => segment
      .replace(/<image\b[^>]*>\s*([\s\S]*?)\s*<\/image>/gi, (match, source) => (
        isDisplayableImageUrl(imagePathToUrl(String(source || "").trim())) ? "" : match
      ))
      .replace(/!\[[^\]]*]\(\s*(?!data:image\/)[^)]+\)/gi, "$&")
      .replace(/data:(?!image\/)[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+/gi, "[base64 已过滤]")
      .replace(/\b(?:[A-Za-z0-9+/]{120,}\r?\n?){4,}={0,2}\b/g, "[base64 已过滤]")
      .replace(/\[图片]\s*\[(?:图片 base64|base64) 已过滤]/g, "")
      .replace(/(?:\[(?:图片|图片 base64) 已过滤]\s*)+/g, "")
      .replace(/(?:\[base64 已过滤]\s*){2,}/g, "[base64 已过滤]"))
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!cleaned && hadContent) return "[内容已过滤]";
    return cleaned;
  }

  function hasFilteredPayload(text) {
    return /\[(?:图片 base64 已过滤|base64 已过滤|内容已过滤)]/.test(text);
  }

  function stripIdeContext(text) {
    const source = String(text || "");
    if (!/^\s*# Context from my IDE setup:/i.test(source)) return source.trim();
    const marker = /(?:^|\n)#{1,6}\s+My request for Codex:\s*/i.exec(source);
    if (marker) return source.slice(Number(marker.index || 0) + marker[0].length).trim();
    return source.replace(/^\s*# Context from my IDE setup:\s*[\s\S]*?(?=\n\S)/i, "").trim();
  }

  function isToolLike(message) {
    return message.role === "tool" || ["command", "tool", "file", "search"].includes(message.kind);
  }

  function isShellLauncherCommand(text) {
    return /^(?:.*[/\\])?(?:bash|cmd(?:\.exe)?|fish|powershell(?:\.exe)?|pwsh(?:\.exe)?|sh|zsh)(?:\s|$)/iu.test(String(text || "").trim());
  }

  // 与 Trae Codex 扩展前端一致：优先取 commandActions 里最后一个非 shell 启动器的
  // 真实命令，退回 command 字段并过滤 powershell.exe/cmd.exe 这类包装。
  function commandDisplayText(message) {
    const actions = Array.isArray(message?.meta?.commandActions) ? message.meta.commandActions : [];
    for (let index = actions.length - 1; index >= 0; index -= 1) {
      const raw = actions[index]?.command;
      const command = Array.isArray(raw) ? raw.map((entry) => String(entry || "")).join(" ") : String(raw || "");
      const trimmed = command.trim();
      if (trimmed && !isShellLauncherCommand(trimmed)) return trimmed;
    }
    const fallbackRaw = message?.meta?.command;
    const fallback = Array.isArray(fallbackRaw) ? fallbackRaw.map((entry) => String(entry || "")).join(" ") : String(fallbackRaw || "");
    const trimmedFallback = fallback.trim();
    return isShellLauncherCommand(trimmedFallback) ? "" : trimmedFallback;
  }

  function toolTitle(message) {
    if (message.kind === "file") return "file changes";
    if (message.kind === "search") return "web search";
    const commandText = commandDisplayText(message);
    if (commandText) return commandText.slice(0, 160);
    const text = String(message.text || "");
    const title = commandTitleFromText(text);
    return title ? title.slice(0, 160) : "tool output";
  }

  function commandTitleFromText(text) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const firstLine = lines[0] || "";
    if (/^@['"]?$/.test(firstLine)) {
      const terminator = lines.find((line) => /^['"]?@\s*\|/.test(line));
      if (terminator) {
        if (/\|\s*node(?:\.exe)?\b/i.test(terminator)) return "node inline script";
        if (/\|\s*python(?:\.exe)?\b/i.test(terminator)) return "python inline script";
        if (/\|\s*powershell(?:\.exe)?\b/i.test(terminator)) return "PowerShell inline script";
      }
      const firstScriptLine = lines.find((line) => !/^@['"]?$/.test(line) && !/^['"]?@\s*\|/.test(line));
      return firstScriptLine ? friendlyCommandTitle(simplifyCommandTitle(firstScriptLine)) : "inline script";
    }
    return firstLine ? friendlyCommandTitle(simplifyCommandTitle(firstLine)) : "";
  }

  function simplifyCommandTitle(line) {
    return String(line)
      .replace(/^"[^"]*powershell\.exe"\s+-Command\s+/i, "")
      .replace(/^powershell(?:\.exe)?\s+-Command\s+/i, "")
      .replace(/^cmd(?:\.exe)?\s+\/[a-z]\s+\/[a-z]\s+\/c\s+/i, "")
      .replace(/^\$ErrorActionPreference\s*=.*?;\s*/i, "")
      .replace(/^['"]|['"]$/g, "")
      .trim();
  }

  function friendlyCommandTitle(title) {
    if (/Invoke-RestMethod .*127\.0\.0\.1:8787\/api\/status|\/api\/status\?token/i.test(title)) return "phone bridge status";
    if (/Get-NetTCPConnection .*LocalPort 8787/i.test(title)) return "check bridge port";
    if (/adb forward .*9222|chrome_devtools_remote/i.test(title)) return "ADB devtools bridge";
    if (/adb shell screencap|adb pull .*phone/i.test(title)) return "ADB screenshot";
    if (/adb shell am start/i.test(title)) return "open phone page";
    if (/^Start-Sleep\b/i.test(title)) return "wait";
    return title;
  }

  function toolOutput(message) {
    const sourceType = String(itemField(message, "type") || "");
    if (sourceType === "commandExecution") {
      const aggregated = String(itemField(message, "aggregatedOutput") || "").trim();
      if (aggregated) return cleanDisplayText(aggregated);
    }
    const text = String(message.text || "");
    if (!text) return "";
    const lines = text.split(/\r?\n/);
    const output = lines.length > 1 ? lines.slice(1).join("\n").trim() || text : text;
    return cleanDisplayText(output);
  }

  function toolStatus(message) {
    const status = toolStatusKey(message);
    if (status === "completed" || status === "done") return "完成";
    if (status === "running") return "运行中";
    if (status === "failed") return "失败";
    if (status === "unknown") return "状态未知";
    return status;
  }

  function toolStatusKey(message) {
    if (message.streaming) return "running";
    const status = String(message.meta?.status || "").toLowerCase();
    const exitCode = Number(message.meta?.exitCode);
    if (["failed", "error", "declined", "denied", "cancelled", "canceled", "aborted", "interrupted"].includes(status) || (Number.isFinite(exitCode) && exitCode !== 0)) return "failed";
    if (status === "running" || status === "inprogress" || status === "in_progress" || status === "in-progress") return "running";
    if (status === "completed" || status === "done" || status === "success") return "completed";
    return status ? "unknown" : "completed";
  }

  function roleLabel(message) {
    if (message.role === "user") return "你";
    if (message.role === "tool") return message.kind === "command" ? "命令" : "工具";
    if (message.role === "system") return "系统";
    if (message.kind === "reasoning") return "思考摘要";
    if (message.kind === "plan") return "计划";
    if (messagePhase(message) === "commentary") return "Codex";
    return "Codex";
  }

  return {
    messageThreadId, messageTurnId, isAboveComposerTurnDiff,
    systemActivityLabel, systemActivityDetail, isUnknownCurrentActivity,
    summarizeFileChanges, fileChangesForMessage, unifiedDiffForMessage,
    changesFromUnifiedDiff, displayFilePath, displayDiffFileName, normalizePath,
    planStepsForMessage, imagesForMessage, imageSignature, isDisplayableImageUrl,
    itemField, messagePhase, messageIsInProgress, activityStatusKey, activityStatusLabel,
    dynamicToolName, dynamicToolContentItems, dynamicToolOutput, collabActionLabel,
    agentStateLabel, agentStateClass, shortAgentId, agentPathDisplay, formatStructuredValue,
    stringifyForDisplay, formatDuration, generatedImageSources, imagePathToUrl,
    imageGenerationStatusLabel, reviewStateLabel, isTimelineRowsTurnDiff,
    isCompletedTurnDiffCard, displayTextForMessage, cleanDisplayText, hasFilteredPayload,
    isToolLike, toolTitle, toolOutput, toolStatus, toolStatusKey, roleLabel
  };
}
