import { escapeAttribute, escapeHtml } from "./shared/text-utils.js";
import { formatInlineMarkdown } from "./shared/markdown.js";
import { reducePhoneState } from "./state/phone-state.js";
import { createMessageDetails } from "./state/message-details.js";
import { createSubmissionController } from "./composer/submission-controller.js";
import { createMessagePresentation } from "./conversation/message-presentation.js";
import { createThreadListUI } from "./navigation/thread-list-ui.js";
import { encodeResponseAnnotations, decodeResponseAnnotations } from "./overlays/response-annotations.js";
import { createResponseAnnotationUI } from "./overlays/response-annotation-ui.js";
import { createStreamDomUpdater } from "./transport/stream-dom.js";
import { createPhoneConnection } from "./transport/phone-connection.js";
import { createDraftStore } from "./state/draft-store.js";
import { createMessageScrollController } from "./conversation/message-scroll.js";
import { createComposerAttachments, estimateDataUrlBytes } from "./composer/composer-attachments.js";
import { createClientId } from "./shared/client-id.js";
import { createCommandGroupRenderer } from "./conversation/command-group.js";
import { createMessageListRenderer } from "./conversation/message-list.js";
import { createComposerControls } from "./composer/composer-controls.js";
import { createApprovalUI } from "./overlays/approval-ui.js";
import { createThinkingShimmer } from "./conversation/thinking-shimmer.js";
import { createDiffRenderer } from "./conversation/diff-renderer.js";
import { createAboveComposer } from "./conversation/above-composer.js";
import { createActivityRenderer, shieldIconSvg } from "./conversation/activity-renderer.js";
import { createConversationTimeline } from "./conversation/conversation-timeline.js";
import { createMessageRenderer } from "./conversation/message-renderer.js";
import { createMessageEditor } from "./composer/message-editor.js";
import { createThreadNavigation } from "./navigation/thread-navigation.js";

const tokenFromQuery = new URLSearchParams(location.search).get("token") || "";
const STREAM_PROTOCOL_VERSION = 1;
let token = tokenFromQuery || safeLocalStorageGet("codex-phone-token") || "";
let state = null;
const {
  messageThreadId, messageTurnId, isAboveComposerTurnDiff,
  systemActivityLabel, systemActivityDetail, isUnknownCurrentActivity,
  summarizeFileChanges, fileChangesForMessage, unifiedDiffForMessage,
  displayFilePath, displayDiffFileName,
  planStepsForMessage, imagesForMessage, imageSignature, isDisplayableImageUrl,
  itemField, messagePhase, messageIsInProgress, activityStatusKey, activityStatusLabel,
  dynamicToolName, dynamicToolContentItems, dynamicToolOutput, collabActionLabel,
  agentStateLabel, agentStateClass, shortAgentId, agentPathDisplay, formatStructuredValue,
  stringifyForDisplay, formatDuration, generatedImageSources, imagePathToUrl,
  imageGenerationStatusLabel, reviewStateLabel, isTimelineRowsTurnDiff,
  isCompletedTurnDiffCard, displayTextForMessage, cleanDisplayText,
  isToolLike, toolTitle, toolOutput, toolStatusKey, roleLabel
} = createMessagePresentation({ getState: () => state, getToken: () => token, formatElapsed });
let reconnectThreadTimer = null;
let fullStateSeenGeneration = -1;
let stateResponseRevision = 0;
let preferredReconnectThreadId = "";
let preferredReconnectNewThread = false;
let reconnectOpeningThreadId = "";
let reconnectOpenRequestId = "";
let reconnectOpenConfirmed = false;
let awaitingFullState = false;
let visibilitySeq = 0;
let fullStateWatchTimer = null;
let awaitingSocketState = true;
let renderScheduled = false;
let viewportFrame = null;
let viewportKeepBottom = false;
let primaryInputKeyboardBottom = null;
let threadSearchQuery = "";
let lastMessageKey = "";
let draftImages = [];
let draftAnnotations = [];
let lastRenderedThreadId = "";
let earlierMessagesScrollAnchor = null;
let pendingEarlierMessages = null;
let pendingImageReads = 0;
let pendingApprovalId = "";
let approvalTimer = null;
let interruptPending = false;
let interruptTimer = null;
let pendingInterruptPlanKey = "";
let pendingSettings = null;
let settingsTimer = null;
let optimisticThreadId = null;
let optimisticThreadContext = null;
let optimisticThreadTimer = null;
// 会话切换期间保留最近一次已知列表，等待服务端权威状态到达。
const threadMessagesCache = new Map();
let composerEditRevision = 0;
let composerDraftThreadId = "";
let suppressNextThreadDraftSave = false;
let draftHydrationComplete = false;

const SUBMISSION_TIMEOUT_MS = 10000;
const PASSIVE_OPERATION_TIMEOUT_MS = 15000;
const MAX_DRAFT_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DRAFT_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
const EMPTY_THREAD_DRAFT_KEY = "__new_thread__";
const SCROLL_STORAGE_KEY = "codex-phone-thread-scroll-v1";
const SIDEBAR_HISTORY_STATE_KEY = "__codexPhoneSidebarOpen";

