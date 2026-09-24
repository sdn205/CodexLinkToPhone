function commandTerminalIconSvg() {
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.19629 7.86231C6.42357 7.63534 6.7752 7.60692 7.0332 7.77734L7.1377 7.86231L8.80371 9.5293C9.06329 9.78889 9.06307 10.21 8.80371 10.4697L7.1377 12.1367C6.878 12.3964 6.45599 12.3964 6.19629 12.1367C5.93686 11.8771 5.93697 11.456 6.19629 11.1963L7.39258 9.99902L6.19629 8.80371L6.11133 8.69922C5.94087 8.4411 5.96904 8.08955 6.19629 7.86231Z" fill="currentColor"/><path d="M13.4668 11.0156C13.7699 11.0776 13.998 11.3456 13.998 11.667C13.9979 11.9883 13.7698 12.2564 13.4668 12.3184L13.333 12.332H10.833C10.466 12.3319 10.1682 12.034 10.168 11.667C10.168 11.2998 10.4659 11.0021 10.833 11.002H13.333L13.4668 11.0156Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M12.6602 2.66504C13.3492 2.66504 13.9062 2.66439 14.3564 2.70117C14.8142 2.73859 15.2201 2.81796 15.5967 3.00977C16.1922 3.31321 16.677 3.79805 16.9805 4.39356C17.1722 4.77014 17.2517 5.17604 17.2891 5.63379C17.3258 6.08402 17.3252 6.64102 17.3252 7.33008V12.6602C17.3252 13.3492 17.3258 13.9062 17.2891 14.3564C17.2516 14.8142 17.1723 15.2201 16.9805 15.5967C16.677 16.1922 16.1922 16.677 15.5967 16.9805C15.2201 17.1722 14.8142 17.2516 14.3564 17.2891C13.9062 17.3258 13.3492 17.3252 12.6602 17.3252H7.33008C6.64102 17.3252 6.08402 17.3258 5.63379 17.2891C5.17604 17.2517 4.77014 17.1722 4.39356 16.9805C3.79805 16.677 3.31321 16.1922 3.00977 15.5967C2.81796 15.2202 2.73858 14.8142 2.70117 14.3564C2.66439 13.9062 2.66504 13.3492 2.66504 12.6602V7.33008C2.66504 6.64102 2.66439 6.08402 2.70117 5.63379C2.73858 5.17601 2.81797 4.77016 3.00977 4.39356C3.31321 3.79802 3.79802 3.31321 4.39356 3.00977C4.77016 2.81797 5.17604 2.73858 5.63379 2.70117C6.08402 2.66439 6.64102 2.66504 7.33008 2.66504H12.6602ZM7.33008 3.99512C6.61907 3.99512 6.1257 3.99601 5.74219 4.02734C5.3665 4.05804 5.15508 4.11481 4.99707 4.19531C4.65183 4.37124 4.37124 4.65183 4.19531 4.99707C4.11481 5.15508 4.05805 5.3665 4.02734 5.74219C3.99601 6.1257 3.99512 6.61908 3.99512 7.33008V12.6602C3.99512 13.3711 3.99601 13.8646 4.02734 14.248C4.05805 14.6237 4.11481 14.8352 4.19531 14.9932C4.37124 15.3384 4.65186 15.619 4.99707 15.7949C5.15507 15.8754 5.36654 15.9322 5.74219 15.9629C6.1257 15.9942 6.61908 15.9951 7.33008 15.9951H12.6602C13.3711 15.9951 13.8646 15.9942 14.248 15.9629C14.6237 15.9322 14.8352 15.8754 14.9932 15.7949C15.3384 15.619 15.619 15.3384 15.7949 14.9932C15.8754 14.8354 15.9322 15.9322 15.9629 14.248C15.9942 13.8646 15.9951 13.3711 15.9951 12.6602V7.33008C15.9951 6.61908 15.9942 6.1257 15.9629 5.74219C15.9322 5.36654 15.8754 5.15507 15.7949 4.99707C15.619 4.65186 15.3384 4.37124 14.9932 4.19531C14.8352 4.11481 14.6237 4.05805 14.248 4.02734C13.8646 3.99601 13.3711 3.99512 12.6602 3.99512H7.33008Z" fill="currentColor"/></svg>`;
}

function commandChevronIconSvg() {
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.52925 3.7793 7.44429 3.86426c-.22727.22727-.25547.57878-.08496.83691l.08496.10449L12.8085 10l-5.27925 5.2793-.08496.10449c-.17051.25813-.14231.60964.08496.83691.2597.2597.6817.2597.9414 0l5.75-5.75c.2597-.2597.2597-.6817 0-.9414l-5.75-5.75c-.2597-.2597-.6817-.2597-.9414 0Z" fill="currentColor"/></svg>`;
}

