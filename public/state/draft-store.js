/**
 * Owns browser persistence for composer drafts and recoverable submissions.
 * The page keeps UI state; this module keeps the durable storage contract.
 */
export function createDraftStore({
  draftByThread,
  getComposerRevision,
  getCurrentDraftKey,
  getPromptText,
  getDraftAnnotations,
  isCurrentDraftKey,
  applyDraft,
  getActiveSubmissionRequestId,
  onError = () => {},
  createClientId,
  isDisplayableImageUrl,
  estimateDataUrlBytes,
  limits = {}
} = {}) {
  if (!(draftByThread instanceof Map)) throw new TypeError("draftByThread must be a Map");
  if (typeof createClientId !== "function") throw new TypeError("createClientId is required");
  if (typeof isDisplayableImageUrl !== "function") throw new TypeError("isDisplayableImageUrl is required");
  if (typeof estimateDataUrlBytes !== "function") throw new TypeError("estimateDataUrlBytes is required");

  const {
    databaseName = "codex-phone-ui",
    draftStoreName = "drafts",
    submissionStoreName = "submissions",
    activeSubmissionKey = "active",
    maxDraftImages = 6,
    maxImageBytes = 8 * 1024 * 1024,
    maxDraftImageTotalBytes = 12 * 1024 * 1024,
    persistedSubmissionMaxAgeMs = 4 * 60 * 1000
  } = limits;

  let databasePromise = null;
  let openedDatabase = null;
  const persistedDraftImageKeys = new Map();
  const loadedPersistedDraftKeys = new Set();
  const hydrationPromises = new Map();
  const persistenceRevisions = new Map();

  function reportError(error) {
    onError(error instanceof Error ? error : new Error(String(error || "draft storage failed")));
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const request = globalThis.indexedDB.open(databaseName, 2);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("open draft database timed out"));
      }, 3000);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(draftStoreName)) database.createObjectStore(draftStoreName, { keyPath: "key" });
        if (!database.objectStoreNames.contains(submissionStoreName)) database.createObjectStore(submissionStoreName, { keyPath: "key" });
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        openedDatabase = request.result;
        request.result.onversionchange = () => {
          request.result.close();
          openedDatabase = null;
          databasePromise = null;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(request.error || new Error("open draft database failed"));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("open draft database blocked"));
      };
    });
    databasePromise.catch(() => {
      databasePromise = null;
    });
    return databasePromise;
  }

  async function hydratePersistedDrafts() {
    const database = await openDatabase();
    const restoredSubmission = await new Promise((resolve, reject) => {
      const transaction = database.transaction(submissionStoreName, "readonly");
      const request = transaction.objectStore(submissionStoreName).get(activeSubmissionKey);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("read submission failed"));
    });
    return { restoredSubmission };
  }

  async function hydratePersistedDraftKey(key, expectedRevision) {
    if (!key || loadedPersistedDraftKeys.has(key)) return;
    let hydration = hydrationPromises.get(key);
    if (!hydration) {
      const startedAtRevision = Number(getComposerRevision?.() || 0);
      hydration = (async () => {
        const database = await openDatabase();
        const record = await new Promise((resolve, reject) => {
          const transaction = database.transaction(draftStoreName, "readonly");
          const request = transaction.objectStore(draftStoreName).get(key);
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => reject(request.error || new Error("read draft failed"));
        });
        return { record, startedAtRevision };
      })();
      hydrationPromises.set(key, hydration);
    }
    try {
      const { record, startedAtRevision } = await hydration;
      if (!loadedPersistedDraftKeys.has(key)) {
        if (record) {
          const hasLocalDraft = draftByThread.has(key);
          const currentDraft = draftByThread.get(key) || { text: "", images: [] };
          const editingCurrentDraft = isCurrentDraftKey?.(key) && Number(getComposerRevision?.() || 0) !== startedAtRevision;
          const persistedImages = normalizeDraftImages(record.images);
          const currentImages = normalizeDraftImages(currentDraft.images);
          const images = [
            ...persistedImages,
            ...currentImages.filter((image) => !persistedImages.some((existing) => existing.id === image.id || existing.url === image.url))
          ];
          const nextDraft = {
            submissionRequestId: editingCurrentDraft ? undefined : (hasLocalDraft ? currentDraft.submissionRequestId : record.submissionRequestId),
            text: editingCurrentDraft
              ? String(getPromptText?.() || "")
              : String(hasLocalDraft ? currentDraft.text ?? "" : record.text ?? ""),
            images,
            annotations: structuredClone(editingCurrentDraft ? (getDraftAnnotations?.() || []) : currentDraft.annotations ?? record.annotations ?? [])
          };
          draftByThread.set(key, nextDraft);
          persistedDraftImageKeys.set(key, draftRecordPersistenceKey(record));
        }
        loadedPersistedDraftKeys.add(key);
      }
      const loadedDraft = draftByThread.get(key);
      if (loadedDraft && isCurrentDraftKey?.(key) && Number(getComposerRevision?.() || 0) === Number(expectedRevision)) applyDraft?.(loadedDraft);
    } catch (error) {
      reportError(error);
    } finally {
      if (hydrationPromises.get(key) === hydration) hydrationPromises.delete(key);
    }
  }

  function persistDraft(key, draft) {
    const persistenceRevision = nextPersistenceRevision(key);
    const images = normalizeDraftImages(draft.images);
    const effectiveDraft = { ...draft, images };
    const imageKey = draftRecordPersistenceKey(effectiveDraft);
    loadedPersistedDraftKeys.add(key);
    draftByThread.set(key, effectiveDraft);
    return withDatabase((database) => {
      if (persistenceRevisions.get(key) !== persistenceRevision) return;
      if (persistedDraftImageKeys.get(key) === imageKey) return;
      persistedDraftImageKeys.delete(key);
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(draftStoreName, "readwrite");
        transaction.objectStore(draftStoreName).put({
          key,
          text: String(effectiveDraft.text || ""),
          images: images.map((image) => ({ ...image })),
          annotations: structuredClone(effectiveDraft.annotations || []),
          submissionRequestId: effectiveDraft.submissionRequestId,
          updatedAt: Date.now()
        });
        transaction.oncomplete = () => {
          if (persistenceRevisions.get(key) === persistenceRevision) persistedDraftImageKeys.set(key, imageKey);
          resolve();
        };
        transaction.onerror = () => reject(transaction.error || new Error("save draft failed"));
        transaction.onabort = () => reject(transaction.error || new Error("save draft aborted"));
        transaction.commit();
      });
    });
  }

  function deleteDraft(key) {
    draftByThread.delete(key);
    deletePersistedDraft(key);
  }

  function deletePersistedDraft(key) {
    const persistenceRevision = nextPersistenceRevision(key);
    persistedDraftImageKeys.delete(key);
    loadedPersistedDraftKeys.add(key);
    return withDatabase((database) => {
      if (persistenceRevisions.get(key) !== persistenceRevision) return;
      draftByThread.delete(key);
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(draftStoreName, "readwrite");
        transaction.objectStore(draftStoreName).delete(key);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("delete draft failed"));
        transaction.onabort = () => reject(transaction.error || new Error("delete draft aborted"));
        transaction.commit();
      });
    });
  }

  function nextPersistenceRevision(key) {
    const revision = Number(persistenceRevisions.get(key) || 0) + 1;
    persistenceRevisions.set(key, revision);
    return revision;
  }

  function withDatabase(operation) {
    // Enqueue native transactions during the input event itself. Waiting in a
    // page-owned Promise queue can lose the latest edit when navigation begins.
    try {
      return (openedDatabase ? Promise.resolve(operation(openedDatabase)) : openDatabase().then(operation)).catch(reportError);
    } catch (error) {
      reportError(error);
      return Promise.resolve();
    }
  }

  function draftImagesPersistenceKey(images) {
    return (Array.isArray(images) ? images : []).map((image) => `${image.id || ""}:${image.url || ""}`).join("|");
  }

  function draftContentPersistenceKey(draft) {
    return JSON.stringify([draft.text || "", draftImagesPersistenceKey(draft.images), draft.annotations || []]);
  }

  function draftRecordPersistenceKey(draft) {
    return JSON.stringify([draftContentPersistenceKey(draft), draft.submissionRequestId || ""]);
  }

  function normalizeDraftImages(images) {
    const normalized = [];
    let totalBytes = 0;
    for (const image of Array.isArray(images) ? images.slice(0, maxDraftImages) : []) {
      const url = String(image?.url || "");
      if (!isDisplayableImageUrl(url)) continue;
      const size = Math.max(0, Number(image?.size || estimateDataUrlBytes(url)) || 0);
      if (size > maxImageBytes || totalBytes + size > maxDraftImageTotalBytes) continue;
      totalBytes += size;
      normalized.push({
        id: String(image?.id || createClientId()),
        name: String(image?.name || "image"),
        type: String(image?.type || "image/png"),
        size,
        url
      });
    }
    return normalized;
  }

  function persistSubmission(submission) {
    return openDatabase().then((database) => new Promise((resolve, reject) => {
      const transaction = database.transaction(submissionStoreName, "readwrite");
      transaction.objectStore(submissionStoreName).put({
        key: activeSubmissionKey,
        savedAt: Date.now(),
        submission
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("save submission failed"));
      transaction.onabort = () => reject(transaction.error || new Error("save submission aborted"));
    })).catch(reportError);
  }

  function deletePersistedSubmission(requestId = "") {
    const activeRequestId = getActiveSubmissionRequestId?.() || "";
    if (requestId && activeRequestId && requestId !== activeRequestId) return Promise.resolve();
    return openDatabase().then((database) => new Promise((resolve, reject) => {
      const transaction = database.transaction(submissionStoreName, "readwrite");
      transaction.objectStore(submissionStoreName).delete(activeSubmissionKey);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("delete submission failed"));
      transaction.onabort = () => reject(transaction.error || new Error("delete submission aborted"));
    })).catch(reportError);
  }

  function normalizePersistedSubmission(record) {
    const submission = record?.submission;
    if (!submission?.payload?.requestId || !["message:send", "message:edit"].includes(submission.payload.type)) return null;
    if (Date.now() - Number(record.savedAt || 0) > persistedSubmissionMaxAgeMs) return null;
    if (!Array.isArray(submission.payload.images) || !Array.isArray(submission.imageSnapshot)) return null;
    if (submission.payload.type === "message:edit" && (!submission.payload.turnId || !submission.threadId)) return null;
    const payloadImages = submission.payload.type === "message:edit"
      ? []
      : normalizeDraftImages(submission.payload.images).map(({ id, ...image }) => image);
    const imageSnapshot = submission.imageSnapshot
      .filter((image) => image && typeof image.url === "string")
      .slice(0, maxDraftImages)
      .map((image) => ({ id: String(image.id || ""), url: image.url }));
    return {
      ...submission,
      payload: { ...submission.payload, images: payloadImages },
      threadId: String(submission.threadId || ""),
      textSnapshot: String(submission.textSnapshot || ""),
      imageSnapshot
    };
  }

  return {
    hydratePersistedDrafts,
    hydratePersistedDraftKey,
    persistDraft,
    deleteDraft,
    deletePersistedDraft,
    normalizeDraftImages,
    persistSubmission,
    deletePersistedSubmission,
    normalizePersistedSubmission,
    draftContentPersistenceKey
  };
}