const phoneConnection = createPhoneConnection({
  getUrl: () => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}&streamProtocol=${STREAM_PROTOCOL_VERSION}`;
  },
  isVisible: () => document.visibilityState === "visible",
  getStateRevision: () => stateResponseRevision,
  getVisibilitySeq: () => visibilitySeq,
  requestFullState: () => requestFullState(),
  onConnecting: handleSocketConnecting,
  onOpen: handleSocketOpen,
  onMessage: handlePhonePayload,
  onClose: handleSocketClose,
  onAuthFailure: () => {
    toast("连接口令无效，请重新输入", { tone: "error", duration: 0, id: "auth-error" });
    openTokenDialog();
  },
  onRepeatedFailure: () => toast("连接连续失败，请检查服务或连接口令", { tone: "error", duration: 0, id: "connection-failures" }),
  onHealthy: () => dismissToast("connection-failures"),
  onProtocolError: () => toast("收到无法解析的同步数据，正在重新同步", { tone: "error", duration: 5000 }),
  onTransportError: () => updateComposerState()
});

const expandedMessages = new Set();
const draftByThread = new Map();
const scrollByThread = new Map(Object.entries(safeJsonObject(safeSessionStorageGet(SCROLL_STORAGE_KEY)))
  .filter(([, value]) => value && typeof value === "object" && !Array.isArray(value)));
const pendingToolScrollRestore = new Map();
let pendingScrollRestore = null;
const messageDetails = createMessageDetails({
  send,
  createRequestId: createClientId,
  onChange: () => {
    if (state) state = messageDetails.projectState(state);
    cacheCurrentThreadMessages();
    resetRenderCache();
    scheduleRender();
  },
  onError: (message) => toast(message, { tone: "error", duration: 3000 })
});

const elements = {
  threadTitle: document.querySelector("#threadTitle"),
  threadList: document.querySelector("#threadList"),
  threadSearchInput: document.querySelector("#threadSearchInput"),
  threadMenuBtn: document.querySelector("#threadMenuBtn"),
  topbar: document.querySelector(".topbar"),
  messages: document.querySelector("#messages"),
  scrollBottomBtn: document.querySelector("#scrollBottomBtn"),
  aboveComposer: document.querySelector("#aboveComposer"),
  composer: document.querySelector("#composer"),
  promptInput: document.querySelector("#promptInput"),
  modelButton: document.querySelector("#modelButton"),
  modelButtonLabel: document.querySelector("#modelButtonLabel"),
  modelMenu: document.querySelector("#modelMenu"),
  effortButton: document.querySelector("#effortButton"),
  effortButtonLabel: document.querySelector("#effortButtonLabel"),
  effortMenu: document.querySelector("#effortMenu"),
  contextRingBtn: document.querySelector("#contextRingBtn"),
  contextRing: document.querySelector("#contextRing"),
  sendBtn: document.querySelector("#sendBtn"),
  uploadBtn: document.querySelector("#uploadBtn"),
  imageInput: document.querySelector("#imageInput"),
  attachmentTray: document.querySelector("#attachmentTray"),
  newThreadBtn: document.querySelector("#newThreadBtn"),
  mobileThreadTitle: document.querySelector("#mobileThreadTitle"),
  approvalDock: document.querySelector("#approvalDock"),
  notice: document.querySelector("#notice"),
  qrImage: document.querySelector("#qrImage"),
  tokenDialog: document.querySelector("#tokenDialog"),
  tokenForm: document.querySelector("#tokenForm"),
  tokenInput: document.querySelector("#tokenInput"),
  saveTokenBtn: document.querySelector("#saveTokenBtn"),
  toastRegion: document.querySelector("#toastRegion"),
  sidebar: document.querySelector("#sidebar"),
  sidebarBackdrop: document.querySelector("#sidebarBackdrop"),
  menuBtn: document.querySelector("#menuBtn"),
  imageViewer: document.querySelector("#imageViewer"),
  imageViewerImg: document.querySelector("#imageViewerImg"),
  imageViewerBackdrop: document.querySelector("#imageViewerBackdrop"),
  imageViewerClose: document.querySelector("#imageViewerClose")
  ,
  renameDialog: document.querySelector("#renameDialog"),
  renameForm: document.querySelector("#renameForm"),
  renameInput: document.querySelector("#renameInput"),
  renameCancelBtn: document.querySelector("#renameCancelBtn"),
  renameSaveBtn: document.querySelector("#renameSaveBtn"),
  threadContextMenu: document.querySelector("#threadContextMenu")
  ,
  clearUnreadReveal: document.querySelector("#clearUnreadReveal"),
  clearUnreadBtn: document.querySelector("#clearUnreadBtn")
};

for (const [name, element] of Object.entries(elements)) {
  if (!element) throw new Error(`缺少页面元素：${name}`);
}
const thinkingShimmer = createThinkingShimmer({
  messages: elements.messages,
  initialDelayMs: 600,
  activeMs: 1000,
  cadenceMs: 4000
});
const annotationUI = createResponseAnnotationUI({
  messages: elements.messages,
  composer: elements.composer,
  getThreadId: () => state?.currentThreadId || "",
  getMessages: () => timeline.messages(),
  getDraft: () => draftAnnotations,
  createId: createClientId,
  setDraft: (annotations) => {
    draftAnnotations = annotations;
    composerEditRevision++;
    saveCurrentDraft();
    updateComposerState();
  },
  canEdit: () => Boolean(state?.currentThreadId && !submissions.pending && !messageEditor.active && !threadNavigation.isHistoryBackPending() && !elements.sidebar.classList.contains("open")),
  canSend: () => !elements.sendBtn.disabled,
  onSend: () => elements.composer.requestSubmit(),
  onEditorChange: (open) => {
    if (open) document.documentElement.style.setProperty("--annotation-layout-bottom", `${Math.max(elements.composer.getBoundingClientRect().bottom, primaryInputKeyboardBottom ?? 0)}px`);
    else document.documentElement.style.removeProperty("--annotation-layout-bottom");
    document.body.classList.toggle("annotationEditing", open);
    elements.composer.inert = open;
    updateViewportSizing();
  },
  onCopy: writeClipboard,
  onError: (message) => toast(message, { tone: "error" }),
  onSelectionEnd: () => { lastMessageKey = ""; renderMessages(); },
  onLoadEarlier: () => elements.messages.querySelector("[data-load-earlier-messages]")?.click()
});
const messageScroll = createMessageScrollController({
  messages: elements.messages,
  scrollBottomButton: elements.scrollBottomBtn,
  composer: elements.composer,
  getState: () => state,
  hasActiveSelection: () => annotationUI.hasActiveSelection(),
  isMobileView,
  getMessageCount: () => state?.messages?.length || 0
});
const streamDom = createStreamDomUpdater({
  messages: elements.messages,
  getState: () => state,
  annotationUI,
  roleLabel,
  messagesNearBottom: () => messageScroll.nearBottom(),
  stickMessagesToBottomSoon: (afterScroll) => messageScroll.stickToBottomSoon(afterScroll),
  scheduleScrollBottomButtonUpdate: () => messageScroll.scheduleBottomButtonUpdate()
});
const threadListUI = createThreadListUI({
  getState: () => state,
  getElements: () => elements,
  getSearchQuery: () => threadSearchQuery,
  setSearchQuery: (value) => { threadSearchQuery = value; },
  getDisabled: () => Boolean(awaitingSocketState || submissions.pending || pendingImageReads || !phoneConnection.isOpen() || state?.codex?.status !== "connected"),
  displayThreadName,
  escapeHtml,
  formatTime,
  createClientId,
  snapshotDraft: snapshotCurrentDraft,
  saveDraft: () => saveCurrentDraft(),
  optimisticSwitchThread,
  closeSidebar: (...args) => threadNavigation.closeSidebar(...args),
  send,
  showThreadContextMenu,
  currentThreadIsRunning
});
const threadNavigation = createThreadNavigation({
  elements,
  getState: () => state,
  isMobileView,
  annotationUI,
  toast,
  snapshotCurrentDraft,
  saveCurrentDraft,
  optimisticSwitchThread,
  send,
  createClientId,
  requestFullState,
  threadListPullMaxPx: 76,
  threadListPullTriggerPx: 52
});
const {
  toggleSidebar,
  openSidebar,
  closeSidebar,
  handleSidebarPopState,
  syncSidebarFromHistory,
  syncSidebarAccessibility,
  renderClearUnreadControl,
  beginThreadListPull,
  updateThreadListPull,
  endThreadListPull,
  clearAllUnreadThreads,
  resetUnreadRequestState
} = threadNavigation;
const draftStore = createDraftStore({
  draftByThread,
  getComposerRevision: () => composerEditRevision,
  getCurrentDraftKey: () => currentDraftKey(),
  getPromptText: () => elements.promptInput.value,
  getDraftAnnotations: () => draftAnnotations,
  isCurrentDraftKey: (key) => currentDraftKey() === key,
  applyDraft: (draft) => applyDraft(draft),
  getActiveSubmissionRequestId: () => submissions.pending?.payload?.requestId || submissions.recoverable?.payload?.requestId || "",
  onError: () => toast("草稿存储失败，请勿关闭当前页面", { tone: "error", duration: 0, id: "draft-storage-error" }),
  createClientId,
  isDisplayableImageUrl,
  estimateDataUrlBytes,
  limits: {
    maxDraftImages: MAX_DRAFT_IMAGES,
    maxImageBytes: MAX_IMAGE_BYTES,
    maxDraftImageTotalBytes: MAX_DRAFT_IMAGE_TOTAL_BYTES
  }
});
const attachments = createComposerAttachments({
  imageInput: elements.imageInput,
  uploadButton: elements.uploadBtn,
  attachmentTray: elements.attachmentTray,
  imageViewer: elements.imageViewer,
  imageViewerImage: elements.imageViewerImg,
  getImages: () => draftImages,
  setImages: (images) => { draftImages = Array.isArray(images) ? images : []; },
  getCurrentDraftKey: () => currentDraftKey(),
  snapshotDraft: () => snapshotCurrentDraft(),
  getDraftForKey: (key) => draftByThread.get(key),
  setDraftForKey: (key, draft) => draftByThread.set(key, draft),
  persistDraft: (key, draft) => draftStore.persistDraft(key, draft),
  saveDraft: () => saveCurrentDraft(),
  getPendingReads: () => pendingImageReads,
  setPendingReads: (value) => { pendingImageReads = value; },
  createClientId,
  escapeAttribute,
  toast,
  renderComposerState: () => updateComposerState(),
  updateViewportSizing: () => updateViewportSizing(),
  releasePressedButtons: () => releasePressedButtons(),
  maxImages: MAX_DRAFT_IMAGES,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxTotalBytes: MAX_DRAFT_IMAGE_TOTAL_BYTES
});
const activityRenderer = createActivityRenderer({
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
  openImage: (url) => attachments.openViewer(url),
  thinkingShimmer
});
const commandGroups = createCommandGroupRenderer({
  expandedMessages,
  pendingToolScrollRestore,
  escapeHtml,
  toolStatusKey,
  toolTitle,
  toolOutput,
  messageNodeRenderKey: (message) => messageNodeRenderKey(message),
  canStreamInPlace: (existing, message) => canStreamInPlace(existing, message),
  updateStreamingMessageNode: (node, message) => updateStreamingMessageNode(node, message),
  onRender: () => {
    lastMessageKey = "";
    renderMessages();
  }
});
const diffRenderer = createDiffRenderer({
  fileChangesForMessage,
  displayTextForMessage,
  summarizeFileChanges,
  displayDiffFileName,
  displayFilePath
});
const aboveComposer = createAboveComposer({
  container: elements.aboveComposer,
  getState: () => state,
  getMessages: () => timeline.messages(),
  isMobileView,
  isThreadRunning: () => currentThreadIsRunning(),
  isAboveComposerTurnDiff,
  messageThreadId,
  messageTurnId,
  fileChangesForMessage,
  planStepsForMessage,
  displayTextForMessage,
  messageRenderKey: (message) => messageRenderer.renderKey(message),
  renderInProgressTurnDiff: (message) => diffRenderer.renderInProgressTurnDiffMessage(message),
  escapeAttribute,
  formatInlineMarkdown,
  nearBottom: () => messageScroll.nearBottom(),
  stickToBottomSoon: () => messageScroll.stickToBottomSoon(),
  updateViewportSizing: () => updateViewportSizing(),
  getPendingInterruptPlanKey: () => pendingInterruptPlanKey,
  onPlanToggle: () => {
    lastMessageKey = "";
    aboveComposer.render();
    renderMessages();
  }
});
const timeline = createConversationTimeline({
  getState: () => state,
  isMobileView,
  isThreadRunning: () => currentThreadIsRunning(),
  currentFixedTurnDiff: () => aboveComposer.currentTurnDiff(),
  messageThreadId,
  messageTurnId,
  messageIsInProgress,
  isAboveComposerTurnDiff,
  isTimelineRowsTurnDiff,
  isCompletedTurnDiffCard,
  formatElapsed
});
const messageEditor = createMessageEditor({
  messagesElement: elements.messages,
  getState: () => state,
  getMessages: () => timeline.messages(),
  isMobileView,
  isConnected: () => !awaitingSocketState && state?.codex?.status === "connected" && phoneConnection.isOpen(),
  isThreadRunning: () => currentThreadIsRunning(),
  getPendingSubmission: () => submissions.pending,
  getRecoverableSubmission: () => submissions.recoverable,
  hasPendingImageReads: () => pendingImageReads > 0,
  hasPendingSettings: () => Boolean(pendingSettings),
  messageThreadId,
  messageTurnId,
  displayTextForMessage,
  encodeResponseAnnotations,
  decodeResponseAnnotations,
  createClientId,
  submissionMatchesCurrentDraft: (submission) => submissionMatchesCurrentDraft(submission),
  retrySubmission: (submission) => submissions.retry(submission),
  beginSubmission: (payload, threadId, text, images) => submissions.begin(payload, threadId, text, images),
  onRenderChange: () => {
    lastMessageKey = "";
    renderMessages();
    updateComposerState();
  }
});
const submissions = createSubmissionController({
  timeoutMs: SUBMISSION_TIMEOUT_MS,
  send: (payload) => send(payload),
  persistSubmission: (submission) => draftStore.persistSubmission(submission),
  deletePersistedSubmission: (requestId) => draftStore.deletePersistedSubmission(requestId),
  captureSubmission: (payload, threadId, textSnapshotOverride, imageSnapshotOverride) => ({
    payload,
    threadId,
    textSnapshot: textSnapshotOverride === null ? elements.promptInput.value : String(textSnapshotOverride || ""),
    imageSnapshot: imageSnapshotOverride === null
      ? draftImages.map((image) => ({ ...image }))
      : Array.isArray(imageSnapshotOverride) ? imageSnapshotOverride : [],
    annotationSnapshot: payload.type === "message:edit" ? [] : structuredClone(draftAnnotations)
  }),
  getCurrentThreadId: () => state?.currentThreadId || "",
  getThreadRevision: () => state?.threadRevision,
  getMessages: () => state?.messages || [],
  belongsToCurrentThread: (submission) => submissionBelongsToCurrentThread(submission),
  validateRetry: (submission) => {
    if (pendingImageReads) return "当前操作完成后再重试发送";
    const currentThreadId = state?.currentThreadId || "";
    return submission.threadId && currentThreadId !== submission.threadId ? "请先返回原会话再重试发送" : "";
  },
  publicErrorMessage: (payload, fallback) => publicOperationErrorMessage(payload, fallback),
  onStart: (submission) => {
    if (submission.payload.type !== "message:edit") saveCurrentDraft(submission.threadId);
    updateComposerState();
    clearComposerImmediately(submission, submission.threadId);
  },
  onRetryStart: () => updateComposerState(),
  onRecoverable: async (submission, message, options = {}) => {
    if (options.restore !== false) await restoreSubmissionDraftIfEmpty(submission);
    updateComposerState();
    if (!submissionBelongsToCurrentThread(submission)) return;
    if (options.restore !== false && submission.payload.type !== "message:edit" && !submissionMatchesCurrentDraft(submission)) {
      dismissToast(`submission-${submission.payload.requestId}`);
      return;
    }
    if (options.warning) toast(message, { tone: "warning" });
    else showSubmissionRetry(message, submission);
  },
  onActivate: (submission) => {
    messageEditor.restoreSubmission(submission);
    restoreSubmissionDraftIfEmpty(submission);
    updateComposerState();
  },
  onDefiniteFailure: (submission, payload) => {
    if (submission.payload.type === "message:edit") {
      messageEditor.clear();
      lastMessageKey = "";
    }
    restoreSubmissionDraftIfEmpty(submission);
    updateComposerState();
    if (submissionBelongsToCurrentThread(submission)) showSubmissionRetry(publicOperationErrorMessage(payload, "消息发送失败"), submission);
  },
  onAccepted: (submission, payload) => {
    if (submission.payload.type === "message:edit") {
      messageEditor.clear();
      lastMessageKey = "";
    } else {
      const acceptedThreadId = payload.threadId || submission.threadId || state?.currentThreadId || "";
      clearSubmittedDraftIfUnchanged(submission, acceptedThreadId);
    }
    updateComposerState();
  },
  onThreadBound: (_submission, threadId) => moveDraftToCreatedThread(threadId),
  dismissNotice: (requestId) => dismissToast(`submission-${requestId}`)
});
const messageRenderer = createMessageRenderer({
  getState: () => state,
  expandedMessages,
  aboveComposer,
  activityRenderer,
  commandGroups,
  diffRenderer,
  annotationUI,
  messagePhase,
  displayTextForMessage,
  isUnknownCurrentActivity,
  isTimelineRowsTurnDiff,
  isCompletedTurnDiffCard,
  roleLabel,
  isToolLike,
  imagesForMessage,
  imageSignature,
  unifiedDiffForMessage,
  planStepsForMessage,
  stringifyForDisplay,
  itemField,
  editingMessageMatches: (message) => messageEditor.matches(message),
  renderInlineMessageEditor: (message) => messageEditor.renderInline(message),
  shouldReserveMessageEditAction: (message) => messageEditor.shouldReserveAction(message),
  renderMessageEditAction: (message) => messageEditor.renderAction(message),
  canEditMessage: (message) => messageEditor.canEdit(message),
  openImage: (url) => attachments.openViewer(url),
  togglePlan: (id) => togglePlanCollapsed(id)
});
const messageList = createMessageListRenderer({
  messages: elements.messages,
  getState: () => state,
  getVisibleMessages: () => timeline.messages(),
  getRenderableMessages: (messages) => timeline.renderable(messages),
  getRenderItems: (messages) => timeline.renderItems(messages),
  getActivityKey: (messages) => turnActivityKey(messages),
  getOmittedMessages: () => state?.sync?.omittedMessages || 0,
  getExpansionKey: () => `${[...expandedMessages].join(",")}|${aboveComposer.expansionKey()}`,
  getEditingMessage: () => messageEditor.current,
  isEditingTargetVisible: (messages) => messages.some((message) => messageEditor.matches(message)),
  isThreadRunning: () => currentThreadIsRunning(),
  hasCurrentPlan: () => Boolean(aboveComposer.currentPlan()),
  getCurrentThreadName: () => currentThread()?.name || "新会话",
  isEarlierMessagesPending: () => Boolean(pendingEarlierMessages),
  renderInlineEditor: (message) => messageEditor.renderInline(message),
  renderTurnDivider: (divider, existingNodes) => renderTurnDividerNode(divider, existingNodes),
  renderCommandGroup: (group, existingNodes) => commandGroups.render(group, existingNodes),
  renderMessageNode: (message, existingNodes) => renderMessageNode(message, existingNodes),
  renderActivity: (activityKey, existingNodes) => renderTurnActivityNode(activityKey, existingNodes),
  itemKey: (item) => messageRenderItemKey(item),
  annotationUI,
  pendingToolScrollRestore,
  disposeThinkingShimmer: (node) => thinkingShimmer.dispose(node),
  nearBottom: () => messageScroll.nearBottom(),
  stickToBottomSoon: (afterScroll) => messageScroll.stickToBottomSoon(afterScroll),
  scheduleBottomButtonUpdate: () => messageScroll.scheduleBottomButtonUpdate(),
  updateBottomButton: () => messageScroll.updateBottomButton(),
  updateMessageDensity: () => updateMessageDensity(),
  setInitialScrollPending: (value) => messageScroll.setInitialScrollPending(value),
  getLastKey: () => lastMessageKey,
  setLastKey: (value) => { lastMessageKey = value; },
  getPendingScrollRestore: () => pendingScrollRestore,
  setPendingScrollRestore: (value) => { pendingScrollRestore = value; },
  getEarlierMessagesAnchor: () => earlierMessagesScrollAnchor,
  setEarlierMessagesAnchor: (value) => { earlierMessagesScrollAnchor = value; },
  getPendingEarlierMessages: () => pendingEarlierMessages,
  getCurrentThreadId: () => state?.currentThreadId || ""
});
const composerControls = createComposerControls({
  modelButton: elements.modelButton,
  modelButtonLabel: elements.modelButtonLabel,
  modelMenu: elements.modelMenu,
  effortButton: elements.effortButton,
  effortButtonLabel: elements.effortButtonLabel,
  effortMenu: elements.effortMenu,
  contextRingButton: elements.contextRingBtn,
  contextRing: elements.contextRing,
  composer: elements.composer,
  getState: () => state,
  isAwaitingState: () => awaitingSocketState,
  hasPendingSubmission: () => Boolean(submissions.pending),
  getPendingSettings: () => pendingSettings,
  isSocketOpen: () => phoneConnection.isOpen(),
  onCompact: () => submitThreadCompact()
});
const approvalUI = createApprovalUI({
  approvalDock: elements.approvalDock,
  getState: () => state,
  getPendingApprovalId: () => pendingApprovalId,
  stringifyForDisplay,
  formatStructuredValue,
  shieldIconSvg,
  onResolve: (approvalId, decision) => requestApprovalResolution(approvalId, decision)
});
syncSidebarFromHistory(history.state);
elements.imageViewer.inert = true;

if (tokenFromQuery) {
  safeLocalStorageSet("codex-phone-token", tokenFromQuery);
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete("token");
  history.replaceState(history.state, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
}

if (!token) {
  elements.tokenDialog.showModal();
} else {
  safeLocalStorageSet("codex-phone-token", token);
  // 刷新后直接等服务端真实状态，不再恢复本地缓存：
  // 缓存恢复会把上一次的“执行命令/运行中”旧页面先渲染出来，
  // 弱网下服务端状态覆盖不及时，看起来就像永远卡在同一页。
  connect();
}

elements.tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveTokenAndConnect();
});
elements.tokenDialog.addEventListener("cancel", (event) => event.preventDefault());

document.addEventListener("pointerdown", pressButton, true);
document.addEventListener("pointerup", releasePressedButtons, true);
document.addEventListener("pointercancel", releasePressedButtons, true);
document.addEventListener("pointerleave", releasePressedButtons, true);
window.addEventListener("popstate", handleSidebarPopState);

elements.newThreadBtn.addEventListener("click", () => startNewThread());
elements.menuBtn.addEventListener("click", toggleSidebar);
elements.threadMenuBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleHeaderThreadMenu();
});
elements.contextRingBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  composerControls.toggleContextPanel();
});
elements.renameCancelBtn.addEventListener("click", () => elements.renameDialog.close());
elements.renameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitThreadRename();
});
elements.sidebarBackdrop.addEventListener("click", closeSidebar);
elements.clearUnreadBtn.addEventListener("click", clearAllUnreadThreads);
elements.threadList.addEventListener("touchstart", beginThreadListPull, { passive: true });
elements.threadList.addEventListener("touchmove", updateThreadListPull, { passive: false });
elements.threadList.addEventListener("touchend", endThreadListPull, { passive: true });
elements.threadList.addEventListener("touchcancel", endThreadListPull, { passive: true });
elements.scrollBottomBtn.addEventListener("click", () => messageScroll.scrollToBottomFromButton());
elements.messages.addEventListener("scroll", (event) => messageScroll.handleScroll(event), { passive: true });
elements.messages.addEventListener("pointerdown", (event) => messageScroll.beginPointerGesture(event), { passive: true });
window.addEventListener("pointerup", () => messageScroll.endPointerGesture(), { passive: true });
window.addEventListener("pointercancel", () => messageScroll.endPointerGesture(), { passive: true });
elements.messages.addEventListener("touchstart", (event) => messageScroll.beginTouchGesture(event), { passive: true });
elements.messages.addEventListener("touchmove", (event) => messageScroll.trackTouchGesture(event), { passive: true });
elements.messages.addEventListener("touchend", () => messageScroll.endTouchGesture(), { passive: true });
elements.messages.addEventListener("touchcancel", () => messageScroll.endTouchGesture(), { passive: true });
elements.messages.addEventListener("wheel", (event) => {
  if (event.deltaY < 0 || event.target?.closest?.(".cmdOutputWrap")) messageScroll.suspendAutoStick();
}, { passive: true });
elements.messages.addEventListener("click", (event) => {
  const earlier = event.target.closest("[data-load-earlier-messages]");
  if (earlier) {
    requestEarlierMessages(earlier);
    return;
  }
  const fileRef = event.target.closest("[data-file-path]");
  if (fileRef) {
    toggleFileRefBubble(fileRef);
    return;
  }
  const loadDetail = event.target.closest("[data-load-message-detail]");
  if (loadDetail) {
    requestMessageDetail(loadDetail.dataset.loadMessageDetail);
    return;
  }
  const trigger = event.target.closest("[data-toggle-message]");
  if (!trigger) return;
  commandGroups.toggleExpanded(trigger.dataset.toggleMessage);
});
elements.messages.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-copy-code]");
  if (!trigger) return;
  copyCodeBlock(trigger);
});
elements.threadSearchInput.addEventListener("input", () => {
  threadListUI.setQuery(elements.threadSearchInput.value);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    attachments.closeViewer();
    closeSidebar();
  }
});

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (submissions.pending || pendingImageReads || pendingSettings) return;
  const rawText = elements.promptInput.value;
  const text = rawText.trim();
  const running = currentThreadIsRunning();
  if (!text && !draftImages.length && !draftAnnotations.length && running) {
    requestTurnInterrupt();
    return;
  }
  if (!text && !draftImages.length && !draftAnnotations.length) return;
  if (submissions.recoverable && submissionMatchesCurrentDraft(submissions.recoverable)) {
    submissions.retry(submissions.recoverable);
    return;
  }
  const payload = {
    type: "message:send",
    clientUserMessageId: createClientId(),
    requestId: createClientId(),
    threadId: state?.currentThreadId || "",
    threadRevision: state?.threadRevision,
    text: encodeResponseAnnotations(rawText, draftAnnotations),
    images: draftImages.map(({ id, ...image }) => image)
  };
  submissions.begin(payload, state?.currentThreadId || "");
});

elements.promptInput.addEventListener("input", () => {
  composerEditRevision++;
  autosize();
  saveCurrentDraft(undefined, { userEdit: true });
  if (submissions.recoverable && !submissionMatchesCurrentDraft(submissions.recoverable)) {
    dismissToast(`submission-${submissions.recoverable.payload.requestId}`);
  }
});
elements.promptInput.addEventListener("focus", () => {
  if (isMobileView() && primaryInputKeyboardBottom === null) primaryInputKeyboardBottom = elements.composer.getBoundingClientRect().bottom;
  updateViewportSizing();
});
elements.promptInput.addEventListener("blur", updateViewportSizing);

elements.modelButton.addEventListener("click", () => composerControls.toggleSettingMenu("model"));
elements.effortButton.addEventListener("click", () => composerControls.toggleSettingMenu("effort"));
elements.modelMenu.addEventListener("click", (event) => {
  const option = event.target.closest("[data-model]");
  if (!option || pendingSettings) return;
  const model = option.dataset.model;
  const modelOption = (state?.models || []).find((entry) => entry.model === model);
  const supported = modelOption?.supportedReasoningEfforts || [];
  const currentEffort = state?.threadSettings?.effort || "";
  const effort = supported.some((entry) => entry.reasoningEffort === currentEffort)
    ? currentEffort
    : modelOption?.defaultReasoningEffort || supported[0]?.reasoningEffort || "";
  composerControls.closeSettingMenus();
  requestSettingsUpdate(model, effort);
});
elements.effortMenu.addEventListener("click", (event) => {
  const option = event.target.closest("[data-effort]");
  if (!option || pendingSettings) return;
  composerControls.closeSettingMenus();
  requestSettingsUpdate(state?.threadSettings?.model || "", option.dataset.effort);
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".composerSetting")) composerControls.closeSettingMenus();
});

elements.uploadBtn.addEventListener("click", () => elements.imageInput.click());
elements.imageInput.addEventListener("change", () => attachments.addFiles(elements.imageInput.files, currentDraftKey()));
elements.imageInput.addEventListener("cancel", () => attachments.resetFilePickerState({ clearInput: true }));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    saveCurrentDraft();
    visibilitySeq += 1;
    send({ type: "phone:background", seq: visibilitySeq });
  }
  if (document.visibilityState === "visible") {
    attachments.resetFilePickerState();
    syncAfterForeground();
  }
});
window.addEventListener("pageshow", (event) => {
  attachments.resetFilePickerState();
  // 仅浏览器从 bfcache 恢复页面时强制同步；首次加载不重建连接。
  if (event.persisted) syncAfterForeground();
});
window.addEventListener("online", () => {
  attachments.resetFilePickerState();
  if (!token || document.visibilityState !== "visible") return;
  phoneConnection.networkRestored();
});
window.addEventListener("pagehide", () => {
  saveCurrentDraft();
  saveCurrentThreadScroll();
});
elements.imageViewerBackdrop.addEventListener("click", () => attachments.closeViewer());
elements.imageViewerClose.addEventListener("click", () => attachments.closeViewer());
setupViewportSizing();
autosize();
hydratePersistedDrafts();

function startNewThread() {
  if (submissions.pending || pendingImageReads || pendingSettings) {
    toast("当前操作完成后才能新建会话", { tone: "warning" });
    return;
  }
  const previousThreadId = state?.currentThreadId || "";
  const previousDraft = snapshotCurrentDraft();
  saveCurrentDraft();
  optimisticSwitchThread("", previousDraft);
  closeSidebar();
  send({ type: "thread:new", requestId: createClientId() });
}

function optimisticSwitchThread(nextThreadId, previousDraft) {
  if (!state) return;
  const previousThreadId = state.currentThreadId || "";
  if (previousThreadId === nextThreadId) return;
  cacheCurrentThreadMessages();
  // 新建会话（目标为空）也用乐观标记保护：迟到的旧线程消息补丁
  // 不能灌回刚清空的对话流。空串表示“正在等待新建会话确认”。
  optimisticThreadId = nextThreadId === "" ? "" : (nextThreadId || null);
  optimisticThreadContext = { targetThreadId: nextThreadId || null, previousThreadId: previousThreadId || null, previousDraft };
  clearTimeout(optimisticThreadTimer);
  optimisticThreadTimer = setTimeout(() => {
    if (optimisticThreadId === null) return;
    // 服务器已确认切换但状态迟迟没到（弱网），停止忽略状态，以服务器最终状态为准。
    optimisticThreadId = null;
    optimisticThreadContext = null;
    requestFullState();
  }, 8000);
  state = {
    ...state,
    currentThreadId: nextThreadId || null,
    messages: [],
    busy: false,
    activeTurnId: null,
    activeTurnThreadId: null,
    approvals: [],
    sync: { ...(state.sync || {}), omittedMessages: 0, messageLimit: 0 }
  };
  // 先渲染目标会话的最近已知列表，随后由服务端状态校准。
  restoreThreadMessages(nextThreadId);
  cacheCurrentThreadMessages();
  handleThreadChange(previousThreadId, nextThreadId || "");
  resetRenderCache();
  scheduleRender();
}

function currentDraftThreadId() {
  if (state && Object.prototype.hasOwnProperty.call(state, "currentThreadId")) return state.currentThreadId || "";
  return lastRenderedThreadId || "";
}

function draftKey(threadId = currentDraftThreadId()) {
  return threadId || EMPTY_THREAD_DRAFT_KEY;
}

function currentDraftKey() {
  return draftKey(currentDraftThreadId());
}

function snapshotCurrentDraft() {
  return {
    text: elements.promptInput.value,
    images: draftImages.map((image) => ({ ...image })),
    annotations: structuredClone(draftAnnotations)
  };
}

function saveCurrentDraft(threadId = currentDraftThreadId(), { userEdit = false } = {}) {
  const key = draftKey(threadId);
  const draft = snapshotCurrentDraft();
  if (!draft.text && !draft.images.length && !draft.annotations.length) {
    if (!draftHydrationComplete && !userEdit) return;
    if (!userEdit && !draftByThread.has(key)) return;
  }
  // An explicitly empty draft is a saved user choice. Absence is reserved for
  // a submitted draft, whose result may still need to be recovered.
  draftByThread.set(key, draft);
  draftStore.persistDraft(key, draft);
}

function restoreDraft(threadId) {
  if (!draftHydrationComplete || !state || !Object.prototype.hasOwnProperty.call(state, "currentThreadId")) return;
  if (String(state.currentThreadId || "") !== String(threadId || "")) return;
  const key = draftKey(threadId);
  const draft = draftByThread.get(key) || { text: "", images: [] };
  applyDraft(draft, threadId);
  void draftStore.hydratePersistedDraftKey(key, composerEditRevision);
}

function applyDraft(draft = {}, threadId = currentDraftThreadId()) {
  annotationUI.closeForThreadChange();
  elements.promptInput.value = draft.text || "";
  draftImages = Array.isArray(draft.images) ? draft.images.map((image) => ({ ...image })) : [];
  draftAnnotations = structuredClone(draft.annotations || []);
  composerDraftThreadId = threadId || "";
  composerEditRevision++;
  attachments.renderTray();
  annotationUI.renderDraft();
  autosize();
  updateComposerState();
}

function clearDraft(threadId = currentDraftThreadId()) {
  applyDraft({ text: "", images: [] }, threadId);
}

function handleThreadChange(previousThreadId, nextThreadId) {
  if (previousThreadId === nextThreadId && lastRenderedThreadId === nextThreadId) return;
  if (previousThreadId !== nextThreadId) thinkingShimmer.disposeCurrent();
  if (previousThreadId !== nextThreadId) saveCurrentThreadScroll(previousThreadId);
  if (previousThreadId !== nextThreadId) messageEditor.clear();
  if (!submissions.pending && previousThreadId !== nextThreadId) {
    if (suppressNextThreadDraftSave) suppressNextThreadDraftSave = false;
    else saveCurrentDraft(previousThreadId);
  }
  if (submissions.pending && !submissions.pending.threadId && nextThreadId) {
    submissions.bindPendingThread(nextThreadId);
  }
  lastRenderedThreadId = nextThreadId || "";
  expandedMessages.clear();
  aboveComposer.reset();
  earlierMessagesScrollAnchor = null;
  messageScroll.resetGestureState();
  // 切换对话后一律定位到最新消息（底部）：对话流必须显示最新内容，
  // 不能恢复这个会话上次浏览时的中间/开头位置。
  messageScroll.setInitialScrollPending(true);
  messageScroll.resumeAutoStick();
  pendingScrollRestore = null;
  resetRenderCache();
  const submissionBelongsToAnotherThread = Boolean(submissions.pending?.threadId && submissions.pending.threadId !== nextThreadId);
  if (!submissions.pending || submissionBelongsToAnotherThread || composerDraftThreadId !== nextThreadId) restoreDraft(nextThreadId);
  submissions.activateForCurrentThread();
}

function moveDraftToCreatedThread(threadId) {
  const draft = draftByThread.get(EMPTY_THREAD_DRAFT_KEY);
  if (draft) {
    draftByThread.set(threadId, draft);
    draftStore.persistDraft(threadId, draft);
  }
  deleteDraft(EMPTY_THREAD_DRAFT_KEY);
}

function saveCurrentThreadScroll(threadId = currentDraftThreadId()) {
  if (!elements.messages) return;
  const key = draftKey(threadId);
  scrollByThread.set(key, {
    top: Math.max(0, elements.messages.scrollTop),
    atBottom: messageScroll.atBottom(8)
  });
  safeSessionStorageSet(SCROLL_STORAGE_KEY, JSON.stringify(Object.fromEntries(scrollByThread)));
}

function requestMessageDetail(id) {
  if (!phoneConnection.isOpen()) return;
  messageDetails.request(state?.messages.find((message) => message.id === id));
}

let fileRefBubble = null;
let activeFileRefEl = null;

function hideFileRefBubble() {
  if (fileRefBubble) {
    fileRefBubble.remove();
    fileRefBubble = null;
  }
  activeFileRefEl = null;
}

function showFileRefBubble(element) {
  hideFileRefBubble();
  const path = element.dataset.filePath || "";
  if (!path) return;
  const bubble = document.createElement("div");
  bubble.className = "fileRefBubble";
  bubble.innerHTML = `<span class="fileRefBubbleArrow" aria-hidden="true"></span><span class="fileRefBubbleText">${escapeHtml(path)}</span>`;
  document.body.append(bubble);
  const rect = element.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  const elementCenterX = rect.left + rect.width / 2;
  let top = rect.top - bubbleRect.height - 8;
  let placeBelow = false;
  if (top < 8) {
    top = rect.bottom + 8;
    placeBelow = true;
  }
  top = Math.max(8, Math.min(top, window.innerHeight - bubbleRect.height - 8));
  const left = Math.max(8, Math.min(elementCenterX - bubbleRect.width / 2, window.innerWidth - bubbleRect.width - 8));
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
  const arrow = bubble.querySelector(".fileRefBubbleArrow");
  arrow.classList.toggle("up", placeBelow);
  arrow.classList.toggle("down", !placeBelow);
  // 箭头对准文件名所在位置，而不是永远固定在气泡中央。
  const arrowX = Math.max(6, Math.min(elementCenterX - left, bubbleRect.width - 6));
  arrow.style.left = `${arrowX}px`;
  fileRefBubble = bubble;
  activeFileRefEl = element;
}

function toggleFileRefBubble(element) {
  if (activeFileRefEl === element && fileRefBubble) hideFileRefBubble();
  else showFileRefBubble(element);
}

document.addEventListener("pointerdown", (event) => {
  if (!fileRefBubble) return;
  if (event.target.closest(".fileRefBubble") || event.target.closest("[data-file-path]")) return;
  hideFileRefBubble();
}, true);

document.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".contextRingPanel") || event.target.closest("#contextRingBtn")) return;
  composerControls.closeContextPanel();
  if (event.target.closest(".threadContextMenu") || event.target.closest("#threadMenuBtn")) return;
  closeThreadContextMenu();
}, true);

elements.messages.addEventListener("scroll", hideFileRefBubble, { passive: true });

function connect() {
  if (!token) {
    openTokenDialog();
    return;
  }
  phoneConnection.connect();
}

function handleSocketConnecting() {
  messageDetails.disconnect();
  clearTimeout(reconnectThreadTimer);
  awaitingSocketState = true;
  awaitingFullState = true;
  // 保留最后一份已确认页面，连接校准只影响写操作，不得把已确认内容清空。
  // 首次加载时 DOM 本来就是空的；后续重连必须继续显示上一次权威状态。
  if (!state) clearRenderedStateForHydration();
  composerControls.renderSettings();
  updateComposerState();
  updateOperationControls();
}

function handleSocketOpen() {
  updateComposerState();
  const reconnectThreadId = preferredReconnectThreadId;
  const reconnectNewThread = preferredReconnectNewThread;
  preferredReconnectThreadId = "";
  preferredReconnectNewThread = false;
  queryPendingSendResult();
  if (reconnectThreadId) {
    reconnectOpeningThreadId = reconnectThreadId;
    reconnectOpenRequestId = createClientId();
    reconnectOpenConfirmed = false;
    send({ type: "thread:open", threadId: reconnectThreadId, requestId: reconnectOpenRequestId });
    reconnectThreadTimer = setTimeout(() => recoverFromStaleThread(reconnectThreadId), PASSIVE_OPERATION_TIMEOUT_MS);
  } else if (reconnectNewThread) {
    send({ type: "thread:new" });
  }
}

function handlePhonePayload(payload, { generation }) {
  if (payload.type === "stream:append" || payload.type === "stream:complete") {
    handleStreamFrame(payload);
    return;
  }
  if (payload.type === "state") {
    applyFullState(payload, generation);
    return;
  }
  if (payload.type === "state:patch") {
    if (awaitingFullState) return;
    if (!applyStatePatch(payload.patch)) return;
    discardCompletedStreamDomUpdates(payload.patch);
    stateResponseRevision++;
    markHeartbeatHealthy();
    awaitingSocketState = false;
    scheduleRender();
    settleStateBoundOperations({ patch: payload.patch });
    return;
  }

  switch (payload.type) {
    case "turn:interrupt:result":
      clearPendingInterrupt();
      if (!payload.ok) toast(publicOperationErrorMessage(payload, "停止失败，可再次尝试"), { tone: "error" });
      return;
    case "message:send:result":
    case "message:edit:result":
      submissions.handleResult(payload);
      return;
    case "messages:more:result":
      handleEarlierMessagesResult(payload);
      return;
    case "message:detail:result":
      messageDetails.receive(payload);
      return;
    case "thread:compact:result":
      composerControls.closeContextPanel();
      if (!payload.ok) toast(publicOperationErrorMessage(payload, "压缩失败，请重试"), { tone: "error" });
      return;
    case "settings:update:result":
      clearPendingSettings();
      if (!payload.ok) toast(publicOperationErrorMessage(payload, "设置更新失败，请重试"), { tone: "error" });
      return;
    case "thread:rename:result":
      return;
    case "threads:mark-all-read:result":
      resetUnreadRequestState();
      if (!payload.ok) toast(publicOperationErrorMessage(payload, "清除未读消息失败，请重试"), { tone: "error" });
      return;
    case "thread:archive:result":
      if (payload.ok) toast("对话已归档", { tone: "success" });
      else toast(publicOperationErrorMessage(payload, "归档失败，请重试"), { tone: "error" });
      return;
    case "thread:open:result":
      settleOptimisticThreadOpen(payload);
      handleThreadOperationResult(payload);
      return;
    case "thread:new:result":
      handleThreadOperationResult(payload);
      return;
    case "error":
      handleServerError(payload);
  }
}

function applyFullState(payload, generation) {
  const firstFullStateForSocket = fullStateSeenGeneration !== generation;
  const result = reducePhoneState(state, payload, { firstForConnection: firstFullStateForSocket });
  if (result.status === "invalid") {
    toast("同步状态无效，正在重试", { tone: "error" });
    requestFullState();
    return;
  }
  if (result.status !== "applied") return;
  fullStateSeenGeneration = generation;
  awaitingFullState = false;
  resetStreamDomUpdates();
  clearTimeout(fullStateWatchTimer);
  stateResponseRevision++;
  markHeartbeatHealthy();
  const hadState = Boolean(state);
  const previousThreadId = state?.currentThreadId || "";
  awaitingSocketState = false;
  cacheCurrentThreadMessages();
  state = messageDetails.projectState(result.state);
  const rawNextThreadId = state?.currentThreadId || "";
  let nextThreadId = rawNextThreadId;
  if (optimisticThreadId !== null) {
    if (String(rawNextThreadId || "") === String(optimisticThreadId || "")) {
      clearTimeout(optimisticThreadTimer);
      optimisticThreadId = null;
      optimisticThreadContext = null;
    } else {
      nextThreadId = optimisticThreadId || "";
      state = { ...payload.state, currentThreadId: optimisticThreadId || null, messages: [] };
      restoreThreadMessages(nextThreadId);
      cacheCurrentThreadMessages();
      handleThreadChange(previousThreadId, nextThreadId);
      if (!hadState && !pendingScrollRestore) {
        messageScroll.setInitialScrollPending(true);
        messageScroll.resumeAutoStick();
      }
      settleStateBoundOperations({ full: true });
      resetRenderCache();
      scheduleRender();
      return;
    }
  }
  cacheCurrentThreadMessages();
  handleThreadChange(previousThreadId, nextThreadId);
  if (!hadState && !pendingScrollRestore) {
    messageScroll.setInitialScrollPending(true);
    messageScroll.resumeAutoStick();
  }
  settleStateBoundOperations({ full: true });
  resetRenderCache();
  scheduleRender();
}

function settleOptimisticThreadOpen(payload) {
  if (optimisticThreadId === null || payload.ok) return;
  const context = optimisticThreadContext;
  clearTimeout(optimisticThreadTimer);
  optimisticThreadId = null;
  optimisticThreadContext = null;
  if (context && state) {
    const target = context.targetThreadId || "";
    const previous = context.previousThreadId || "";
    state = { ...state, currentThreadId: previous || null, messages: [] };
    handleThreadChange(target, previous);
    if (context.previousDraft) applyDraft(context.previousDraft, previous);
  }
  toast(publicOperationErrorMessage(payload, "切换失败，已回到原会话"), { tone: "error" });
}

function handleSocketClose() {
  messageDetails.disconnect();
  awaitingSocketState = true;
  awaitingFullState = false;
  clearTimeout(fullStateWatchTimer);
  preferredReconnectThreadId = submissions.pending?.threadId || state?.currentThreadId || preferredReconnectThreadId;
  preferredReconnectNewThread = Boolean(!submissions.pending?.threadId && state && !state.currentThreadId);
  if (submissions.pending) submissions.markRecoverable("连接中断，发送结果未知", submissions.pending);
  composerControls.renderSettings();
  updateComposerState();
  updateOperationControls();
}

function queryPendingSendResult() {
  const payload = submissions.queryResultPayload();
  if (!payload) return;
  if (!phoneConnection.isOpen()) return;
  send(payload);
}

function syncAfterForeground() {
  if (!token) return;
  phoneConnection.syncAfterForeground();
}

function markHeartbeatHealthy() {
  phoneConnection.markHealthy();
}

function reconnectForForeground() {
  preferredReconnectThreadId = state?.currentThreadId || preferredReconnectThreadId;
  phoneConnection.reconnect();
}

function send(payload) {
  if (!phoneConnection.send(payload)) {
    toast("手机端尚未连接电脑桥接服务", { tone: "error" });
    return false;
  }
  return true;
}

function handleStreamFrame(payload) {
  if (awaitingFullState) return;
  const result = reducePhoneState(state, payload);
  if (result.ack && result.status !== "applied") acknowledgeStream(payload, result.ack.ok, result.ack.offset);
  if (result.status === "gap" || result.status === "invalid") requestFullState();
  if (result.status !== "applied") return;
  state = result.state;
  cacheCurrentThreadMessages();
  if (payload.type === "stream:append") {
    stateResponseRevision++;
    markHeartbeatHealthy();
    awaitingSocketState = false;
    if (result.inserted) {
      lastMessageKey = "";
      scheduleRender();
    }
    queueStreamDomUpdate(String(payload.messageId), result.offset, result.delta);
    acknowledgeStream(payload, result.ack.ok, result.ack.offset);
  } else {
    streamDom.discardMessage(payload.messageId);
    lastMessageKey = "";
    scheduleRender();
  }
}

function applyStatePatch(patch) {
  if (patch && optimisticThreadId !== null && patch.currentThreadId !== undefined) {
    if (String(patch.currentThreadId || "") === String(optimisticThreadId || "")) {
      clearTimeout(optimisticThreadTimer);
      optimisticThreadId = null;
      optimisticThreadContext = null;
    } else {
      patch = { ...patch };
      delete patch.currentThreadId;
      delete patch.messages;
    }
  }
  const result = reducePhoneState(state, { type: "state:patch", patch });
  if (result.status === "gap" || result.status === "invalid") requestFullState();
  if (result.status !== "applied") return false;
  cacheCurrentThreadMessages();
  state = messageDetails.projectState(result.state);
  cacheCurrentThreadMessages();
  return true;
}

function acknowledgeStream(payload, ok, offset) {
  send({
    type: "stream:ack",
    messageId: String(payload?.messageId || ""),
    frameId: Number(payload?.frameId || 0),
    offset,
    ok
  });
}

function queueStreamDomUpdate(messageId, offset, delta) {
  streamDom.queue(messageId, offset, delta);
}

function flushStreamDomUpdates() {
  streamDom.flush();
}

function discardCompletedStreamDomUpdates(patch) {
  streamDom.discardCompleted(patch);
}

function resetStreamDomUpdates() {
  streamDom.reset();
}

function requestFullState() {
  // 全量状态到达前忽略所有增量补丁，避免积压的旧流式补丁一格一格渲染。
  awaitingFullState = true;
  clearTimeout(fullStateWatchTimer);
  fullStateWatchTimer = setTimeout(() => {
    if (awaitingFullState && phoneConnection.isOpen()) reconnectForForeground();
  }, 8000);
  return send({ type: "state:request", seq: visibilitySeq });
}

function composerIsEmpty() {
  return !String(elements.promptInput.value || "").trim() && draftImages.length === 0 && draftAnnotations.length === 0;
}

function clearComposerImmediately(submission, threadId) {
  if (!submission || submission.payload.type === "message:edit") return;
  if (String(elements.promptInput.value || "") !== String(submission.textSnapshot || "")) return;
  elements.promptInput.value = "";
  draftImages = [];
  draftAnnotations = [];
  annotationUI.renderDraft();
  composerEditRevision++;
  attachments.resetFilePickerState({ clearInput: true });
  attachments.renderTray();
  // 这是明确的用户提交，不受初始草稿 hydration 的保护门槛影响。
  // 立即留下删除版本，旧的异步读取/写入随后到达也不能复活已发送内容。
  deleteDraft(draftKey(threadId));
  updateComposerState();
}

function cacheCurrentThreadMessages() {
  if (!state) return;
  const threadId = state.currentThreadId || "";
  if (!threadId) return;
  const threadMessages = (state.messages || []).filter((message) => {
    const messageThread = messageThreadId(message);
    // 会话缓存必须有明确归属。无 threadId 的消息无法证明属于当前会话，
    // 继续缓存会在切换会话时把旧最终回复带到新会话末尾。
    return messageThread === threadId;
  });
  // 切换期间的空壳状态不能覆盖已有列表。
  const existing = threadMessagesCache.get(threadId);
  if (!threadMessages.length && Array.isArray(existing) && existing.length > 0) return;
  threadMessagesCache.set(threadId, threadMessages);
}

function restoreThreadMessages(threadId) {
  if (!threadId) return;
  const cached = threadMessagesCache.get(threadId);
  if (Array.isArray(cached)) {
    state.messages = cached.filter((message) => messageThreadId(message) === threadId).slice();
  }
}

async function restoreSubmissionDraftIfEmpty(submission) {
  if (!submission || submission.payload.type === "message:edit") return;
  if (!submissionBelongsToCurrentThread(submission)) return;
  if (!composerIsEmpty()) return;
  const key = draftKey(submission.threadId);
  const revision = composerEditRevision;
  await draftStore.hydratePersistedDraftKey(key, -1);
  if (!submissionBelongsToCurrentThread(submission) || composerEditRevision !== revision || !composerIsEmpty()) return;
  // A saved draft, including an empty one, belongs to the user. A request
  // snapshot can only recover a missing draft; it cannot overwrite an edit.
  if (draftByThread.has(key)) return;
  elements.promptInput.value = String(submission.textSnapshot || "");
  draftImages = Array.isArray(submission.imageSnapshot)
    ? submission.imageSnapshot.map((image) => ({ ...image }))
    : [];
  draftAnnotations = structuredClone(submission.annotationSnapshot || []);
  composerEditRevision++;
  annotationUI.renderDraft();
  attachments.renderTray();
  saveCurrentDraft(submission.threadId || state?.currentThreadId || "");
  updateComposerState();
}

function submissionBelongsToCurrentThread(submission) {
  if (!submission || !state || !Object.prototype.hasOwnProperty.call(state, "currentThreadId")) return false;
  const currentThreadId = String(state.currentThreadId || "");
  const submissionThreadId = String(submission.threadId || "");
  // 空 threadId 只代表“新会话草稿”，不能绑定到任何已有会话。
  return submissionThreadId ? submissionThreadId === currentThreadId : currentThreadId === "";
}

function showSubmissionRetry(message, submission) {
  toast(message, {
    tone: "error",
    duration: 0,
    id: `submission-${submission.payload.requestId}`
  });
}

function publicOperationErrorMessage(payload = {}, fallback = "操作失败") {
  const operation = String(payload.operation || "");
  const code = String(payload.code || "");
  if (code.startsWith("message_order_")) {
    if (operation === "thread:open") return "会话加载失败，请重试";
    if (operation === "message:send") return "消息发送失败，请重试";
    if (operation === "message:edit") return "消息更新失败，请重试";
    return "会话同步失败，请重试";
  }
  const message = String(payload.message || fallback).trim();
  // 前端只展示可操作的短错误；内部排序证据和调用链留在服务端日志。
  return message.length > 240 ? fallback : (message || fallback);
}

function submissionMatchesCurrentDraft(submission) {
  if (!submission) return false;
  if (!submissionBelongsToCurrentThread(submission)) return false;
  const currentThreadId = state?.currentThreadId || "";
  if (submission.payload.type === "message:edit") {
    const editingMessage = messageEditor.current;
    return Boolean(
      editingMessage &&
      String(editingMessage.threadId || currentThreadId) === currentThreadId &&
      String(editingMessage.turnId || "") === String(submission.payload.turnId || "") &&
      String(editingMessage.text || "") === String(submission.textSnapshot || "")
    );
  }
  const currentImages = draftImages.map((image) => image.url);
  const submittedImages = submission.imageSnapshot.map((image) => image.url);
  return elements.promptInput.value === submission.textSnapshot
    && JSON.stringify(draftAnnotations) === JSON.stringify(submission.annotationSnapshot || [])
    && currentImages.length === submittedImages.length
    && currentImages.every((url, index) => url === submittedImages[index]);
}

function clearSubmittedDraftIfUnchanged(submission, acceptedThreadId) {
  const currentImages = draftImages.map((image) => image.url);
  const submittedImages = submission.imageSnapshot.map((image) => image.url);
  const unchanged = elements.promptInput.value === submission.textSnapshot
    && JSON.stringify(draftAnnotations) === JSON.stringify(submission.annotationSnapshot || [])
    && currentImages.length === submittedImages.length
    && currentImages.every((url, index) => url === submittedImages[index]);
  const stillClearedAfterSubmission = composerIsEmpty();
  const keys = new Set([draftKey(submission.threadId), draftKey(acceptedThreadId)]);
  const currentKey = currentDraftKey();
  if ((!unchanged && !stillClearedAfterSubmission) || (acceptedThreadId && state?.currentThreadId && acceptedThreadId !== state.currentThreadId)) {
    for (const key of keys) {
      if (key !== currentKey) deleteDraft(key);
    }
    saveCurrentDraft();
    return;
  }
  for (const key of keys) deleteDraft(key);
  clearDraft();
}

function handleThreadOperationResult(payload) {
  const requestId = String(payload.requestId || "");
  if (payload.type === "thread:open:result" && reconnectOpenRequestId && requestId === reconnectOpenRequestId) {
    if (!payload.ok) {
      recoverFromStaleThread(reconnectOpeningThreadId);
      return;
    }
    reconnectOpenConfirmed = true;
    settleReconnectThreadOpen();
    return;
  }
}

function recoverFromStaleThread(threadId) {
  if (!threadId || reconnectOpeningThreadId !== threadId) return;
  reconnectOpeningThreadId = "";
  reconnectOpenRequestId = "";
  reconnectOpenConfirmed = false;
  clearTimeout(reconnectThreadTimer);
  requestFullState();
  // 目标会话恢复失败时保持当前选择，交给用户明确选择下一步；
  // 自动打开任意其他会话会把写入目标和界面状态一起带偏。
  openSidebar();
}

function handleServerError(payload = {}) {
  const errorMessage = publicOperationErrorMessage(payload, "操作失败");
  const operation = String(payload.operation || "");
  const requestId = String(payload.requestId || "");
  let alreadyShown = false;
  if (operation === "thread:open" && reconnectOpeningThreadId && (!requestId || requestId === reconnectOpenRequestId)) {
    recoverFromStaleThread(reconnectOpeningThreadId);
    alreadyShown = true;
  }
  else if (operation === "messages:more" && pendingEarlierMessages && (!requestId || requestId === pendingEarlierMessages.requestId)) {
    finishEarlierMessagesLoad(false);
  }
  else if (operation === "turn:interrupt" && interruptPending) clearPendingInterrupt();
  else if (operation === "settings:update" && pendingSettings) clearPendingSettings();
  else if (operation === "approval:resolve" && pendingApprovalId) clearPendingApproval();
  else if (operation === "threads:mark-all-read") {
    resetUnreadRequestState();
  }
  else if ((operation === "message:send" || operation === "message:edit") && submissions.pending && (!requestId || requestId === submissions.pending.payload.requestId)) {
    submissions.markRecoverable(errorMessage, submissions.pending);
    alreadyShown = true;
  }
  if (!alreadyShown) toast(errorMessage, { tone: "error", duration: 6000 });
}

function settleStateBoundOperations({ full = false, patch = null } = {}) {
  settleReconnectThreadOpen();
  if (
    pendingEarlierMessages
    && full
    && state?.currentThreadId === pendingEarlierMessages.threadId
    && Number(state?.sync?.omittedMessages || 0) < pendingEarlierMessages.omittedMessages
  ) {
    finishEarlierMessagesLoad(true);
  }
  if (pendingApprovalId && !(state?.approvals || []).some((approval) => approval.id === pendingApprovalId)) {
    clearPendingApproval();
  }
  if (interruptPending && !currentThreadIsRunning()) {
    aboveComposer.rememberInterruptedPlanTurn(pendingInterruptPlanKey);
    clearPendingInterrupt();
  }
  if (
    pendingSettings
    && state?.threadSettings?.model === pendingSettings.model
    && state?.threadSettings?.effort === pendingSettings.effort
  ) clearPendingSettings();

  // 如果回执丢失，只有服务端已经写入带真实 turnId 的 canonical userMessage
  // 才能结算提交；浏览器自己的草稿和消息数组不参与确认。
  submissions.settleFromAuthoritativeState();
}

function settleReconnectThreadOpen() {
  if (!reconnectOpeningThreadId || !reconnectOpenConfirmed) return;
  if (state?.currentThreadId !== reconnectOpeningThreadId) return;
  reconnectOpeningThreadId = "";
  reconnectOpenRequestId = "";
  reconnectOpenConfirmed = false;
  clearTimeout(reconnectThreadTimer);
}

function requestEarlierMessages(button) {
  if (pendingEarlierMessages) return;
  const threadId = state?.currentThreadId || "";
  earlierMessagesScrollAnchor = {
    threadId,
    scrollHeight: elements.messages.scrollHeight,
    scrollTop: elements.messages.scrollTop
  };
  messageScroll.suspendAutoStick();
  button.disabled = true;
  const operation = {
    requestId: createClientId(),
    threadId,
    revision: state?.threadRevision,
    omittedMessages: Math.max(0, Number(state?.sync?.omittedMessages || 0)),
    button,
    timer: null
  };
  pendingEarlierMessages = operation;
  if (!send({ type: "messages:more", requestId: operation.requestId, threadId, threadRevision: state?.threadRevision })) {
    finishEarlierMessagesLoad(false);
    return;
  }
  operation.timer = setTimeout(() => {
    if (pendingEarlierMessages === operation) finishEarlierMessagesLoad(false, "加载历史消息超时，请重试");
  }, PASSIVE_OPERATION_TIMEOUT_MS);
}

function handleEarlierMessagesResult(payload) {
  const operation = pendingEarlierMessages;
  if (!operation || String(payload.requestId || "") !== operation.requestId) return;
  if (!payload.ok) {
    finishEarlierMessagesLoad(false, publicOperationErrorMessage(payload, "加载历史消息失败，请重试"));
    return;
  }
  if (
    state?.currentThreadId === operation.threadId
    && Number(state?.sync?.omittedMessages || 0) < operation.omittedMessages
  ) finishEarlierMessagesLoad(true);
}

function finishEarlierMessagesLoad(success, message = "") {
  const operation = pendingEarlierMessages;
  if (!operation) return;
  clearTimeout(operation.timer);
  pendingEarlierMessages = null;
  if (!success) {
    earlierMessagesScrollAnchor = null;
    const button = operation.button?.isConnected
      ? operation.button
      : elements.messages.querySelector("[data-load-earlier-messages]");
    if (button) button.disabled = false;
    if (message) toast(message, { tone: "error" });
  }
  lastMessageKey = "";
}

function requestTurnInterrupt() {
  if (interruptPending) return;
  interruptPending = true;
  pendingInterruptPlanKey = aboveComposer.planTurnKey(state?.currentThreadId || "", state?.activeTurnId || "");
  resetRenderCache();
  scheduleRender();
  updateComposerState();
  const interruptRequestId = createClientId();
  if (!send({ type: "turn:interrupt", requestId: interruptRequestId, threadId: state?.currentThreadId || "", threadRevision: state?.threadRevision })) {
    clearPendingInterrupt();
    return;
  }
  // 点击暂停必须立即反馈：服务器同样先置 busy=false，
  // UI 立刻恢复可输入，不等回执在积压队列里排队；回执到达后再校准。
  if (state) {
    state = { ...state, busy: false, activeTurnId: null, activeTurnThreadId: null };
    resetRenderCache();
    scheduleRender();
    settleStateBoundOperations({ patch: {} });
  }
  interruptTimer = setTimeout(() => {
    clearPendingInterrupt();
    toast("停止请求超时，可再次尝试", { tone: "error" });
  }, PASSIVE_OPERATION_TIMEOUT_MS);
}

function clearPendingInterrupt() {
  clearTimeout(interruptTimer);
  interruptPending = false;
  pendingInterruptPlanKey = "";
  resetRenderCache();
  scheduleRender();
  updateComposerState();
}

function requestSettingsUpdate(model, effort) {
  if (awaitingSocketState || !phoneConnection.isOpen() || state?.codex?.status !== "connected") {
    toast("连接恢复后才能更新设置", { tone: "error" });
    return;
  }
  if (state?.threadSettings?.model === model && state?.threadSettings?.effort === effort) return;
  pendingSettings = { model, effort };
  composerControls.renderSettings();
  updateComposerState();
  if (!send({
    type: "settings:update",
    threadId: state?.currentThreadId || "",
    threadRevision: state?.threadRevision,
    model,
    effort
  })) {
    clearPendingSettings();
    return;
  }
  settingsTimer = setTimeout(() => {
    clearPendingSettings();
    toast("设置更新超时，请重试", { tone: "error" });
  }, PASSIVE_OPERATION_TIMEOUT_MS);
}

function clearPendingSettings() {
  clearTimeout(settingsTimer);
  pendingSettings = null;
  composerControls.renderSettings();
  updateComposerState();
}

function pressButton(event) {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  button.classList.add("isPressed");
}

function releasePressedButtons() {
  document.querySelectorAll("button.isPressed").forEach((button) => button.classList.remove("isPressed"));
}

function resetRenderCache() {
  threadListUI.invalidate();
  approvalUI.invalidate();
  aboveComposer.invalidate();
  lastMessageKey = "";
}

function clearRenderedStateForHydration() {
  resetStreamDomUpdates();
  thinkingShimmer.disposeCurrent();
  elements.threadList.replaceChildren();
  elements.messages.replaceChildren();
  elements.aboveComposer.replaceChildren();
  elements.approvalDock.replaceChildren();
  elements.approvalDock.classList.remove("open");
  resetRenderCache();
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  if (!state) return;
  renderStatus();
  renderClearUnreadControl();
  threadListUI.render();
  composerControls.renderContextRing();
  approvalUI.render();
  composerControls.renderSettings();
  aboveComposer.render();
  renderMessages();
  updateOperationControls();
}

function submitThreadCompact() {
  if (!phoneConnection.isOpen()) return;
  if (!send({ type: "thread:compact", requestId: createClientId() })) return;
  composerControls.closeContextPanel();
}

let renamingThreadId = "";
let contextMenuThread = null;

function openThreadRenameDialog(thread) {
  renamingThreadId = String(thread.id || "");
  elements.renameInput.value = String(thread.name || "");
  elements.renameDialog.showModal();
  requestAnimationFrame(() => elements.renameInput.focus());
}

function submitThreadRename() {
  const name = elements.renameInput.value.trim();
  if (!renamingThreadId || !name) return;
  const requestId = createClientId();
  send({ type: "thread:rename", threadId: renamingThreadId, name, requestId });
  elements.renameDialog.close();
  renamingThreadId = "";
}

function archiveThread(thread) {
  const requestId = createClientId();
  send({ type: "thread:archive", threadId: String(thread.id || ""), requestId });
}

function showThreadContextMenu(thread, x, y) {
  composerControls.closeContextPanel();
  contextMenuThread = thread;
  const menu = elements.threadContextMenu;
  menu.replaceChildren();
  const renameButton = document.createElement("button");
  renameButton.type = "button";
  renameButton.role = "menuitem";
  renameButton.innerHTML = `${pencilIconSvg()}<span>重命名会话</span>`;
  renameButton.addEventListener("click", () => {
    closeThreadContextMenu();
    openThreadRenameDialog(thread);
  });
  const archiveButton = document.createElement("button");
  archiveButton.type = "button";
  archiveButton.role = "menuitem";
  archiveButton.innerHTML = `${archiveIconSvg()}<span>归档会话</span>`;
  archiveButton.addEventListener("click", () => {
    closeThreadContextMenu();
    archiveThread(thread);
  });
  menu.append(renameButton, archiveButton);
  menu.hidden = false;
  const menuRect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - menuRect.width - 8));
  let top = y + 8;
  if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, y - menuRect.height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function toggleHeaderThreadMenu() {
  const thread = currentThread();
  if (!thread?.id) return;
  const menu = elements.threadContextMenu;
  if (!menu.hidden && contextMenuThread?.id === thread.id) {
    closeThreadContextMenu();
    return;
  }
  const rect = elements.threadMenuBtn.getBoundingClientRect();
  showThreadContextMenu(thread, rect.right - 8, rect.bottom + 6);
  elements.threadMenuBtn.setAttribute("aria-expanded", "true");
}

function closeThreadContextMenu() {
  elements.threadContextMenu.hidden = true;
  contextMenuThread = null;
  elements.threadMenuBtn.setAttribute("aria-expanded", "false");
}

function pencilIconSvg() {
  return `<svg width="21" height="21" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.7313 4.20472C13.1489 2.92391 15.3377 2.96644 16.7039 4.33265L16.8318 4.46742C18.0713 5.8393 18.0713 7.93343 16.8318 9.30531L16.7039 9.44007L10.4119 15.7311C10.0884 16.0546 9.85387 16.2917 9.62188 16.4821L9.3875 16.6588C9.18236 16.799 8.96432 16.9196 8.73711 17.0192L8.50762 17.1119C8.32585 17.1785 8.13845 17.2266 7.92168 17.2711L7.15703 17.4069L4.76348 17.8053C4.62062 17.8291 4.46916 17.8552 4.34063 17.8649C4.24185 17.8723 4.10835 17.875 3.9627 17.8395L3.81426 17.7907C3.59124 17.695 3.40749 17.5271 3.2918 17.316L3.2459 17.2223C3.1596 17.0209 3.16176 16.8276 3.17168 16.6959C3.18138 16.5674 3.20744 16.4159 3.23125 16.2731L3.62969 13.8795L3.76445 13.1149C3.80902 12.898 3.85797 12.7108 3.92461 12.5289L4.01738 12.2985C4.11693 12.0715 4.23774 11.854 4.37774 11.6491L4.55352 11.4147C4.74395 11.1825 4.98173 10.9484 5.30547 10.6246L11.5965 4.33265L11.7313 4.20472ZM6.2459 11.5651C5.89673 11.9142 5.71261 12.0998 5.58672 12.2526L5.47539 12.3991C5.38197 12.5358 5.30159 12.6812 5.23516 12.8327L5.17363 12.9869C5.1333 13.0971 5.1025 13.2125 5.06817 13.3815L4.94121 14.0983L4.54277 16.4918L4.5418 16.4938H4.54473L6.93828 16.0944L7.65508 15.9684C7.82408 15.9341 7.93949 15.9033 8.04961 15.8629L8.20293 15.8014C8.35464 15.7349 8.49956 15.6538 8.63652 15.5602L8.78399 15.4498C8.93677 15.3239 9.12233 15.1398 9.47149 14.7907L14.4588 9.80238L11.2332 6.57679L6.2459 11.5651ZM15.7635 5.27308C14.9282 4.43776 13.6058 4.38573 12.7098 5.11683L12.5369 5.27308L12.1736 5.63636L15.4002 8.86195L15.7635 8.49964L15.9197 8.32581C16.6016 7.48961 16.6016 6.28311 15.9197 5.44691L15.7635 5.27308Z" fill="currentColor"/></svg>`;
}

