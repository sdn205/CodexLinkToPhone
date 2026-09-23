import { escapeAttribute, escapeHtml, linkify } from "./text-utils.js";

export function renderMarkdown(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = markdownFenceStart(line);
    if (fence) {
      const code = [];
      index++;
      while (index < lines.length && !isMarkdownFenceEnd(lines[index], fence)) {
        code.push(lines[index]);
        index++;
      }
      if (index < lines.length) index++;
      html.push(renderCodeBlock(code.join("\n"), fence.language));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${formatInlineMarkdown(heading[2])}</h${level}>`);
      index++;
      continue;
    }

    if (/^[-*_]\s*[-*_]\s*[-*_]\s*$/.test(line.trim())) {
      html.push("<hr>");
      index++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index++;
      }
      html.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const header = splitMarkdownTableRow(lines[index]);
      const alignments = parseMarkdownTableAlignments(lines[index + 1]);
      const rows = [];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        const row = splitMarkdownTableRow(lines[index]);
        if (row.length > header.length) break;
        rows.push(row);
        index++;
      }
      html.push(renderMarkdownTable(header, alignments, rows));
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
        index++;
      }
      const taskList = items.some((item) => /^\[[ xX]\]\s+/.test(item));
      html.push(`<ul${taskList ? ' class="taskList"' : ""}>${items.map((item) => {
        const task = item.match(/^\[([ xX])\]\s+(.+)$/);
        if (!task) return `<li>${formatInlineMarkdown(item)}</li>`;
        return `<li class="taskListItem"><input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""}><span>${formatInlineMarkdown(task[2])}</span></li>`;
      }).join("")}</ul>`);
      continue;
    }

    const orderedList = line.match(/^\s*(\d+)[.)]\s+/);
    if (orderedList) {
      const start = Number(orderedList[1]) || 1;
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        const item = lines[index].match(/^\s*(\d+)[.)]\s+(.+)$/);
        if (item) items.push({ value: Number(item[1]) || 1, text: item[2] });
        index++;
      }
      const startAttribute = start === 1 ? "" : ` start="${start}"`;
      html.push(`<ol${startAttribute}>${items.map((item) => `<li value="${item.value}">${formatInlineMarkdown(item.text)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index++;
    }
    html.push(`<p>${formatInlineMarkdown(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }

  return html.join("");
}

function renderCodeBlock(code, language = "") {
  const label = codeLanguageLabel(language);
  return `
    <figure class="codeBlockWrap">
      <figcaption class="codeBlockHeader">
        <span>${escapeHtml(label)}</span>
        <button class="codeCopyBtn" type="button" data-copy-code aria-label="Copy" title="Copy code">
          <svg class="copyIcon" viewBox="0 0 21 21" aria-hidden="true">
            <path d="M13.468 11.1216C13.468 10.4107 13.468 9.91717 13.4367 9.53369C13.4137 9.25191 13.3758 9.0622 13.3244 8.91846L13.2687 8.78858C13.1148 8.48652 12.8803 8.23344 12.593 8.05713L12.466 7.98584C12.308 7.90546 12.0963 7.84854 11.7209 7.81787C11.3374 7.78656 10.8439 7.78662 10.133 7.78662H7.29999C6.58895 7.78662 6.09562 7.78654 5.7121 7.81787C5.43015 7.84091 5.24064 7.87872 5.09686 7.93018L4.96698 7.98584C4.66487 8.13977 4.41184 8.37419 4.23554 8.66162L4.16522 8.78858C4.08477 8.94657 4.02794 9.15811 3.99725 9.53369C3.96594 9.91718 3.96503 10.4107 3.96503 11.1216V13.9546C3.96503 14.6656 3.96592 15.159 3.99725 15.5425C4.02796 15.9182 4.08471 16.1296 4.16522 16.2876L4.23554 16.4136C4.41185 16.7012 4.66472 16.9353 4.96698 17.0894L5.09686 17.146C5.24061 17.1974 5.43024 17.2343 5.7121 17.2573C6.09562 17.2887 6.58895 17.2896 7.29999 17.2896H10.133C10.8439 17.2896 11.3374 17.2886 11.7209 17.2573C12.0965 17.2266 12.308 17.1698 12.466 17.0894L12.593 17.019C12.8804 16.8427 13.1148 16.5897 13.2687 16.2876L13.3244 16.1577C13.3759 16.0139 13.4137 15.8244 13.4367 15.5425C13.468 15.159 13.468 14.6656 13.468 13.9546V11.1216ZM14.798 13.1196C15.2528 13.118 15.6011 13.1147 15.8879 13.0913C16.2634 13.0606 16.475 13.0038 16.633 12.9233L16.759 12.8521C17.0466 12.6757 17.2808 12.4228 17.4348 12.1206L17.4914 11.9907C17.5428 11.847 17.5797 11.6572 17.6027 11.3755C17.634 10.992 17.6349 10.4985 17.6349 9.7876V6.95459C17.6349 6.24355 17.6341 5.75022 17.6027 5.3667C17.5797 5.08484 17.5428 4.89522 17.4914 4.75147L17.4348 4.62158C17.2807 4.31933 17.0466 4.06645 16.759 3.89014L16.633 3.81982C16.475 3.73932 16.2636 3.68256 15.8879 3.65186C15.5044 3.62052 15.011 3.61963 14.3 3.61963H11.467C10.7561 3.61963 10.2626 3.62054 9.87909 3.65186C9.59738 3.67487 9.40759 3.71179 9.26386 3.76318L9.13397 3.81982C8.83175 3.97382 8.57885 4.20802 8.40253 4.49561L8.33124 4.62158C8.25079 4.77957 8.19396 4.99114 8.16327 5.3667C8.13984 5.65352 8.13561 6.00178 8.13397 6.45654H10.133C10.822 6.45654 11.3791 6.4559 11.8293 6.49268C12.2873 6.5301 12.6937 6.6093 13.0705 6.80127L13.2883 6.92334C13.7839 7.22739 14.1878 7.66313 14.4533 8.18408L14.5197 8.32666C14.6642 8.66318 14.7291 9.02433 14.7619 9.42529C14.7987 9.8755 14.798 10.4326 14.798 11.1216V13.1196ZM18.965 9.7876C18.965 10.4766 18.9657 11.0337 18.9289 11.4839C18.8961 11.8848 18.8311 12.246 18.6867 12.5825L18.6203 12.7251C18.3548 13.246 17.9509 13.6818 17.4553 13.9858L17.2365 14.1079C16.8599 14.2998 16.4541 14.3791 15.9963 14.4165C15.6592 14.444 15.2624 14.4481 14.7951 14.4497C14.7935 14.917 14.7894 15.3138 14.7619 15.6509C14.7292 16.0516 14.664 16.4122 14.5197 16.7485L14.4533 16.8911C14.1878 17.4122 13.7841 17.8487 13.2883 18.1528L13.0705 18.2749C12.6937 18.4669 12.2873 18.5461 11.8293 18.5835C11.3791 18.6203 10.822 18.6196 10.133 18.6196H7.29999C6.6109 18.6196 6.05394 18.6203 5.6037 18.5835C5.20305 18.5508 4.84233 18.4855 4.50604 18.3413L4.36347 18.2749C3.84243 18.0094 3.40584 17.6056 3.10175 17.1099L2.97968 16.8911C2.78787 16.5145 2.70849 16.1087 2.67108 15.6509C2.6343 15.2006 2.63495 14.6437 2.63495 13.9546V11.1216C2.63495 10.4326 2.63431 9.8755 2.67108 9.42529C2.7085 8.96729 2.78771 8.56084 2.97968 8.18408L3.10175 7.96631C3.40585 7.47049 3.84235 7.06679 4.36347 6.80127L4.50604 6.73486C4.84236 6.59059 5.20302 6.52542 5.6037 6.49268C5.9405 6.46516 6.33707 6.4601 6.80389 6.4585C6.8055 5.99167 6.81056 5.5951 6.83807 5.2583C6.87549 4.80047 6.95482 4.39471 7.14667 4.01807L7.26874 3.79932C7.5728 3.30371 8.00855 2.89973 8.52948 2.63428L8.67206 2.56787C9.00854 2.42345 9.36978 2.35844 9.77069 2.32568C10.2209 2.28891 10.778 2.28955 11.467 2.28955H14.3C14.9891 2.28955 15.546 2.2889 15.9963 2.32568C16.4541 2.3631 16.8599 2.44247 17.2365 2.63428L17.4553 2.75635C17.951 3.06044 18.3548 3.49703 18.6203 4.01807L18.6867 4.16065C18.8309 4.49694 18.8962 4.85765 18.9289 5.2583C18.9657 5.70854 18.965 6.2655 18.965 6.95459V9.7876Z"></path>
          </svg>
          <svg class="checkIcon" viewBox="0 0 17 17" aria-hidden="true">
            <path d="M12.8961 3.64101C13.1297 3.41418 13.4984 3.37523 13.7779 3.56581C14.0571 3.75635 14.1554 4.11331 14.0299 4.41347L13.9615 4.53847L7.71151 13.7045C7.59411 13.8767 7.4063 13.9877 7.19881 14.0072C6.99136 14.0267 6.78564 13.9533 6.63826 13.806L2.88826 10.056L2.79842 9.9457C2.6192 9.67407 2.64927 9.30496 2.88826 9.06581C3.12738 8.82669 3.49647 8.79676 3.76815 8.97597L3.8785 9.06581L7.03084 12.2182L12.8053 3.74941L12.8961 3.64101Z"></path>
          </svg>
        </button>
      </figcaption>
      <pre class="codeBlock" data-language="${escapeAttribute(label)}"><code>${escapeHtml(code)}</code></pre>
    </figure>
  `;
}

function codeLanguageLabel(language = "") {
  const value = String(language || "").trim().toLowerCase();
  if (!value || value === "txt" || value === "plain" || value === "plaintext") return "text";
  return value;
}

function markdownFenceStart(line) {
  const match = String(line || "").match(/^\s*(`{3,}|~{3,})\s*([^\s`~]+)?(?:\s+.*)?$/);
  if (!match) return null;
  return { marker: match[1][0], length: match[1].length, language: match[2] || "" };
}

function isMarkdownFenceEnd(line, fence) {
  const value = String(line || "").trim();
  return value.length >= fence.length && Array.from(value).every((character) => character === fence.marker);
}

function isMarkdownBlockStart(line) {
  return Boolean(markdownFenceStart(line))
    || /^(#{1,6})\s+/.test(line)
    || /^>\s?/.test(line)
    || /^\s*[-*+]\s+/.test(line)
    || /^\s*\d+[.)]\s+/.test(line)
    || /^[-*_]\s*[-*_]\s*[-*_]\s*$/.test(line.trim());
}

function isMarkdownTableStart(lines, index) {
  return index + 1 < lines.length
    && isMarkdownTableRow(lines[index])
    && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[index + 1]);
}

function isMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  return trimmed.includes("|") && !isMarkdownBlockStart(trimmed);
}

function splitMarkdownTableRow(line) {
  let value = String(line || "").trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const cells = [];
  let cell = "";
  let inCode = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && ["|", "\\", "`"].includes(value[index + 1])) {
      cell += value[index + 1];
      index += 1;
    } else if (character === "`") {
      inCode = !inCode;
      cell += character;
    } else if (character === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseMarkdownTableAlignments(separator) {
  return splitMarkdownTableRow(separator).map((cell) => {
    const value = cell.trim();
    if (value.startsWith(":") && value.endsWith(":")) return "center";
    if (value.endsWith(":")) return "right";
    return "left";
  });
}

function renderMarkdownTable(header, alignments, rows) {
  const width = header.length;
  const cell = (tag, value, index) => `<${tag} style="text-align:${alignments[index] || "left"}">${formatInlineMarkdown(value || "")}</${tag}>`;
  const head = `<thead><tr>${header.map((value, index) => cell("th", value, index)).join("")}</tr></thead>`;
  const body = rows.length
    ? `<tbody>${rows.map((row) => `<tr>${Array.from({ length: width }, (_, index) => cell("td", row[index], index)).join("")}</tr>`).join("")}</tbody>`
    : "";
  return `<div class="markdownTableScroll"><table>${head}${body}</table></div>`;
}

export function formatInlineMarkdown(text) {
  const placeholders = [];
  const reserve = (html) => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(html);
    return token;
  };

  let output = escapeHtml(text);
  output = output.replace(/`([^`]+)`/g, (_, code) => reserve(`<code class="inlineCode">${code}</code>`));
  output = output.replace(/\[([^\]]+)]\(([^)\s]+)\)/g, (_, label, target) => {
    if (/^(https?:|mailto:|#)/i.test(target)) {
      return reserve(`<a href="${escapeAttribute(target)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`);
    }
    const fileRef = parseFileRefTarget(target);
    if (fileRef) {
      const lineHtml = fileRef.line ? `<span class="fileRefLine"> (${escapeHtml(fileRef.line)})</span>` : "";
      return reserve(`<button type="button" class="fileRef" data-file-path="${escapeAttribute(target)}">${escapeHtml(fileRef.name)}${lineHtml}</button>`);
    }
    return reserve(`<a href="${escapeAttribute(target)}">${escapeHtml(label)}</a>`);
  });
  output = linkify(output);
  output = output
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  return output.replace(/\u0000(\d+)\u0000/g, (_, id) => placeholders[Number(id)] || "");
}

function parseFileRefTarget(target) {
  const value = String(target || "");
  const lineMatch = value.match(/^(.*?)(?::(\d+(?:-\d+)?))$/);
  const base = lineMatch ? lineMatch[1] : value;
  const line = lineMatch ? `line ${lineMatch[2]}` : "";
  if (!isLocalFilePath(base)) return null;
  // 与扩展一致：只显示路径最后一段文件名，完整路径留在气泡里。
  const name = String(base).split(/[\\/]/).pop() || base;
  return { name, line };
}

function isLocalFilePath(value) {
  if (!value) return false;
  // 非盘符的协议（http、mailto、data 等）不算本地文件。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(value) && !/^[a-zA-Z]:[\\/]/.test(value)) return false;
  return /[\\/]/.test(value) || /^[a-zA-Z]:/.test(value);
}
