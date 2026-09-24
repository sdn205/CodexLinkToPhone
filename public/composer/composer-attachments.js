export function estimateDataUrlBytes(value) {
  const source = String(value || "");
  const comma = source.indexOf(",");
  if (comma < 0) return 0;
  return Math.floor((source.length - comma - 1) * 0.75);
}

export function createComposerAttachments({
  imageInput,
  uploadButton,
  attachmentTray,
  imageViewer,
  imageViewerImage,
  getImages,
  setImages,
  getCurrentDraftKey,
  snapshotDraft,
  getDraftForKey,
  setDraftForKey,
  persistDraft,
  saveDraft,
  getPendingReads,
  setPendingReads,
  createClientId,
  escapeAttribute,
  toast,
  renderComposerState,
  updateViewportSizing,
  releasePressedButtons,
  maxImages = 6,
  maxImageBytes = 8 * 1024 * 1024,
  maxTotalBytes = 12 * 1024 * 1024
} = {}) {
  if (!imageInput || !uploadButton || !attachmentTray || !imageViewer || !imageViewerImage) {
    throw new TypeError("attachment elements are required");
  }
  if (typeof getImages !== "function" || typeof setImages !== "function") throw new TypeError("image state accessors are required");
  if (typeof createClientId !== "function") throw new TypeError("createClientId is required");

  function supportedMimeType(file) {
    const type = String(file?.type || "").trim().toLowerCase();
    const normalizedTypes = new Map([
      ["image/png", "image/png"],
      ["image/jpeg", "image/jpeg"],
      ["image/jpg", "image/jpeg"],
      ["image/webp", "image/webp"],
      ["image/gif", "image/gif"],
      ["image/svg+xml", "image/svg+xml"]
    ]);
    if (normalizedTypes.has(type)) return normalizedTypes.get(type);
    if (type && type !== "application/octet-stream") return "";
    const extension = String(file?.name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
    return {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml"
    }[extension] || "";
  }

  function normalizeDataUrl(value, mimeType) {
    const dataUrl = String(value || "");
    if (/^data:image\//i.test(dataUrl)) return dataUrl;
    if (!mimeType || !/^data:[^,]*;base64,/i.test(dataUrl)) return dataUrl;
    return dataUrl.replace(/^data:[^,]*;base64,/i, `data:${mimeType};base64,`);
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        try { reader.abort(); } catch {}
        finish(reject, new Error("图片读取超时"));
      }, 20000);
      reader.onload = () => finish(resolve, String(reader.result || ""));
      reader.onerror = () => finish(reject, reader.error || new Error("read failed"));
      reader.onabort = () => finish(reject, new Error("图片读取已取消"));
      reader.readAsDataURL(file);
    });
  }

  function setPendingReadDelta(delta) {
    setPendingReads(Math.max(0, Number(getPendingReads?.() || 0) + delta));
    renderComposerState?.();
  }

  async function addFiles(files, contextKey = getCurrentDraftKey()) {
    const allFiles = Array.from(files || []);
    const selected = allFiles.filter((file) => supportedMimeType(file));
    const unsupportedCount = allFiles.length - selected.length;
    imageInput.value = "";
    if (unsupportedCount) toast?.(`有 ${unsupportedCount} 个普通文件未添加；当前手机协议只支持图片`, { tone: "warning", duration: 6000 });
    if (!selected.length) return;

    const existingDraft = contextKey === getCurrentDraftKey()
      ? snapshotDraft()
      : getDraftForKey?.(contextKey) || { text: "", images: [] };
    const workingImages = (existingDraft.images || []).map((image) => ({ ...image }));
    const availableSlots = Math.max(0, maxImages - workingImages.length);
    const filesToRead = selected.slice(0, availableSlots);
    if (selected.length > availableSlots) {
      toast?.(`最多添加 ${maxImages} 张图片，已忽略 ${selected.length - availableSlots} 张`, { tone: "warning" });
    }
    if (!filesToRead.length) return;

    setPendingReadDelta(filesToRead.length);
    let totalBytes = workingImages.reduce((sum, image) => sum + Number(image.size || estimateDataUrlBytes(image.url)), 0);
    for (const file of filesToRead) {
      try {
        if (file.size > maxImageBytes) throw new Error("图片过大，单张不能超过 8MB");
        if (totalBytes + file.size > maxTotalBytes) throw new Error("图片总量不能超过 12MB");
        const mimeType = supportedMimeType(file);
        const dataUrl = normalizeDataUrl(await readAsDataUrl(file), mimeType);
        if (!/^data:image\//i.test(dataUrl)) throw new Error("图片格式无法识别");
        workingImages.push({
          id: createClientId(),
          name: file.name || "image",
          type: mimeType,
          size: file.size,
          url: dataUrl
        });
        totalBytes += file.size;
      } catch (error) {
        toast?.(error?.message || "读取图片失败", { tone: "error" });
      } finally {
        setPendingReadDelta(-1);
      }
    }

    const latestDraft = getDraftForKey?.(contextKey) || existingDraft;
    const currentDraft = contextKey === getCurrentDraftKey() ? snapshotDraft() : latestDraft;
    const nextDraft = {
      text: String(currentDraft.text || ""),
      images: workingImages,
      annotations: structuredClone(currentDraft.annotations || [])
    };
    setDraftForKey?.(contextKey, nextDraft);
    setPendingReadDelta(1);
    try {
      await persistDraft?.(contextKey, nextDraft);
    } finally {
      setPendingReadDelta(-1);
    }
    const storedDraft = getDraftForKey?.(contextKey) || nextDraft;
    if (contextKey === getCurrentDraftKey()) {
      setImages(storedDraft.images || workingImages);
      renderTray();
    } else {
      toast?.("图片已保存在原会话草稿中", { tone: "warning" });
    }
    renderComposerState?.();
    updateViewportSizing?.();
  }

  function resetFilePickerState({ clearInput = false } = {}) {
    if (clearInput) imageInput.value = "";
    imageInput.blur();
    uploadButton.blur();
    releasePressedButtons?.();
    updateViewportSizing?.();
  }

  function renderTray() {
    attachmentTray.replaceChildren();
    for (const image of getImages()) {
      const item = document.createElement("div");
      item.className = "attachmentItem";
      item.innerHTML = `
        <button class="attachmentPreview" type="button" aria-label="查看图片">
          <img src="${escapeAttribute(image.url)}" alt="${escapeAttribute(image.name || "图片")}" />
        </button>
        <button class="attachmentRemove" type="button" aria-label="移除图片">×</button>
      `;
      item.querySelector(".attachmentPreview").addEventListener("click", () => openViewer(image.url));
      item.querySelector(".attachmentRemove").addEventListener("click", () => {
        setImages(getImages().filter((entry) => entry.id !== image.id));
        renderTray();
        saveDraft?.();
        renderComposerState?.();
        updateViewportSizing?.();
      });
      attachmentTray.append(item);
    }
  }

  function openViewer(url) {
    imageViewer.classList.remove("loadFailed");
    imageViewerImage.onerror = () => {
      imageViewer.classList.add("loadFailed");
      toast?.("图片加载失败", { tone: "error" });
    };
    imageViewerImage.src = url;
    imageViewer.classList.add("open");
    imageViewer.inert = false;
    imageViewer.setAttribute("aria-hidden", "false");
  }

  function closeViewer() {
    imageViewer.classList.remove("open");
    imageViewer.setAttribute("aria-hidden", "true");
    imageViewer.inert = true;
    imageViewerImage.removeAttribute("src");
    imageViewerImage.onerror = null;
    imageViewer.classList.remove("loadFailed");
  }

  return {
    addFiles,
    supportedMimeType,
    normalizeDataUrl,
    estimateDataUrlBytes,
    readAsDataUrl,
    resetFilePickerState,
    renderTray,
    openViewer,
    closeViewer
  };
}