function archiveIconSvg() {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.8008 10.1816C12.1035 10.2438 12.3309 10.5119 12.3311 10.833C12.3311 11.1542 12.1036 11.4222 11.8008 11.4844L11.666 11.498H8.33301C7.96589 11.4979 7.66797 11.2002 7.66797 10.833C7.66814 10.466 7.966 10.1682 8.33301 10.168H11.666L11.8008 10.1816Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M15.417 2.66797C16.7045 2.66815 17.7489 3.71251 17.749 5V5.83301C17.749 6.33171 17.59 6.79271 17.3232 7.17188C17.3263 7.19763 17.3311 7.22343 17.3311 7.25V12.667C17.3311 13.3559 17.3317 13.9131 17.2949 14.3633C17.2622 14.7639 17.197 15.1246 17.0527 15.4609L16.9863 15.6035C16.7209 16.1245 16.3169 16.5602 15.8213 16.8643L15.6035 16.9863C15.2268 17.1782 14.8202 17.2575 14.3623 17.2949C13.9121 17.3317 13.3549 17.332 12.666 17.332H7.33301C6.64407 17.332 6.08689 17.3317 5.63672 17.2949C5.23627 17.2622 4.87521 17.1979 4.53906 17.0537L4.39648 16.9863C3.8754 16.7208 3.43882 16.3171 3.13477 15.8213L3.0127 15.6035C2.82089 15.227 2.74153 14.821 2.7041 14.3633C2.66732 13.9131 2.66797 13.3559 2.66797 12.667V7.25C2.66797 7.22312 2.67268 7.19694 2.67578 7.1709C2.4096 6.79197 2.25195 6.33115 2.25195 5.83301V5C2.25212 3.7124 3.29634 2.66797 4.58398 2.66797H15.417ZM16.001 8.08789C15.8141 8.13621 15.619 8.16501 15.417 8.16504H4.58398C4.38146 8.16504 4.18541 8.13644 3.99805 8.08789V12.667C3.99805 13.3778 3.99895 13.8714 4.03027 14.2549C4.06097 14.6303 4.11779 14.8421 4.19824 15L4.26855 15.126C4.44482 15.4134 4.69792 15.6478 5 15.8018L5.12988 15.8574C5.27361 15.9089 5.4633 15.9467 5.74512 15.9697C6.12858 16.0011 6.62215 16.002 7.33301 16.002H12.666C13.3767 16.002 13.8705 16.001 14.2539 15.9697C14.6292 15.9391 14.8411 15.8821 14.999 15.8018L15.126 15.7305C15.4132 15.5542 15.6479 15.3019 15.8018 15L15.8574 14.8691C15.9088 14.7255 15.9467 14.5363 15.9697 14.2549C16.0011 13.8714 16.001 13.3779 16.001 12.667V8.08789ZM4.58398 3.99805C4.03088 3.99805 3.5822 4.44693 3.58203 5V5.83301C3.58203 6.38621 4.03078 6.83496 4.58398 6.83496H15.417C15.97 6.83478 16.4189 6.3861 16.4189 5.83301V5C16.4188 4.44705 15.9699 3.99823 15.417 3.99805H4.58398Z" fill="currentColor"/></svg>`;
}