export function createCommandGroupRenderer({
  expandedMessages,
  pendingToolScrollRestore,
  escapeHtml,
  toolStatusKey,
  toolTitle,
  toolOutput,
  messageNodeRenderKey,
  canStreamInPlace,
  updateStreamingMessageNode,
  onRender = () => {}
} = {}) {
  if (!(expandedMessages instanceof Set)) throw new TypeError("expandedMessages must be a Set");
  if (!(pendingToolScrollRestore instanceof Map)) throw new TypeError("pendingToolScrollRestore must be a Map");

  function renderToolMessage(message) {
    const expanded = expandedMessages.has(message.id);
    const wrap = document.createElement("div");
    const statusKey = toolStatusKey(message);
    wrap.className = `toolBlock ${statusKey}${expanded ? " expanded" : ""}`;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "cmdRow";
    button.setAttribute("aria-expanded", String(expanded));
    button.innerHTML = `
      <span class="cmdChevron">▸</span>
      <span class="cmdState">${escapeHtml(statusKey === "running" ? "正在运行命令" : "已运行")}</span>
      <code class="cmdLabel">${escapeHtml(toolTitle(message))}</code>
    `;
    button.addEventListener("click", () => {
      const nextExpanded = !expandedMessages.has(message.id);
      if (nextExpanded) expandedMessages.add(message.id);
      else expandedMessages.delete(message.id);
      wrap.classList.toggle("expanded", nextExpanded);
      button.setAttribute("aria-expanded", String(nextExpanded));
    });
    wrap.append(button);

    const output = document.createElement("div");
    output.className = "cmdOutputWrap";
    output.innerHTML = `<pre>${escapeHtml(toolOutput(message))}</pre>`;
    if (message.textTruncated) {
      const loadButton = document.createElement("button");
      loadButton.type = "button";
      loadButton.className = "cmdLoadFull";
      loadButton.dataset.loadMessageDetail = message.id;
      loadButton.textContent = "查看完整输出";
      output.append(loadButton);
    }
    wrap.append(output);
    return wrap;
  }

  function render(group, existingNodes = new Map()) {
    const expanded = expandedMessages.has(group.id);
    const renderKey = key(group);
    const existing = existingNodes.get(group.id);
    if (existing?.dataset.renderKey === renderKey) return existing;

    const node = existing || document.createElement("article");
    node.className = `message tool commandGroupMessage${expanded ? " expanded" : ""}`;
    node.dataset.commandGroupId = group.id;

    let row = node.querySelector(".commandGroupRow");
    let body = node.querySelector(".commandGroupBody");
    if (!row || !body) {
      node.replaceChildren();
      row = document.createElement("button");
      row.type = "button";
      row.className = "commandGroupRow";
      row.innerHTML = `
        <span class="commandGroupIcon" aria-hidden="true">${commandTerminalIconSvg()}</span>
        <span class="commandGroupLabel">运行了命令</span>
        <span class="commandGroupChevron" aria-hidden="true">${commandChevronIconSvg()}</span>
      `;
      body = document.createElement("div");
      body.className = "commandGroupBody";
      row.addEventListener("click", () => {
        const nextExpanded = !expandedMessages.has(group.id);
        if (nextExpanded) expandedMessages.add(group.id);
        else expandedMessages.delete(group.id);
        node.classList.toggle("expanded", nextExpanded);
        row.setAttribute("aria-expanded", String(nextExpanded));
        body.hidden = !nextExpanded;
      });
      node.append(row, body);
    }

    row.setAttribute("aria-expanded", String(expanded));
    body.hidden = !expanded;
    renderItems(group.messages, body);
    node.dataset.renderKey = renderKey;
    return node;
  }

  function renderItems(messages, body) {
    const existing = new Map();
    for (const child of body.children) {
      if (child.dataset.messageId) existing.set(child.dataset.messageId, child);
    }
    const desired = messages.map((message) => renderMessageNode(message, existing.get(message.id)));
    let current = body.firstElementChild;
    for (const child of desired) {
      if (current === child) {
        current = current.nextElementSibling;
        continue;
      }
      const pre = child.querySelector(".cmdOutputWrap pre");
      const savedScrollTop = pre?.scrollTop;
      body.insertBefore(child, current);
      if (pre && savedScrollTop !== undefined) pre.scrollTop = savedScrollTop;
    }
    while (current) {
      const next = current.nextElementSibling;
      current.remove();
      current = next;
    }
  }

  function renderMessageNode(message, existing) {
    const renderKey = messageNodeRenderKey(message);
    if (existing?.dataset.renderKey === renderKey) return existing;
    const existingPre = existing?.querySelector(".cmdOutputWrap pre");
    if (existingPre && !pendingToolScrollRestore.has(message.id)) pendingToolScrollRestore.set(message.id, existingPre.scrollTop);
    if (existing && canStreamInPlace(existing, message)) {
      updateStreamingMessageNode(existing, message);
      existing.dataset.renderKey = renderKey;
      return existing;
    }
    const node = renderToolMessage(message);
    node.dataset.messageId = message.id;
    node.dataset.renderKey = renderKey;
    return node;
  }

  function key(group) {
    return `${group.id}:${expandedMessages.has(group.id) ? 1 : 0}:${group.messages.map(messageNodeRenderKey).join("|")}`;
  }

  function toggleExpanded(id) {
    if (!id) return;
    if (expandedMessages.has(id)) expandedMessages.delete(id);
    else expandedMessages.add(id);
    onRender();
  }

  return {
    render,
    renderToolMessage,
    renderMessageNode,
    renderKey: key,
    toggleExpanded
  };
}