function renderStatus() {
  const codex = state?.codex || {};
  const connected = codex.status === "connected";
  const current = currentThread();
  const running = currentThreadIsRunning();
  const currentName = displayThreadName(current, state?.currentThreadId ? "当前会话" : "新会话");
  document.body.classList.toggle("isBusy", running);
  document.body.classList.toggle("codexDisconnected", !connected);
  document.body.classList.toggle("hasBlockingRequest", Boolean(state?.approvals?.length));
  elements.threadTitle.textContent = currentName || "手机上的 Codex";
  elements.mobileThreadTitle.textContent = currentName || "新会话";
  document.title = currentName ? `${currentName} - Codex Phone` : "Codex Link To Phone";
  elements.notice.style.display = state?.app?.publicUrl ? "" : "none";
  if (state?.app?.qrPath) elements.qrImage.src = state.app.qrPath;
  updateComposerState();
}

function renderMessages() {
  messageList.render();
}

function isPlanFixedAboveComposer(message) {
  return aboveComposer.isPlanFixed(message);
}

function messageRenderItemKey(item) {
  if (item.type === "turnDivider") return `${item.type}:${item.id}:${item.label}`;
  if (item.type === "commandGroup") return commandGroups.renderKey(item);
  return messageRenderer.renderKey(item.message);
}

function renderTurnDividerNode(divider, existingNodes = new Map()) {
  const renderKey = messageRenderItemKey(divider);
  const existing = existingNodes.get(divider.id);
  if (existing?.dataset.renderKey === renderKey) return existing;

  const node = document.createElement("div");
  node.className = "turnDivider";
  node.dataset.turnDividerId = divider.id;
  node.dataset.renderKey = renderKey;
  node.setAttribute("role", "separator");
  node.setAttribute("aria-label", divider.label);
  node.innerHTML = `<span>${escapeHtml(divider.label)}</span>`;
  return node;
}

function turnActivityKey(messages) {
  if (!currentThreadIsRunning()) return "idle";
  const lastMessage = messages[messages.length - 1];
  const lastAssistantIsStreaming = lastMessage?.role === "assistant"
    && lastMessage?.kind === "text"
    && messagePhase(lastMessage) === "final_answer"
    && lastMessage?.streaming
    && String(lastMessage.text || "").trim();
  if (lastAssistantIsStreaming) return "idle";
  const descriptor = turnActivityDescriptor(messages);
  if (descriptor.key === "thinking" && hasRunningContextCompaction(messages)) return "idle";
  // 正在思考必须完全固定：key 只由“是否显示”决定，不含 turnId、时间戳。
  // 节点一旦创建就永不重建，动画不与任何消息、任何状态挂钩。
  return descriptor.key;
}

function hasRunningContextCompaction(messages) {
  const activeTurnId = String(state?.activeTurnId || "");
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind !== "context_compaction" || !messageIsInProgress(message)) continue;
    if (!activeTurnId || messageTurnId(message) === activeTurnId) return true;
  }
  return false;
}

function renderTurnActivityNode(activityKey, existingNodes = new Map()) {
  const existing = existingNodes.get("turn-activity");
  const activityThreadId = String(state?.currentThreadId || "");
  if (existing?.dataset.renderKey === activityKey && existing?.dataset.activityThreadId === activityThreadId) return existing;

  const node = document.createElement("div");
  node.className = "turnActivity";
  node.dataset.staticNode = "turn-activity";
  node.dataset.renderKey = activityKey;
  node.dataset.activityThreadId = activityThreadId;
  const descriptor = turnActivityDescriptor(timeline.messages());
  node.innerHTML = thinkingShimmer.html(descriptor.label);
  thinkingShimmer.start(node);
  return node;
}

function turnActivityDescriptor(messages) {
  if (state?.approvals?.length) return { key: "approval", label: "等待你的确认" };
  return { key: "thinking", label: "正在思考" };
}

function renderMessageNode(message, existingNodes = new Map()) {
  const renderKey = messageNodeRenderKey(message);
  const existing = existingNodes.get(message.id);
  if (existing && annotationUI.protectsMessage(message.id)) return existing;
  if (existing?.dataset.renderKey === renderKey) return existing;
  const existingPre = existing?.querySelector(".cmdOutputWrap pre");
  if (existingPre && !pendingToolScrollRestore.has(message.id)) {
    pendingToolScrollRestore.set(message.id, existingPre.scrollTop);
  }
  if (existing && canStreamInPlace(existing, message)) {
    updateStreamingMessageNode(existing, message);
    existing.dataset.renderKey = renderKey;
    return existing;
  }
  const node = messageRenderer.render(message);
  node.dataset.messageId = message.id;
  node.dataset.renderKey = renderKey;
  return node;
}

function messageNodeRenderKey(message) {
  return `${messageRenderer.renderKey(message)}:${expandedMessages.has(message.id) ? 1 : 0}:${aboveComposer.isCollapsed(message.id) ? 1 : 0}`;
}

function canStreamInPlace(existing, message) {
  if (message.role === "tool") {
    const needsLoadButton = Boolean(message.textTruncated);
    const hasLoadButton = Boolean(existing.querySelector(".cmdLoadFull"));
    if (needsLoadButton !== hasLoadButton) return false;
    return Boolean(existing?.querySelector(".cmdOutputWrap pre")) && !existing.querySelector(".messageImage");
  }
  if (!message?.streaming) return false;
  if (message.role !== "assistant" || message.kind !== "text") return false;
  if (messageEditor.matches(message)) return false;
  if (imagesForMessage(message, String(message.text || "")).length) return false;
  if (!existing) return false;
  return Boolean(existing.querySelector(".bubble")) && !existing.querySelector(".messageImage");
}

function updateStreamingMessageNode(node, message) {
  if (message.role === "tool") {
    const pre = node.querySelector(".cmdOutputWrap pre");
    if (pre) {
      // 流式输出整体替换文本时保留用户当前滚动位置，防止“往回弹到开头”。
      const savedScrollTop = pre.scrollTop;
      const savedScrollLeft = pre.scrollLeft;
      pre.textContent = toolOutput(message);
      pre.scrollTop = savedScrollTop;
      pre.scrollLeft = savedScrollLeft;
    }
    // 状态标签也必须跟随最新消息：工具消息的 running→completed 不会重建节点，
    // 只能在这里同步，否则“正在运行命令”会一直挂到节点被重建为止。
    const statusKey = toolStatusKey(message);
    const stateLabel = node.querySelector(".cmdState");
    if (stateLabel) stateLabel.textContent = statusKey === "running" ? "正在运行命令" : "已运行";
    const toolBlock = node.querySelector(".toolBlock") || node;
    for (const candidate of ["running", "completed", "failed", "unknown"]) toolBlock.classList.remove(candidate);
    toolBlock.classList.add(statusKey);
    return;
  }
  const metaLabel = node.querySelector(".messageMeta span");
  if (metaLabel) metaLabel.textContent = `${roleLabel(message)} · 生成中`;
  const bubble = node.querySelector(".bubble");
  if (bubble) {
    if (annotationUI.renderStreaming(bubble, message)) return;
    bubble.textContent = String(message.text || "");
    bubble.dataset.streamOffset = String(message.text || "").length;
  }
}

function updateMessageDensity() {
  elements.messages.classList.remove("isSparse");
}

function isMobileView() {
  return window.matchMedia("(max-width: 768px), (pointer: coarse) and (max-width: 980px)").matches;
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${String(remainingMinutes).padStart(2, "0")}m`;
}

function togglePlanCollapsed(id) {
  if (!id) return;
  const message = state?.messages?.find((entry) => entry.id === id);
  if (message && !isPlanFixedAboveComposer(message)) {
    if (expandedMessages.has(id)) expandedMessages.delete(id);
    else expandedMessages.add(id);
  } else {
    aboveComposer.toggleCollapsed(id);
    return;
  }
  aboveComposer.invalidate();
  lastMessageKey = "";
  aboveComposer.render();
  renderMessages();
}

async function copyCodeBlock(button) {
  const wrap = button.closest(".codeBlockWrap");
  const code = wrap?.querySelector("code")?.textContent;
  if (typeof code !== "string") return;

  try {
    await writeClipboard(code);
  } catch {
    toast("复制失败，浏览器没有授权剪贴板。");
    return;
  }
  button.classList.add("copied");
  button.setAttribute("aria-label", "Copied");
  setTimeout(() => {
    button.classList.remove("copied");
    button.setAttribute("aria-label", "Copy");
  }, 2000);
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  const previousFocus = document.activeElement;
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  let ok = false;
  try {
    textarea.select();
    ok = document.execCommand("copy");
  } finally {
    textarea.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
  }
  if (!ok) throw new Error("copy failed");
}

function currentThread() {
  return (Array.isArray(state?.threads) ? state.threads : []).find((thread) => thread.id === state.currentThreadId);
}

function autosize() {
  elements.promptInput.style.height = "auto";
  const minHeight = isMobileView() ? 24 : 30;
  const maxHeight = composerInputMaxHeight();
  const nextHeight = Math.max(minHeight, Math.min(elements.promptInput.scrollHeight, maxHeight));
  elements.promptInput.style.height = `${nextHeight}px`;
  elements.promptInput.style.overflowY = elements.promptInput.scrollHeight > maxHeight ? "auto" : "hidden";
  updateComposerState();
  updateViewportSizing();
}

function composerInputMaxHeight() {
  if (!isMobileView()) return 180;
  const viewportHeight = window.visualViewport?.height || window.innerHeight || 640;
  return Math.round(Math.min(180, Math.max(64, viewportHeight * 0.25)));
}

function updateComposerState() {
  const connected = !awaitingSocketState && state?.codex?.status === "connected" && phoneConnection.isOpen();
  const hasText = Boolean(elements.promptInput.value.trim());
  // 右上角三点菜单：没有当前会话（新会话/未连接）时不显示。
  elements.threadMenuBtn.hidden = !Boolean(state?.currentThreadId);
  const hasImages = draftImages.length > 0;
  const hasContent = hasText || hasImages || draftAnnotations.length > 0;
  const running = currentThreadIsRunning();
  const submitting = Boolean(submissions.pending);
  const readingImages = pendingImageReads > 0;
  const editing = messageEditor.active;
  const blockedByApproval = Boolean(state?.approvals?.length);
  const stopMode = Boolean(!submitting && !interruptPending && !blockedByApproval && running && !hasContent);
  elements.sendBtn.disabled = submitting || readingImages || pendingSettings || interruptPending || blockedByApproval || !connected || (!hasContent && !running);
  elements.sendBtn.classList.toggle("isStop", stopMode);
  elements.sendBtn.classList.toggle("isSending", readingImages || interruptPending);
  elements.sendBtn.setAttribute("aria-label", blockedByApproval ? "等待审批" : readingImages ? "正在读取图片" : interruptPending ? "正在停止" : submitting ? "已发送" : stopMode ? "停止生成" : "发送");
  elements.promptInput.readOnly = submitting || (awaitingSocketState && !state);
  elements.uploadBtn.disabled = editing || submitting || readingImages || !connected;
  elements.imageInput.disabled = editing || submitting || readingImages || !connected;
  elements.attachmentTray.querySelectorAll(".attachmentRemove").forEach((button) => {
    button.disabled = editing || submitting || readingImages;
  });
  elements.messages.querySelectorAll(".editMessageButton").forEach((button) => {
    const target = timeline.messages().find((message) => messageTurnId(message) === button.dataset.editTurnId);
    button.disabled = !messageEditor.canEdit(target);
  });
  const inlineEditor = elements.messages.querySelector(".inlineMessageEditor");
  if (inlineEditor) {
    const inlineInput = inlineEditor.querySelector(".inlineMessageEditorInput");
    const inlineSubmit = inlineEditor.querySelector(".inlineMessageEditorSubmit");
    const editPending = submissions.pending?.payload?.type === "message:edit";
    if (inlineSubmit) {
      inlineSubmit.disabled = editPending || !String(inlineInput?.value || "").trim();
      inlineSubmit.textContent = editPending ? "发送中" : "发送";
    }
    inlineEditor.querySelector(".inlineMessageEditorCancel")?.toggleAttribute("disabled", editPending);
    if (inlineInput) inlineInput.readOnly = editPending;
  }
  elements.composer.classList.toggle("hasText", hasContent);
  elements.composer.classList.toggle("isStopMode", stopMode);
  elements.composer.classList.toggle("isSending", readingImages || interruptPending);
  elements.composer.classList.toggle("isReadingAttachments", readingImages);
  elements.attachmentTray.classList.toggle("show", hasImages);
  annotationUI.updateControls();
  updateOperationControls();
}

function currentThreadIsRunning() {
  return Boolean(state?.busy && state?.currentThreadId && (!state.activeTurnThreadId || state.activeTurnThreadId === state.currentThreadId));
}

async function hydratePersistedDrafts() {
  const restoreAtRevision = composerEditRevision;
  try {
    const { restoredSubmission } = await draftStore.hydratePersistedDrafts();
    draftHydrationComplete = true;
    if (state && composerEditRevision === restoreAtRevision && !submissions.pending) restoreDraft(currentDraftThreadId());
    const submission = draftStore.normalizePersistedSubmission(restoredSubmission);
    if (submission && !submissions.pending) {
      submissions.restorePersisted(submission);
      queryPendingSendResult();
    } else if (restoredSubmission && !submission) {
      void draftStore.deletePersistedSubmission();
    }
  } catch {
    draftHydrationComplete = true;
    toast("草稿存储失败，请勿关闭当前页面", { tone: "error", duration: 0, id: "draft-storage-error" });
  }
}

function deleteDraft(key) {
  draftStore.deleteDraft(key);
}

function displayThreadName(thread, fallback = "未命名会话") {
  if (!thread) return fallback;
  const serverName = cleanThreadDisplayName(thread.name || "");
  const preview = cleanThreadDisplayName(thread.preview || "");
  return !isGenericThreadName(serverName) ? serverName : preview || serverName || fallback;
}

function isGenericThreadName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return !normalized || [
    "未命名会话",
    "当前会话",
    "新会话",
    "新对话",
    "new thread",
    "new conversation",
    "untitled",
    "untitled thread",
    "unnamed thread"
  ].includes(normalized);
}

function cleanThreadDisplayName(value) {
  return cleanDisplayText(value, { stripIdeContext: true })
    .split(/\r?\n/)[0]
    .replace(/\s+(?:to|recipient)=functions\.[a-z0-9_.-]+[\s\S]*$/i, "")
    .trim();
}

function safeJsonParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function safeJsonObject(value) {
  const parsed = safeJsonParse(value, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function safeLocalStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeSessionStorageGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionStorageSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function openTokenDialog() {
  elements.tokenInput.value = "";
  if (!elements.tokenDialog.open) elements.tokenDialog.showModal();
  setTimeout(() => elements.tokenInput.focus(), 0);
}

function saveTokenAndConnect() {
  const nextToken = elements.tokenInput.value.trim();
  if (!nextToken) {
    toast("请输入连接口令", { tone: "warning" });
    return;
  }
  preferredReconnectThreadId = state?.currentThreadId || "";
  phoneConnection.invalidate();
  token = nextToken;
  safeLocalStorageSet("codex-phone-token", token);
  elements.tokenDialog.close();
  dismissToast("auth-error");
  resetRenderCache();
  connect();
}

function updateOperationControls() {
  const locked = Boolean(submissions.pending || pendingImageReads || pendingSettings);
  const threadListLocked = Boolean(submissions.pending || pendingImageReads);
  const connected = !awaitingSocketState && state?.codex?.status === "connected" && phoneConnection.isOpen();
  elements.newThreadBtn.disabled = locked || !connected;
  elements.threadList.querySelectorAll(".threadItem").forEach((button) => {
    button.disabled = threadListLocked || !connected;
  });
}

function requestApprovalResolution(approvalId, decision) {
  if (pendingApprovalId) return;
  pendingApprovalId = approvalId;
  approvalUI.render();
  updateComposerState();
  if (!send({ type: "approval:resolve", approvalId, decision }, "正在提交审批结果")) {
    clearPendingApproval();
    return;
  }
  approvalTimer = setTimeout(() => {
    clearPendingApproval();
    toast("审批提交超时，请重试", { tone: "error" });
  }, PASSIVE_OPERATION_TIMEOUT_MS);
}

function clearPendingApproval() {
  clearTimeout(approvalTimer);
  if (!pendingApprovalId) return;
  pendingApprovalId = "";
  approvalUI.invalidate();
  if (state) approvalUI.render();
  updateComposerState();
}

function setupViewportSizing() {
  updateViewportSizing();
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(updateViewportSizing);
    observer.observe(elements.composer);
    observer.observe(elements.aboveComposer);
    observer.observe(elements.approvalDock);
  }
  window.addEventListener("resize", () => {
    syncSidebarAccessibility();
    autosize();
    updateViewportSizing();
    if (!state) return;
    aboveComposer.invalidate();
    lastMessageKey = "";
    aboveComposer.render();
    renderMessages();
  }, { passive: true });
  window.visualViewport?.addEventListener("resize", () => {
    autosize();
    updateViewportSizing();
  }, { passive: true });
  window.visualViewport?.addEventListener("scroll", updateViewportSizing, { passive: true });
}

function updateViewportSizing() {
  viewportKeepBottom ||= Boolean(state && !annotationUI.hasActiveSelection() && messageScroll.autoStickEnabled() && messageScroll.atBottom(24));
  if (viewportFrame) cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = null;
    const keepBottom = viewportKeepBottom && !annotationUI.hasActiveSelection();
    viewportKeepBottom = false;
    const viewport = window.visualViewport;
    const viewportHeight = Math.ceil(viewport?.height || window.innerHeight || 0);
    const layoutHeight = Math.ceil(window.innerHeight || viewportHeight || 0);
    const keyboardInset = Math.max(0, layoutHeight - viewportHeight - Math.ceil(viewport?.offsetTop || 0));
    if (primaryInputKeyboardBottom !== null && !document.body.classList.contains("annotationEditing") &&
        document.activeElement !== elements.promptInput && viewportHeight + (viewport?.offsetTop || 0) >= primaryInputKeyboardBottom) {
      primaryInputKeyboardBottom = null;
    }
    document.body.classList.toggle("keyboardOpen", isMobileView() && keyboardInset > 120);
    const composerHeight = Math.ceil(elements.composer.getBoundingClientRect().height || 96);
    const aboveComposerHeight = Math.ceil(elements.aboveComposer.getBoundingClientRect().height || 0);
    const approvalHeight = Math.ceil(elements.approvalDock.getBoundingClientRect().height || 0);
    const topbarHeight = Math.ceil(elements.topbar.getBoundingClientRect().height || 56);
    document.documentElement.style.setProperty("--composer-height", `${composerHeight}px`);
    document.documentElement.style.setProperty("--above-composer-height", `${aboveComposerHeight}px`);
    document.documentElement.style.setProperty("--approval-height", `${approvalHeight}px`);
    document.documentElement.style.setProperty("--topbar-height", `${topbarHeight}px`);
    if (viewportHeight) document.documentElement.style.setProperty("--visual-viewport-height", `${viewportHeight}px`);
    if (keepBottom) {
      requestAnimationFrame(() => {
        if (annotationUI.hasActiveSelection()) return;
        // 用户已经离开底部时不再强制回底，避免布局变化把用户拉回去。
        const distanceFromBottom = Math.max(0, elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight);
        if (distanceFromBottom > 8 && !messageScroll.autoStickEnabled()) return;
        elements.messages.scrollTop = elements.messages.scrollHeight;
        messageScroll.updateBottomButton();
      });
    }
    messageScroll.updateBottomButton();
  });
}

function toast(message, options = {}) {
  const text = String(message || "").trim();
  if (!text) return null;
  const tone = options.tone || "info";
  const id = options.id || `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  dismissToast(id);

  const item = document.createElement("div");
  item.className = `toast ${tone}`;
  item.dataset.toastId = id;
  item.setAttribute("role", tone === "error" ? "alert" : "status");
  const copy = document.createElement("span");
  copy.className = "toastMessage";
  copy.textContent = text;
  item.append(copy);

  if (options.actionLabel && typeof options.onAction === "function") {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "toastAction";
    action.textContent = options.actionLabel;
    action.addEventListener("click", () => {
      dismissToast(id);
      options.onAction();
    });
    item.append(action);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toastClose";
  close.setAttribute("aria-label", "关闭提示");
  close.textContent = "×";
  close.addEventListener("click", () => dismissToast(id));
  item.append(close);
  elements.toastRegion.append(item);

  while (elements.toastRegion.children.length > 4) elements.toastRegion.firstElementChild?.remove();
  const duration = options.duration === 0 ? 0 : Number(options.duration || (tone === "error" ? 6000 : 2400));
  if (duration > 0) item.dismissTimer = setTimeout(() => dismissToast(id), duration);
  return id;
}

function dismissToast(id) {
  const item = Array.from(elements.toastRegion.children).find((node) => node.dataset.toastId === id);
  if (!item) return;
  clearTimeout(item.dismissTimer);
  item.remove();
}

function formatTime(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const milliseconds = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(milliseconds));
}
