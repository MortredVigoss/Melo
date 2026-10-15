import { t, ui } from './i18n.js';
import { installLanguageControls } from './languageControls.js';
import { renderExtraFast, editExtraFast, handleExtraFast } from './extraFast.js';
import { decodeBootstrap, olderBootstrap, changedBootstrapSections, pageAffected } from './bootstrapPatch.js';
import { EditSession, createSettingsFormEditors, installUnsavedSettingsGuard } from './settingsEdit.js';
import { renderMemoryFacts } from './memoryFacts.js';
import { renderLocalSettings, installLocalSettings, applyLocalAppearance, shouldSendOnEnter, notifyLocalCompletion, nativeSettings } from './localSettings.js';
import { renderSyncConflicts } from './syncConflicts.js';
import { renderConversationContext } from './conversationContext.js';
import { renderAgentAvatar, readAgentAvatar } from './agentAvatar.js';
import { renderReplyDocument, replyPlainText } from './replyDocument.js';
import { renderImageSettings, renderImageTaskControls, consumeImageTask, restoreImageTask, clearImageTask, handleImageInput, handleImageAction } from './imageControls.js';
import { createVoiceInput, voiceInputSupported, voiceInputActive, voiceInputLabel, renderVoiceInput } from './voiceInput.js';
import { renderLlmConnections, editLlmConnection, handleLlmConnection } from './llmConnections.js';
import { renderAtomicButton } from './atomicButton.js';
import { renderExecutionPanel, syncExecutionPanel, receiveExecutionScene, renderSceneReplay, selectedMessagePresentation } from './executionPanel.js';
import { DEFAULT_MODELS_BY_AUTH_MODE } from '/shared/modelCatalog.js';
import { modelLabel, modelPanelPosition, conversationAgents, conversationAgent, conversationConnectionReady, renderModelPicker, renderModelReceipt, connectionModelOptions, renderDefaultModelSettings } from './modelPresentation.js';
import { createTurnPresentation, receiveTurnPresentation, turnLabel, chatStreamError } from './turnPresentation.js';
import { updateNeuralWorkspace, syncNeuralComposer, preserveNeuralRegion } from './neuralDom.js';
import { resolveWorkspaceStage } from './neuralLayout.js';
import { captureNeuralLayout, animateNeuralLayout } from './neuralMotion.js';
import { neuralGroups, groupForSettings, renderNeuralNavigation, renderNeuralOverview, syncNeuralScene } from './neuralShell.js';
import {
  renderVizMountHtml,
  mountVizBlocks,
  isRenderableViz,
} from './viz/vizRenderer.js';
import {
  renderInlineSegmentWithCites,
  installCitationDrawer,
  resetCitationPreviewCache,
} from './viz/citationRenderer.js';
import { promoteTextUrlsToAttachments } from '/shared/urlDetector.js';
import { extractTextUrls } from '/shared/textUrls.js';
import { renderCopyLinkButton, copyLinkText } from './linkActions.js';
import { resolveActiveMinimaxVoiceId } from '/shared/minimaxVoiceResolver.js';
import { describeAudioExtractionStatus, describeVideoExtractionStatus } from './videoStatus.js';
import { renderAdvancedPage } from './advancedPage.js';
import { renderAttachmentCards } from './attachmentCards.js';
import { createSearchPageRenderer } from './searchPage.js';
import { createScrollPreservation } from './scrollPreservation.js';
import { buildAgentProfilePatch } from './agentProfilePatch.js';
import { routeHttpUrlClick } from './anchorRouting.js';
import { selectTtsBridgeCallback } from './ttsBridgeRouter.js';
import { createReplyDelivery, receiveReplyDelivery } from './replyDelivery.js';
import { renderActiveToolCallsStrip as _renderActiveToolCallsStripFromModule } from './activeToolCallsStrip.js';
import { renderMessageToolResults as _renderMessageToolResultsFromModule } from './messageToolResults.js';
import {
  UNDO_TOAST_DEFAULT_MS,
  formatUndoToastLabel,
  nextCountdownTickMs,
} from './undoToast.js';
import { agentDocumentWithPreset, agentDraftFromProfile, normalizeChannelsForDraft } from './agentDraft.js';
import { buildConnectorDraft, pickConnectorField, buildAutosaveBody } from './connectorDraft.js';
import { applyFormInputToDraft } from './connectorDraftDispatch.js';
import { credentialChipState, CREDENTIAL_FIELDS, clearCommittedSecrets } from './credentialChip.js';
import { decideAgentMcpAuthAction } from './agentMcpAuthorise.js';
import {
  decideFileSafetyPreflight,
  decideFileSafetyResponseAction,
} from './fileSafetyResponse.js';

const app = document.querySelector('#app');
const memoryFactEdit = new EditSession();
const settingsFormEditors = createSettingsFormEditors({render,
  ownsDraft: form => form.dataset.form === 'agent-profile-update',
  scope: form => form.dataset.agentId ? agentDraftKey(form.dataset.agentId) : form.dataset.form==='task-pricing' ? uiState.bootstrap?.settings?.config?.model || '' : '',
  onCancel: form => {
    if(form.dataset.agentId) delete uiState.agentDrafts[agentDraftKey(form.dataset.agentId)];
    if(form.dataset.form==='task-pricing') uiState.taskPricing=null;
    if(['connector-config','model-config'].includes(form.dataset.form)) clearModelFormDraft(form);
  },
});
settingsFormEditors.install(document);
document.addEventListener('toggle', event => {
  const key = event.target.dataset?.agentSection;
  if (key) uiState.agentOpenSections[key] = event.target.open;
}, true);
installUnsavedSettingsGuard(window);


const uiState = {
  neuralGroup: null,
  neuralOverview: true,
  neuralExpanded: false,
  neuralStill: false,
  bootstrap: null,
  loading: true,
  sending: false,
  sendAbortController: null,
  activeTurn: null,
  modelPickerOpen: false,
  modelPickerSaving: false,
  thinkingSince: 0,
  searchLoading: false,
  searchFileLoading: false,
  searchFileHits: [],
  // When the user clicks a search result that carries a specific matching
  // line, we stash { filePath, line } here so the post-render hook can
  // scroll the file preview to that line.  Cleared after a successful scroll
  // so re-rendering the same file later doesn't keep jumping the viewport.
  pendingGoToLine: null,
  // Per-file-group toggle state for the search results sub-list.  Keys are
  // filePath strings; value = true means "show the per-line hits under the
  // group".  We keep this outside of `searchFileHits` because those records
  // are replaced wholesale every time a group re-streams.
  expandedSearchGroups: {},
  composer: '',
  composerHistoryIndex: -1,
  composerHistoryDraft: '',
  projectSearch: '',
  chatSearch: '',
  searchQuery: '',
  // Phase 3.3.2 — Customize → Skills filter state. `query` is a free-form
  // search over name/description/tags/triggers. `tag` narrows to skills
  // that carry a specific tag (null = no tag filter). `state` is one of
  // 'all' | 'enabled' | 'disabled' | 'custom' | 'builtin' | 'disk'.
  skillFilter: {
    query: '',
    tag: null,
    state: 'all',
  },
  // Phase 3.3.3 — slash-command palette for the composer. Shown when the
  // composer value starts with "/<query>". Lists enabled skills whose id
  // or name matches the query; clicking an entry inserts "/<skill-id> "
  // into the composer so the user can keep typing arguments.
  slashPalette: {
    open: false,
    query: '',
    selectedIndex: 0,
  },
  // Phase 3.3.4 — skill-run telemetry shown in the Customize → Skills
  // health panel. Lazily populated when the user opens the Skills tab;
  // `loading` guards concurrent refetches.
  skillRunStats: {
    loading: false,
    loaded: false,
    skills: [],
    error: null,
  },
  // Phase 3 — Customize → Memory panel. Lazily populated on first open.
  // `snapshot` is the response from /api/memory/status; `wipeConfirmOpen`
  // gates the destructive wipe-embeddings dialog so a single click can't
  // drop vectors by accident.  `skillMarkdown` caches per-skill exported
  // SKILL.md text so switching between tabs doesn't refetch every click.
  memoryStatus: {
    loading: false,
    loaded: false,
    snapshot: null,
    error: null,
    wipeConfirmOpen: false,
    wipeInFlight: false,
    wipeResult: null,
  },
  // File-safety persistent allowlist (Phase 3b/3c). Lazy-loaded on first
  // navigation to the Safety section; refresh-on-demand otherwise.
  safetyAllowlist: {
    loading: false,
    loaded: false,
    rules: [],
    error: null,
    pendingRemoveId: null,
  },
  // Domain cookies (Phase 4 — Xiaohongshu/Douyin extraction reliability).
  // Lives in the Safety section alongside the file-safety allowlist
  // because both are persistent grants the user trades for capability.
  // The list-side never returns cookie values — only host + length +
  // tail preview — so the DOM never holds the session secret.
  domainCookies: {
    loading: false,
    loaded: false,
    hosts: [],
    error: null,
    addHost: '',
    addCookie: '',
    addInFlight: false,
    addError: '',
    pendingRemoveHost: null,
  },
  // Advanced page (developer / experimental ops). Caches CLI MCP server
  // names, plugin registry, and background-task list — none of these
  // ride on bootstrap, so we lazy-fetch on first navigation and keep the
  // values around until an explicit Refresh.
  advanced: {
    loading: false,
    loaded: false,
    error: null,
    cliServers: [],
    plugins: [],
    tasks: [],
    diagnostics: null,
  },
  // Phase 3 — Skill detail tab: 'overview' (default) or 'markdown'.
  skillDetailTab: 'overview',
  // Cache: skillId → { loading, markdown, error }.  Cleared on import/reload.
  skillMarkdown: {},
  showProjectForm: false,
  showArtifactForm: false,
  selectedArtifactId: null,
  fileEditMode: false,
  fileDraftPath: null,
  fileDraftContent: '',
  draftProject: {
    name: '',
    tag: '',
    summary: '',
    instructions: '',
    workspacePath: '',
  },
  draftArtifact: {
    title: '',
    language: 'markdown',
    kind: 'note',
    content: '',
  },
  // When non-null, the artifact detail panel renders an edit form
  // pre-filled from `editingArtifactDraft` instead of the read-only
  // preview. Set by `start-edit-artifact`, cleared by save/cancel.
  editingArtifactId: null,
  editingArtifactDraft: {
    title: '',
    language: '',
    kind: '',
    content: '',
  },
  showTaskForm: false,
  draftTask: {
    title: '',
    summary: '',
    owner: 'builder',
    kind: 'task',
  },
  modelSetupDraft: null,
  modelCatalogLoading: false,
  agentEditorTab: 'identity',
  // Map of agentId → active channel tab ('telegram' | 'discord' | 'lark').
  // Defaults to 'telegram' on first read. Used by the channels section to
  // show one channel at a time filling the full panel width.
  agentChannelTab: {},
  agentDrafts: {},
  agentCreating: false,
  agentOpenSections: {},
  agentSaveStates: {},
  agentSecretVisibility: {},
  commandInputs: {},
  commandPalette: {
    open: false,
    query: '',
    selectedIndex: 0,
  },
  voice: {
    supported: voiceInputSupported(),
    recording: false,
    status: 'idle',
    preview: '',
    error: '',
  },
  composerAttachments: [],
  composerAttachmentMenuOpen: false,
  // Task panel "Run agent" overflow menu — shows main as the primary
  // button and tucks research/builder/reviewer behind a "⋯" dropdown so
  // the lane row doesn't sprout four equal-weight chips.
  taskLaneOverflowOpen: false,
  composerDragActive: false,
  highlightedMessageId: null,
  shouldFocusSearch: false,
  lastThreadScrollSignature: '',
  lastThreadChatId: null,
  threadAutoFollow: true,
  agentListScrollTop: 0,
  agentDetailScrollTops: {},
  agentEditorStates: {},
  shouldFocusAgentEditor: false,
  streamingChatId: null,
  streamingAssistantText: '',
  // Pending voice transcript to be pre-attached when auto-submitting a voice message.
  // Set to null when not in a voice-submit flow.
  composerVoiceTranscript: null,
  // Stable id linking the voice audio attachment to its prefilled transcript
  // entry. describeAudioExtractionStatus matches transcript→attachment by id,
  // so without this the just-transcribed voice message would mis-render as
  // "transcript unavailable" (2026-05-23 Codex C 闭环).
  composerVoiceAttachmentId: null,
  error: '',
  // Tool execution UI state
  // pendingToolPermissions: array of one dialog descriptor per pending request.
  // Two shapes share this queue, distinguished by `kind`:
  //   - tool-runner   { kind: 'tool',         requestId, toolId, args }
  //   - file-safety   { kind: 'file_safety',  requestId, operation, payload }
  pendingToolPermissions: [],
  // activeToolCalls: array of { id, name, arguments, status:'running'|'ok'|'error', output? }
  activeToolCalls: [],
  // TTS state
  ttsAutoPlay: localStorage.getItem('melo-tts-autoplay') === '1',
  ttsSpeakingMessageId: null,
  ttsSpeakingLoadingId: null,  // button is loading (synthesis pending), not yet playing
  ttsVoicePanelOpen: false,
  // 'auto' = try API then fallback to browser; 'api' = API only;
  // 'browser' = speechSynthesis only (in-page, dropdown picks browser voice);
  // 'macos'   = /usr/bin/say only (host speakers, dropdown picks macOS voice).
  // Legacy values 'browser' from old builds may have meant either path
  // depending on whether /api/tts/native succeeded — settings panel now
  // disambiguates explicitly.
  ttsEngine: localStorage.getItem('melo-tts-engine') || 'auto',
  ttsApiVoice: localStorage.getItem('melo-tts-api-voice') || 'nova',
  ttsBrowserVoiceName: localStorage.getItem('melo-tts-browser-voice') || '',
  ttsBrowserVoices: [],
  ttsMacosVoiceName: localStorage.getItem('melo-tts-macos-voice') || '',
  ttsMacosVoices: [],   // populated lazily on panel open via /api/tts/say-voices
  ttsMacosVoicesLoaded: false,
  ttsEdgeVoice: localStorage.getItem('melo-tts-edge-voice') || '',
  ttsCustomVoiceId: localStorage.getItem('melo-tts-custom-voice-id') || '',
  // Active chat agent — which agent handles new chats from the home screen
  activeChatAgentId: localStorage.getItem('melo-active-chat-agent') || 'main',
  newChatModel: null,
  newChatArtifactIds: [],
  newChatProjectId: null,
  showArchivedProjects: false,
  agentSelectorOpen: false,
  // Scroll position saved before re-render for position restoration
  lastKnownScrollTop: 0,
  // Anchor captured before an innerHTML swap so viz cards' async hydration
  // doesn't pull the user's viewport away from the message they were
  // reading. { messageId, viewportOffset } — see captureThreadAnchor().
  pendingVizAnchor: null,
};

let contentScrollbarHideTimer = 0;
let activeSearchFileSource = null;
let activeSearchFileSequence = 0;
let activeEditableContextTarget = null;
let activeCopyContextTarget = null;
let activeRecentContextChatId = null;
let activeAudioContextUrl = null;
let agentMarkdownAutosaveTimer = 0;
let agentMarkdownAutosaveSequence = 0;
let pendingAgentMarkdownAutosave = null;
let agentMarkdownLastInteractionAt = 0;
let agentChannelAutosaveTimer = 0;
let agentChannelAutosaveSequence = 0;
let pendingAgentChannelAutosave = null;
let agentRuntimeRefreshTimer = 0;
const AGENT_MARKDOWN_AUTOSAVE_IDLE_MS = 900;

// ─── Global typing guard ─────────────────────────────────────────────────────
// Whenever the user hits a key in ANY input/textarea (anywhere in the app),
// stamp `now` on `lastUserKeystrokeAt`. Background-initiated renders
// (autosave round-trips landing, 4s runtime poll, toast timers, voice-panel
// spinner, etc.) check this stamp before doing a full innerHTML swap and
// defer if a keystroke landed in the last N ms — because a render mid-typing
// wipes document.activeElement, which is what causes the "caret jumps to
// another field" symptom the user kept reporting across multiple rounds of
// partial fixes. The 500 ms threshold is tuned to feel instant on human
// timescales while being much longer than any single keystroke's frame time.
// The deferred render is scheduled via `scheduleDeferredRender` below so we
// don't drop it — it fires as soon as the user goes idle.
let lastUserKeystrokeAt = 0;
let lastUserScrollAt = 0;
let deferredRenderPending = false;
let deferredRenderTimer = 0;
const TYPING_GUARD_WINDOW_MS = 500;
const TYPING_GUARD_DEFER_CHECK_MS = 120;
// Scroll guard window — must cover macOS trackpad momentum scroll, which
// can decay over 1-2 seconds after the user lifts their fingers. The first
// version used 250 ms (felt right for keyboard cadence), but user-tested
// 2026-05-05 still saw cut-off mid-momentum because trackpad inertia ran
// past the window. 1500 ms covers typical momentum settle time without
// noticeably delaying eventually-needed background renders (deferred
// renders fire as soon as the user is idle for one tick interval).
const SCROLL_GUARD_WINDOW_MS = 1500;

function userIsActivelyTyping() {
  if (!lastUserKeystrokeAt) return false;
  return Date.now() - lastUserKeystrokeAt < TYPING_GUARD_WINDOW_MS;
}

function userIsActivelyScrolling() {
  if (!lastUserScrollAt) return false;
  return Date.now() - lastUserScrollAt < SCROLL_GUARD_WINDOW_MS;
}

function scheduleDeferredRender() {
  if (deferredRenderPending) return;
  deferredRenderPending = true;
  const tick = () => {
    if (userIsActivelyTyping() || userIsActivelyScrolling()) {
      deferredRenderTimer = window.setTimeout(tick, TYPING_GUARD_DEFER_CHECK_MS);
      return;
    }
    deferredRenderPending = false;
    deferredRenderTimer = 0;
    // Deferred path is itself a background render — keep recursing the same
    // guard until the user is truly idle (otherwise a sustained typing burst
    // every 400 ms would bypass the guard on the first tick we happen to
    // sample between keystrokes).
    render({ background: true });
  };
  deferredRenderTimer = window.setTimeout(tick, TYPING_GUARD_DEFER_CHECK_MS);
}

const icon = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  search:
    '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  sliders:
    '<svg viewBox="0 0 24 24"><path d="M4 7h16M7 7v8M4 17h16M17 17V9"/></svg>',
  bubble:
    '<svg viewBox="0 0 24 24"><path d="M5 18.5V6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H9l-4 3.5Z"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6A2.5 2.5 0 0 1 20.5 9.5v8A2.5 2.5 0 0 1 18 20H6A2.5 2.5 0 0 1 3.5 17.5Z"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21 4 16.5v-9Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>',
  wand: '<svg viewBox="0 0 24 24"><path d="m4 20 10-10"/><path d="m14 4 1 3 3 1-3 1-1 3-1-3-3-1 3-1Z"/><path d="m18 14 .5 1.5L20 16l-1.5.5L18 18l-.5-1.5L16 16l1.5-.5Z"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M4 12 20 4l-4 16-4.5-5.5Z"/><path d="M20 4 9.5 14.5"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V7a3 3 0 0 1 3-3Z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3M8 21h8"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
  dots: '<svg viewBox="0 0 24 24"><circle cx="6.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="17.5" cy="12" r="1.4"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="6" y="11" width="12" height="9" rx="2"/><path d="M8.5 11V8.8a3.5 3.5 0 1 1 7 0V11"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  chevronLeft: '<svg viewBox="0 0 24 24"><path d="m15 6-6 6 6 6"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20 16-4.5-4.5L7 20"/></svg>',
  video: '<svg viewBox="0 0 24 24"><rect x="3.5" y="6" width="12.5" height="12" rx="2"/><path d="m16 10 4.5-2.5v9L16 14"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M12 6v12"/><path d="M8 9v6"/><path d="M16 9v6"/><path d="M4 11v2"/><path d="M20 11v2"/></svg>',
  spark:
    '<svg viewBox="0 0 24 24"><path d="M12 2v5M12 17v5M2 12h5M17 12h5M4.9 4.9l3.5 3.5M15.6 15.6l3.5 3.5M19.1 4.9l-3.5 3.5M8.4 15.6l-3.5 3.5"/></svg>',
  chip:
    '<svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/><path d="M7 12H4M20 12h-3M12 7V4M12 20v-3"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4v13H7A2.5 2.5 0 0 1 4.5 18V6A2.5 2.5 0 0 1 7 3.5Z"/><path d="M14 3.5V8h4"/></svg>',
  terminal:
    '<svg viewBox="0 0 24 24"><path d="M5 6.5h14A1.5 1.5 0 0 1 20.5 8v8A1.5 1.5 0 0 1 19 17.5H5A1.5 1.5 0 0 1 3.5 16V8A1.5 1.5 0 0 1 5 6.5Z"/><path d="m7 10 2 2-2 2M11.5 14H16"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="m10 14 4-4"/><path d="M7.5 15.5 5 18a3 3 0 1 1-4.2-4.2L3.3 11.3"/><path d="m16.5 8.5 2.5-2.5a3 3 0 1 1 4.2 4.2l-2.5 2.5"/></svg>',
  speak: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a9 9 0 0 1 0 12"/></svg>',
  speakOff: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5 10.5 19"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M5 4.5h12l2.5 2.5V19A1.5 1.5 0 0 1 18 20.5H6A1.5 1.5 0 0 1 4.5 19V6A1.5 1.5 0 0 1 6 4.5Z"/><path d="M8 4.5v6h8v-6M8 20v-5.5h8V20"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff:
    '<svg viewBox="0 0 24 24"><path d="M3 3 21 21"/><path d="M10.6 10.7A3 3 0 0 0 13.3 13.4"/><path d="M9.9 5.3A10.8 10.8 0 0 1 12 5c6 0 9.5 7 9.5 7a17.6 17.6 0 0 1-3.2 3.7"/><path d="M6.2 6.2A17.1 17.1 0 0 0 2.5 12s3.5 7 9.5 7c1.5 0 2.8-.3 4-.8"/></svg>',
};

const HOME_PROMPT_PRESETS = [
  {
    id: 'write',
    label: 'Write',
    mode: 'chat',
    prompt: 'Help me write a clear and polished message about ',
  },
  {
    id: 'learn',
    label: 'Learn',
    mode: 'cowork',
    prompt: 'Teach me this step by step: ',
  },
  {
    id: 'code',
    label: 'Code',
    mode: 'code',
    prompt: 'Help me debug, build, or explain this code task: ',
  },
  {
    id: 'life',
    label: 'Life stuff',
    mode: 'chat',
    prompt: 'Help me think through this practical life task: ',
  },
  {
    id: 'melo-choice',
    label: "Melo's choice",
    mode: '',
    prompt: 'Choose the best way to approach this and help me get started: ',
  },
];

const MODEL_SETUP_DEFAULTS = {
  local: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.1',
  },
  'api-key': {
    baseUrl: 'https://api.openai.com/v1',
    model: DEFAULT_MODELS_BY_AUTH_MODE['api-key'],
  },
  codex: {
    baseUrl: 'https://chatgpt.com/backend-api',
    model: DEFAULT_MODELS_BY_AUTH_MODE.codex,
  },
};

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function truncate(value = '', max = 180) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isAbortError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error.name === 'AbortError' || error.code === 'ABORT_ERR'),
  );
}

function thinkingLabel() {
  if (!uiState.sending) {
    return '';
  }

  const label = turnLabel(uiState.activeTurn, { permission: uiState.pendingToolPermissions.length > 0, tools: uiState.activeToolCalls.some(tool => tool.status === 'running') });
  if (!uiState.thinkingSince) return label;

  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - uiState.thinkingSince) / 1000),
  );
  return elapsedSeconds > 0 ? `${label} · ${elapsedSeconds}s` : label;
}

function parseRenderableMessageBlocks(value = '') {
  const blocks = [];
  const source = String(value || '');
  const pattern = /```([\w.+-]+)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(source))) {
    const [raw, language = '', block = ''] = match;
    const before = source.slice(lastIndex, match.index);
    if (before.trim()) {
      blocks.push({ type: 'text', value: before });
    }
    blocks.push({ type: 'code', language, value: block.trim() });
    lastIndex = match.index + raw.length;
  }

  const tail = source.slice(lastIndex);
  if (tail.trim() || !blocks.length) {
    blocks.push({ type: 'text', value: tail || source });
  }

  return blocks;
}

function normalizeDisplayConversationText(value = '') {
  // Defense-in-depth: the backend's extractVizSpec() strips the trailer
  // before persisting, but if one ever slips through (old messages, a
  // provider that returned partial text, etc.) we still don't want the
  // raw <viz-spec>…</viz-spec> JSON blob rendered in the chat bubble.
  const preStripped = String(value || '').replace(/<viz-spec>[\s\S]*?<\/viz-spec>/gi, '');
  const normalized = preStripped.replace(/\r\n/g, '\n');
  const strippedLines = normalized
    .split('\n')
    .map(line =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .replace(/^\s*---+\s*$/, ''),
    )
    .join('\n');

  return strippedLines
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(
      /(^|[\s([{"'“‘（【《「『])\*([^*\n]+)\*(?=$|[\s)\]}.,!?;:'"”’）】》」』，。！？；：、])/gu,
      '$1$2',
    )
    .replace(
      /(^|[\s([{"'“‘（【《「『])_([^_\n]+)_(?=$|[\s)\]}.,!?;:'"”’）】》」』，。！？；：、])/gu,
      '$1$2',
    )
    .replace(/(^|[\s([{"'“‘（【《「『])([*_#~]{1,3})(?=[\p{L}\p{N}\p{Script=Han}])/gu, '$1')
    .replace(/(?<=[\p{L}\p{N}\p{Script=Han}])([*_#~]{1,3})(?=$|[\s)\]}.,!?;:'"”’）】》」』，。！？；：、])/gu, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderTextBlock(value = '') {
  return renderReplyDocument(String(value).replace(/<viz-spec>[\s\S]*?<\/viz-spec>/gi, ''), renderInlineText, escapeHtml);
}

function renderRichText(value = '') {
  return parseRenderableMessageBlocks(value)
    .map(block => {
      if (block.type === 'code') {
        return ui`
          <div
            class="message-code-block"
            data-copyable-surface
            data-copy-text="${escapeHtml(block.value)}"
          >
            ${
              block.language
                ? ui`<div class="message-code-label">${escapeHtml(block.language)}</div>`
                : ''
            }
            <pre><code data-language="${escapeHtml(block.language)}">${escapeHtml(block.value)}</code></pre>
          </div>
        `;
      }

      return renderTextBlock(block.value);
    })
    .join('');
}

function formatRuntimeTimestamp(value, fallback = 'Not yet') {
  if (!value) {
    return fallback;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  const diffMs = Math.max(0, Date.now() - parsed);
  const diffSeconds = Math.round(diffMs / 1000);
  if (diffSeconds < 5) {
    return 'Just now';
  }
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function renderChannelRuntimeMetric(label, value) {
  return ui`
    <div class="agent-runtime-metric">
      <div class="agent-runtime-metric-label">${escapeHtml(label)}</div>
      <div class="agent-runtime-metric-value">${escapeHtml(value || '—')}</div>
    </div>
  `;
}

function renderChannelRuntimeCard(channel, { showRoute = false } = {}) {
  const incomingPreview = channel?.lastIncomingPreview || '';
  const replyPreview = channel?.lastReplyPreview || '';

  return ui`
    <div class="agent-channel-runtime">
      <div class="agent-editor-header">
        <div class="agent-editor-heading">
          <div class="meta-block-label">Runtime</div>
          <div class="list-row-meta">Live polling and recent Telegram activity for this agent.</div>
        </div>
        <span class="chip ${channel?.statusLabel === 'Polling live' ? 'is-accent' : ''}">
          ${escapeHtml(channel?.runtimeLabel || 'Disabled')}
        </span>
      </div>
      <div class="agent-channel-runtime-grid">
        ${renderChannelRuntimeMetric('Bot', channel?.botLabel || 'Unknown bot')}
        ${renderChannelRuntimeMetric('Status', channel?.statusLabel || 'Not checked')}
        ${renderChannelRuntimeMetric('Last checked', channel?.lastCheckedLabel || formatRuntimeTimestamp(channel?.lastCheckedAt))}
        ${renderChannelRuntimeMetric('Last poll', channel?.lastPolledLabel || formatRuntimeTimestamp(channel?.lastPolledAt, 'No recent poll'))}
        ${renderChannelRuntimeMetric('Last incoming', channel?.lastIncomingLabel || formatRuntimeTimestamp(channel?.lastIncomingAt, 'No incoming messages yet'))}
        ${renderChannelRuntimeMetric('Last reply', channel?.lastReplyLabel || formatRuntimeTimestamp(channel?.lastReplyAt, 'No replies sent yet'))}
        ${
          showRoute
            ? renderChannelRuntimeMetric('Default route', channel?.chatId || channel?.lastRemoteChatId || 'Not pinned')
            : ''
        }
      </div>
      ${
        incomingPreview || replyPreview
          ? ui`
            <div class="agent-runtime-preview-stack">
              ${
                incomingPreview
                  ? ui`
                    <div class="agent-runtime-preview-card">
                      <div class="agent-runtime-preview-label">Last incoming</div>
                      <div class="agent-runtime-preview-copy">${escapeHtml(incomingPreview)}</div>
                    </div>
                  `
                  : ''
              }
              ${
                replyPreview
                  ? ui`
                    <div class="agent-runtime-preview-card">
                      <div class="agent-runtime-preview-label">Last reply</div>
                      <div class="agent-runtime-preview-copy">${escapeHtml(replyPreview)}</div>
                    </div>
                  `
                  : ''
              }
            </div>
          `
          : ''
      }
    </div>
  `;
}

function normalizeRenderableMessageBlock(block) {
  if (!block || typeof block !== 'object') {
    return null;
  }

  const type = block.type === 'code' ? 'code' : 'text';
  const text =
    typeof block.text === 'string'
      ? block.text
      : typeof block.value === 'string'
        ? block.value
        : '';

  if (!String(text).trim()) {
    return null;
  }

  return {
    type,
    language:
      type === 'code'
        ? String(block.language || '').trim()
        : '',
    text,
  };
}

function messageBlocksForRender(message) {
  const persistedBlocks = Array.isArray(message?.blocks)
    ? message.blocks
        .map(normalizeRenderableMessageBlock)
        .filter(Boolean)
    : [];

  if (persistedBlocks.length) {
    return persistedBlocks;
  }

  return parseRenderableMessageBlocks(message?.content || '')
    .map(block => ({
      type: block.type === 'code' ? 'code' : 'text',
      language: block.type === 'code' ? String(block.language || '').trim() : '',
      text: String(block.value || ''),
    }))
    .map(normalizeRenderableMessageBlock)
    .filter(Boolean);
}

function renderMessageBlocks(message) {
  const blocks = messageBlocksForRender(message);
  if (!blocks.length) {
    return '';
  }

  // Collect citations from all text blocks in assistant messages
  const isAssistant = message?.role === 'assistant';
  const allCitations = [];

  const renderedBlocks = blocks
    .map(block => {
      if (block.type === 'code') {
        return ui`
          <div
            class="message-code-block"
            data-copyable-surface
            data-copy-text="${escapeHtml(block.text)}"
          >
            ${
              block.language
                ? ui`<div class="message-code-label">${escapeHtml(block.language)}</div>`
                : ''
            }
            <pre><code data-language="${escapeHtml(block.language)}">${escapeHtml(
              block.text,
            )}</code></pre>
          </div>
        `;
      }

      let textForDisplay = block.text;
      if (isAssistant) {
        const { citations, cleanText } = extractSourceCitations(block.text);
        citations.forEach(c => allCitations.push(c));
        textForDisplay = cleanText;
      }

      const displayText = textForDisplay.trim();
      if (!displayText) {
        return '';
      }

      return ui`
        <div
          class="message-bubble"
          data-copyable-surface
          data-copy-text="${escapeHtml(replyPlainText(displayText))}"
        >
          ${renderTextBlock(displayText)}
        </div>
      `;
    })
    .join('');

  return ui`
    <div class="message-block-stack">
      ${renderedBlocks}
      ${isAssistant ? renderSourceCitationCards(allCitations) : ''}
    </div>
  `;
}

function renderInlineText(value = '') {
  // URL/markdown-link matcher — cite tags must NOT be swallowed here (the
  // tag shape has no http(s) prefix, so the URL regex naturally skips them).
  // The slices BETWEEN url matches get a second pass through the citation
  // renderer so inline `<cite>` tags become clickable pills.
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;
  let cursor = 0;
  let html = '';
  let match;

  while ((match = pattern.exec(value))) {
    html += renderInlineSegmentWithCites(value.slice(cursor, match.index), escapeHtml);
    const url = extractTextUrls(match[2] || match[3])[0];
    const label = match[1] || url;
    html += ui`<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(
      label,
    )}</a>${renderCopyLinkButton(url, escapeHtml)}`;
    cursor = match.index + (match[2] ? match[0].length : url.length);
  }

  html += renderInlineSegmentWithCites(value.slice(cursor), escapeHtml);
  return html.replaceAll('\n', '<br />');
}

// ─── Web source citation helpers ───────────────────────────────────────────────

/**
 * Extract [source: url] citation markers from text.
 * Returns { citations: [{url, via?}], cleanText }.
 */
function extractSourceCitations(text = '') {
  const citations = [];
  const seen = new Set();
  // Match [source: url] and optional [via: method] following it
  const pattern = /\[source:\s*(https?:\/\/[^\]]+)\](?:\s*\[via:\s*([^\]]+)\])?/gi;
  const cleanText = text.replace(pattern, (_match, url, via) => {
    const trimmedUrl = url.trim();
    if (!seen.has(trimmedUrl)) {
      seen.add(trimmedUrl);
      citations.push({ url: trimmedUrl, via: (via || '').trim() });
    }
    return '';
  }).trim();
  return { citations, cleanText };
}

/**
 * Try to extract a readable hostname label from a URL.
 */
function citationHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * Render citation source cards for web search / fetch_url results.
 */
function renderSourceCitationCards(citations) {
  if (!citations.length) return '';
  return ui`
    <div class="source-citation-strip">
      ${citations.map(({ url, via }) => ui`
        <a
          class="source-citation-card"
          href="${escapeHtml(url)}"
          target="_blank"
          rel="noreferrer"
          title="${escapeHtml(url)}"
        >
          <span class="citation-icon">🔗</span>
          <span class="citation-host">${escapeHtml(citationHostname(url))}</span>
          ${via ? ui`<span class="citation-via">${escapeHtml(via)}</span>` : ''}
        </a>
      `).join('')}
    </div>
  `;
}

function splitLines(value = '') {
  return String(value).replace(/\r\n/g, '\n').split('\n');
}

function fallbackLineDiff(beforeLines, afterLines) {
  const operations = [];
  const total = Math.max(beforeLines.length, afterLines.length);

  for (let index = 0; index < total; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];

    if (beforeLine === afterLine && beforeLine !== undefined) {
      operations.push({ type: 'context', line: beforeLine });
      continue;
    }

    if (beforeLine !== undefined) {
      operations.push({ type: 'remove', line: beforeLine });
    }

    if (afterLine !== undefined) {
      operations.push({ type: 'add', line: afterLine });
    }
  }

  return operations;
}

function buildLineDiff(beforeText = '', afterText = '') {
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  const maxCells = 80000;

  if (beforeLines.length * afterLines.length > maxCells) {
    return fallbackLineDiff(beforeLines, afterLines);
  }

  const dp = Array.from({ length: beforeLines.length + 1 }, () =>
    Array(afterLines.length + 1).fill(0),
  );

  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        beforeLines[i] === afterLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const operations = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      operations.push({ type: 'context', line: beforeLines[i] });
      i += 1;
      j += 1;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      operations.push({ type: 'remove', line: beforeLines[i] });
      i += 1;
    } else {
      operations.push({ type: 'add', line: afterLines[j] });
      j += 1;
    }
  }

  while (i < beforeLines.length) {
    operations.push({ type: 'remove', line: beforeLines[i] });
    i += 1;
  }

  while (j < afterLines.length) {
    operations.push({ type: 'add', line: afterLines[j] });
    j += 1;
  }

  return operations;
}

function buildPatchPreview(filePath, beforeText = '', afterText = '') {
  if (beforeText === afterText) {
    return {
      hasChanges: false,
      lines: ['No changes to preview.'],
    };
  }

  const operations = buildLineDiff(beforeText, afterText);
  const renderedLines = [`--- ${filePath}`, `+++ ${filePath}`];

  for (const operation of operations.slice(0, 320)) {
    const prefix =
      operation.type === 'add' ? '+' : operation.type === 'remove' ? '-' : ' ';
    renderedLines.push(`${prefix}${operation.line}`);
  }

  if (operations.length > 320) {
    renderedLines.push(' ... patch preview truncated ...');
  }

  return {
    hasChanges: true,
    lines: renderedLines,
  };
}

function renderPatchPreviewBlock(title, filePath, beforeText, afterText) {
  const preview = buildPatchPreview(filePath, beforeText, afterText);

  return ui`
    <div class="patch-preview-card">
      <div class="header-row">
        <h3 class="subsection-title">${escapeHtml(title)}</h3>
        <span class="meta-label">${preview.hasChanges ? 'Ready to apply' : 'No changes'}</span>
      </div>
      <div class="patch-preview">
        ${preview.lines
          .map(line => {
            const klass = line.startsWith('+')
              ? 'is-add'
              : line.startsWith('-')
                ? 'is-remove'
                : line.startsWith('@@')
                  ? 'is-meta'
                  : '';
            return ui`<span class="diff-line ${klass}">${escapeHtml(line)}</span>`;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderAttachmentPreviewList(attachments = []) {
  if (!attachments.length) {
    return '';
  }

  return ui`
    <div class="composer-attachment-list">
      ${attachments
        .map(
          attachment => ui`
            <div class="composer-attachment-chip">
              <span class="chip-icon">${attachmentIcon(attachment.kind, attachment)}</span>
              <span class="composer-attachment-label">${escapeHtml(attachmentLabel(attachment))}</span>
              ${
                attachment.sizeLabel
                  ? ui`<span class="meta-label">${escapeHtml(attachment.sizeLabel)}</span>`
                  : ''
              }
              <button
                class="composer-attachment-remove"
                type="button"
                data-action="remove-composer-attachment"
                data-attachment-id="${attachment.id}"
                title="Remove attachment"
              >
                ×
              </button>
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function renderComposerAttachmentMenu() {
  if (!uiState.composerAttachmentMenuOpen) {
    return '';
  }

  return ui`
    <div class="composer-attachment-menu">
      <button class="composer-menu-item" type="button" data-action="pick-composer-attachment" data-accept="image/*">
        <span class="chip-icon">${icon.image}</span>
        Image
      </button>
      <button class="composer-menu-item" type="button" data-action="pick-composer-attachment" data-accept="video/*" title="Direct video files are parsed best-effort: audio is transcribed and keyframes are sent when the media is accessible. Platform links may fall back to preview text.">
        <span class="chip-icon">${icon.video}</span>
        <span class="composer-menu-item-text">
          <span>Video</span>
          <span class="composer-menu-item-hint">best-effort transcript + keyframes</span>
        </span>
      </button>
      <button class="composer-menu-item" type="button" data-action="pick-composer-attachment" data-accept="audio/*" title="Audio is transcribed first, then the transcript is sent to the model. Raw audio is only used when the selected backend supports it.">
        <span class="chip-icon">${icon.audio}</span>
        <span class="composer-menu-item-text">
          <span>Audio</span>
          <span class="composer-menu-item-hint">transcribed first</span>
        </span>
      </button>
      <button class="composer-menu-item" type="button" data-action="pick-composer-attachment" data-accept="application/pdf,.pdf" title="Text-based PDFs are extracted via pdf-parse and the text is sent to the model. Scanned image-only PDFs may need OCR.">
        <span class="chip-icon">${icon.file}</span>
        <span class="composer-menu-item-text">
          <span>PDF</span>
          <span class="composer-menu-item-hint">text-based PDFs</span>
        </span>
      </button>
      <button class="composer-menu-item" type="button" data-action="add-link-attachment">
        <span class="chip-icon">${icon.link}</span>
        Link
      </button>
    </div>
  `;
}

function renderTtsVoicePanel() {
  if (!uiState.ttsVoicePanelOpen) return '';

  const engine = uiState.ttsEngine;
  const browserVoices = uiState.ttsBrowserVoices;
  const whisperBaseUrl = uiState.bootstrap?.settings?.config?.whisperBaseUrl || '';
  const ttsProvider = uiState.bootstrap?.settings?.config?.ttsProvider || '';
  const isEdgeTtsActive = engine === 'api' && ttsProvider === 'edge';
  const isCustomVoiceActive = engine === 'api' && !isEdgeTtsActive && /127\.0\.0\.1:7860/.test(whisperBaseUrl);
  const isApiVoiceActive = engine === 'api' && !isEdgeTtsActive && !isCustomVoiceActive;

  // Group browser voices by language for readability
  const enVoices = browserVoices.filter(v => v.lang.startsWith('en'));
  const otherVoices = browserVoices.filter(v => !v.lang.startsWith('en'));

  const browserVoiceOptions = [
    ui`<option value="">System default</option>`,
    ...enVoices.map(v =>
      ui`<option value="${escapeHtml(v.name)}" ${uiState.ttsBrowserVoiceName === v.name ? 'selected' : ''}>${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`
    ),
    otherVoices.length ? ui`<option disabled>──────────</option>` : '',
    ...otherVoices.map(v =>
      ui`<option value="${escapeHtml(v.name)}" ${uiState.ttsBrowserVoiceName === v.name ? 'selected' : ''}>${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`
    ),
  ].join('');

  const radioRow = (label, hint, isActive, action, dataAttrs = '') => ui`
    <button class="tts-radio-row ${isActive ? 'is-active' : ''}" ${action} ${dataAttrs}>
      <span class="tts-radio-dot">${isActive ? '●' : '○'}</span>
      <span class="tts-radio-body">
        <span class="tts-radio-label">${label}</span>
        ${hint ? ui`<span class="tts-radio-hint">${hint}</span>` : ''}
      </span>
    </button>
  `;

  // macOS voice options — lazy-loaded via /api/tts/say-voices when the
  // panel first opens. Until then, show a placeholder so the radio still
  // renders and reflects the user's persisted selection.
  const macosVoices = uiState.ttsMacosVoices;
  const macosVoiceOptions = (() => {
    if (!uiState.ttsMacosVoicesLoaded) {
      return ui`<option value="">Loading…</option>`;
    }
    if (macosVoices.length === 0) {
      return ui`<option value="">(no /usr/bin/say voices found)</option>`;
    }
    // Group by language family — en first (most users), then everything
    // else alphabetised by lang code.
    const enMac = macosVoices.filter(v => v.lang.startsWith('en'));
    const otherMac = macosVoices.filter(v => !v.lang.startsWith('en'))
      .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    const opt = v =>
      ui`<option value="${escapeHtml(v.name)}" ${uiState.ttsMacosVoiceName === v.name ? 'selected' : ''}>${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`;
    return [
      ui`<option value="">Auto-detect by language</option>`,
      ...enMac.map(opt),
      otherMac.length ? ui`<option disabled>──────────</option>` : '',
      ...otherMac.map(opt),
    ].join('');
  })();

  return ui`
    <div class="tts-voice-panel">
      <div class="tts-panel-header">
        <span class="toolbar-icon" style="width:14px;height:14px">${icon.speak}</span>
        Voice settings
      </div>

      <label class="tts-panel-row checkbox-row">
        <input type="checkbox" data-action="toggle-tts-enable" ${uiState.ttsAutoPlay ? 'checked' : ''} />
        <span>Auto-speak replies</span>
      </label>

      <div class="tts-panel-divider"></div>
      <div class="tts-panel-section-label">Voice source</div>

      ${radioRow(
        'Auto',
        'Tries API voice first · falls back to macOS say · default',
        engine === 'auto',
        'data-action="set-tts-engine"', 'data-engine="auto"'
      )}

      ${radioRow(
        'macOS voice',
        'System speakers · /usr/bin/say · no setup',
        engine === 'macos',
        'data-action="set-tts-engine"', 'data-engine="macos"'
      )}

      ${engine === 'macos' ? ui`
        <div class="tts-panel-sub">
          <select class="tts-voice-select" data-action="select-tts-macos-voice">
            ${macosVoiceOptions}
          </select>
        </div>
      ` : ''}

      ${(() => {
        // Naming: in real browsers this is speechSynthesis (WebKit voices);
        // in the desktop WKWebView wrapper it's actually AVSpeechSynthesizer
        // via a Swift bridge — same engine code path here, very different
        // implementation under the hood.  Showing "Browser voice" inside
        // the desktop app misled users; expose it as "Desktop native voice"
        // there instead.  Real browsers keep the original label.
        const isWebView = Boolean(window.webkit?.messageHandlers?.meloVoice);
        const label = isWebView ? 'Desktop native voice' : 'Browser voice';
        const hint = isWebView
          ? 'AVSpeechSynthesizer via system bridge · picker unused here'
          : 'In-page · speechSynthesis · WebKit voices';
        return radioRow(
          label,
          hint,
          engine === 'browser',
          'data-action="set-tts-engine"', 'data-engine="browser"',
        );
      })()}

      ${engine === 'browser' && browserVoices.length > 0 ? ui`
        <div class="tts-panel-sub">
          <select class="tts-voice-select" data-action="select-tts-browser-voice"
                  ${window.webkit?.messageHandlers?.meloVoice ? 'disabled title="Voice picker only applies in actual browsers — desktop app routes to system AVSpeechSynthesizer"' : ''}>
            ${browserVoiceOptions}
          </select>
        </div>
      ` : ''}

      ${radioRow(
        'Edge TTS',
        isEdgeTtsActive ? 'Active — Microsoft neural voice' : 'Fast · natural voice · requires internet',
        isEdgeTtsActive,
        'data-action="activate-edge-tts"', ''
      )}

      ${isEdgeTtsActive ? ui`
        <div class="tts-panel-sub">
          <select class="tts-voice-select" data-action="select-tts-edge-voice">
            <option value="">Auto-detect by language</option>
            ${EDGE_TTS_VOICES.map(v =>
              ui`<option value="${escapeHtml(v.id)}" ${uiState.ttsEdgeVoice === v.id ? 'selected' : ''}>${escapeHtml(v.label)} — ${escapeHtml(v.desc)}</option>`
            ).join('')}
          </select>
        </div>
      ` : ''}

      ${radioRow(
        'API voice',
        'OpenAI-compatible endpoint · requires API key',
        isApiVoiceActive,
        'data-action="set-tts-engine"', 'data-engine="api"'
      )}

      ${isApiVoiceActive ? ui`
        <div class="tts-panel-sub">
          <select class="tts-voice-select" data-action="select-tts-api-voice">
            ${TTS_API_VOICES.map(v =>
              ui`<option value="${v.id}" ${uiState.ttsApiVoice === v.id ? 'selected' : ''}>${v.label} — ${v.desc}</option>`
            ).join('')}
          </select>
        </div>
      ` : ''}

      ${(() => {
        // Build MiniMax custom voices from agent profiles that have a minimaxVoiceId
        const SYSTEM_AGENT_IDS = new Set(['main', 'research', 'builder', 'reviewer']);
        const customVoices = allChatAgentProfiles()
          .filter(a => a.minimaxVoiceId)
          .map(a => ({ id: a.minimaxVoiceId, label: a.name, agentId: a.id }));
        const isMinimaxActive = engine === 'api' && ttsProvider === 'minimax';
        // Read the masked-key flag exposed by the bootstrap; raw
        // minimaxApiKey is never sent to the client (server returns only
        // hasMinimaxKey + maskedMinimaxApiKey). Old code Boolean()'d the
        // raw field which would always be undefined here.
        const hasMinimaxKey = Boolean(uiState.bootstrap?.settings?.config?.hasMinimaxKey);

        if (!customVoices.length && !hasMinimaxKey) return '';

        return `
          ${radioRow(
            '自定义语音',
            isMinimaxActive
              ? `Active — ${customVoices.find(v => v.id === uiState.ttsCustomVoiceId)?.label || t("自定义")}`
              : 'MiniMax 克隆音色 · 需要 API Key',
            isMinimaxActive,
            'data-action="activate-minimax-voice"', ''
          )}
          ${isMinimaxActive && customVoices.length > 1 ? ui`
            <div class="tts-panel-sub">
              <select class="tts-voice-select" data-action="select-tts-custom-voice">
                ${customVoices.map(v =>
                  ui`<option value="${escapeHtml(v.id)}" ${uiState.ttsCustomVoiceId === v.id ? 'selected' : ''}>${escapeHtml(v.label)}</option>`
                ).join('')}
              </select>
            </div>
          ` : ''}
        `;
      })()}

      <div class="tts-panel-divider"></div>
      <div class="tts-panel-footer">
        <button class="tts-panel-link" type="button"
                data-action="select-customize-item"
                data-section="connectors"
                data-id="openai-compatible">
          ${escapeHtml('配置 MiniMax 自定义语音 →')}
        </button>
        <button class="tts-panel-link" type="button"
                data-action="select-customize-item"
                data-section="connectors"
                data-id="openai-compatible">
          ${escapeHtml('配置 Whisper 转写 →')}
        </button>
      </div>

    </div>
  `;
}

function renderMessageAttachments(message) {
  return renderAttachmentCards(message, { escapeHtml, truncate, icon, attachmentLabel, isPdfAttachment, describeAudioExtractionStatus, describeVideoExtractionStatus, extractTextUrls });
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function activeMode() {
  return uiState.bootstrap?.modes.find(
    mode => mode.id === uiState.bootstrap?.settings.activeMode,
  );
}

function activeChat() {
  return uiState.bootstrap?.activeChat || null;
}

function activeProject() {
  return uiState.bootstrap?.activeProject || null;
}

function activeProjectChats() {
  const projectId = activeProject()?.id;
  if (!projectId) return [];
  return (uiState.bootstrap?.chats || []).filter(chat => chat.projectId === projectId);
}

function activeProjectArtifacts() {
  return uiState.bootstrap?.projectArtifacts || [];
}

function cloneBootstrapState(bootstrap) {
  if (!bootstrap) {
    return null;
  }

  if (typeof structuredClone === 'function') {
    return structuredClone(bootstrap);
  }

  return JSON.parse(JSON.stringify(bootstrap));
}

function optimisticMessagePreview(message) {
  const content = String(message?.content || '').trim();
  if (content) {
    return content.slice(0, 140);
  }

  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (attachments.length) {
    const attachmentKinds = [...new Set(attachments.map(attachment => attachment.kind).filter(Boolean))];
    return `${attachments.length} attachment${attachments.length === 1 ? '' : 's'}${
      attachmentKinds.length ? ` · ${attachmentKinds.join(', ')}` : ''
    }`;
  }

  return 'No messages yet.';
}

function optimisticChatTitle(message) {
  const content = String(message?.content || '').trim();
  if (!content) {
    return 'New chat';
  }

  const normalized = content
    .replace(/\s+/g, ' ')
    .replace(/[?!.。！？]+$/u, '')
    .trim();

  return truncate(normalized, 48) || 'New chat';
}

function resetStreamingAssistant() {
  uiState.streamingChatId = null;
  uiState.streamingAssistantText = '';
}

function prepareThreadNavigation({ highlightedMessageId = null, autoFollow = true } = {}) {
  uiState.highlightedMessageId = highlightedMessageId;
  uiState.lastThreadScrollSignature = '';
  uiState.lastThreadChatId = null;
  uiState.threadAutoFollow = autoFollow;
}

function renderThinkingMessage() {
  return '';
}

function renderStreamingAssistantMessage(chat) {
  if (!uiState.sending || uiState.streamingChatId !== chat?.id) {
    return '';
  }

  // Tool calls strip always shown while tools are running (even before text appears)
  const toolStrip = renderActiveToolCallsStrip();

  if (!uiState.streamingAssistantText) {
    return toolStrip + renderThinkingMessage();
  }

  // Strip any <tool_call>...</tool_call> XML blocks (and partial opening tags)
  // before display — these are internal model directives, not user-visible text.
  // Also strip any <viz-spec>...</viz-spec> trailer — complete or partial — so
  // the raw JSON trailer never flashes in the streaming text on its way to
  // being turned into a Demon viz card after the stream settles.
  const displayText = uiState.streamingAssistantText
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*$/, '')
    .replace(/<viz-spec>[\s\S]*?<\/viz-spec>/gi, '')
    .replace(/<viz-spec>[\s\S]*$/i, '')
    .trim();

  const { citations: streamCitations, cleanText: streamCleanText } =
    extractSourceCitations(displayText);

  return ui`
    ${toolStrip}
    <article class="message assistant is-streaming">
      <div class="message-role">${renderAgentAvatar(activeChatAgentProfile() || {name:t("助手")}, escapeHtml, 24)} ${escapeHtml(activeChatAgentProfile()?.name || t("助手"))}</div>
      <div
        class="message-bubble"
        data-copyable-surface
        data-copy-text="${escapeHtml(replyPlainText(streamCleanText))}"
      >
        ${renderRichText(streamCleanText)}
      </div>
      ${renderSourceCitationCards(streamCitations)}
    </article>
  `;
}

// Surgical DOM update for the streaming-assistant bubble. Why this exists:
// `render()` does `app.innerHTML = ...`, i.e. it blows away AND rebuilds
// EVERY node in the page. Doing that on every streamed token makes the
// whole chat flash (`闪屏`) — every sidebar row, every settled message
// bubble, every panel gets demolished and re-painted 20-50 times a second.
//
// This fast path short-circuits that for the only update 99% of streaming
// frames actually carry: "the streaming bubble grew by a few tokens." It
// finds the already-mounted `<article class="message assistant is-streaming">`
// element and patches just its bubble (and citation strip) in place.
//
// Returns true if it handled the update; false if full `render()` is needed
// (first delta of a reply, tool-strip state changed, different chat is active,
// node missing because a prior render rebuilt, etc.).
function renderStreamingFast() {
  // Sanity: must actually be streaming into the currently-active chat.
  const chat = activeChat();
  if (!chat || !uiState.sending || uiState.streamingChatId !== chat.id) return false;

  // First delta of the reply — there's no article yet, do a full render so
  // the DOM shell gets built.
  const article = document.querySelector('.message-list .message.assistant.is-streaming');
  if (!article) return false;

  // The tool-call strip sits OUTSIDE the streaming article (it's a sibling
  // above it). Its state only changes on tool_calls_start / tool_calls_done
  // events, which both go through full render(). Here we only have to
  // assume it's already in sync.

  const bubble = article.querySelector('.message-bubble');
  if (!bubble) return false;

  // Re-apply the same strip passes the template does so the bubble never
  // flashes raw `<tool_call>` / `<viz-spec>` JSON mid-stream.
  const displayText = uiState.streamingAssistantText
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*$/, '')
    .replace(/<viz-spec>[\s\S]*?<\/viz-spec>/gi, '')
    .replace(/<viz-spec>[\s\S]*$/i, '')
    .trim();

  const { citations: streamCitations, cleanText: streamCleanText } =
    extractSourceCitations(displayText);

  // Update bubble text + copy-surface in place. innerHTML swap here is
  // scoped to ONE small element, not the whole app, so no flash.
  bubble.innerHTML = renderRichText(streamCleanText);
  bubble.setAttribute('data-copy-text', replyPlainText(streamCleanText));

  // Update / remove the citation cards under the bubble.
  const citationHtml = renderSourceCitationCards(streamCitations);
  let citationHost = article.querySelector('.source-citation-cards');
  if (citationHtml.trim()) {
    if (!citationHost) {
      // First time any citations appear — insert a fresh node at the end.
      const wrapper = document.createElement('div');
      wrapper.innerHTML = citationHtml;
      const node = wrapper.firstElementChild;
      if (node) article.appendChild(node);
    } else {
      // Replace the existing citation strip with freshly rendered markup.
      const wrapper = document.createElement('div');
      wrapper.innerHTML = citationHtml;
      const node = wrapper.firstElementChild;
      if (node) citationHost.replaceWith(node);
    }
  } else if (citationHost) {
    citationHost.remove();
  }

  // Autoscroll the thread so the newly appended tokens stay visible. We do
  // this lightweight version instead of full syncThreadViewport() because the
  // latter reads layout-affecting state across the whole page.
  if (uiState.threadAutoFollow) {
    const scroller = document.querySelector('.thread-scroll-region');
    if (scroller instanceof HTMLElement) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  return true;
}

function applyOptimisticUserMessage({ chatId, content, attachments }) {
  const bootstrap = uiState.bootstrap;
  if (!bootstrap) {
    return null;
  }

  const optimisticMessage = {
    id: `optimistic-user-${Date.now()}`,
    role: 'user',
    content,
    attachments,
    createdAt: new Date().toISOString(),
  };

  const chats = Array.isArray(bootstrap.chats) ? [...bootstrap.chats] : [];
  const chatIndex = chats.findIndex(chat => chat.id === chatId);
  const activeChatMatches = bootstrap.activeChat?.id === chatId;
  const baseChat =
    (activeChatMatches ? bootstrap.activeChat : null) ||
    (chatIndex >= 0 ? chats[chatIndex] : null);

  if (!baseChat) {
    return null;
  }

  const nextChat = {
    ...baseChat,
    messages: [...(Array.isArray(baseChat.messages) ? baseChat.messages : []), optimisticMessage],
    updatedAt: optimisticMessage.createdAt,
  };

  if (!String(nextChat.title || '').trim() || nextChat.title === 'New chat') {
    nextChat.title = optimisticChatTitle(optimisticMessage);
  }

  const nextChats =
    chatIndex >= 0
      ? [nextChat, ...chats.filter(chat => chat.id !== chatId)]
      : [nextChat, ...chats];

  const nextSummary = {
    id: nextChat.id,
    title: nextChat.title,
    projectId: nextChat.projectId || null,
    mode: nextChat.mode,
    locked: Boolean(nextChat.locked),
    updatedAt: nextChat.updatedAt,
    updatedLabel: 'Just now',
    preview: optimisticMessagePreview(optimisticMessage),
    messageCount: nextChat.messages.length,
  };

  const recents = Array.isArray(bootstrap.recents) ? bootstrap.recents : [];
  const nextRecents = [nextSummary, ...recents.filter(chat => chat.id !== chatId)].slice(0, 10);

  uiState.bootstrap = {
    ...bootstrap,
    activeChat: nextChat,
    chats: nextChats,
    recents: nextRecents,
    settings: {
      ...bootstrap.settings,
      selectedChatId: chatId,
      activeView: 'chat',
    },
  };

  return optimisticMessage.id;
}

function agentProfileById(agentId) {
  return uiState.bootstrap?.customize?.agents?.find(agent => agent.id === agentId) || null;
}

function mainAgentProfile() {
  return agentProfileById('main');
}

function activeChatAgentProfile() {
  return conversationAgent(uiState.bootstrap, {overview:uiState.neuralOverview, newAgentId:uiState.activeChatAgentId,newProjectId:uiState.newChatProjectId});
}

function allChatAgentProfiles() {
  return conversationAgents(uiState.bootstrap, {overview:uiState.neuralOverview,newProjectId:uiState.newChatProjectId});
}

function selectedAgentProfile() {
  return agentProfileById(uiState.bootstrap?.settings?.selectedAgentId || 'main');
}

function selectedAgentScope() {
  const scope = uiState.bootstrap?.settings?.selectedAgentScope;
  const project = activeProject();
  return scope === 'project' && project ? 'project' : 'global';
}

function agentDraftKey(agentId, scope = selectedAgentScope(), projectId = activeProject()?.id || 'global') {
  return `${scope}:${scope === 'project' ? projectId : 'global'}:${agentId}`;
}

function agentSaveKey(
  agentId,
  scope = selectedAgentScope(),
  projectId = activeProject()?.id || 'global',
) {
  return `${scope}:${scope === 'project' ? projectId : 'global'}:${agentId}`;
}

function agentSecretVisibilityKey(agentId, channelId) {
  return `${agentId}:${channelId}`;
}

// Server returns agent.channels as an ARRAY ([{id:'telegram',...},{id:'discord',...}])
// via summarizeAgentProfile, but the server's normalizeAgentChannels on the
// write path (updateAgentProfile) expects channels as an OBJECT keyed by
// channel.id. If we clone the array into the draft and then assign
// `draft.channels.telegram = { ... }`, JSON.stringify drops those string
// properties on serialization (arrays only serialize numeric indices) and
// every edit the user makes is silently thrown away — the user sees the
// checkbox bounce back, the bot token disappear, etc. Normalize to an object
// at the draft boundary so all downstream code (render, autosave POST, test
// connection) operates on a plain object.
function agentDraftFor(agent) {
  if (!agent) return null;
  const key = agentDraftKey(agent.id);
  // The cached uiState.agentDrafts entry wins so the user's in-progress
  // edits aren't blown away on every render. When there isn't a cache
  // hit, agentDraftFromProfile() (lifted to ./agentDraft.js for unit-
  // testability) builds a fresh draft from the profile — including
  // `enabledMcpServerIds`, which the previous inline copy forgot to
  // thread through. Codex 2026-04-28 audit caught that omission
  // silently dropping the per-agent MCP whitelist on save: the
  // chip-row read draft.enabledMcpServerIds (undefined → empty Set →
  // no chip is "selected"), the hidden form input submitted '', and
  // /api/agents/update happily wrote `enabledMcpServerIds: []` over
  // whatever the profile had.
  return uiState.agentDrafts[key] || agentDraftFromProfile(agent);
}

function mergeAgentDraft(agentId, patch) {
  const draftKey = agentDraftKey(agentId);
  const currentDraft = {
    ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
  };
  uiState.agentDrafts[draftKey] = {
    ...currentDraft,
    ...patch,
  };
  return uiState.agentDrafts[draftKey];
}

function updateAgentChannelDraft(agentId, channelId, patch) {
  const currentDraft = mergeAgentDraft(agentId, {});
  // Defensive: if channels is still an array (e.g. draft was hydrated before
  // normalizeChannelsForDraft was in place, or a server payload shape change
  // slips through), coerce to object keyed by channel.id. Writing into an
  // array with a string key silently drops the edit on JSON.stringify.
  const channels = normalizeChannelsForDraft(currentDraft.channels);
  channels[channelId] = {
    ...(channels[channelId] || { id: channelId }),
    ...patch,
  };
  return mergeAgentDraft(agentId, { channels });
}

function currentAgentScrollKey() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent' && !(uiState.bootstrap?.settings?.activeView === 'customize' && uiState.bootstrap?.settings?.selectedCustomizeSection === 'agents')) {
    return null;
  }

  const selected = selectedAgentProfile();
  if (!selected) {
    return null;
  }

  return `${selectedAgentScope()}:${activeProject()?.id || 'global'}:${selected.id}`;
}

function currentAgentEditorStateKey() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent' && !(uiState.bootstrap?.settings?.activeView === 'customize' && uiState.bootstrap?.settings?.selectedCustomizeSection === 'agents')) {
    return null;
  }

  const selected = selectedAgentProfile();
  if (!selected) {
    return null;
  }

  const scope = selectedAgentScope();
  const projectId = scope === 'project' ? activeProject()?.id || 'global' : 'global';
  return `${scope}:${projectId}:${selected.id}:${uiState.agentEditorTab}`;
}

function captureAgentEditorState() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent' && !(uiState.bootstrap?.settings?.activeView === 'customize' && uiState.bootstrap?.settings?.selectedCustomizeSection === 'agents')) {
    return;
  }

  const editor = document.querySelector('.agent-content-editor');
  const stateKey = currentAgentEditorStateKey();
  if (!(editor instanceof HTMLTextAreaElement) || !stateKey) {
    return;
  }

  uiState.agentEditorStates[stateKey] = {
    scrollTop: editor.scrollTop,
    selectionStart: editor.selectionStart,
    selectionEnd: editor.selectionEnd,
    focused: document.activeElement === editor,
  };
}

function captureAgentScrollState() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent' && !(uiState.bootstrap?.settings?.activeView === 'customize' && uiState.bootstrap?.settings?.selectedCustomizeSection === 'agents')) {
    return;
  }

  const listPane = document.querySelector('.agent-list-pane');
  if (listPane instanceof HTMLElement) {
    uiState.agentListScrollTop = listPane.scrollTop;
  }

  const detailPane = document.querySelector('.agent-detail-column');
  const scrollKey = currentAgentScrollKey();
  if (detailPane instanceof HTMLElement && scrollKey) {
    uiState.agentDetailScrollTops[scrollKey] = detailPane.scrollTop;
  }
}

function restoreAgentScrollState() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent' && !(uiState.bootstrap?.settings?.activeView === 'customize' && uiState.bootstrap?.settings?.selectedCustomizeSection === 'agents')) {
    return;
  }

  const listPane = document.querySelector('.agent-list-pane');
  if (listPane instanceof HTMLElement) {
    listPane.scrollTop = uiState.agentListScrollTop || 0;
  }

  const detailPane = document.querySelector('.agent-detail-column');
  const scrollKey = currentAgentScrollKey();
  if (detailPane instanceof HTMLElement && scrollKey) {
    detailPane.scrollTop = uiState.agentDetailScrollTops[scrollKey] || 0;
  }
}

// Generic form-input focus + caret preservation across the app-wide
// incremental updates in render(). This fallback also covers replaced pages. Any render
// triggered mid-typing (autosave spinner, 4-second runtime refresh, toast
// timer, unrelated state changes, etc.) yanks the caret out of the input
// the user is editing — the user sees focus jump "somewhere else", usually
// back up to the first input on the agent form (the Agent name input for
// 金冬天, which is why the user described it as "光标跳到最上面输入金冬天id
// 的那个输入框"). We locate the focused input by `form.id + element.name`
// which is stable across re-render, then restore focus and selection. Only
// applies to inputs and textareas that live inside a form with an id — this
// covers every config form (agent profile, connector, model, skill, etc.),
// but intentionally NOT the composer textarea, which has its own handling.
function captureFocusedInputState() {
  const active = document.activeElement;
  if (
    !(active instanceof HTMLInputElement) &&
    !(active instanceof HTMLTextAreaElement)
  ) {
    return null;
  }
  const form = active.form;
  if (!form || !form.id || !active.name) {
    return null;
  }
  // Textareas have a scrollTop that matters; inputs don't.
  const scrollTop =
    active instanceof HTMLTextAreaElement ? active.scrollTop : undefined;
  return {
    formId: form.id,
    name: active.name,
    selectionStart: active.selectionStart ?? null,
    selectionEnd: active.selectionEnd ?? null,
    scrollTop,
  };
}

function restoreFocusedInputState(state) {
  if (!state) return;
  const form = document.getElementById(state.formId);
  if (!(form instanceof HTMLFormElement)) return;
  const el = form.elements.namedItem(state.name);
  // form.elements can return a RadioNodeList if multiple inputs share a name;
  // the agent / connector forms never do that, but guard anyway.
  const input =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el
      : null;
  if (!input) return;
  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }
  try {
    const maxPos = input.value.length;
    const start = Math.min(state.selectionStart ?? maxPos, maxPos);
    const end = Math.min(state.selectionEnd ?? start, maxPos);
    input.setSelectionRange(start, end);
  } catch {}
  if (typeof state.scrollTop === 'number' && input instanceof HTMLTextAreaElement) {
    input.scrollTop = state.scrollTop;
  }
}

function restoreAgentEditorState() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent') {
    return;
  }

  const stateKey = currentAgentEditorStateKey();
  if (!stateKey) {
    return;
  }

  const editorState = uiState.agentEditorStates[stateKey];
  if (!editorState && !uiState.shouldFocusAgentEditor) {
    return;
  }

  window.requestAnimationFrame(() => {
    const editor = document.querySelector('.agent-content-editor');
    if (!(editor instanceof HTMLTextAreaElement) || stateKey !== currentAgentEditorStateKey()) {
      return;
    }
    // A user may focus/select text between render and this animation frame.
    // Never replace that newer selection with the previous render's caret.
    if (document.activeElement === editor) return;

    if (editorState?.focused) {
      // CRITICAL: in WKWebView, calling textarea.setSelectionRange(...) has
      // the side-effect of implicitly focusing the textarea — even though
      // we're only trying to "remember" where the caret was. That means the
      // anotherFieldFocused guard below used to be too late: by the time we
      // checked document.activeElement, setSelectionRange had already
      // stolen focus from the user's currently-typed input (e.g. the
      // Discord/Telegram Bot token, Group ID, or Channel ID field that
      // lives in the same form as IDENTITY.md). We now gate the whole
      // scroll + setSelectionRange + focus restore behind the same guard,
      // so a background re-render landing mid-typing doesn't touch the
      // IDENTITY.md editor at all. The editor's selection will be
      // re-applied the next time it actually gets focus.
      const active = document.activeElement;
      const anotherFieldFocused =
        active !== editor &&
        (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement);

      if (!anotherFieldFocused) {
        editor.scrollTop = editorState.scrollTop || 0;
        const maxPosition = editor.value.length;
        const selectionStart = Math.min(editorState.selectionStart ?? maxPosition, maxPosition);
        const selectionEnd = Math.min(editorState.selectionEnd ?? selectionStart, maxPosition);
        try {
          editor.setSelectionRange(selectionStart, selectionEnd);
        } catch {}

        if (editorState.focused) {
          editor.focus({ preventScroll: true });
        }
      }
    }

    if (uiState.shouldFocusAgentEditor) {
      editor.focus({ preventScroll: true });
      editor.selectionStart = editor.selectionEnd = editor.value.length;
      uiState.shouldFocusAgentEditor = false;
    }
  });
}

function agentPresetById(presetId) {
  return uiState.bootstrap?.customize?.agentPresets?.find(preset => preset.id === presetId) || null;
}

function agentToolOptions() {
  return uiState.bootstrap?.customize?.agentTools || [];
}

function selectedCustomizeItem() {
  if (!uiState.bootstrap) return null;
  if (uiState.bootstrap.settings.selectedCustomizeSection === 'agents') {
    return uiState.bootstrap.customize.agents.find(
      agent => agent.id === uiState.bootstrap.settings.selectedAgentId,
    );
  }
  if (uiState.bootstrap.settings.selectedCustomizeSection === 'skills') {
    return uiState.bootstrap.customize.skills.find(
      skill => skill.id === uiState.bootstrap.settings.selectedSkillId,
    );
  }

  return uiState.bootstrap.customize.connectors.find(
    connector => connector.id === uiState.bootstrap.settings.selectedConnectorId,
  );
}

function artifactShelfRows() { return (uiState.artifactCollection==='results' ? uiState.bootstrap?.results : uiState.bootstrap?.artifacts) || []; }
function selectedArtifact() {
  const artifacts = artifactShelfRows();
  return (
    artifacts.find(artifact => artifact.id === uiState.selectedArtifactId) ||
    artifacts[0] ||
    null
  );
}

function connectorById(connectorId) {
  return uiState.bootstrap?.customize.connectors.find(
    connector => connector.id === connectorId,
  );
}

function connectorEnabled(connectorId) {
  return Boolean(connectorById(connectorId)?.enabled);
}

function filteredProjects() {
  const query = uiState.projectSearch.trim().toLowerCase();
  const projects = (uiState.bootstrap?.projects || []).filter(project=>Boolean(project.archived)===uiState.showArchivedProjects);
  if (!query) return projects;

  return projects.filter(project =>
    `${project.name}\n${project.summary}\n${project.instructions}\n${project.workspacePath}`
      .toLowerCase()
      .includes(query),
  );
}

function filteredChats() {
  const query = uiState.chatSearch.trim().toLowerCase();
  const chats = uiState.bootstrap?.chats || [];
  if (!query) return chats;

  return chats.filter(chat =>
    `${chat.title}\n${chat.preview}`.toLowerCase().includes(query),
  );
}

// Phase 3.3.2 — apply Customize → Skills filter state (query + tag + state)
// to the full skill list. Returns a new array; does not mutate bootstrap.
function filteredSkills() {
  const all = uiState.bootstrap?.customize?.skills || [];
  const { query, tag, state } = uiState.skillFilter;
  const q = (query || '').trim().toLowerCase();

  return all.filter(skill => {
    // State filter.
    if (state === 'enabled' && !skill.enabled) return false;
    if (state === 'disabled' && skill.enabled) return false;
    if (state === 'custom' && skill.source !== 'custom') return false;
    if (state === 'builtin' && skill.source !== 'built-in') return false;
    if (state === 'disk' && skill.origin !== 'disk') return false;

    // Tag filter (exact, case-insensitive).
    if (tag) {
      const tags = Array.isArray(skill.tags) ? skill.tags : [];
      if (!tags.some(t => String(t).toLowerCase() === String(tag).toLowerCase())) {
        return false;
      }
    }

    // Free-text query over name, id, description, tags, triggers.
    if (q) {
      const haystack = [
        skill.name,
        skill.id,
        skill.description,
        ...(skill.tags || []),
        ...(skill.triggers || []),
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });
}

// Phase 3.3.3 — the composer value qualifies for the slash palette when it
// starts with "/" followed by at most 40 chars of id-safe text and no
// whitespace. Returns the query (the text after the slash) or null.
function parseSlashQuery(composerValue) {
  if (typeof composerValue !== 'string') return null;
  const match = composerValue.match(/^\/([a-z0-9_-]{0,40})$/i);
  return match ? match[1].toLowerCase() : null;
}

// Skills that match the current slash query, ranked: exact id match first,
// then prefix matches on id, then prefix matches on name, then substring
// matches. Only enabled skills participate (a disabled skill can't be
// invoked anyway, so including it would be misleading).
function slashPaletteMatches() {
  const all = uiState.bootstrap?.customize?.skills || [];
  const query = (uiState.slashPalette.query || '').toLowerCase();
  const pool = all.filter(s => s.enabled);
  if (!query) return pool.slice(0, 12);

  const scored = [];
  for (const skill of pool) {
    const id = String(skill.id || '').toLowerCase();
    const name = String(skill.name || '').toLowerCase();
    let score = 0;
    if (id === query) score = 100;
    else if (id.startsWith(query)) score = 80;
    else if (name.startsWith(query)) score = 60;
    else if (id.includes(query)) score = 40;
    else if (name.includes(query)) score = 20;
    if (score > 0) scored.push({ skill, score });
  }
  scored.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  return scored.slice(0, 12).map(s => s.skill);
}

// All unique tags across the current skill set, sorted alphabetically.
// Used to render the tag-filter chip row.
function allSkillTags() {
  const all = uiState.bootstrap?.customize?.skills || [];
  const set = new Set();
  for (const skill of all) {
    for (const tag of skill.tags || []) {
      if (tag) set.add(String(tag).toLowerCase());
    }
  }
  return [...set].sort();
}

function searchResults() {
  return (
    uiState.bootstrap?.search || {
      query: uiState.searchQuery,
      items: [],
      suggestions: [],
      features: [],
      promptHistory: [],
      skills: [],
      connectors: [],
      chatThreads: [],
      chatHits: [],
      memoryItems: [],
      projects: [],
      artifacts: [],
      files: [],
    }
  );
}

// ─── Search click-through boost (in-memory LRU) ────────────────────────────
//
// When the user repeatedly opens the same search result, we nudge it up the
// list next time. This is session-local (resets on app restart) and deliberately
// *small* — at most ±20 points — so it can't override a highly-relevant fresh
// match, only break ties among items with similar base scores.
//
// Why in-memory / why not persist:
//   - Click patterns are very session-scoped; yesterday's clicks often aren't
//     predictive of today's intent.
//   - Persisting would add disk I/O to every open-result action for marginal
//     benefit. If we ever want persistence, this is the single place to change.

const SEARCH_CLICK_BOOST_MAX_ENTRIES = 256;
const SEARCH_CLICK_BOOST_HALFLIFE_MS = 12 * 60 * 60 * 1000;   // 12 h
const SEARCH_CLICK_BOOST_CAP = 20;
const SEARCH_CLICK_BOOST_PER_HIT = 4;

// Map preserves insertion order — we use that for cheap LRU eviction.
const _searchClickBoosts = new Map();

function recordSearchClickBoost(id) {
  if (!id || typeof id !== 'string') return;
  const now = Date.now();
  const existing = _searchClickBoosts.get(id);
  if (existing) {
    // Refresh LRU position
    _searchClickBoosts.delete(id);
    _searchClickBoosts.set(id, { count: existing.count + 1, lastAt: now });
    return;
  }
  if (_searchClickBoosts.size >= SEARCH_CLICK_BOOST_MAX_ENTRIES) {
    const oldestKey = _searchClickBoosts.keys().next().value;
    if (oldestKey !== undefined) _searchClickBoosts.delete(oldestKey);
  }
  _searchClickBoosts.set(id, { count: 1, lastAt: now });
}

function getSearchClickBoost(id, now = Date.now()) {
  if (!id) return 0;
  const entry = _searchClickBoosts.get(id);
  if (!entry) return 0;
  const ageMs = Math.max(0, now - entry.lastAt);
  // Exponential half-life decay: 2^(-age/halflife)
  const decay = Math.pow(2, -ageMs / SEARCH_CLICK_BOOST_HALFLIFE_MS);
  const raw = entry.count * SEARCH_CLICK_BOOST_PER_HIT * decay;
  return Math.min(SEARCH_CLICK_BOOST_CAP, Math.round(raw));
}

function searchResultIcon(item) {
  if (!item?.iconKey || !(item.iconKey in icon)) {
    return icon.search;
  }
  return icon[item.iconKey];
}

function currentSearchItems() {
  const results = searchResults();
  if (!uiState.searchQuery.trim()) {
    return results.suggestions || [];
  }

  return [
    ...(results.features || []),
    ...(results.promptHistory || []),
    ...(results.skills || []),
    ...(results.connectors || []),
    ...(results.chatThreads || []),
    ...(results.chatHits || []),
    ...(results.memoryItems || []),
    ...(results.projects || []),
    ...(results.artifacts || []),
    ...mergedSearchFileItems(),
  ];
}

function mergedSearchFileItems() {
  const results = searchResults();
  const fileItems = results.files || [];
  // Each entry in searchFileHits is now a file-group ({ filePath, hits: [...], ... })
  // rather than a per-line hit, so we index by filePath directly.
  const fileGroups = uiState.searchFileHits || [];
  const groupByPath = new Map();
  const consumedGroupPaths = new Set();

  for (const group of fileGroups) {
    const path = group?.filePath || '';
    if (!path) continue;
    groupByPath.set(path, group);
  }

  const merged = [];
  for (const fileItem of fileItems) {
    const group = groupByPath.get(fileItem.filePath);
    if (group) {
      consumedGroupPaths.add(fileItem.filePath);
      merged.push({
        ...fileItem,
        id: `file-merged:${fileItem.filePath}`,
        subtitle: group.subtitle || fileItem.subtitle,
        meta: group.meta || fileItem.meta,
        lineNumber: group.lineNumber || null,
        lineText: group.lineText || '',
        hits: group.hits || [],
        action: group.action || fileItem.action,
        score: Math.max(fileItem.score || 0, group.score || 0) + 6,
      });
      continue;
    }
    merged.push(fileItem);
  }

  for (const group of fileGroups) {
    if (!consumedGroupPaths.has(group.filePath)) {
      merged.push(group);
    }
  }

  const now = Date.now();
  return merged
    .sort((left, right) => {
      const ls = (left.score || 0) + getSearchClickBoost(left.id, now);
      const rs = (right.score || 0) + getSearchClickBoost(right.id, now);
      if (rs !== ls) return rs - ls;
      return Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0);
    })
    .slice(0, 12);
}

function searchBucketsForRender() {
  const results = searchResults();

  if (!uiState.searchQuery.trim()) {
    return [
      {
        id: 'suggestions',
        title: 'Suggested functions',
        items: results.features || results.suggestions || [],
      },
      {
        id: 'recent-prompts',
        title: 'Prompt history',
        items: results.promptHistory || [],
      },
      {
        id: 'recent-skills',
        title: 'Skills',
        items: results.skills || [],
      },
      {
        id: 'recent-connectors',
        title: 'Connectors',
        items: results.connectors || [],
      },
      {
        id: 'recent-chats',
        title: 'Recent chats',
        items: results.chatThreads || [],
      },
      {
        id: 'recent-projects',
        title: 'Projects',
        items: results.projects || [],
      },
    ].filter(bucket => bucket.items.length);
  }

  return [
    { id: 'features', title: 'Functions', items: results.features || [] },
    { id: 'prompt-history', title: 'Prompt history', items: results.promptHistory || [] },
    { id: 'skills', title: 'Skills', items: results.skills || [] },
    { id: 'connectors', title: 'Connectors', items: results.connectors || [] },
    { id: 'chat-threads', title: 'Chats', items: results.chatThreads || [] },
    { id: 'chat-hits', title: 'Messages', items: results.chatHits || [] },
    { id: 'memory-items', title: 'Memory', items: results.memoryItems || [] },
    { id: 'projects', title: 'Projects', items: results.projects || [] },
    { id: 'artifacts', title: 'Artifacts', items: results.artifacts || [] },
    { id: 'files', title: 'Workspace files', items: mergedSearchFileItems() },
  ].filter(bucket => bucket.items.length);
}

function currentSearchResultById(resultId) {
  return currentSearchItems().find(item => item.id === resultId) || null;
}

async function handleOpenSearchResult(result) {
  if (!result?.action) {
    return;
  }

  // Record the click so the boost map can re-rank this result next time.
  recordSearchClickBoost(result.id);

  uiState.highlightedMessageId = null;
  uiState.shouldFocusSearch = false;

  switch (result.action.type) {
    case 'new-chat-home':
      await handleOpenNewChatHome();
      break;
    case 'open-view':
      uiState.shouldFocusSearch = result.action.view === 'search';
      await patchSettings({
        activeView: result.action.view,
        ...(result.action.mode ? { activeMode: result.action.mode } : {}),
      });
      break;
    case 'open-customize-section':
      await patchSettings({
        activeView: 'customize',
        selectedCustomizeSection: result.action.section,
      });
      break;
    case 'switch-mode':
      await patchSettings({
        activeMode: result.action.mode,
        activeView: 'chat',
        ...(result.action.projectId ? { selectedProjectId: result.action.projectId } : {}),
      });
      break;
    case 'focus-project':
      await patchSettings({
        selectedProjectId: result.projectId,
        activeView: 'projects',
      });
      break;
    case 'open-artifact':
      uiState.artifactCollection=uiState.bootstrap.results?.some(a=>a.id===result.artifactId)?'results':'knowledge';
      uiState.selectedArtifactId = result.artifactId;
      await patchSettings({
        activeView: 'artifacts',
      });
      break;
    case 'open-file':
      await handleSelectWorkspaceFile(result.filePath);
      break;
    case 'open-file-match':
      // `open-file-match` carries a `lineNumber` on the result — wire it
      // through so the file preview scrolls to the hit line after mount.
      // We accept the line number from the explicit action payload first
      // (so sub-list line clicks can specify a different line than the
      // top-ranked one carried at the group level), then fall back to the
      // group-level `lineNumber` that ships on the merged row.
      await handleSelectWorkspaceFile(result.filePath, {
        lineNumber:
          (result.action && Number(result.action.lineNumber)) ||
          Number(result.lineNumber) ||
          null,
      });
      break;
    case 'open-chat-thread': {
      prepareThreadNavigation({
        highlightedMessageId: null,
        autoFollow: true,
      });
      const chat = uiState.bootstrap?.chats?.find(item => item.id === result.chatId);
      await patchSettings({
        selectedChatId: result.chatId,
        activeView: 'chat',
        activeMode: chat?.mode || 'chat',
        selectedProjectId:
          chat?.projectId || null,
        selectedFilePath: null,
      });
      break;
    }
    case 'open-chat-hit': {
      prepareThreadNavigation({
        highlightedMessageId: result.messageId || null,
        autoFollow: false,
      });
      const chat = uiState.bootstrap?.chats?.find(item => item.id === result.chatId);
      await patchSettings({
        selectedChatId: result.chatId,
        activeView: 'chat',
        activeMode: chat?.mode || 'chat',
        selectedProjectId:
          chat?.projectId || null,
        selectedFilePath: null,
      });
      break;
    }
    default:
      break;
  }
}

function activeTasks() {
  const projectId = activeProject()?.id;
  const tasks = uiState.bootstrap?.tasks || [];
  if (!projectId) return tasks;
  return tasks.filter(task => !task.projectId || task.projectId === projectId);
}

function approvalQueue() {
  return uiState.bootstrap?.approvals || [];
}

function syncSelectedArtifact() {
  const artifacts = artifactShelfRows();
  if (!artifacts.some(artifact => artifact.id === uiState.selectedArtifactId)) {
    uiState.selectedArtifactId = artifacts[0]?.id || null;
  }
}

function resetFileEditor() {
  uiState.fileEditMode = false;
  uiState.fileDraftPath = null;
  uiState.fileDraftContent = '';
}

function startSelectedFileEdit() {
  const selectedFile = uiState.bootstrap?.workspace?.selectedFile;
  if (!selectedFile) {
    showError('Select a file before editing it.');
    return;
  }

  uiState.fileEditMode = true;
  uiState.fileDraftPath = selectedFile.path;
  uiState.fileDraftContent = selectedFile.content;
  render();
}

async function api(path, options = {}) {
  // Keep the request's exact baseline even if another response arrives first.
  const base = uiState.bootstrap?._snapshot ? structuredClone(uiState.bootstrap) : null;
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(base ? { 'x-melo-bootstrap-base': base._snapshot.token } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed.');
  }

  return decodeBootstrap(payload, base);
}

function parseEventStreamBlock(block) {
  const lines = block
    .split(/\r?\n/)
    .map(line => line.trimEnd());
  let event = 'message';
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    if (line.startsWith('event:')) {
      event = line.slice(6).trimStart() || event;
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  const raw = dataLines.join('\n').trim();
  if (!raw) {
    return null;
  }

  try {
    return {
      event,
      payload: JSON.parse(raw),
    };
  } catch {
    return {
      event,
      payload: { value: raw },
    };
  }
}

async function streamApi(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw chatStreamError(payload);
  }

  if (!response.body) {
    throw new Error('Streaming request returned no response body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let donePayload = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const separatorIndex = buffer.search(/\r?\n\r?\n/);
        if (separatorIndex === -1) {
          break;
        }

        const block = buffer.slice(0, separatorIndex);
        const separatorLength = buffer.startsWith('\r\n\r\n', separatorIndex) ? 4 : 2;
        buffer = buffer.slice(separatorIndex + separatorLength);

        const message = parseEventStreamBlock(block);
        if (!message) {
          continue;
        }

        if (typeof options.onEvent === 'function') {
          options.onEvent(message);
        }

        if (message.event === 'done') {
          donePayload = message.payload;
        } else if (message.event === 'error') {
          throw chatStreamError(message.payload);
        } else if (message.event === 'aborted') {
          throw new DOMException('The request was stopped.', 'AbortError');
        }
      }
    }

    if (!donePayload) throw chatStreamError({ code: 'STREAM_INTERRUPTED' });
    return donePayload;
  } finally {
    try {
      await reader.cancel();
    } catch {}

    try {
      reader.releaseLock();
    } catch {}
  }
}

async function loadBootstrap(query = uiState.searchQuery, { quiet = false } = {}) {
  if (!quiet && !uiState.bootstrap) {
    uiState.loading = true;
    bgRender();
  }

  if (quiet) {
    uiState.searchLoading = true;
    // Only render the "loading" state when the user is actually looking at
    // search — background polls on other views would otherwise trigger an
    // unnecessary re-render that can disturb scroll mid-gesture.
    if (uiState.bootstrap?.settings?.activeView === 'search') {
      render({ background: true });
    }
  }

  let changedSections = null;
  try {
    const normalizedQuery = query.trim();
    const suffix = normalizedQuery
      ? `?q=${encodeURIComponent(normalizedQuery)}`
      : '';
    const firstBootstrap = !uiState.bootstrap;
    const incoming = await api(`/api/bootstrap${suffix}`);
    if (olderBootstrap(incoming, uiState.bootstrap)) return;
    changedSections = changedBootstrapSections(uiState.bootstrap, incoming);
    uiState.bootstrap = incoming;
    if (firstBootstrap) {
      uiState.neuralOverview = uiState.bootstrap.settings.activeView === 'chat' && !uiState.bootstrap.settings.selectedChatId;
    }
    // Only sync searchQuery from the server response when the user hasn't typed
    // something newer while the request was in-flight. Full innerHTML re-renders
    // recreate the input element, so overwriting with a stale value discards any
    // characters the user typed during the round-trip.
    if (uiState.searchQuery.trim() === normalizedQuery || !normalizedQuery) {
      uiState.searchQuery = normalizedQuery;
    }
    uiState.error = '';
    syncSelectedArtifact();
    syncSearchFileStream(normalizedQuery);
  } catch (error) {
    stopSearchFileStream();
    uiState.error = error.message;
  } finally {
    uiState.loading = false;
    uiState.searchLoading = false;
    // When `quiet` is set, this is a background poll (runtime refresh every
    // 4s while a TG/DC channel is enabled). Tag the render as background so
    // the typing-guard in render() can defer it if the user is mid-keystroke
    // in a config input — prevents the "cursor jumps between Discord Bot
    // token fields" symptom.
    render({ background: quiet, changedSections });
  }
}

function stopSearchFileStream() {
  if (activeSearchFileSource) {
    activeSearchFileSource.close();
    activeSearchFileSource = null;
  }
  activeSearchFileSequence += 1;
  uiState.searchFileLoading = false;
  uiState.searchFileHits = [];
}

function mergeStreamedFileGroup(group) {
  // De-dupe by filePath (groups replace older groups for the same file).
  const existing = uiState.searchFileHits.filter(item => item.filePath !== group.filePath);
  existing.push(group);
  uiState.searchFileHits = existing
    .sort((left, right) => {
      if ((right.score || 0) !== (left.score || 0)) {
        return (right.score || 0) - (left.score || 0);
      }
      return Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0);
    })
    .slice(0, 12);
}

function syncSearchFileStream(query = uiState.searchQuery) {
  const normalizedQuery = String(query || '').trim();
  const activeView = uiState.bootstrap?.settings?.activeView || 'chat';
  if (!normalizedQuery || activeView !== 'search' || typeof EventSource !== 'function') {
    stopSearchFileStream();
    return;
  }

  if (activeSearchFileSource) {
    activeSearchFileSource.close();
    activeSearchFileSource = null;
  }

  const projectId =
    uiState.bootstrap?.activeProject?.id ||
    uiState.bootstrap?.settings?.selectedProjectId ||
    '';
  const sequence = activeSearchFileSequence + 1;
  activeSearchFileSequence = sequence;
  uiState.searchFileHits = [];
  uiState.searchFileLoading = true;

  const url = new URL('/api/search/files', window.location.origin);
  url.searchParams.set('q', normalizedQuery);
  if (projectId) {
    url.searchParams.set('projectId', projectId);
  }

  const source = new EventSource(url.toString());
  activeSearchFileSource = source;

  // File-grouped events arrive on 'group' — one event per file, each
  // carrying `filePath` + `subtitle` + up to 3 representative `hits`.
  // (The transitional per-line 'hit' event was retired in P3 follow-up
  // #3; both server and smoke harness now speak 'group' only.)
  source.addEventListener('group', event => {
    if (sequence !== activeSearchFileSequence) {
      return;
    }

    try {
      mergeStreamedFileGroup(JSON.parse(event.data));
      bgRender();
    } catch {}
  });

  const finish = () => {
    if (sequence !== activeSearchFileSequence) {
      return;
    }

    uiState.searchFileLoading = false;
    if (activeSearchFileSource === source) {
      activeSearchFileSource.close();
      activeSearchFileSource = null;
    }
    bgRender();
  };

  source.addEventListener('done', finish);
  source.addEventListener('error', finish);
  render();
}

function selectedAgentNeedsRuntimeRefresh() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent') {
    return false;
  }

  const selected = selectedAgentProfile();
  if (!selected) {
    return false;
  }

  const telegramChannel =
    selected.channels?.find?.(channel => channel.id === 'telegram') ||
    selected.channels?.telegram;
  const discordChannel =
    selected.channels?.find?.(channel => channel.id === 'discord') ||
    selected.channels?.discord;

  return Boolean(telegramChannel?.enabled || discordChannel?.enabled);
}

function syncAgentRuntimeRefresh() {
  window.clearTimeout(agentRuntimeRefreshTimer);

  if (!selectedAgentNeedsRuntimeRefresh()) {
    return;
  }

  agentRuntimeRefreshTimer = window.setTimeout(async () => {
    if (!selectedAgentNeedsRuntimeRefresh()) {
      return;
    }

    try {
      await loadBootstrap(uiState.searchQuery, { quiet: true });
    } catch {}
  }, 4000);
}

function scheduleSearchRefresh() {
  window.clearTimeout(scheduleSearchRefresh.timer);
  scheduleSearchRefresh.timer = window.setTimeout(() => {
    loadBootstrap(uiState.searchQuery, { quiet: true });
  }, 180);
}

function showError(message) {
  uiState.error = message;
  bgRender();
  window.clearTimeout(showError.timer);
  showError.timer = window.setTimeout(() => {
    uiState.error = '';
    bgRender();
  }, 4800);
}

function voiceBridgeSupported() {
  return Boolean(globalThis.webkit?.messageHandlers?.meloVoice);
}

function openExternalUrl(url) {
  const normalized = String(url || '').trim();
  if (!/^https?:\/\//i.test(normalized)) {
    return false;
  }

  if (globalThis.webkit?.messageHandlers?.meloVoice) {
    globalThis.webkit.messageHandlers.meloVoice.postMessage({
      action: 'openExternalUrl',
      url: normalized,
    });
    return true;
  }

  // Opening with noopener returns null even on success. Create the window
  // synchronously so a real popup failure can be reported, then sever opener.
  const opened = window.open('about:blank', '_blank');
  if (!opened) return false;
  opened.opener = null;
  opened.location.replace(normalized);
  return true;
}

window.addEventListener('melo-external-link', event => {
  if (event.detail?.ok === false) showError('浏览器未能打开，请点击链接旁的「复制链接」后粘贴到浏览器。');
});

function composerHintText({ inline = false } = {}) {
  if (uiState.sending) {
    return 'Working on your message now. Live lookups can take a little longer.';
  }
  if (uiState.voice.recording) {
    return '正在听写，点击麦克风停止。文字可修改，确认后发送。';
  }
  if (uiState.voice.preview) {
    return '转写完成后可编辑，再点击发送。';
  }
  if (!inline && !uiState.composer.trim()) {
    return 'Type / for Melo commands, files, projects, and actions.';
  }
  if (inline) {
    return 'Reply in this thread';
  }
  return 'Enter to send. Shift+Enter for a new line.';
}

function appendComposerText(text = '') {
  const normalized = String(text).trim();
  if (!normalized) {
    return;
  }

  const current = uiState.composer.trim();
  uiState.composer = current ? `${current}\n${normalized}` : normalized;
}

function promptHistoryEntries() {
  return (uiState.bootstrap?.settings?.promptHistory || [])
    .map(entry => String(entry?.content || '').trim())
    .filter(Boolean);
}

function resetComposerHistoryNavigation() {
  uiState.composerHistoryIndex = -1;
  uiState.composerHistoryDraft = '';
}

function navigateComposerHistory(direction = 'older') {
  const entries = promptHistoryEntries();
  if (!entries.length) {
    return false;
  }

  if (uiState.composerHistoryIndex < 0) {
    uiState.composerHistoryDraft = uiState.composer;
  }

  if (direction === 'older') {
    uiState.composerHistoryIndex = Math.min(
      entries.length - 1,
      uiState.composerHistoryIndex + 1,
    );
  } else if (uiState.composerHistoryIndex <= 0) {
    uiState.composerHistoryIndex = -1;
    uiState.composer = uiState.composerHistoryDraft;
    uiState.composerHistoryDraft = '';
    render();
    focusComposerSoon();
    return true;
  } else {
    uiState.composerHistoryIndex -= 1;
  }

  if (uiState.composerHistoryIndex >= 0) {
    uiState.composer = entries[uiState.composerHistoryIndex] || '';
  }

  render();
  focusComposerSoon();
  return true;
}

function homePromptPresetById(presetId) {
  return HOME_PROMPT_PRESETS.find(preset => preset.id === presetId) || null;
}

function focusComposerSoon() {
  window.requestAnimationFrame(() => {
    const composer = document.querySelector('#composer');
    if (!(composer instanceof HTMLTextAreaElement)) {
      return;
    }
    composer.focus();
    composer.selectionStart = composer.selectionEnd = composer.value.length;
  });
}

function syncComposerTextareaHeight() {
  const composer = document.querySelector('#composer');
  if (!(composer instanceof HTMLTextAreaElement)) {
    return;
  }

  const computedStyle = window.getComputedStyle(composer);
  const minHeight = Number.parseFloat(computedStyle.minHeight) || 58;
  const maxHeight = Number.parseFloat(computedStyle.maxHeight) || 220;

  composer.style.height = 'auto';
  const nextHeight = Math.min(maxHeight, Math.max(minHeight, composer.scrollHeight));
  composer.style.height = `${nextHeight}px`;
  composer.style.overflowY = composer.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden';
}

function renderEditContextMenu() {
  return ui`
    <div id="edit-context-menu" class="edit-context-menu" aria-hidden="true">
      <button class="edit-context-item" type="button" data-action="editable-undo">Undo</button>
      <button class="edit-context-item" type="button" data-action="editable-redo">Redo</button>
      <div class="edit-context-divider"></div>
      <button class="edit-context-item" type="button" data-action="editable-cut">Cut</button>
      <button class="edit-context-item" type="button" data-action="editable-copy">Copy</button>
      <button class="edit-context-item" type="button" data-action="editable-paste">Paste</button>
      <button class="edit-context-item" type="button" data-action="editable-select-all">Select all</button>
    </div>
  `;
}

function renderCopyContextMenu() {
  return ui`
    <div id="copy-context-menu" class="edit-context-menu" aria-hidden="true">
      <button class="edit-context-item" type="button" data-action="copy-surface-selection">Copy</button>
      <button class="edit-context-item" type="button" data-action="copy-surface-all">Copy all</button>
      <button class="edit-context-item" type="button" data-action="copy-surface-select-all">Select all</button>
    </div>
  `;
}

function renderRecentContextMenu() {
  const recent = (uiState.bootstrap?.recents || []).find(chat => chat.id === activeRecentContextChatId);
  const isLocked = Boolean(recent?.locked);
  return ui`
    <div id="recent-context-menu" class="edit-context-menu" aria-hidden="true">
      <button class="edit-context-item" type="button" data-action="toggle-chat-lock">
        ${isLocked ? 'Unlock' : 'Lock'}
      </button>
      <div class="edit-context-divider"></div>
      <button class="edit-context-item is-danger" type="button" data-action="delete-chat">
        Delete
      </button>
    </div>
  `;
}

function renderAudioContextMenu() {
  return ui`
    <div id="audio-context-menu" class="edit-context-menu" aria-hidden="true">
      <button class="edit-context-item" type="button" data-action="transcribe-audio-message">Transcribe</button>
    </div>
  `;
}

function openAudioContextMenu(audioUrl, x, y) {
  const menu = document.querySelector('#audio-context-menu');
  if (!(menu instanceof HTMLElement)) return;

  activeAudioContextUrl = audioUrl;
  menu.classList.add('is-open');
  menu.setAttribute('aria-hidden', 'false');
  menu.style.left = '0px';
  menu.style.top = '0px';

  const rect = menu.getBoundingClientRect();
  const left = Math.max(12, Math.min(x, window.innerWidth - rect.width - 12));
  const top = Math.max(12, Math.min(y, window.innerHeight - rect.height - 12));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function closeAudioContextMenu() {
  const menu = document.querySelector('#audio-context-menu');
  if (menu instanceof HTMLElement) {
    menu.classList.remove('is-open');
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    menu.setAttribute('aria-hidden', 'true');
  }
  activeAudioContextUrl = null;
}

function editableSelectionText(target) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    return target.value.slice(start, end);
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    const selection = window.getSelection();
    return selection ? selection.toString() : '';
  }

  return '';
}

function focusEditableTarget() {
  if (
    activeEditableContextTarget instanceof HTMLInputElement ||
    activeEditableContextTarget instanceof HTMLTextAreaElement ||
    activeEditableContextTarget instanceof HTMLElement
  ) {
    activeEditableContextTarget.focus();
  }
}

function closeEditableContextMenu() {
  const menu = document.querySelector('#edit-context-menu');
  if (menu instanceof HTMLElement) {
    menu.classList.remove('is-open');
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    menu.setAttribute('aria-hidden', 'true');
  }
  activeEditableContextTarget = null;
}

function closeCopyContextMenu() {
  const menu = document.querySelector('#copy-context-menu');
  if (menu instanceof HTMLElement) {
    menu.classList.remove('is-open');
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    menu.setAttribute('aria-hidden', 'true');
  }
  activeCopyContextTarget = null;
}

function closeRecentContextMenu() {
  const menu = document.querySelector('#recent-context-menu');
  if (menu instanceof HTMLElement) {
    menu.classList.remove('is-open');
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    menu.setAttribute('aria-hidden', 'true');
  }
  activeRecentContextChatId = null;
}

function openEditableContextMenu(target, x, y) {
  const menu = document.querySelector('#edit-context-menu');
  if (!(menu instanceof HTMLElement)) {
    return;
  }

  activeEditableContextTarget = target;
  menu.classList.add('is-open');
  menu.setAttribute('aria-hidden', 'false');
  menu.style.left = '0px';
  menu.style.top = '0px';

  const rect = menu.getBoundingClientRect();
  const left = Math.max(12, Math.min(x, window.innerWidth - rect.width - 12));
  const top = Math.max(12, Math.min(y, window.innerHeight - rect.height - 12));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function openCopyContextMenu(target, x, y) {
  const menu = document.querySelector('#copy-context-menu');
  if (!(menu instanceof HTMLElement)) {
    return;
  }

  activeCopyContextTarget = target;
  menu.classList.add('is-open');
  menu.setAttribute('aria-hidden', 'false');
  menu.style.left = '0px';
  menu.style.top = '0px';

  const rect = menu.getBoundingClientRect();
  const left = Math.max(12, Math.min(x, window.innerWidth - rect.width - 12));
  const top = Math.max(12, Math.min(y, window.innerHeight - rect.height - 12));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function openRecentContextMenu(chatId, x, y) {
  const menu = document.querySelector('#recent-context-menu');
  if (!(menu instanceof HTMLElement) || !chatId) {
    return;
  }

  // Preserve the recents list scroll position — render() rebuilds the DOM and
  // would reset scrollTop to 0 otherwise.
  const recentList = document.querySelector('.recent-list');
  const savedScrollTop = recentList instanceof HTMLElement ? recentList.scrollTop : 0;

  activeRecentContextChatId = chatId;
  render();

  if (savedScrollTop > 0) {
    const restoredList = document.querySelector('.recent-list');
    if (restoredList instanceof HTMLElement) {
      restoredList.scrollTop = savedScrollTop;
    }
  }

  const nextMenu = document.querySelector('#recent-context-menu');
  if (!(nextMenu instanceof HTMLElement)) {
    return;
  }

  nextMenu.classList.add('is-open');
  nextMenu.setAttribute('aria-hidden', 'false');
  nextMenu.style.left = '0px';
  nextMenu.style.top = '0px';

  const rect = nextMenu.getBoundingClientRect();
  const left = Math.max(12, Math.min(x, window.innerWidth - rect.width - 12));
  const top = Math.max(12, Math.min(y, window.innerHeight - rect.height - 12));
  nextMenu.style.left = `${left}px`;
  nextMenu.style.top = `${top}px`;
}

function copyableSelectionText(target) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return '';
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  const hasAnchor = anchorNode && target.contains(anchorNode);
  const hasFocus = focusNode && target.contains(focusNode);

  return hasAnchor && hasFocus ? selection.toString() : '';
}

function copyableSurfaceText(target) {
  return target.dataset.copyText || target.innerText || target.textContent || '';
}

async function handleCopyContextAction(action) {
  if (!(activeCopyContextTarget instanceof HTMLElement)) {
    closeCopyContextMenu();
    return;
  }

  switch (action) {
    case 'copy-surface-selection': {
      const selectionText = copyableSelectionText(activeCopyContextTarget);
      const text = selectionText || copyableSurfaceText(activeCopyContextTarget);
      if (text) {
        await navigator.clipboard.writeText(text);
      }
      break;
    }
    case 'copy-surface-all': {
      const text = copyableSurfaceText(activeCopyContextTarget);
      if (text) {
        await navigator.clipboard.writeText(text);
      }
      break;
    }
    case 'copy-surface-select-all': {
      const range = document.createRange();
      range.selectNodeContents(activeCopyContextTarget);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      break;
    }
    default:
      break;
  }

  closeCopyContextMenu();
}

async function handleEditableContextAction(action) {
  if (
    !(
      activeEditableContextTarget instanceof HTMLInputElement ||
      activeEditableContextTarget instanceof HTMLTextAreaElement ||
      (activeEditableContextTarget instanceof HTMLElement &&
        activeEditableContextTarget.isContentEditable)
    )
  ) {
    closeEditableContextMenu();
    return;
  }

  focusEditableTarget();

  switch (action) {
    case 'editable-undo':
      document.execCommand('undo');
      break;
    case 'editable-redo':
      document.execCommand('redo');
      break;
    case 'editable-cut': {
      const selectedText = editableSelectionText(activeEditableContextTarget);
      if (selectedText) {
        await navigator.clipboard.writeText(selectedText);
      }
      if (
        activeEditableContextTarget instanceof HTMLInputElement ||
        activeEditableContextTarget instanceof HTMLTextAreaElement
      ) {
        const start = activeEditableContextTarget.selectionStart ?? 0;
        const end = activeEditableContextTarget.selectionEnd ?? start;
        activeEditableContextTarget.setRangeText('', start, end, 'start');
        activeEditableContextTarget.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('cut');
      }
      break;
    }
    case 'editable-copy': {
      const selectedText = editableSelectionText(activeEditableContextTarget);
      if (selectedText) {
        await navigator.clipboard.writeText(selectedText);
      }
      break;
    }
    case 'editable-paste': {
      const text = await navigator.clipboard.readText();
      if (
        activeEditableContextTarget instanceof HTMLInputElement ||
        activeEditableContextTarget instanceof HTMLTextAreaElement
      ) {
        const start = activeEditableContextTarget.selectionStart ?? activeEditableContextTarget.value.length;
        const end = activeEditableContextTarget.selectionEnd ?? start;
        activeEditableContextTarget.setRangeText(text, start, end, 'end');
        activeEditableContextTarget.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('insertText', false, text);
      }
      break;
    }
    case 'editable-select-all':
      if (
        activeEditableContextTarget instanceof HTMLInputElement ||
        activeEditableContextTarget instanceof HTMLTextAreaElement
      ) {
        activeEditableContextTarget.select();
      } else if (activeEditableContextTarget instanceof HTMLElement) {
        const range = document.createRange();
        range.selectNodeContents(activeEditableContextTarget);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      break;
    default:
      break;
  }

  closeEditableContextMenu();
}

function setVoiceState(patch = {}) {
  uiState.voice = {
    ...uiState.voice,
    ...patch,
    supported: patch.supported ?? (voiceBridgeSupported() || uiState.voice.supported),
  };
}

function isPdfAttachment(attachment = {}) {
  const mimeType = String(attachment?.mimeType || '').toLowerCase();
  const fileName = String(attachment?.fileName || attachment?.title || attachment?.url || '');
  return mimeType.includes('pdf') || /\.pdf(?:\?|$)/i.test(fileName);
}

function isPdfFile(file) {
  return String(file?.type || '').toLowerCase().includes('pdf') || /\.pdf$/i.test(file?.name || '');
}

function attachmentIcon(kind, attachment = null) {
  if (attachment && isPdfAttachment(attachment)) return icon.file;
  switch (kind) {
    case 'image':
      return icon.image;
    case 'video':
      return icon.video;
    case 'audio':
      return icon.audio;
    case 'link':
    default:
      return icon.link;
  }
}

function attachmentLabel(attachment) {
  return attachment.title || attachment.fileName || `${attachment.kind} attachment`;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function detectAttachmentKindFromFile(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (isPdfFile(file)) return 'link';
  return null;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function queueComposerFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) {
    return;
  }

  const nextAttachments = [];
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) {
      showError(`${file.name} is too large. Keep attachments under 20 MB.`);
      continue;
    }

    const kind = detectAttachmentKindFromFile(file);
    if (!kind) {
      showError(`${file.name} is not supported yet. Add images, video, audio, or PDF files here.`);
      continue;
    }

    const url = await readFileAsDataUrl(file);
    nextAttachments.push({
      id: crypto.randomUUID(),
      kind,
      url,
      title: file.name,
      fileName: file.name,
      mimeType: file.type || (isPdfFile(file) ? 'application/pdf' : ''),
      sizeLabel: formatFileSize(file.size),
    });
  }

  if (nextAttachments.length) {
    uiState.composerAttachments = [...uiState.composerAttachments, ...nextAttachments].slice(0, 8);
    uiState.composerAttachmentMenuOpen = false;
    render();
  }
}

function openComposerAttachmentPicker(accept) {
  const input = document.querySelector('#composer-attachment-input');
  if (!(input instanceof HTMLInputElement)) {
    showError('Attachment picker is unavailable right now.');
    return;
  }
  uiState.composerAttachmentMenuOpen = false;
  input.accept = accept;
  input.value = '';
  input.click();
  render();
}

function promptComposerLinkAttachment() {
  const value = window.prompt('Paste a link to attach to this chat', 'https://');
  const url = String(value || '').trim();
  if (!url) {
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    showError('Please paste a full http or https link.');
    return;
  }
  // Reuse the same classifier as text-paste promotion so YouTube / audio /
  // video / PDF / plain web pages produce identical kind / mimeType / title
  // regardless of how the user attached them.
  const promoted = promoteTextUrlsToAttachments(url, uiState.composerAttachments);
  if (!promoted.length) {
    // URL was already in composerAttachments — silently no-op.
    uiState.composerAttachmentMenuOpen = false;
    render();
    return;
  }
  const enriched = promoted.map(a => ({
    ...a,
    id: crypto.randomUUID(),
    sizeLabel: '',
  }));
  uiState.composerAttachments = [...uiState.composerAttachments, ...enriched].slice(0, 8);
  uiState.composerAttachmentMenuOpen = false;
  render();
}

function hasFileTransfer(event) {
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes('Files');
}

function composerDropTargetFromEvent(event) {
  if (!(event.target instanceof Element)) {
    return null;
  }
  return event.target.closest('.composer-input-frame');
}

function setComposerDragActive(active) {
  const nextValue = Boolean(active);
  if (uiState.composerDragActive === nextValue) {
    return;
  }
  uiState.composerDragActive = nextValue;
  render();
}

function voiceContext() {
  const settings = uiState.bootstrap?.settings || {};
  return [settings.activeView, settings.selectedProjectId, settings.selectedChatId, uiState.activeChatAgentId].join('|');
}

const voiceInput = createVoiceInput({
  getContext: voiceContext,
  onChange: state => {
    const samePhase = state.status === uiState.voice.status && state.sessionID === uiState.voice.sessionID;
    setVoiceState(state);
    const preview = document.querySelector('.voice-preview-body');
    if (samePhase && voiceInputActive(state) && preview) {
      // Partial words must not rebuild the chat, interrupt scrolling or break IME typing.
      preview.textContent = state.preview || '识别内容将进入输入框，不会自动发送。';
      return;
    }
    render();
  },
  onCommit: text => {
    appendComposerText(text);
    window.requestAnimationFrame(() => {
      const composer = document.querySelector('#composer');
      if (!(composer instanceof HTMLTextAreaElement)) return;
      composer.focus();
      composer.selectionStart = composer.selectionEnd = composer.value.length;
    });
  },
});

function stopVoiceCaptureIfNeeded() {
  if (voiceInputActive(uiState.voice)) voiceInput.cancel();
}

function handleVoiceBridgeEvent(detail = {}) { voiceInput.receive(detail); }

function toggleVoiceInput() {
  if (voiceInputActive(uiState.voice)) { voiceInput.stop(); return; }
  if (uiState.sending) return;
  stopCurrentTts();
  voiceInput.start(uiState.voiceLanguage || 'zh-CN');
}

function applyBootstrap(payload) {
  if (olderBootstrap(payload, uiState.bootstrap)) return;
  if (voiceInputActive(uiState.voice) && ['activeView', 'selectedChatId', 'selectedProjectId'].some(key => payload?.settings?.[key] !== uiState.bootstrap?.settings?.[key])) stopVoiceCaptureIfNeeded();
  const prevProjectId = uiState.bootstrap?.settings?.selectedProjectId || null;
  const nextProjectId = payload?.settings?.selectedProjectId || null;
  uiState.bootstrap = payload;
  // Drafts belong to each role and scope; only save/cancel may discard them.
  syncSelectedArtifact();
  if (payload?.settings?.activeView !== 'search' || !uiState.searchQuery.trim()) {
    stopSearchFileStream();
  }
  // Workspace-relative citation paths can shadow different files across
  // projects — flush the drawer's preview cache on project switches.
  if (prevProjectId !== nextProjectId) {
    resetCitationPreviewCache();
  }
  render();
}

// Background refreshes also preserve drafts and defer DOM updates while typing.
function applyBootstrapPreservingDrafts(payload, { background = false } = {}) {
  if (olderBootstrap(payload, uiState.bootstrap)) return;
  const changedSections = changedBootstrapSections(uiState.bootstrap, payload);
  uiState.bootstrap = payload;
  syncSelectedArtifact();
  if (payload?.settings?.activeView !== 'search' || !uiState.searchQuery.trim()) {
    stopSearchFileStream();
  }
  // Forward the `background` flag so the typing guard in render() can defer
  // the DOM swap if the user is actively typing (see feedback: "还是跳光标").
  render({ background, changedSections });
}

async function patchSettings(patch) {
  if (['activeView', 'selectedChatId', 'selectedProjectId'].some(key => key in patch && patch[key] !== uiState.bootstrap?.settings?.[key])) stopVoiceCaptureIfNeeded();
  if (patch.activeView) {
    uiState.neuralOverview = false;
    uiState.neuralGroup = null;
  }
  const payload = await api('/api/settings', {
    method: 'POST',
    body: patch,
  });
  applyBootstrap(payload);
}

async function handleCreateChat({
  mode = uiState.bootstrap.settings.activeMode,
  projectId = uiState.newChatProjectId ?? null,
  agentId = uiState.activeChatAgentId || 'main',
} = {}) {
  const payload = await api('/api/chats', {
    method: 'POST',
    body: { mode, projectId, agentId, modelSelection:uiState.newChatModel, contextArtifactIds:uiState.newChatArtifactIds },
  });
  uiState.composer = '';
  uiState.composerAttachments = [];
  resetComposerHistoryNavigation();
  // 2026-06-04 audit闭环: clear pending voice transcript + its linking id when
  // switching chats. Without this a recorded-but-unsent voice message leaves
  // composerVoiceTranscript/Id set; the next plain-text send would carry a
  // stale extractedMedia transcript referencing an orphan attachmentId.
  // Parallels the send-path reset (handleSendMessage).
  uiState.composerVoiceTranscript = null;
  uiState.composerVoiceAttachmentId = null;
  applyBootstrap(payload);
}

async function handleOpenNewChatHome() {
  uiState.neuralOverview = false;
  uiState.neuralGroup = null;
  stopVoiceCaptureIfNeeded();
  setVoiceState({
    recording: false,
    preview: '',
    error: '',
    status: uiState.voice.supported ? 'ready' : 'idle',
  });
  uiState.composer = '';
  resetComposerHistoryNavigation();
  uiState.composerAttachments = [];
  // 2026-06-04 audit闭环: also clear pending voice transcript + linking id
  // (same stale-transcript leak as handleCreateChat) — composerAttachments
  // reset above drops the audio attachment but the voice fields would
  // otherwise survive into the next send.
  uiState.composerVoiceTranscript = null;
  uiState.composerVoiceAttachmentId = null;
  uiState.composerAttachmentMenuOpen = false;
  uiState.composerDragActive = false;
  uiState.commandPalette.open = false;
  uiState.commandPalette.query = '';
  uiState.commandPalette.selectedIndex = 0;
  uiState.shouldFocusSearch = false;

  await patchSettings({
    activeView: 'chat',
    activeMode: 'chat',
    selectedChatId: null,
    selectedFilePath: null,
  });
}

async function handleToggleChatLock(chatId) {
  const recent = (uiState.bootstrap?.recents || []).find(chat => chat.id === chatId);
  if (!recent) {
    showError('Chat not found.');
    return;
  }

  applyBootstrap(
    await api('/api/chats/update', {
      method: 'POST',
      body: {
        chatId,
        patch: {
          locked: !recent.locked,
        },
      },
    }),
  );
  closeRecentContextMenu();
}

async function handleDeleteChat(chatId) {
  applyBootstrap(
    await api('/api/chats/delete', {
      method: 'POST',
      body: { chatId },
    }),
  );
  closeRecentContextMenu();
}

async function handleTranscribeAudio() {
  const audioUrl = activeAudioContextUrl;
  closeAudioContextMenu();
  if (!audioUrl) return;

  try {
    const result = await api('/api/audio/transcribe', {
      method: 'POST',
      body: { url: audioUrl },
    });
    if (result?.ok && result.text) {
      showTranscriptToast(result.text);
    } else {
      uiState.error = result?.error || 'Transcription failed.';
      render();
      setTimeout(() => { uiState.error = null; render(); }, 4000);
    }
  } catch (err) {
    uiState.error = String(err?.message || 'Transcription failed.');
    bgRender();
    setTimeout(() => { uiState.error = null; render(); }, 4000);
  }
}

/**
 * Lightweight one-line confirmation toast.  Used by short-lived feedback
 * like "Copied <path>" — distinct from `showTranscriptToast` (which is a
 * persistent panel with copy/close affordances).  Auto-dismisses after
 * `ms` and only ever shows one at a time.
 */
function showFlashToast(message, { ms = 2000 } = {}) {
  const existing = document.querySelector('#flash-toast');
  if (existing instanceof HTMLElement) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'flash-toast';
  toast.className = 'flash-toast';
  toast.textContent = String(message ?? '');
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.isConnected) toast.remove(); }, ms);
}

/**
 * Soft-delete undo toast.  Bottom-centre banner with a live "Xs"
 * countdown and an Undo button.  Only one shows at a time — opening a
 * second one removes the first (and silently commits its underlying
 * delete by virtue of leaving the timer alone).
 *
 * Pure logic (label formatting, tick scheduling) lives in
 * `desktop-ui/undoToast.js` so it's covered by node:test; this helper
 * is the DOM glue.
 */
function showUndoToast({ message = '', onUndo, ms = UNDO_TOAST_DEFAULT_MS } = {}) {
  const existing = document.querySelector('#undo-toast');
  if (existing instanceof HTMLElement) existing.remove();

  const deadline = Date.now() + ms;
  const toast = document.createElement('div');
  toast.id = 'undo-toast';
  toast.className = 'undo-toast';
  // Two flex children: the live label (message + countdown) and the
  // Undo button.  innerHTML stays here because the message has already
  // been built by the caller from trusted state (no user-supplied
  // markup).
  toast.innerHTML = ui`
    <span class="undo-toast-label" data-role="label"></span>
    <button class="undo-toast-button" type="button" data-role="undo">Undo</button>
  `;
  const labelEl = toast.querySelector('[data-role="label"]');
  const button = toast.querySelector('[data-role="undo"]');
  let tickHandle = null;

  function clearTickHandle() {
    if (tickHandle != null) {
      clearTimeout(tickHandle);
      tickHandle = null;
    }
  }

  function dismiss() {
    clearTickHandle();
    if (toast.isConnected) toast.remove();
  }

  function tick() {
    const remaining = deadline - Date.now();
    if (labelEl) labelEl.textContent = formatUndoToastLabel(message, remaining);
    if (remaining <= 0) {
      dismiss();
      return;
    }
    tickHandle = setTimeout(tick, nextCountdownTickMs(remaining));
  }

  if (button) {
    button.addEventListener('click', () => {
      dismiss();
      try { onUndo?.(); } catch (err) {
        // Surface but never let the toast itself throw out of the
        // click handler (would interrupt other UI).
        console.warn('[undo-toast] onUndo handler threw:', err?.message || err);
      }
    });
  }

  document.body.appendChild(toast);
  tick();
}

function showTranscriptToast(text) {
  const existing = document.querySelector('#transcript-toast');
  if (existing instanceof HTMLElement) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'transcript-toast';
  toast.className = 'transcript-toast';
  toast.innerHTML = ui`
    <div class="transcript-toast-header">
      <span>Transcript</span>
      <button class="transcript-toast-close" type="button" aria-label="Close">&#x2715;</button>
    </div>
    <div class="transcript-toast-body">${escapeHtml(text)}</div>
    <button class="transcript-toast-copy" type="button">Copy text</button>
  `;

  toast.querySelector('.transcript-toast-close').addEventListener('click', () => toast.remove());
  toast.querySelector('.transcript-toast-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(text).catch(() => {});
    toast.remove();
  });

  document.body.appendChild(toast);
  setTimeout(() => { if (toast.isConnected) toast.remove(); }, 20000);
}

async function startProjectSession(projectId, mode) {
  await handleCreateChat({ projectId, mode });
}

async function handleSendMessage(prepared = null) {
  if (uiState.sending || uiState.agentSelectionSaving || (!prepared && voiceInputActive(uiState.voice))) return;
  const content = prepared?.content || uiState.composer.trim();
  const attachments = prepared ? [] : [...uiState.composerAttachments];
  if (!content && !attachments.length) return;

  const fromOverview = prepared ? false : uiState.neuralOverview;
  uiState.neuralOverview = false;
  uiState.neuralGroup = null;
  if (content && (await handleComposerCommand())) {
    return;
  }

  // Tracks whether the user clicked Stop mid-stream. Read in the finally
  // block to decide between flushing the buffered TTS tail (good run) and
  // dropping it (aborted run — a half-finished sentence would otherwise
  // play seconds after the Stop click).
  const imageTask = prepared?.imageTask || consumeImageTask();
  const teamPlan = prepared?.teamPlan || null;
  let sendWasAborted = false;
  let sendSucceeded = false;
  const replyDelivery = createReplyDelivery();

  // Capture and clear the voice transcript before resetting composer state.
  const voiceTranscript = (prepared ? null : uiState.composerVoiceTranscript) || null;
  if (!prepared) uiState.composerVoiceTranscript = null;
  // Same for the linking id (2026-05-23 Codex C 闭环) — capture before reset
  // so the prefilled transcript entry can reference the audio attachment.
  const voiceAttachmentId = (prepared ? null : uiState.composerVoiceAttachmentId) || null;
  if (!prepared) uiState.composerVoiceAttachmentId = null;

  let chatId = prepared?.chatId || (fromOverview ? null : uiState.bootstrap?.settings?.selectedChatId || null);
  const submissionKey = targetChatId => JSON.stringify({ chatId: targetChatId, content, attachments, imageTask, teamPlan,
    voiceTranscript, voiceAttachmentId, mode: uiState.bootstrap?.settings?.activeMode,
    agentId: activeChat()?.agentId || uiState.bootstrap?.settings?.selectedAgentId,
    modelSelection: activeChat()?.modelSelection || null });
  const retry = !prepared && uiState.composerRetry?.key === submissionKey(chatId) ? uiState.composerRetry : null;
  uiState.sending = true;
  uiState.activeTurn = createTurnPresentation(prepared?.requestId || retry?.requestId || crypto.randomUUID());
  uiState.modelPickerOpen = false;
  uiState.thinkingSince = Date.now();
  uiState.sendAbortController = new AbortController();
  let previousBootstrap = cloneBootstrapState(uiState.bootstrap);
  const turnRequestId = uiState.activeTurn.requestId;
  resetStreamingAssistant();
  uiState.composer = '';
  resetComposerHistoryNavigation();
  uiState.composerAttachments = [];
  uiState.composerAttachmentMenuOpen = false;
  if (chatId) {
    applyOptimisticUserMessage({
      chatId,
      content,
      attachments,
    });
  }
  render();

  try {
    if (!chatId) {
      await handleCreateChat();
      chatId = uiState.bootstrap.settings.selectedChatId;
      previousBootstrap = cloneBootstrapState(uiState.bootstrap);
      applyOptimisticUserMessage({
        chatId,
        content,
        attachments,
      });
      render();
    }

    uiState.streamingChatId = chatId;
    uiState.streamingAssistantText = '';
    render();

    // Start streaming TTS session
    if (_isTtsActive()) await _streamTtsStart();

    const result = await streamApi('/api/chat/send/stream', {
      method: 'POST',
      body: {
        requestId: turnRequestId,
        chatId,
        content,
        attachments,
        ...(imageTask ? { imageTask } : {}),
        ...(teamPlan ? {teamPlan} : {}),
        ...(voiceTranscript
          ? {
              extractedMedia: [
                {
                  // attachmentId links this transcript to the voice audio
                  // attachment so describeAudioExtractionStatus matches them
                  // (2026-05-23 Codex C 闭环).
                  ...(voiceAttachmentId ? { attachmentId: voiceAttachmentId } : {}),
                  kind: 'transcript',
                  text: voiceTranscript,
                  metadata: { source: 'speech-recognition', fileName: 'voice-message.wav' },
                },
              ],
            }
          : {}),
        mode: uiState.bootstrap.settings.activeMode,

      },
      signal: uiState.sendAbortController.signal,
      onEvent: message => {
        if (message.event === 'execution_scene') receiveExecutionScene(message.payload?.scene);
        const previousPhase = uiState.activeTurn?.phase;
        receiveTurnPresentation(uiState.activeTurn, message.event, message.payload);
        if (previousPhase !== uiState.activeTurn?.phase) render();
        const delivery = receiveReplyDelivery(replyDelivery, message.event, message.payload);
        if (delivery.speechDelta) _streamTtsPushChunk(delivery.speechDelta);
        if (typeof delivery.finalSpeechText === 'string' && _isTtsActive()) {
          _streamTts.buffer = delivery.finalSpeechText;
        }
        if (message.event === 'delta') {
          uiState.streamingChatId = chatId;
          // payload.delta is always the incremental text; payload.text is the accumulated total.
          // Use payload.delta directly for TTS — the derived `delta` below can be null when
          // both fields are present (which all streaming paths do), causing TTS to never fire.
          const payloadDelta = String(message.payload?.delta || '');
          const delta = typeof message.payload?.text === 'string'
            ? null // full-text replace for display accumulation
            : payloadDelta;
          uiState.streamingAssistantText =
            typeof message.payload?.text === 'string'
              ? message.payload.text
              : `${uiState.streamingAssistantText}${delta}`;
          // Feed incremental delta to streaming TTS
          // Fast path: during a pure-delta stream frame, patch ONLY the
          // streaming bubble instead of doing a full `app.innerHTML = ...`
          // rebuild. Falls back to render() the first time through (DOM
          // shell doesn't exist yet) or when the bubble node can't be
          // found. This is what kills the 闪屏 the user reported.
          if (!renderStreamingFast()) render();
        } else if (message.event === 'tool_permission') {
          // Tool permission request: show dialog. Two payload shapes:
          //   tool-runner  → { requestId, toolId, args }
          //   file-safety  → { requestId, kind: 'file_safety', operation, ...payload }
          const payload = message.payload || {};
          const { requestId } = payload;
          if (!requestId) {
            // Malformed event — ignore.
          } else if (payload.kind === 'file_safety') {
            const { operation, ...rest } = payload;
            // De-dupe by requestId only — multiple distinct file ops can be
            // pending in parallel (e.g. delete stage 1 + a separate write).
            uiState.pendingToolPermissions = uiState.pendingToolPermissions.filter(
              p => p.requestId !== requestId,
            );
            uiState.pendingToolPermissions.push({
              kind: 'file_safety',
              requestId,
              operation,
              payload: rest,
            });
            render();
          } else if (payload.toolId) {
            const { toolId, args } = payload;
            // Retransmissions replace only themselves; parallel calls need distinct decisions.
            uiState.pendingToolPermissions = uiState.pendingToolPermissions.filter(
              p => p.requestId !== requestId,
            );
            uiState.pendingToolPermissions.push({
              kind: 'tool',
              requestId,
              toolId,
              args: args || {},
            });
            render();
          }
        } else if (message.event === 'reply_text') {
          // Speech is handled by replyDelivery only after the finalized event.
        } else if (message.event === 'tool_calls_start') {
          // Tools about to execute — strip <tool_call> XML from the streaming display
          uiState.streamingAssistantText = uiState.streamingAssistantText
            .replace(/<tool_call>[\s\S]*$/, '')
            .trim();
          // Discard intermediate TTS text ("我正在搜索...")
          _streamTtsOnToolCall();
          // Mark as running
          const calls = message.payload?.calls || [];
          for (const c of calls) {
            const existing = uiState.activeToolCalls.find(t => t.id === c.id);
            if (existing) {
              existing.status = 'running';
            } else {
              uiState.activeToolCalls.push({ id: c.id, name: c.name, arguments: c.arguments, status: 'running' });
            }
          }
          render();
        } else if (message.event === 'tool_calls_done') {
          // Tools finished: update status.  G-1d slice 1.5 (2026-05-11):
          // capture `evidenceTrail` when present so devtools / a future
          // debug overlay (G-1f) can show which fallback tiers a search
          // tool walked through.  Field is optional — only the 3 search
          // tools (fetch_url / social_link / web_search) populate it.
          const results = message.payload?.results || [];
          for (const r of results) {
            const existing = uiState.activeToolCalls.find(t => t.id === r.id);
            if (existing) {
              existing.status = r.ok ? 'ok' : 'error';
              existing.output = r.output;
              if (Array.isArray(r.evidenceTrail) && r.evidenceTrail.length > 0) {
                existing.evidenceTrail = r.evidenceTrail;
              }
            }
          }
          // Clear completed calls after a short delay so user sees the checkmarks
          setTimeout(() => {
            uiState.activeToolCalls = uiState.activeToolCalls.filter(t => t.status === 'running');
            bgRender();
          }, 1800);
          bgRender();
        }
      },
    });

    sendSucceeded = true;
    if (!prepared) uiState.composerRetry = null;
    notifyLocalCompletion();
    if (result?.bootstrap) {
      applyBootstrap(result.bootstrap);
    } else {
      await loadBootstrap(uiState.searchQuery, { quiet: true });
    }
  } catch (error) {
    if (isAbortError(error)) {
      sendWasAborted = true;
      try {
        await loadBootstrap(uiState.searchQuery, { quiet: true });
      } catch {}
      return;
    }
    try {
      await loadBootstrap(uiState.searchQuery, { quiet: true });
    } catch {
      if (previousBootstrap) {
        uiState.bootstrap = previousBootstrap;
      }
    }
    uiState.composer = content;
    uiState.composerAttachments = attachments;
    uiState.composerVoiceTranscript = voiceTranscript;
    uiState.composerVoiceAttachmentId = voiceAttachmentId;
    if (!prepared) uiState.composerRetry = { requestId: turnRequestId, chatId, key: submissionKey(chatId),
      interrupted: error.code === 'REQUEST_INTERRUPTED' };
    restoreImageTask(imageTask);
    uiState.composerAttachmentMenuOpen = false;
    showError(error.message);
  } finally {
    uiState.sending = false;
    uiState.activeTurn = null;
    uiState.sendAbortController = null;
    uiState.thinkingSince = 0;
    uiState.activeToolCalls = [];
    uiState.pendingToolPermissions = [];

    // Stop button behaviour: when the user aborted the stream, the buffered
    // partial sentence in _streamTts.buffer is half a thought — flushing it
    // would have the assistant speak garbled fragments seconds after the
    // click. Discard the buffer AND tell the server to abort any synthesis
    // already on its way (covers the queue path + speak-text fast paths).
    if (sendWasAborted || !sendSucceeded) {
      try { await api('/api/tts/queue-clear', { method: 'POST', body: {} }); } catch {}
      try { await api('/api/tts/speak-stop', { method: 'POST', body: {} }); } catch {}
      _streamTtsReset();
    } else if (_isTtsActive()) {
      await _streamTtsFlush(); // sends accumulated text / remaining tail to TTS
    } else {
      _streamTtsReset();
    }
    resetStreamingAssistant();
    render();
  }
}

function handleStopSending() {
  if (!uiState.sending || !uiState.sendAbortController) {
    return;
  }

  uiState.sendAbortController.abort();
}

// ── TTS helpers ──────────────────────────────────────────────────────────────

const TTS_API_VOICES = [
  { id: 'alloy',   label: 'Alloy',   desc: 'Neutral & balanced' },
  { id: 'ash',     label: 'Ash',     desc: 'Warm & conversational' },
  { id: 'coral',   label: 'Coral',   desc: 'Expressive & bright' },
  { id: 'echo',    label: 'Echo',    desc: 'Deep & resonant' },
  { id: 'fable',   label: 'Fable',   desc: 'Authoritative & clear' },
  { id: 'nova',    label: 'Nova',    desc: 'Friendly (default)' },
  { id: 'onyx',    label: 'Onyx',    desc: 'Rich & deep' },
  { id: 'sage',    label: 'Sage',    desc: 'Calm & measured' },
  { id: 'shimmer', label: 'Shimmer', desc: 'Soft & gentle' },
  { id: 'verse',   label: 'Verse',   desc: 'Dynamic & expressive' },
];

const EDGE_TTS_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural',   label: '晓晓 (zh-CN)', desc: '温柔自然' },
  { id: 'zh-CN-YunxiNeural',      label: '云希 (zh-CN)', desc: '活泼男声' },
  { id: 'zh-CN-YunjianNeural',    label: '云健 (zh-CN)', desc: '深沉男声' },
  { id: 'zh-CN-XiaohanNeural',    label: '晓涵 (zh-CN)', desc: '沉稳女声' },
  { id: 'zh-TW-HsiaoChenNeural',  label: '曉臻 (zh-TW)', desc: '台湾普通话' },
  { id: 'en-US-AriaNeural',       label: 'Aria (en-US)',  desc: 'Expressive & natural' },
  { id: 'en-US-JennyNeural',      label: 'Jenny (en-US)', desc: 'Friendly & versatile' },
  { id: 'en-US-GuyNeural',        label: 'Guy (en-US)',   desc: 'Authoritative male' },
  { id: 'en-GB-SoniaNeural',      label: 'Sonia (en-GB)', desc: 'British English' },
  { id: 'ja-JP-NanamiNeural',     label: '七海 (ja-JP)',  desc: '日本語' },
  { id: 'ko-KR-SunHiNeural',      label: '선히 (ko-KR)',  desc: '한국어' },
];

const MINIMAX_TTS_PARAMS = [
  {
    key: 'ttsSpeed',
    label: 'Speed / 语速',
    defaultValue: 1,
    min: 0.5,
    max: 2,
    step: 0.1,
    note: '默认 1.0；0.5 最慢，2.0 最快。',
  },
  {
    key: 'ttsPitch',
    label: 'Pitch / 音高',
    defaultValue: 0,
    min: -12,
    max: 12,
    step: 1,
    note: '默认 0；-12 更低沉，12 更明亮。',
  },
  {
    key: 'ttsVol',
    label: 'Volume / 音量',
    defaultValue: 1,
    min: 0.1,
    max: 10,
    step: 0.1,
    note: '默认 1.0；0.1 最小，10 最大。',
  },
];

function agentTtsParamInputValue(draft, selected, key, defaultValue) {
  const hasDraftValue =
    draft && Object.prototype.hasOwnProperty.call(draft, key);
  const raw = hasDraftValue ? draft[key] : selected?.[key];
  if (raw === null || raw === undefined || raw === '') {
    return String(defaultValue);
  }
  return String(raw);
}

function coerceMiniMaxTtsParam(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function minimaxTtsParamsForAgent(agent) {
  const params = {};
  for (const def of MINIMAX_TTS_PARAMS) {
    params[def.key] = coerceMiniMaxTtsParam(
      agent?.[def.key],
      def.defaultValue,
      def.min,
      def.max,
    );
  }
  return params;
}

function minimaxTtsConfigPatchForVoice(voiceId) {
  const agent = allChatAgentProfiles().find(profile => profile.minimaxVoiceId === voiceId);
  // Only inherit speed / pitch / vol from the bound agent when that agent
  // explicitly defines them. Falling back to the def.defaultValue would
  // overwrite the user's manual connector-level tuning every time they
  // pick a voice, which is the bug the audit caught: the tts panel's
  // sliders kept resetting to 1.0 / 0 / 1.0 on each voice change.
  const patch = { minimaxVoiceId: voiceId };
  if (agent) {
    for (const def of MINIMAX_TTS_PARAMS) {
      const raw = agent[def.key];
      if (raw === null || raw === undefined || raw === '') continue;
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) continue;
      patch[def.key] = Math.max(def.min, Math.min(def.max, numeric));
    }
  }
  return patch;
}

function renderMinimaxTtsParameterInputs(draft, selected) {
  return ui`
    <div class="minimax-param-list">
      ${MINIMAX_TTS_PARAMS.map(def => ui`
        <label class="minimax-param-row">
          <input
            class="config-input minimax-param-input"
            type="number"
            name="${def.key}"
            value="${escapeHtml(agentTtsParamInputValue(draft, selected, def.key, def.defaultValue))}"
            min="${def.min}"
            max="${def.max}"
            step="${def.step}"
            inputmode="decimal"
          />
          <span class="minimax-param-copy">
            <span class="minimax-param-name">${escapeHtml(def.label)}</span>
            <span class="minimax-param-note">${escapeHtml(def.note)}</span>
          </span>
        </label>
      `).join('')}
    </div>
  `;
}

let _ttsAudio = null;

function initBrowserVoices() {
  if (!globalThis.speechSynthesis) return;
  const load = () => {
    const voices = speechSynthesis.getVoices();
    if (voices.length) {
      uiState.ttsBrowserVoices = voices;
      render();
    }
  };
  speechSynthesis.addEventListener('voiceschanged', load);
  load();
}

// Patch just the speak buttons without a full render() — avoids scroll jump
function _updateTtsSpeakingUI(activeMessageId) {
  const loadingId = uiState.ttsSpeakingLoadingId;
  document.querySelectorAll('[data-action="speak-message"]').forEach(btn => {
    const isActive = activeMessageId && btn.dataset.messageId === activeMessageId;
    const isLoading = !isActive && loadingId && btn.dataset.messageId === loadingId;
    btn.classList.toggle('is-speaking', Boolean(isActive));
    btn.classList.toggle('is-tts-loading', Boolean(isLoading));
    btn.title = isActive ? 'Stop speaking' : 'Read aloud';
    btn.setAttribute('aria-label', isActive ? 'Stop speaking' : 'Read aloud');
  });
}

async function stopCurrentTts() {
  if (_ttsAudio) {
    const prev = _ttsAudio;
    _ttsAudio = null;
    // Await pause() so that any speak-stop request reaches the server before
    // the caller proceeds to send a new speak-text (prevents session-increment race).
    try { await prev.pause(); } catch {}
    if (prev instanceof Audio) {
      try { prev.src = ''; } catch {}
    }
  }
  if (globalThis.speechSynthesis?.speaking) {
    speechSynthesis.cancel();
  }
  uiState.ttsSpeakingMessageId = null;
  _updateTtsSpeakingUI(null);
}

function _playAudioBuffer(base64, mimeType, messageId) {
  if (messageId) { uiState.ttsSpeakingMessageId = messageId; _updateTtsSpeakingUI(messageId); }

  // Prefer native Swift bridge — bypasses WKWebView autoplay restrictions
  if (window.webkit?.messageHandlers?.meloVoice) {
    window.webkit.messageHandlers.meloVoice.postMessage({ action: 'playAudio', data: base64 });
    // Authoritative end-of-playback comes from Swift's
    // AVAudioPlayerDelegate.audioPlayerDidFinishPlaying which dispatches a
    // melo-tts CustomEvent (see _installMeloTtsListener below). The duration
    // heuristic kept here as a safety net for stale frames in case the
    // delegate event fails to land — long buffers used to desync from real
    // playback when this was the ONLY signal, leaving the indicator stuck
    // and letting a second click race a still-playing audio source.
    const approxMs = Math.max(3000, (base64.length * 0.75 / 16000) * 1000);
    const safetyTimer = setTimeout(() => {
      if (uiState.ttsSpeakingMessageId === messageId) {
        uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
      }
      if (_ttsAudio === bridgeRef) _ttsAudio = null;
    }, approxMs + 5000);
    const bridgeRef = {
      source: 'avaudio',
      pause: () => {
        clearTimeout(safetyTimer);
        if (window.webkit?.messageHandlers?.meloVoice) {
          window.webkit.messageHandlers.meloVoice.postMessage({ action: 'stopAudio' });
        }
        uiState.ttsSpeakingMessageId = null;
      },
      _onAudioEnded: () => {
        clearTimeout(safetyTimer);
        if (uiState.ttsSpeakingMessageId === messageId) {
          uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
        }
        if (_ttsAudio === bridgeRef) _ttsAudio = null;
      },
    };
    _ttsAudio = bridgeRef;
    return;
  }

  // Fallback: WebView Audio element with Blob URL
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mimeType || 'audio/mpeg' });
  const blobUrl = URL.createObjectURL(blob);
  const audio = new Audio(blobUrl);
  _ttsAudio = audio;
  const cleanup = (ref) => () => {
    URL.revokeObjectURL(blobUrl);
    if (_ttsAudio === ref) { _ttsAudio = null; uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null); }
  };
  audio.addEventListener('ended', cleanup(audio));
  audio.addEventListener('error', cleanup(audio));
  audio.play().catch(cleanup(audio));
}

async function loadMacosVoices() {
  if (uiState.ttsMacosVoicesLoaded) return;
  try {
    const result = await api('/api/tts/say-voices', { method: 'GET' });
    const voices = Array.isArray(result?.voices) ? result.voices : [];
    uiState.ttsMacosVoices = voices;
    uiState.ttsMacosVoicesLoaded = true;
    bgRender();
  } catch {
    uiState.ttsMacosVoices = [];
    uiState.ttsMacosVoicesLoaded = true;  // mark loaded even on failure so we don't retry every panel open
    bgRender();
  }
}

function speakWithBrowser(text, messageId = null) {
  // WKWebView (Melo Desktop app) silently drops `speechSynthesis.speak()`
  // — utterances are queued but no sound comes out. Fall through to the
  // Swift native bridge (AVSpeechSynthesizer) which DOES output to host
  // speakers. The dropdown's voice picker only applies in real browsers
  // because the bridge takes text only — a hint in the panel tells the
  // user. In real browsers this branch is skipped entirely.
  if (window.webkit?.messageHandlers?.meloVoice) {
    return _speakWithNativeBridge(text, messageId);
  }
  if (!globalThis.speechSynthesis) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  if (uiState.ttsBrowserVoiceName) {
    const v = uiState.ttsBrowserVoices.find(x => x.name === uiState.ttsBrowserVoiceName);
    if (v) utterance.voice = v;
  }
  utterance.rate = 1.0;
  if (messageId) { uiState.ttsSpeakingMessageId = messageId; _updateTtsSpeakingUI(messageId); }
  utterance.addEventListener('end', () => {
    uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
  });
  utterance.addEventListener('error', () => {
    uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
  });
  speechSynthesis.speak(utterance);
  return true;
}

function _speakWithNativeBridge(text, messageId) {
  if (!window.webkit?.messageHandlers?.meloVoice) return false;
  // Mirrors Swift's empty-text guard so callers that hand us a stripped
  // string don't end up spawning `say` with no input. Soft contract today,
  // but cheap to enforce on both sides so a future caller can't break it.
  if (typeof text !== 'string' || !text.trim()) return false;
  window.webkit.messageHandlers.meloVoice.postMessage({ action: 'speakText', text });
  if (messageId) { uiState.ttsSpeakingMessageId = messageId; _updateTtsSpeakingUI(messageId); }
  const approxMs = Math.max(2000, text.length * 300);
  const timer = setTimeout(() => {
    if (uiState.ttsSpeakingMessageId === messageId) {
      uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
    }
  }, approxMs);
  const sayRef = {
    source: 'say',
    pause: () => {
      clearTimeout(timer);
      if (window.webkit?.messageHandlers?.meloVoice) {
        window.webkit.messageHandlers.meloVoice.postMessage({ action: 'stopAudio' });
      }
      uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
    },
    _onSayEnded: () => {
      clearTimeout(timer);
      if (uiState.ttsSpeakingMessageId === messageId) {
        uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
      }
      if (_ttsAudio === sayRef) _ttsAudio = null;
    },
  };
  _ttsAudio = sayRef;
  return true;
}

function _detectLang(text) {
  if (/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(text)) return 'zh';
  if (/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(text)) return 'ko';
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja';
  return '';
}

// ── Streaming TTS sentence queue ──────────────────────────────────────────────
// Detects sentence boundaries in streaming text, sends each sentence to the
// server queue immediately (parallel synthesis, ordered playback).
const _streamTts = {
  buffer: '',
  active: false,
  hasToolCalls: false,
  sentToQueue: false,   // true when sentences were already queued during streaming
  queuedChars: 0,       // total characters sent to queue during streaming (for timeout estimate)
  // Browser voice in WKWebView (desktop app) routes through the Swift
  // native bridge, which terminates any in-flight `say` before starting
  // a new one — calling it per-sentence during streaming would only let
  // the LAST sentence be heard. So when the bridge is the active backend,
  // we accumulate sentences here and speak the full batch once at flush.
  // Real browser speechSynthesis queues utterances natively; this batch
  // stays empty for them.
  browserBatch: '',
};

// Sentence-break pattern: Chinese/Japanese punctuation or Western end-of-sentence
const _SENTENCE_BREAK = /[。！？\n]|[.!?](?=\s|$)/;

// One-time auto-speak flag: set when a voice message is sent, cleared after the response
let _oneTimeAutoSpeak = false;

// Strip everything TTS should NOT read aloud. The user's rule is: "don't read
// the tool-call/thinking-process junk, don't read URLs, don't read weird stuff
// like the JSON behind a molecule diagram".
//
// Concretely we strip, in order:
//   1. <tool_call>…</tool_call>            — tool invocations (complete)
//   2. <tool_call>…$                       — partial tool-call tail mid-stream
//   3. <viz-spec>…</viz-spec>              — viz trailer JSON (molecule, globe-flight, etc.)
//   4. <viz-spec>…$                        — partial viz-spec tail mid-stream
//   5. <think>…</think>, <thinking>…</thinking>
//   6. ```...```                           — fenced code blocks (often JSON / SMILES / etc.)
//   7. `inline`                            — inline code spans
//   8. [source:…] / [via:…] citation tags
//   9. Markdown image/link URLs            — keep alt/label text, drop the (url) part
//  10. Bare http(s):// URLs
// Whitespace is then collapsed. Used by every path that hands text to TTS.
function _stripForTts(text) {
  let out = String(text || '');
  // Tool-call XML (complete + partial).
  out = out.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, ' ');
  out = out.replace(/<tool_call>[\s\S]*$/i, ' ');
  // Viz-spec JSON trailer (complete + partial).
  out = out.replace(/<viz-spec>[\s\S]*?<\/viz-spec>/gi, ' ');
  out = out.replace(/<viz-spec>[\s\S]*$/i, ' ');
  // Thinking blocks.
  out = out.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ' ');
  out = out.replace(/<think(?:ing)?>[\s\S]*$/i, ' ');
  // Fenced code blocks — chem structures, raw JSON, SMILES, etc. TTS shouldn't try to read these.
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/```[\s\S]*$/, ' ');
  // Inline code.
  out = out.replace(/`[^`\n]{1,200}`/g, ' ');
  // Citation / provenance tags the model sometimes inlines.
  out = out.replace(/\[source:[^\]]+\]/gi, ' ');
  out = out.replace(/\[via:[^\]]+\]/gi, ' ');
  // Markdown image: ![alt](url) → alt
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1');
  // Markdown link: [text](url) → text
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  // Bare URLs.
  out = out.replace(/https?:\/\/\S+/g, ' ');
  // Collapse whitespace.
  return out.replace(/\s+/g, ' ').trim();
}

// Back-compat shim — kept so callers that only cared about URL-stripping still
// work, but routed through the full TTS sanitizer so everything stays consistent.
function _stripUrlsForTts(text) {
  return _stripForTts(text);
}

function _streamTtsReset() {
  _streamTts.buffer = '';
  _streamTts.active = false;
  _streamTts.hasToolCalls = false;
  _streamTts.sentToQueue = false;
  _streamTts.queuedChars = 0;
  _oneTimeAutoSpeak = false;
}

async function _streamTtsStart() {
  _streamTts.buffer = '';
  _streamTts.active = true;
  _streamTts.hasToolCalls = false;
  _streamTts.sentToQueue = false;
  _streamTts.queuedChars = 0;
  _streamTts.browserBatch = '';
  // Stop any leftover playback from the previous response — covers all
  // three engines:
  //   - server TTS via speak-stop / queue-clear (API + macOS say paths)
  //   - in-page speechSynthesis.cancel() (real browser Browser voice)
  //   - WKWebView native bridge stopAudio (Browser voice in desktop app)
  try { await api('/api/tts/speak-stop', { method: 'POST', body: {} }); } catch {}
  try { await api('/api/tts/queue-clear', { method: 'POST', body: {} }); } catch {}
  if (globalThis.speechSynthesis?.speaking || globalThis.speechSynthesis?.pending) {
    try { speechSynthesis.cancel(); } catch {}
  }
  if (window.webkit?.messageHandlers?.meloVoice) {
    try { window.webkit.messageHandlers.meloVoice.postMessage({ action: 'stopAudio' }); } catch {}
  }
}

function _streamTtsOnToolCall() {
  // Tool call started — discard ONLY the unflushed partial text.
  //
  // 2026-05-12 fix (voice mid-utterance termination Bug 2):
  //
  // The old implementation also fired `speak-stop` + `queue-clear` +
  // `speechSynthesis.cancel()` + WKWebView `stopAudio` on every tool_call
  // event.  Intent was to drop intermediate "我正在搜索..." narration before
  // the tool fires.  But that indiscriminately killed ALREADY-COMPLETED
  // sentences that had been flushed to the queue and were mid-playback —
  // user heard "好的，让我帮你查询天" cut off because a `<tool_call>` event
  // landed mid-afplay.  Any agent reply with tool calls suffered this.
  //
  // Codex C-gate follow-up: an earlier draft of this fix also cleared
  // `_streamTts.browserBatch` thinking it was "accumulated unspoken".
  // It's NOT — `_streamTtsPushChunk` only writes COMPLETE, sentence-
  // broken text into `browserBatch` (the WKWebView Browser engine
  // batches because its native postMessage bridge terminates the
  // previous utterance on each call; flushing the batch once at stream
  // end IS the engine's whole workaround for that limitation).
  // Clearing browserBatch would have re-introduced the same
  // truncation bug on WKWebView Browser engine.  Keep browserBatch.
  //
  // So the real "intermediate" content is ONLY what's in
  // `_streamTts.buffer` — raw streaming text past the last sentence
  // break, where no `。/.!?/\n` has been detected yet, so we know it's
  // a partial in progress.  Clearing only this is enough.  Anything
  // already in `_ttsQueue`, mid-afplay, in browserBatch, or already
  // submitted to speechSynthesis was a complete sentence; let it finish.
  //
  // Trade-off: if the agent narrates a complete sentence like "好的，让我
  // 帮你查询。" (note the closing 。) right before firing a tool_call, the
  // user will hear it — that's correct (the assistant said it, the
  // listener should hear it, even if it's about a forthcoming tool action).
  _streamTts.hasToolCalls = true;
  _streamTts.buffer = '';
  // Intentionally do NOT clear `_streamTts.browserBatch` — see comment above.
}

function _isTtsActive() {
  return uiState.ttsAutoPlay || _oneTimeAutoSpeak;
}

function _streamTtsPushChunk(delta) {
  if (!_streamTts.active || !_isTtsActive()) return;
  // Strip any <tool_call> XML — e.g. the model sometimes emits it mid-stream
  const cleaned = delta.replace(/<tool_call>[\s\S]*/g, '');
  if (!cleaned) return;
  _streamTts.buffer += cleaned;

  const isApi = uiState.ttsEngine === 'api' || uiState.ttsEngine === 'auto';
  const isMacos = uiState.ttsEngine === 'macos';
  const isBrowser = uiState.ttsEngine === 'browser';
  // Real-browser speechSynthesis queues utterances naturally; the WKWebView
  // bridge does NOT (each `speakText` postMessage terminates the previous
  // one), so for desktop-app Browser voice we batch sentences and play
  // them as one utterance at flush — see browserBatch field on _streamTts.
  const isWebView = Boolean(window.webkit?.messageHandlers?.meloVoice);
  const browserStreamsLive = isBrowser && !isWebView;

  // Flush complete sentences immediately for real-time speech (API, macOS say,
  // or real-browser speechSynthesis). Desktop-app Browser voice batches.
  let match;
  while ((match = _SENTENCE_BREAK.exec(_streamTts.buffer)) !== null) {
    const endIdx = match.index + match[0].length;
    const raw = _streamTts.buffer.slice(0, endIdx).trim();
    _streamTts.buffer = _streamTts.buffer.slice(endIdx);
    const sentence = _stripUrlsForTts(raw);
    if (sentence.length >= 4) {
      if (isMacos) {
        // Bug 1 fix (2026-05-12): use /api/tts/native-queue-add instead of
        // /api/tts/native.  The old endpoint kill+replaces the previous
        // `say` process on every call — per-sentence streaming POSTs cut
        // every sentence short by the next one.  The queue endpoint chains
        // sequentially: each say spawns only after the previous one exits.
        const lang = _detectLang(sentence);
        api('/api/tts/native-queue-add', {
          method: 'POST',
          body: { text: sentence, lang, voice: uiState.ttsMacosVoiceName },
        }).catch(() => {});
      } else if (browserStreamsLive) {
        speakWithBrowser(sentence);
      } else if (isBrowser) {
        // WKWebView Browser voice — accumulate, speak once at flush.
        _streamTts.browserBatch += sentence + ' ';
      } else if (isApi) {
        _streamTtsEnqueue(sentence);
        _streamTts.sentToQueue = true;
        _streamTts.queuedChars += sentence.length;
      }
    }
  }
}

async function _streamTtsFlush() {
  // Called when streaming ends — send any remaining buffered tail to TTS
  const tail = _stripUrlsForTts(_streamTts.buffer.trim());
  _streamTts.buffer = '';
  _streamTts.active = false;
  const sentToQueue = _streamTts.sentToQueue;
  const totalQueuedChars = _streamTts.queuedChars + tail.length;
  _streamTts.sentToQueue = false;
  _streamTts.queuedChars = 0;
  _oneTimeAutoSpeak = false;

  const useApi = uiState.ttsEngine === 'api' || uiState.ttsEngine === 'auto';
  const useMacos = uiState.ttsEngine === 'macos';
  const useBrowser = uiState.ttsEngine === 'browser';

  if (useApi) {
    if (sentToQueue) {
      // Sentences were already queued during streaming — only flush the remaining tail
      if (tail.length >= 2) {
        _streamTtsEnqueue(tail);
      }
      // Set up _ttsAudio so stopCurrentTts() sends queue-clear (not speak-stop)
      const audio = { pause: async () => {
        if (_ttsAudio === audio) _ttsAudio = null;
        try { await api('/api/tts/queue-clear', { method: 'POST', body: {} }); } catch {}
      }};
      _ttsAudio = audio;
      // Auto-clear after generous estimate based on total queued text
      const approxMs = Math.min(300_000, Math.max(30_000, totalQueuedChars * 600 + 15_000));
      setTimeout(() => { if (_ttsAudio === audio) _ttsAudio = null; }, approxMs);
    } else {
      // No sentences queued during streaming — batch send full text via speak-text
      if (tail.length < 2) return;
      const input = tail.slice(0, 4096);
      const ttsRef = {};
      const chunks = Math.max(1, Math.ceil(input.length / 80));
      const approxMs = Math.min(300_000, Math.max(60_000, chunks * 40_000 + input.length * 600));
      const timer = setTimeout(() => {
        if (_ttsAudio === ttsRef.audio) _ttsAudio = null;
      }, approxMs);
      const audio = { pause: async () => {
        clearTimeout(timer);
        if (_ttsAudio === audio) _ttsAudio = null;
        try { await api('/api/tts/speak-stop', { method: 'POST', body: {} }); } catch {}
      }};
      ttsRef.audio = audio;
      _ttsAudio = audio;
      api('/api/tts/speak-text', {
        method: 'POST',
        body: { text: input, voice: uiState.ttsApiVoice },
      }).catch(() => {});
    }
  } else if (useMacos) {
    if (tail.length >= 2) {
      // Bug 1 fix (2026-05-12): same reasoning as _streamTtsPushChunk —
      // /api/tts/native would kill the in-flight streaming-queue say.
      // Append to the queue so the tail plays AFTER the streamed
      // sentences instead of cutting them.
      const lang = _detectLang(tail);
      api('/api/tts/native-queue-add', {
        method: 'POST',
        body: { text: tail.slice(0, 400), lang, voice: uiState.ttsMacosVoiceName },
      }).catch(() => {});
    }
  } else if (useBrowser) {
    // Concat any sentences accumulated during streaming (WKWebView bridge
    // path — see _streamTts.browserBatch comment) with the unflushed tail
    // and speak as a single utterance. Real browsers had per-sentence
    // calls already; their browserBatch is empty so this is just `tail`.
    const batch = (_streamTts.browserBatch || '').trim();
    _streamTts.browserBatch = '';
    const combined = (batch && tail ? `${batch} ${tail}` : (batch || tail)).trim();
    if (combined.length >= 2) {
      speakWithBrowser(combined.slice(0, 4096));
    }
  }
}

function _streamTtsEnqueue(sentence) {
  const useApi = uiState.ttsEngine === 'api' || uiState.ttsEngine === 'auto';
  const useMacos = uiState.ttsEngine === 'macos';
  const useBrowser = uiState.ttsEngine === 'browser';

  if (useApi) {
    api('/api/tts/queue-add', {
      method: 'POST',
      body: { text: sentence, voice: uiState.ttsApiVoice },
    }).catch(() => {});
  } else if (useMacos) {
    const lang = _detectLang(sentence);
    api('/api/tts/native', {
      method: 'POST',
      body: { text: sentence, lang, voice: uiState.ttsMacosVoiceName },
    }).catch(() => {});
  } else if (useBrowser) {
    speakWithBrowser(sentence);
  }
}

async function speakText(text, messageId = null) {
  // Await stop so speak-stop reaches server before speak-text (prevents race condition).
  await stopCurrentTts();
  const input = _stripUrlsForTts(String(text || '').trim());
  if (!input) return;

  const useApi = uiState.ttsEngine === 'api' || uiState.ttsEngine === 'auto';
  // 'auto' falls back to macOS say (current historical behavior); explicit
  // 'macos' / 'browser' choices are honoured strictly.
  const useMacos = uiState.ttsEngine === 'macos' || uiState.ttsEngine === 'auto';
  const useBrowser = uiState.ttsEngine === 'browser';

  if (useApi) {
    try {
      // speak-text: server splits text into sentences, synthesises in parallel, plays in order
      // Responds immediately (fire-and-forget playback on host via afplay)
      const result = await api('/api/tts/speak-text', {
        method: 'POST',
        body: { text: input.slice(0, 4096), voice: uiState.ttsApiVoice },
        signal: AbortSignal.timeout(10_000),
      });
      if (result?.ok) {
        if (messageId) { uiState.ttsSpeakingMessageId = messageId; _updateTtsSpeakingUI(messageId); }
        // Estimate duration: Fish Speech on CPU takes ~30-50s per sentence to synthesise
        // (sentences are synthesised in parallel, so total ≈ slowest sentence + play time).
        // Use a generous estimate so the indicator stays on while audio is still pending.
        const chunks = result.chunks || Math.ceil(input.length / 80);
        const approxMs = Math.min(300_000, Math.max(60_000, chunks * 40_000 + input.length * 600));
        const ttsRef = {};
        const timer = setTimeout(() => {
          // Clear _ttsAudio reference so a re-click after the indicator disappears
          // does NOT send speak-stop (which would cancel still-running synthesis).
          if (_ttsAudio === ttsRef.audio) _ttsAudio = null;
          if (uiState.ttsSpeakingMessageId === messageId) {
            uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
          }
        }, approxMs);
        const audio = { pause: async () => {
          clearTimeout(timer);
          if (_ttsAudio === audio) _ttsAudio = null;
          uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
          try { await api('/api/tts/speak-stop', { method: 'POST', body: {} }); } catch {}
        }};
        ttsRef.audio = audio;
        _ttsAudio = audio;
        return;
      }
    } catch (err) {
      if (uiState.ttsEngine === 'api') {
        console.warn('TTS API failed:', err?.message || err);
      }
    }
  }

  // macOS voice: use /usr/bin/say via Node server — plays through host
  // speakers directly, bypasses WKWebView autoplay restrictions entirely.
  if (useMacos) {
    try {
      const lang = _detectLang(input);
      const result = await api('/api/tts/native', {
        method: 'POST',
        body: { text: input.slice(0, 400), lang, voice: uiState.ttsMacosVoiceName },
        signal: AbortSignal.timeout(30_000),
      });
      if (result?.ok) {
        // Audio plays on the host; set up a speaking indicator with estimated duration
        if (messageId) { uiState.ttsSpeakingMessageId = messageId; _updateTtsSpeakingUI(messageId); }
        const approxMs = Math.max(2000, input.length * 80); // ~80ms per char
        const timer = setTimeout(() => {
          if (uiState.ttsSpeakingMessageId === messageId) {
            uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
          }
        }, approxMs);
        _ttsAudio = { pause: async () => {
          clearTimeout(timer);
          uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
          try { await api('/api/tts/speak-stop', { method: 'POST', body: {} }); } catch {}
        }};
        return;
      }
    } catch (err) {
      console.warn('Native TTS failed:', err?.message || err);
    }
    // Macos failed (no /usr/bin/say, e.g. Linux) — fall back to speechSynthesis.
    if (!speakWithBrowser(input, messageId)) {
      showError('TTS is not available in this environment.');
    }
    return;
  }

  // Explicit Browser voice — speechSynthesis only. No server involvement.
  if (useBrowser) {
    if (!speakWithBrowser(input, messageId)) {
      showError('Browser speech synthesis is not available in this environment.');
    }
    return;
  }
}

async function handleSpeakMessage(trigger) {
  const messageId = trigger.dataset.messageId;
  // If already speaking or loading this message, stop it
  if (uiState.ttsSpeakingMessageId === messageId || uiState.ttsSpeakingLoadingId === messageId) {
    uiState.ttsSpeakingLoadingId = null;
    stopCurrentTts();
    return;
  }

  const chat = activeChat();
  if (!chat) return;
  const message = chat.messages.find(m => m.id === messageId);
  if (!message) return;

  // Show loading indicator immediately so user gets instant feedback
  uiState.ttsSpeakingLoadingId = messageId;
  _updateTtsSpeakingUI(null);

  // Case 1: message has an audio attachment (voice reply already recorded) — just play it
  const audioAttachment = (message.attachments || []).find(
    a => a.kind === 'audio' || /\.(mp3|wav|ogg|aiff|aac|m4a)(\?|$)/i.test(a.url || ''),
  );
  if (audioAttachment?.url) {
    uiState.ttsSpeakingLoadingId = null;
    uiState.ttsSpeakingMessageId = messageId;
    _updateTtsSpeakingUI(messageId);
    try {
      const res = await fetch(audioAttachment.url);
      const ab = await res.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
      const mime = audioAttachment.mimeType || (audioAttachment.url.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav');
      _playAudioBuffer(base64, mime, messageId);
    } catch {
      // fallback to afplay
      try {
        await api('/api/tts/native', { method: 'POST', body: { text: '', url: audioAttachment.url } });
      } catch {}
    }
    return;
  }

  // Case 2: text reply — TTS
  const rawText = Array.isArray(message.content)
    ? message.content
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('\n')
    : String(message.content || '');

  // Run the full TTS sanitizer — strips tool_call XML, viz-spec JSON,
  // thinking blocks, code fences, markdown links, URLs, citation tags, …
  // so the voice only reads the prose the user actually sees.
  const cleanText = _stripForTts(rawText);

  uiState.ttsSpeakingLoadingId = null; // clear loading — speakText sets speaking state
  if (!cleanText) {
    uiState.ttsSpeakingLoadingId = null;
    _updateTtsSpeakingUI(null);
    return;
  }
  await speakText(cleanText, messageId);
}

async function handleCreateProject() {
  const { name, summary, instructions, tag, workspacePath } = uiState.draftProject;
  if (!name.trim()) {
    showError('Project name is required.');
    return;
  }

  const payload = await api('/api/projects', {
    method: 'POST',
    body: {
      name,
      summary,
      instructions,
      tag,
      workspacePath,
    },
  });

  uiState.showProjectForm = false;
  uiState.draftProject = {
    name: '',
    tag: '',
    summary: '',
    instructions: '',
    workspacePath: '',
  };
  applyBootstrap(payload);
}

async function handleUpdateProject(form) {
  const formData = new FormData(form);
  const payload = await api('/api/projects/update', {
    method: 'POST',
    body: {
      projectId: form.dataset.projectId,
      patch: {
        name: String(formData.get('name') || ''),
        tag: String(formData.get('tag') || ''),
        summary: String(formData.get('summary') || ''),
        instructions: String(formData.get('instructions') || ''),
        workspacePath: String(formData.get('workspacePath') || ''),
        confirmWorkspace: formData.get('confirmWorkspace') === 'on',
        knowledgeIds: formData.getAll('knowledgeIds').map(String),
      },
    },
  });
  applyBootstrap(payload);
}

async function handleCreateArtifact() {
  const { title, content, language, kind } = uiState.draftArtifact;
  if (!content.trim()) {
    showError('Artifact content is required.');
    return;
  }

  const payload = await api('/api/artifacts', {
    method: 'POST',
    body: {
      title,
      content,
      language,
      kind,
      projectId: creationContext().projectId,
    },
  });

  uiState.draftArtifact = {
    title: '',
    language: 'markdown',
    kind: 'note',
    content: '',
  };
  uiState.showArtifactForm = false;
  applyBootstrap(payload);
}

function handleStartEditArtifact(artifactId) {
  const artifact = artifactShelfRows().find(item => item.id === artifactId);
  if (!artifact) return;
  uiState.selectedArtifactId = artifactId;
  uiState.editingArtifactId = artifactId;
  uiState.editingArtifactDraft = {
    title: artifact.title || '',
    language: artifact.language || 'text',
    kind: artifact.kind || 'note',
    content: artifact.content || '',
  };
  render();
}

function handleCancelEditArtifact() {
  uiState.editingArtifactId = null;
  uiState.editingArtifactDraft = { title: '', language: '', kind: '', content: '' };
  render();
}

async function handleUpdateArtifact() {
  const artifactId = uiState.editingArtifactId;
  if (!artifactId) return;
  const draft = uiState.editingArtifactDraft;
  if (!draft.content.trim()) {
    showError('Artifact content is required.');
    return;
  }

  const payload = await api('/api/artifacts/update', {
    method: 'POST',
    body: {
      artifactId,
      patch: {
        title: draft.title,
        language: draft.language,
        kind: draft.kind,
        content: draft.content,
      },
    },
  });

  uiState.editingArtifactId = null;
  uiState.editingArtifactDraft = { title: '', language: '', kind: '', content: '' };
  applyBootstrap(payload);
}

/**
 * Server-driven soft-delete with a 5-second undo window.
 *
 * Flow:
 *   1. POST /api/artifacts/delete → server stamps `deletedAt`. The row
 *      vanishes from the UI (bootstrap filters soft-deleted out) but
 *      lives on in state.json so undo + crash recovery + GC all work.
 *   2. Pop an undo-toast counting down 5s.  Clicking Undo posts to
 *      /api/artifacts/restore which clears `deletedAt` and the row
 *      reappears with the same id (no recreate, no broken refs).
 *   3. If the toast lapses untouched, we do nothing — the server has
 *      already committed the delete.  `purgeStaleSoftDeletes` evicts
 *      the tombstone after 7 days at server boot.
 *
 * This replaces the older client-timer model that broke when the user
 * reloaded / closed the window during the undo window (Codex C
 * finding: setTimeout died, server never deleted, but UI said
 * "Deleted").  Now every transition is server-acknowledged.
 */
async function handleDeleteArtifact(artifactId) {
  if (!artifactId) return;
  const artifact = artifactShelfRows().find(item => item.id === artifactId);
  if (!artifact) return;

  // Clear current selection / edit-buffer pre-emptively so the detail
  // panel doesn't render stale content for the row we're about to hide.
  if (uiState.selectedArtifactId === artifactId) {
    uiState.selectedArtifactId = null;
  }
  if (uiState.editingArtifactId === artifactId) {
    uiState.editingArtifactId = null;
    uiState.editingArtifactDraft = { title: '', language: '', kind: '', content: '' };
  }

  const label = artifact.title ? `"${artifact.title}"` : 'this artifact';

  let payload;
  try {
    payload = await api('/api/artifacts/delete', {
      method: 'POST',
      body: { artifactId },
    });
  } catch (err) {
    uiState.error = String(err?.message || 'Failed to delete artifact.');
    render();
    setTimeout(() => { uiState.error = null; render(); }, 4000);
    return;
  }
  applyBootstrap(payload);

  showUndoToast({
    message: `Deleted ${label}.`,
    ms: UNDO_TOAST_DEFAULT_MS,
    onUndo: async () => {
      try {
        const restored = await api('/api/artifacts/restore', {
          method: 'POST',
          body: { artifactId },
        });
        applyBootstrap(restored);
      } catch (err) {
        uiState.error = `Restore failed: ${err?.message || err}`;
        bgRender();
        setTimeout(() => { uiState.error = null; render(); }, 4000);
      }
    },
  });
}

async function handleSaveConnectorConfig(form) {
  // Password inputs render with value="" so a stale FormData read can
  // wipe a key the user just pasted but didn't have time to commit
  // before the next background render rebuilt the DOM. Prefer the
  // shared draft (kept in sync by the form's input handler) for
  // every secret-bearing field; the form is only a fallback for
  // non-secret values that aren't tracked in the draft yet.
  const formData = new FormData(form);
  const draft = uiState.modelSetupDraft || {};
  const pick = name => pickConnectorField(draft, formData, name);
  // Each form owns only its fields. Connection credentials live in the
  // model provider editor, so prompt/audio saves cannot switch connections.
  const keys = form.dataset.form === 'model-config' ? ['systemPrompt'] :
    ['whisperApiKey', 'whisperBaseUrl', 'minimaxApiKey', 'minimaxGroupId', 'minimaxVoiceId'];
  const body = Object.fromEntries(keys.map(name => [name, pick(name)]));

  const payload = await api('/api/settings/model', {
    method: 'POST',
    body,
  });
  clearModelFormDraft(form);
  applyBootstrap(payload);
}

function clearModelFormDraft(form) {
  const keys = form.dataset.form === 'model-config' ? ['systemPrompt'] : ['whisperApiKey','whisperBaseUrl','minimaxApiKey','minimaxGroupId','minimaxVoiceId'];
  for (const key of keys) if (uiState.modelSetupDraft) delete uiState.modelSetupDraft[key];
}

async function handleLoadModelOptions(form) {
  // Same draft-first read as handleSaveConnectorConfig — masked password
  // inputs always submit "" through FormData, so any background render
  // between paste and click would otherwise drop the API key the user
  // pasted before pressing "Read available models" (Codex B follow-up,
  // 2026-04-28).
  const formData = new FormData(form);
  const draft = uiState.modelSetupDraft || {};
  const pick = name => pickConnectorField(draft, formData, name);
  const authMode = pick('authMode') || 'codex';
  const apiKey = pick('apiKey');
  const body = {
    authMode,
    baseUrl: pick('baseUrl'),
    model: pick('model'),
    systemPrompt: pick('systemPrompt'),
  };

  if ((authMode === 'api-key' || authMode === 'local') && apiKey) {
    body.apiKey = apiKey;
  }

  uiState.modelCatalogLoading = true;
  render();
  try {
    const payload = await api('/api/settings/model/options', {
      method: 'POST',
      body,
    });
    // Preserve modelSetupDraft after refresh (Codex C 第十四轮 audit
    // 2026-04-28). The server-side refreshModelCatalog is now
    // catalog-only — it does NOT persist the form's authMode /
    // baseUrl / model / apiKey / systemPrompt. If we cleared the
    // draft here, the user's pasted-but-unsaved API key would
    // vanish from the form the moment they clicked "Read
    // available models", and the next Save would silently
    // submit the old saved values. Keep the draft so the form
    // continues to render the user's typing; applyBootstrap
    // refreshes the catalog map so the model dropdown reflects
    // the freshly-discovered options without stomping the rest
    // of the form.
    applyBootstrapPreservingDrafts(payload);
  } finally {
    uiState.modelCatalogLoading = false;
    render();
  }
}

async function handleStartModelOAuthLogin() {
  await api('/api/settings/model/oauth/start', {
    method: 'POST',
    body: {},
  });
  showError('OpenAI sign-in was opened in Terminal. Finish the browser authorization, then click Refresh status.');
}

async function handleRefreshModelStatus() {
  uiState.modelSetupDraft = null;
  await loadBootstrap(uiState.searchQuery, { quiet: true });
}

async function handleCreateCustomAgent() {
  if (uiState.agentCreating) return;
  uiState.agentCreating = true;
  render();
  try {
    const payload = await api('/api/agents/create-custom', { method: 'POST', body: {} });
    applyBootstrap(payload);
    const form = app.querySelector('form[data-form="agent-profile-update"]');
    if (form) settingsFormEditors.begin(form);
    render();
    app.querySelector('form[data-form="agent-profile-update"] [name="name"]')?.select();
  } finally {
    uiState.agentCreating = false;
    const button = app.querySelector('[data-action="create-custom-agent"]');
    if (button) { button.disabled = false; button.textContent = t('新增 Agent'); }
  }
}

async function handleUpdateAgentProfile(form) {
  const formData = new FormData(form);
  const project = activeProject();
  const scope = selectedAgentScope();
  const projectId = scope === 'project' ? project?.id || 'global' : 'global';
  const saveKey = agentSaveKey(form.dataset.agentId, scope, projectId);
  const draftKey = agentDraftKey(form.dataset.agentId, scope, project?.id || 'global');
  const patch = buildAgentProfilePatch(form, formData);
  const avatarDraft = agentDraftFor(agentProfileById(form.dataset.agentId));
  if (Object.hasOwn(avatarDraft || {}, 'avatarData')) patch.avatarData=avatarDraft.avatarData;

  const minimumVisibleMs = 100;
  const waitForMinimumVisibleState = new Promise(resolve => setTimeout(resolve, minimumVisibleMs));

  uiState.agentSaveStates[saveKey] = true;
  bgRender();

  try {
    const payload = await api('/api/agents/update', {
      method: 'POST',
      body: {
        agentId: form.dataset.agentId,
        scope,
        projectId: scope === 'project' ? project?.id : null,
        activeView: uiState.bootstrap?.settings?.activeView || 'customize',
        patch,
      },
    });
    await waitForMinimumVisibleState;
    delete uiState.agentDrafts[draftKey];
    applyBootstrap(payload);
    if (payload.agentExportWarning) showError(payload.agentExportWarning);
    const activeTtsConfig = uiState.bootstrap?.settings?.config || {};
    const savedVoiceId = String(patch.minimaxVoiceId || '').trim();
    if (
      activeTtsConfig.ttsProvider === 'minimax' &&
      savedVoiceId &&
      activeTtsConfig.minimaxVoiceId === savedVoiceId
    ) {
      api('/api/settings/model', {
        method: 'POST',
        body: minimaxTtsConfigPatchForVoice(savedVoiceId),
      }).then(nextPayload => applyBootstrapPreservingDrafts(nextPayload)).catch(() => {});
    }
  } finally {
    await waitForMinimumVisibleState;
    delete uiState.agentSaveStates[saveKey];
    render();
  }
}

async function handleTestAgentChannel(trigger) {
  const form = trigger.closest('form');
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  // Test the persisted channel. Drafts are committed only by Save.
  const channelId = trigger.dataset.channelId;
  const project = activeProject();
  const scope = selectedAgentScope();
  const patch = {};

  const payload = await api('/api/agents/channel/test', {
    method: 'POST',
    body: {
      agentId: form.dataset.agentId,
      channelId,
      scope,
      projectId: scope === 'project' ? project?.id : null,
      patch,
    },
  });
  applyBootstrap(payload);
}

async function saveAgentMarkdownSnapshot(snapshot) {
  if (!snapshot?.agentId) {
    return;
  }

  const requestSequence = ++agentMarkdownAutosaveSequence;
  const payload = await api('/api/agents/update', {
    method: 'POST',
    body: {
      agentId: snapshot.agentId,
      scope: snapshot.scope,
      projectId: snapshot.scope === 'project' ? snapshot.projectId : null,
      activeView: uiState.bootstrap?.settings?.activeView || 'agent',
      patch: {
        identity: String(snapshot.identity || '').trim(),
        'soul.md': String(snapshot.soulMd || '').trim(),
      },
    },
  });

  if (requestSequence !== agentMarkdownAutosaveSequence) {
    return;
  }

  uiState.bootstrap = payload;
  uiState.error = '';
}

async function saveAgentChannelSnapshot(snapshot) {
  if (!snapshot?.agentId || !snapshot?.channels) {
    return;
  }

  const saveKey = agentSaveKey(
    snapshot.agentId,
    snapshot.scope,
    snapshot.scope === 'project' ? snapshot.projectId || 'global' : 'global',
  );
  const minimumVisibleMs = 100;
  const waitForMinimumVisibleState = new Promise(resolve => setTimeout(resolve, minimumVisibleMs));
  const requestSequence = ++agentChannelAutosaveSequence;
  // Mark the save-in-progress flag, but do NOT render here. A render() in the
  // middle of the save pipeline blows away document.activeElement and the
  // input caret position, which is exactly what caused "光标会自动跳到最上面
  // 输入金冬天id的那个输入框" — the user's caret was yanked out of the Discord
  // Group ID input the moment the 3-second idle timer fired. Any UI that
  // depends on agentSaveStates (the "Saving…" button label) will pick up the
  // new flag on the next render triggered by an actual DOM event (keystroke,
  // scroll, focus), which is visually indistinguishable at human timescales.
  uiState.agentSaveStates[saveKey] = true;

  // Channel autosave also carries the three voice settings edited on the
  // Telegram panel (voiceReplyMode, edgeTtsVoice, voicePersonality). They are
  // agent-level, not nested under channels, but they share the same autosave
  // trigger so the user never has to hit a separate save button. Only include
  // them when they are present on the snapshot to avoid overwriting a saved
  // value with undefined on unrelated autosaves.
  const patch = { channels: snapshot.channels };
  if (typeof snapshot.voiceReplyMode === 'string') {
    patch.voiceReplyMode = snapshot.voiceReplyMode;
  }
  if (typeof snapshot.edgeTtsVoice === 'string') {
    patch.edgeTtsVoice = snapshot.edgeTtsVoice;
  }
  if (typeof snapshot.voicePersonality === 'string') {
    patch.voicePersonality = snapshot.voicePersonality;
  }

  try {
    const payload = await api('/api/agents/update', {
      method: 'POST',
      body: {
        agentId: snapshot.agentId,
        scope: snapshot.scope,
        projectId: snapshot.scope === 'project' ? snapshot.projectId : null,
        activeView: uiState.bootstrap?.settings?.activeView || 'agent',
        patch,
      },
    });

    if (requestSequence !== agentChannelAutosaveSequence) {
      return;
    }

    await waitForMinimumVisibleState;
    // Use the preserving variant so the user's still-typing draft isn't
    // discarded when this autosave response lands. Without this, every
    // 3-second autosave rebuilt the agent form from server-side state and
    // silently dropped any chars typed during the round-trip.
    applyBootstrapPreservingDrafts(payload, { background: true });
  } finally {
    await waitForMinimumVisibleState;
    if (requestSequence === agentChannelAutosaveSequence) {
      delete uiState.agentSaveStates[saveKey];
      // Background-render: if the user is still typing, the typing guard in
      // render() will defer until they go idle. Prevents the autosave landing
      // from yanking the caret out of whatever input they're still editing.
      render({ background: true });
    }
  }
}

function scheduleAgentChannelAutosave(agentId) {
  const agent = agentProfileById(agentId);
  const draft = agentDraftFor(agent);
  if (!agent || !draft) {
    return;
  }

  // Capture the current draft including agent-level voice fields edited on the
  // Telegram panel so saveAgentChannelSnapshot can forward them. Using draft
  // values (not DOM reads) avoids losing in-flight edits when the autosave
  // timer fires after the user has moved focus.
  pendingAgentChannelAutosave = {
    agentId,
    scope: selectedAgentScope(),
    projectId: activeProject()?.id || null,
    // normalizeChannelsForDraft defends against the server→client array shape
    // leaking into the POST body. Server expects {telegram:{...}, discord:{...}},
    // not [{id:'telegram',...}].
    channels: normalizeChannelsForDraft(draft.channels),
    voiceReplyMode:
      typeof draft.voiceReplyMode === 'string' ? draft.voiceReplyMode : undefined,
    edgeTtsVoice:
      typeof draft.edgeTtsVoice === 'string' ? draft.edgeTtsVoice : undefined,
    voicePersonality:
      typeof draft.voicePersonality === 'string' ? draft.voicePersonality : undefined,
  };

  window.clearTimeout(agentChannelAutosaveTimer);
  // 3-second idle debounce. The user explicitly asked for "输入了一半三秒没动作
  // 就自动保存一下已经输入的内容" — fire only after the user has stopped typing
  // for 3 full seconds. The old 350ms threshold triggered mid-typing, which
  // combined with the full-DOM re-render on save response caused caret jumps
  // and focus loss between keystrokes.
  agentChannelAutosaveTimer = window.setTimeout(async () => {
    const snapshot = pendingAgentChannelAutosave;
    pendingAgentChannelAutosave = null;
    try {
      await saveAgentChannelSnapshot(snapshot);
    } catch (error) {
      showError(error.message);
    }
  }, 3000);
}

function scheduleAgentMarkdownAutosave(agentId) {
  const agent = agentProfileById(agentId);
  const draft = agentDraftFor(agent);
  if (!agent || !draft) {
    return;
  }

  pendingAgentMarkdownAutosave = {
    agentId,
    scope: selectedAgentScope(),
    projectId: activeProject()?.id || null,
    identity: draft.identity || draft.identify || '',
    soulMd: draft['soul.md'] || '',
  };

  agentMarkdownLastInteractionAt = Date.now();

  window.clearTimeout(agentMarkdownAutosaveTimer);
  const runWhenIdle = async () => {
    const remainingIdleMs =
      AGENT_MARKDOWN_AUTOSAVE_IDLE_MS - (Date.now() - agentMarkdownLastInteractionAt);
    if (remainingIdleMs > 24) {
      agentMarkdownAutosaveTimer = window.setTimeout(runWhenIdle, remainingIdleMs);
      return;
    }

    const snapshot = pendingAgentMarkdownAutosave;
    pendingAgentMarkdownAutosave = null;
    try {
      await saveAgentMarkdownSnapshot(snapshot);
    } catch (error) {
      showError(error.message);
    }
  };

  agentMarkdownAutosaveTimer = window.setTimeout(runWhenIdle, AGENT_MARKDOWN_AUTOSAVE_IDLE_MS);
}

async function flushPendingAgentMarkdownAutosave() {
  if (!pendingAgentMarkdownAutosave) {
    return;
  }

  window.clearTimeout(agentMarkdownAutosaveTimer);
  const snapshot = pendingAgentMarkdownAutosave;
  pendingAgentMarkdownAutosave = null;
  await saveAgentMarkdownSnapshot(snapshot);
}

// Counterpart to flushPendingAgentMarkdownAutosave for the channel (Discord /
// Telegram token + guildId + channelId + voiceReply + voiceReplyMode +
// edgeTtsVoice + voicePersonality) autosave pipeline. Without this, any edit
// the user made in the Discord Bot token / Guild ID / Channel ID inputs
// during the 3-second idle window was silently dropped when they switched
// agents, switched scopes, quit the app, or closed the window — matching the
// recurring "我昨天就配置好了这些参数，为什么今天打开这些东西又没了" report.
// See feedback_preserve_user_config.md.
async function flushPendingAgentChannelAutosave() {
  if (!pendingAgentChannelAutosave) {
    return;
  }

  window.clearTimeout(agentChannelAutosaveTimer);
  const snapshot = pendingAgentChannelAutosave;
  pendingAgentChannelAutosave = null;
  await saveAgentChannelSnapshot(snapshot);
}

// Best-effort, synchronous flush used on page unload. Uses navigator.sendBeacon
// when possible so the POST makes it to the server even after the window is
// closed and the event loop stops ticking. sendBeacon is fire-and-forget and
// cannot surface a response, so we do not update bootstrap here — the next
// session will load the freshly-persisted state from state.json anyway.
function flushPendingAgentAutosavesOnUnload() {
  const channelSnapshot = pendingAgentChannelAutosave;
  const markdownSnapshot = pendingAgentMarkdownAutosave;
  pendingAgentChannelAutosave = null;
  pendingAgentMarkdownAutosave = null;

  if (channelSnapshot?.agentId && channelSnapshot?.channels) {
    const patch = { channels: channelSnapshot.channels };
    if (typeof channelSnapshot.voiceReplyMode === 'string') {
      patch.voiceReplyMode = channelSnapshot.voiceReplyMode;
    }
    if (typeof channelSnapshot.edgeTtsVoice === 'string') {
      patch.edgeTtsVoice = channelSnapshot.edgeTtsVoice;
    }
    if (typeof channelSnapshot.voicePersonality === 'string') {
      patch.voicePersonality = channelSnapshot.voicePersonality;
    }
    const body = JSON.stringify({
      agentId: channelSnapshot.agentId,
      scope: channelSnapshot.scope,
      projectId: channelSnapshot.scope === 'project' ? channelSnapshot.projectId : null,
      activeView: uiState.bootstrap?.settings?.activeView || 'agent',
      patch,
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          '/api/agents/update',
          new Blob([body], { type: 'application/json' }),
        );
      } else {
        fetch('/api/agents/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {}
  }

  if (markdownSnapshot?.agentId) {
    const body = JSON.stringify({
      agentId: markdownSnapshot.agentId,
      scope: markdownSnapshot.scope,
      projectId: markdownSnapshot.scope === 'project' ? markdownSnapshot.projectId : null,
      activeView: uiState.bootstrap?.settings?.activeView || 'agent',
      patch: {
        identity: String(markdownSnapshot.identity || '').trim(),
        'soul.md': String(markdownSnapshot.soulMd || '').trim(),
      },
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          '/api/agents/update',
          new Blob([body], { type: 'application/json' }),
        );
      } else {
        fetch('/api/agents/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {}
  }
}

// 3-second idle autosave for the OpenAI connector / model setup form.
// Mirrors the agent-channel autosave contract (feedback_preserve_user_config.md):
// the user pastes a key, walks away from the input, and 3 seconds later
// the value lands on the server without an explicit Save click. The save
// path uses applyBootstrapPreservingDrafts so the still-typing draft is
// not wiped — explicit Save (handleSaveConnectorConfig) uses applyBootstrap
// for "submit & reset" semantics, but the silent background save must not
// yank values mid-edit.
//
// Two snapshots track the autosave lifecycle (Codex 2026-04-28 audit):
//   - `pendingConnectorAutosave`: body queued by the debounce timer,
//     not yet sent. Replaced on every keystroke.
//   - `inflightConnectorAutosave`: body of the request currently in
//     flight. Set when the timer fires, cleared once the response
//     lands. The earlier single-snapshot design nulled the snapshot
//     the moment the POST started, so a window-close mid-flight let
//     the browser cancel the request and unload flush had nothing
//     to beacon.
let pendingConnectorAutosave = null;
let inflightConnectorAutosave = null;
let connectorAutosaveTimer = null;
let connectorAutosaveSequence = 0;

function scheduleConnectorAutosave(form) {
  if (!form) return;
  const body = buildAutosaveBody({
    formData: new FormData(form),
    draft: uiState.modelSetupDraft || {},
  });
  if (!body) {
    // codex skip path: buildAutosaveBody refuses to ship authMode='codex'
    // (would force server-side apiKey=''). If the user just switched
    // FROM api-key TO codex while a 3-second timer was still counting
    // down, the old api-key body is still queued in pendingConnectorAutosave.
    // Cancel it so the stale authMode doesn't get written back over the
    // user's just-selected codex. In-flight requests are NOT aborted —
    // their body reflects the user's intent up to ~100ms ago, the
    // race window is tiny, and aborting could discard a credential
    // the user actually wanted to save. Codex audit 2026-04-28.
    pendingConnectorAutosave = null;
    window.clearTimeout(connectorAutosaveTimer);
    return;
  }
  // Monotonic revision so the server can reject older bodies that
  // race a newer one. Date.now() is unique enough at human input
  // cadence (3-second debounce floor) — concurrent same-millisecond
  // schedules just trigger the "stale or equal" branch on the
  // server, which is no worse than the previous overwrite. The
  // explicit Save path (handleSaveConnectorConfig) deliberately
  // does NOT attach this field, so the server treats it as a
  // force-write and bumps the saved revision past every in-flight
  // autosave. Codex C 第十一轮 (2026-04-28).
  body._autosaveRevision = Date.now();
  pendingConnectorAutosave = { body };

  window.clearTimeout(connectorAutosaveTimer);
  // 3-second idle debounce — fire only after the user has stopped
  // typing for 3 full seconds. Matches the pattern the user explicitly
  // asked for ("输入了一半三秒没动作就自动保存一下已经输入的内容") and
  // already in use for agent channel / markdown autosave.
  connectorAutosaveTimer = window.setTimeout(async () => {
    const snapshot = pendingConnectorAutosave;
    pendingConnectorAutosave = null;
    if (!snapshot) return;
    inflightConnectorAutosave = snapshot;
    const requestSequence = ++connectorAutosaveSequence;
    try {
      const payload = await api('/api/settings/model', {
        method: 'POST',
        body: snapshot.body,
      });
      // Stale-response guard: if a newer autosave fired while this
      // request was in flight, the newer response wins.
      if (requestSequence !== connectorAutosaveSequence) return;
      // ORDER MATTERS: clear the committed secrets from the draft
      // FIRST, then apply the new bootstrap.
      // `applyBootstrapPreservingDrafts()` synchronously calls
      // `render({background:true})`, and the credential chip's
      // "pending vs saved" state is computed from the draft AT
      // THAT RENDER. If we cleared after the apply, render would
      // see the old draft (still holding the freshly-saved
      // secret) and paint "● 待保存" instead of "✓ 已保存" —
      // exactly the regression Codex C 第二十轮 caught. The
      // sweep itself is still race-safe (only matches values
      // the user hasn't moved past) so doing it before the
      // bootstrap apply has no extra risk.
      clearCommittedSecrets(uiState.modelSetupDraft, snapshot.body);
      applyBootstrapPreservingDrafts(payload, { background: true });
    } catch {
      // Silent — autosave should not interrupt typing. Errors surface
      // when the user clicks Save explicitly.
    } finally {
      // Only clear in-flight if we're still the latest in-flight; a
      // newer schedule could have replaced us during the await above.
      if (inflightConnectorAutosave === snapshot) {
        inflightConnectorAutosave = null;
      }
    }
  }, 3000);
}

// pagehide / beforeunload flush — beacon ONE body. Priority rule
// (Codex audit 2026-04-28):
//
//   pending supersedes inflight
//
// `pending` is by definition newer than `inflight`: pending only
// gets repopulated after inflight has been moved out of pending,
// which means any keystroke captured into pending happened AFTER
// inflight started. sendBeacon does NOT guarantee delivery order,
// so beaconing both lets the older inflight body race to land
// last and overwrite the newer pending body server-side. Picking
// just one — the newer — makes the unload-time write deterministic.
//
// If only inflight exists (timer fired, no further keystrokes),
// fall back to it so the user's last typed value still gets a
// final chance to land in case the in-flight fetch was canceled
// by the unload itself.
function flushPendingConnectorAutosaveOnUnload() {
  const pending = pendingConnectorAutosave;
  const inflight = inflightConnectorAutosave;
  pendingConnectorAutosave = null;
  inflightConnectorAutosave = null;
  window.clearTimeout(connectorAutosaveTimer);
  const snapshot = pending || inflight;
  if (!snapshot?.body) return;
  const body = JSON.stringify(snapshot.body);
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        '/api/settings/model',
        new Blob([body], { type: 'application/json' }),
      );
    } else {
      fetch('/api/settings/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {}
}

function flushAllPendingAutosavesOnUnload() {
  flushPendingAgentAutosavesOnUnload();
  flushPendingConnectorAutosaveOnUnload();
}

window.addEventListener('pagehide', flushAllPendingAutosavesOnUnload);
window.addEventListener('beforeunload', flushAllPendingAutosavesOnUnload);

async function handleImportAgentPreset(agentId, presetId) {
  const preset = agentPresetById(presetId);
  if (!preset) {
    showError('Preset not found.');
    return;
  }

  const previous = agentDraftFor(agentProfileById(agentId));
  const instructions = agentDocumentWithPreset(previous?.instructions, preset);
  mergeAgentDraft(agentId, {
    instructions,
    identity: preset.identity || preset.identify,
    'soul.md': preset.soulMd,
  });
  render();
}

async function handleResetProjectAgentOverride(agentId) {
  const project = activeProject();
  if (!project) {
    showError('Choose a project before resetting an override.');
    return;
  }

  const payload = await api('/api/agents/update', {
    method: 'POST',
    body: {
      agentId,
      scope: 'project',
      projectId: project.id,
      activeView: uiState.bootstrap?.settings?.activeView || 'customize',
      clearProjectOverride: true,
    },
  });
  delete uiState.agentDrafts[agentDraftKey(agentId, 'project', project.id)];
  applyBootstrap(payload);
}

// Parse the comma-separated skill form fields (folders, allowedAgentIds,
// toolWhitelist). Pulled out so create + update share the same
// interpretation and tests can pin the behavior in one place.
function parseSkillCsvList(raw) {
  return String(raw || '').split(',').map(v => v.trim()).filter(Boolean);
}

function normalizeSkillFormBody(formData) {
  const folders = parseSkillCsvList(formData.get('folders'));
  const allowedAgentRaw = parseSkillCsvList(formData.get('allowedAgentIds'));
  const toolWhitelistRaw = parseSkillCsvList(formData.get('toolWhitelist'));
  const rawType = String(formData.get('type') || '').trim().toLowerCase();
  const type = rawType === 'prompt' ? 'prompt' : 'executable';
  const iterN = Number(formData.get('maxIterations'));
  const maxIterations = Number.isFinite(iterN) && iterN >= 1 && iterN <= 16 ? Math.floor(iterN) : 6;
  return {
    name: String(formData.get('name') || '').trim(),
    description: String(formData.get('description') || '').trim(),
    addedBy: String(formData.get('addedBy') || '').trim(),
    invokedBy: String(formData.get('invokedBy') || '').trim(),
    systemPrompt: String(formData.get('systemPrompt') || '').trim(),
    folders,
    type,
    maxIterations,
    // null means "any agent" — respect the UI's "All agents" chip state by
    // emitting null rather than an empty array (empty array would be
    // interpreted as "no agents can see this skill").
    allowedAgentIds: allowedAgentRaw.length > 0 ? allowedAgentRaw : null,
    toolWhitelist: toolWhitelistRaw.length > 0 ? toolWhitelistRaw : null,
  };
}

async function handleCreateCustomSkill(form) {
  const formData = new FormData(form);
  const patch = normalizeSkillFormBody(formData);
  const payload = await api('/api/skills/custom', {
    method: 'POST',
    body: {
      skill: {
        id: String(formData.get('id') || '').trim(),
        ...patch,
      },
    },
  });
  form.reset();
  applyBootstrap(payload);
}

async function handleUpdateCustomSkill(form) {
  const formData = new FormData(form);
  const payload = await api('/api/skills/custom/update', {
    method: 'POST',
    body: {
      skillId: form.dataset.skillId,
      patch: normalizeSkillFormBody(formData),
    },
  });
  applyBootstrap(payload);
}

// Expose for unit tests (Node doesn't export window, so we attach through
// globalThis for a non-invasive testing hook).
if (typeof globalThis !== 'undefined') {
  globalThis.__meloUiInternals__ = Object.assign(globalThis.__meloUiInternals__ || {}, {
    parseSkillCsvList,
    normalizeSkillFormBody,
  });
}

async function handleRemoveCustomSkill(skillId) {
  const payload = await api('/api/skills/custom/remove', {
    method: 'POST',
    body: { skillId },
  });
  applyBootstrap(payload);
}

async function handlePingExternalConnector(connectorId) {
  const payload = await api('/api/connectors/external/ping', {
    method: 'POST',
    body: { connectorId },
  });
  applyBootstrap(payload);
}

function creationContext() {
  const view=uiState.bootstrap?.settings?.activeView;
  if (uiState.neuralOverview) return {projectId:null,chatId:null};
  if (view==='projects') return {projectId:activeProject()?.id || null,chatId:null};
  const chat=view==='chat' ? activeChat() : null;
  return {projectId:chat?.projectId || null,chatId:chat?.id || null};
}

async function handleCreateTask() {
  const title = uiState.draftTask.title.trim();
  if (!title) {
    showError('Task title is required.');
    return;
  }

  const payload = await api('/api/tasks', {
    method: 'POST',
    body: {
      title,
      summary: uiState.draftTask.summary.trim(),
      owner: uiState.draftTask.owner,
      kind: uiState.draftTask.kind,
      projectId: creationContext().projectId,
      chatId: creationContext().chatId,
    },
  });

  uiState.draftTask = {
    title: '',
    summary: '',
    owner: 'builder',
    kind: 'task',
  };
  uiState.showTaskForm = false;
  applyBootstrap(payload);
}

async function handleUpdateTaskStatus(taskId, status) {
  const payload = await api('/api/tasks/update', {
    method: 'POST',
    body: {
      taskId,
      patch: {
        status,
      },
    },
  });
  applyBootstrap(payload);
}

async function handleRunTask(taskId, teamPlan = null) {
  if (uiState.sending || uiState.preparingTask) throw new Error('请先等待或停止当前执行。');
  uiState.preparingTask = true;
  try {
  const draft = uiState.composer;
  const attachments = uiState.composerAttachments;
  const payload = await api('/api/tasks/prepare', { method: 'POST', body: { taskId, teamPlan } });
  applyBootstrap(payload.bootstrap);
  await handleSendMessage(payload.execution);
  if (!uiState.composer || uiState.composer === payload.execution.content) {
    uiState.composer = draft;
    uiState.composerAttachments = attachments;
  }
  render();
  } finally { uiState.preparingTask = false; }
}
async function handleRunTaskLane(owner) {
  // One visible task at a time: every approval and Stop uses the chat stream.
  const next = activeTasks().find(t => t.owner === owner && ['todo', 'blocked'].includes(t.status));
  if (!next) throw new Error('没有待执行的任务。');
  await handleRunTask(next.id);
}

async function createApprovalRequest(body) {
  const payload = await api('/api/approvals', {
    method: 'POST',
    body,
  });
  applyBootstrap(payload);
}

async function handleExecuteApproval(approvalId) {
  const result = await api('/api/approvals/execute', {
    method: 'POST',
    body: { approvalId },
  });
  resetFileEditor();
  applyBootstrap(result.bootstrap);
}

async function handleRejectApproval(approvalId) {
  const payload = await api('/api/approvals/reject', {
    method: 'POST',
    body: { approvalId },
  });
  applyBootstrap(payload);
}


function composerCommandCatalog() {
  const dynamicProjects = (uiState.bootstrap?.projects || []).slice(0, 5).map(project => ({
    command: `/project ${project.name}`,
    label: `Switch to project ${project.name}`,
  }));
  const dynamicFiles = (uiState.bootstrap?.workspace?.entries || [])
    .filter(entry => entry.type === 'file')
    .slice(0, 6)
    .map(entry => ({
      command: `/file ${entry.path}`,
      label: `Open file ${entry.path}`,
    }));

  return [
    { command: '/new', label: 'Open the New chat home' },
    { command: '/mode chat', label: 'Switch to Chat mode' },
    { command: '/mode cowork', label: 'Switch to Cowork mode' },
    { command: '/mode code', label: 'Switch to Code mode' },
    { command: '/view projects', label: 'Open the Projects workspace' },
    { command: '/view chats', label: 'Open the chat list' },
    { command: '/view search', label: 'Open global search' },
    { command: '/mcp browse', label: 'Open the runtime MCP browser' },
    { command: '/task Review the current build flow', label: 'Create a task' },
    { command: '/agent reviewer Inspect the latest diff', label: 'Create an agent task' },
    { command: '/run git-status', label: 'Queue the git status command' },
    ...dynamicProjects,
    ...dynamicFiles,
  ];
}

// Lightweight fuzzy scorer for client-side palette/composer filtering.
// Returns 0 when nothing matches (filters the item out).
function clientFuzzyScore(query, ...haystacks) {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const haystack = haystacks.map(s => String(s || '').toLowerCase()).join(' ');
  if (haystack.includes(q)) return 100;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every(t => haystack.includes(t))) return 80;
  // Subsequence match: every character of q appears in order in haystack
  let qi = 0;
  for (let i = 0; i < haystack.length && qi < q.length; i++) {
    if (haystack[i] === q[qi]) qi++;
  }
  return qi === q.length ? 40 : 0;
}

function filteredComposerCommands() {
  const input = uiState.composer.trim();
  if (!input.startsWith('/')) {
    return [];
  }

  const query = input.toLowerCase();
  return composerCommandCatalog()
    .filter(item => clientFuzzyScore(query, item.command, item.label) > 0)
    .slice(0, 8);
}

function openCommandPalette(initialQuery = '') {
  uiState.commandPalette.open = true;
  uiState.commandPalette.query = initialQuery;
  uiState.commandPalette.selectedIndex = 0;
  render();

  window.setTimeout(() => {
    document.getElementById('command-palette-input')?.focus();
    document.getElementById('command-palette-input')?.select?.();
  }, 0);
}

function closeCommandPalette() {
  uiState.commandPalette.open = false;
  uiState.commandPalette.query = '';
  uiState.commandPalette.selectedIndex = 0;
  bgRender();
}

function paletteCommands() {
  const projects = (uiState.bootstrap?.projects || []).slice(0, 6);
  const files = (uiState.bootstrap?.workspace?.entries || [])
    .filter(entry => entry.type === 'file')
    .slice(0, 8);
  const pendingApprovals = approvalQueue().filter(item => item.status === 'pending').slice(0, 6);
  const runnableTasks = activeTasks()
    .filter(task => task.kind === 'agent')
    .slice(0, 8);

  return [
    {
      id: 'palette-new-chat',
      title: 'New chat',
      subtitle: 'Start a fresh local conversation',
      keywords: 'new chat conversation',
      action: 'new-chat',
    },
    {
      id: 'palette-open-projects',
      title: 'Open Projects',
      subtitle: 'Go to the project workspace',
      keywords: 'projects view',
      action: 'open-view',
      payload: { view: 'projects' },
    },
    {
      id: 'palette-open-search',
      title: 'Open Search',
      subtitle: 'Search chats, memory, projects, artifacts, and files',
      keywords: 'search view',
      action: 'open-view',
      payload: { view: 'search' },
    },
    {
      id: 'palette-open-runtime',
      title: 'Open Advanced / MCP Runtime',
      subtitle: 'Inspect MCP servers, plugins, tools, resources, and prompts',
      keywords: 'advanced runtime mcp browser tools resources prompts plugins',
      action: 'open-runtime',
    },
    {
      id: 'palette-open-agents',
      title: 'Open Agent',
      subtitle: t('设置 Agent 的人设、能力与消息渠道'),
      keywords: 'agent agents persona capabilities channels',
      action: 'open-agents',
    },
    {
      id: 'palette-mode-chat',
      title: 'Switch to Chat mode',
      subtitle: 'General collaboration and discussion',
      keywords: 'mode chat',
      action: 'switch-mode',
      payload: { mode: 'chat' },
    },
    // Cowork / Code palette entries are hidden for now — the UI for those
    // modes is still being designed. Leaving this comment so the shortcut
    // is easy to bring back when we have something worth routing to.
    {
      id: 'palette-lane-main',
      title: 'Run main worker lane',
      subtitle: 'Execute queued coordinator agent tasks',
      keywords: 'lane main coordinator tasks',
      action: 'run-lane',
      payload: { owner: 'main' },
    },
    {
      id: 'palette-lane-research',
      title: 'Run research worker lane',
      subtitle: 'Execute queued research agent tasks',
      keywords: 'lane research tasks',
      action: 'run-lane',
      payload: { owner: 'research' },
    },
    {
      id: 'palette-lane-builder',
      title: 'Run builder worker lane',
      subtitle: 'Execute queued builder agent tasks',
      keywords: 'lane builder tasks',
      action: 'run-lane',
      payload: { owner: 'builder' },
    },
    {
      id: 'palette-lane-reviewer',
      title: 'Run reviewer worker lane',
      subtitle: 'Execute queued reviewer agent tasks',
      keywords: 'lane reviewer tasks',
      action: 'run-lane',
      payload: { owner: 'reviewer' },
    },
    ...projects.map(project => ({
      id: `palette-project-${project.id}`,
      title: `Focus project: ${project.name}`,
      subtitle: project.summary,
      keywords: `project ${project.name} ${project.tag}`,
      action: 'focus-project',
      payload: { projectId: project.id },
    })),
    ...files.map(file => ({
      id: `palette-file-${file.path}`,
      title: `Open file: ${file.path}`,
      subtitle: 'Select this file in code mode',
      keywords: `file ${file.path} ${file.name}`,
      action: 'open-file',
      payload: { filePath: file.path },
    })),
    ...pendingApprovals.map(approval => ({
      id: `palette-approval-${approval.id}`,
      title: `Approve: ${approval.title}`,
      subtitle: approval.description || 'Execute pending approval',
      keywords: `approval ${approval.kind} ${approval.title}`,
      action: 'execute-approval',
      payload: { approvalId: approval.id },
    })),
    ...runnableTasks.map(task => ({
      id: `palette-task-${task.id}`,
      title: `Run task: ${task.title}`,
      subtitle: `${task.ownerLabel} · ${task.statusLabel}`,
      keywords: `task agent ${task.title} ${task.owner}`,
      action: 'run-task',
      payload: { taskId: task.id },
    })),
  ];
}

function filteredPaletteCommands() {
  const query = uiState.commandPalette.query.trim().toLowerCase();
  const commands = paletteCommands();
  if (!query) {
    return commands;
  }

  return commands.filter(command =>
    clientFuzzyScore(query, command.title, command.subtitle || '', command.keywords || '') > 0,
  );
}

async function executePaletteCommand(command) {
  if (!command) {
    return;
  }

  closeCommandPalette();
  uiState.neuralOverview = false;
  uiState.neuralGroup = null;

  switch (command.action) {
    case 'new-chat':
      await handleCreateChat();
      break;
    case 'open-view':
      await patchSettings({ activeView: command.payload.view });
      break;
    case 'open-runtime':
      // Legacy command name preserved; routes to the new Advanced page.
      await patchSettings({
        activeView: 'customize',
        selectedCustomizeSection: 'advanced',
      });
      break;
    case 'open-agents':
      await patchSettings({ activeView: 'agent' });
      break;
    case 'switch-mode':
      await patchSettings({
        activeMode: command.payload.mode,
        activeView: 'chat',
      });
      break;
    case 'focus-project':
      await patchSettings({
        selectedProjectId: command.payload.projectId,
        activeView: 'projects',
      });
      break;
    case 'open-file':
      await handleSelectWorkspaceFile(command.payload.filePath);
      break;
    case 'execute-approval':
      await handleExecuteApproval(command.payload.approvalId);
      break;
    case 'run-task':
      await handleRunTask(command.payload.taskId);
      break;
    case 'run-lane':
      await handleRunTaskLane(command.payload.owner);
      break;
    default:
      break;
  }
}

async function handleComposerCommand() {
  const raw = uiState.composer.trim();
  if (!raw.startsWith('/')) {
    return false;
  }

  const commandLine = raw.slice(1).trim();
  if (!commandLine) {
    showError('Type a command after /.');
    return true;
  }

  const [name = '', ...parts] = commandLine.split(/\s+/);
  const lowerName = name.toLowerCase();
  const remainder = parts.join(' ').trim();

  switch (lowerName) {
    case 'new':
      await handleOpenNewChatHome();
      break;
    case 'mode':
      if (!['chat', 'cowork', 'code'].includes(remainder)) {
        showError('Use /mode chat, /mode cowork, or /mode code.');
        return true;
      }
      await patchSettings({
        activeMode: remainder,
        activeView: 'chat',
      });
      break;
    case 'view':
      if (!['chat', 'chats', 'projects', 'customize', 'artifacts', 'search'].includes(remainder)) {
        showError('Unknown view.');
        return true;
      }
      await patchSettings({
        activeView: remainder === 'chat' ? 'chat' : remainder,
      });
      break;
    case 'project': {
      const project = (uiState.bootstrap?.projects || []).find(item =>
        item.name.toLowerCase().includes(remainder.toLowerCase()),
      );
      if (!project) {
        showError('Project not found.');
        return true;
      }
      await patchSettings({
        selectedProjectId: project.id,
        activeView: 'projects',
      });
      break;
    }
    case 'file': {
      const file = (uiState.bootstrap?.workspace?.entries || []).find(
        entry =>
          entry.type === 'file' && entry.path.toLowerCase().includes(remainder.toLowerCase()),
      );
      if (!file) {
        showError('File not found in the current workspace snapshot.');
        return true;
      }
      await handleSelectWorkspaceFile(file.path);
      break;
    }
    case 'run': {
      const [templateId = '', ...queryParts] = parts;
      if (!templateId) {
        showError('Use /run <template-id> [query].');
        return true;
      }
      await createApprovalRequest({
        kind: 'command',
        title: `Run ${templateId}`,
        description: `Command requested from the command workbench.`,
        projectId: creationContext().projectId,
        chatId: creationContext().chatId,
        payload: {
          templateId,
          query: queryParts.join(' ').trim(),
          projectId: creationContext().projectId,
        },
      });
      break;
    }
    case 'task':
      await api('/api/tasks', {
        method: 'POST',
        body: {
          title: remainder || 'Untitled task',
          summary: 'Created from the command workbench.',
          owner: 'builder',
          kind: 'task',
          projectId: creationContext().projectId,
          chatId: creationContext().chatId,
        },
      }).then(applyBootstrap);
      break;
    case 'agent': {
      const [owner = 'reviewer', ...titleParts] = parts;
      await api('/api/tasks', {
        method: 'POST',
        body: {
          title: titleParts.join(' ').trim() || 'Untitled agent task',
          summary: `Assigned to ${owner}.`,
          owner,
          kind: 'agent',
          projectId: creationContext().projectId,
          chatId: creationContext().chatId,
        },
      }).then(applyBootstrap);
      break;
    }
    case 'mcp':
      if (remainder !== 'browse') {
        showError('Use /mcp browse.');
        return true;
      }
      await patchSettings({
        activeView: 'customize',
        selectedCustomizeSection: 'advanced',
      });
      break;
    default:
      showError(`Unknown command: /${lowerName}`);
      return true;
  }

  uiState.composer = '';
  bgRender();
  return true;
}

async function handleRunCommand(form) {
  const formData = new FormData(form);
  await createApprovalRequest({
    kind: 'command',
    title: `Run ${form.dataset.templateId}`,
    description: 'Run a curated local command inside the active project.',
    projectId: creationContext().projectId,
    chatId: creationContext().chatId,
    payload: {
      templateId: form.dataset.templateId,
      query: String(formData.get('query') || '').trim(),
      projectId: creationContext().projectId,
    },
  });
}

async function handleSelectWorkspaceFile(filePath, { lineNumber = null } = {}) {
  const payload = await api('/api/workspace/select-file', {
    method: 'POST',
    body: { filePath },
  });
  resetFileEditor();
  applyBootstrap(payload);
  // Stash the desired line number for the post-render scroll hook.  We only
  // record it when the caller actually asked for one; otherwise leave any
  // previously pending target alone (it gets cleared by the hook once it
  // scrolls, and by view navigation elsewhere).
  if (Number.isFinite(lineNumber) && lineNumber > 0) {
    uiState.pendingGoToLine = { filePath, line: Number(lineNumber) };
  }
}

async function handleSaveWorkspaceFile() {
  const filePath = uiState.fileDraftPath || uiState.bootstrap?.workspace?.selectedFile?.path;
  if (!filePath) {
    showError('Choose a file before saving.');
    return;
  }

  await createApprovalRequest({
    kind: 'file-save',
    title: `Save ${filePath}`,
    description: 'Write the current editor draft back into the workspace.',
    projectId: creationContext().projectId,
    chatId: creationContext().chatId,
    payload: {
      filePath,
      content: uiState.fileDraftContent,
      projectId: creationContext().projectId,
    },
  });
}

async function handleApplyArtifactToSelectedFile(artifactId) {
  const selectedFilePath = uiState.bootstrap?.workspace?.selectedFilePath;
  if (!selectedFilePath) {
    showError('Select a target file before applying an artifact.');
    return;
  }

  await createApprovalRequest({
    kind: 'artifact-apply',
    title: `Apply artifact to ${selectedFilePath}`,
    description: 'Write the selected artifact into the currently selected workspace file.',
    projectId: creationContext().projectId,
    chatId: creationContext().chatId,
    payload: {
      artifactId,
      filePath: selectedFilePath,
      projectId: creationContext().projectId,
    },
  });
}

function navItem(action, iconMarkup, label, view, subtitle = '') {
  const isActive = uiState.bootstrap?.settings.activeView === view;
  return ui`
    <button class="nav-item ${isActive ? 'is-active' : ''}" data-action="${action}" data-view="${view}">
      <span class="nav-icon">${iconMarkup}</span>
      <span class="nav-copy">
        <span class="nav-title">${label}</span>
        ${subtitle ? ui`<span class="nav-subtitle">${subtitle}</span>` : ''}
      </span>
    </button>
  `;
}

function renderSidebar() {
  const data = uiState.bootstrap;
  const currentMode = activeMode();
  const mainAgent = mainAgentProfile();
  const isNewChatActive =
    data.settings.activeView === 'chat' && !data.settings.selectedChatId;

  return ui`
    <aside class="sidebar">
      <div class="sidebar-nav">
        <div class="nav-group">
          <button class="nav-item ${isNewChatActive ? 'is-active' : ''}" data-action="new-chat">
            <span class="nav-icon">${icon.plus}</span>
            <span class="nav-copy">
              <span class="nav-title">New chat</span>
            </span>
          </button>
          ${navItem('open-view', icon.search, 'Search', 'search')}
          ${navItem('open-view', icon.spark, 'Agent', 'agent')}
          ${navItem('open-view', icon.sliders, 'Model', 'model')}
          ${navItem('open-view', icon.wand, 'Customize', 'customize')}
          ${navItem('open-view', icon.bubble, 'Chats', 'chats')}
          ${navItem('open-view', icon.folder, 'Projects', 'projects')}
          ${navItem('open-view', icon.box, 'Artifacts', 'artifacts')}
        </div>
      </div>

      <div class="sidebar-recents">
        <div class="recent-section-title">Recents</div>
        <div class="recent-list">
          ${
            data.recents.length
              ? data.recents
                  .map(
                    recent => ui`
                      <button
                        class="recent-item ${
                          data.settings.selectedChatId === recent.id &&
                          data.settings.activeView === 'chat'
                            ? 'is-active'
                            : ''
                        }"
                        data-action="open-chat"
                        data-chat-id="${recent.id}"
                      >
                        <div class="recent-item-row">
                          <div class="recent-item-title">
                            ${recent.locked ? ui`<span class="recent-lock-badge" aria-label="Locked">${icon.lock}</span>` : ''}
                            <span>${escapeHtml(recent.title)}</span>
                          </div>
                          ${
                            data.settings.selectedChatId === recent.id &&
                            data.settings.activeView === 'chat'
                              ? ui`<span class="recent-item-more">${icon.dots}</span>`
                              : ''
                          }
                        </div>
                        <div class="recent-item-meta">${escapeHtml(recent.preview)}</div>
                      </button>
                    `,
                  )
                  .join('')
              : '<div class="empty-state compact">No threads yet. Start one from New chat.</div>'
          }
        </div>
      </div>

      <div class="sidebar-footer">
        <div class="profile-card">
          <div class="avatar">${escapeHtml(data.profile.initial)}</div>
          <div class="profile-meta">
            <div class="profile-name">${escapeHtml(data.profile.name)}</div>
            <div class="profile-plan">${escapeHtml(data.profile.plan)}</div>
          </div>
        </div>

        <div class="profile-hint">
          ${escapeHtml(currentMode?.label || 'Chat')} mode is ready for the current workspace.

        </div>
      </div>
    </aside>
  `;
}

function renderTopbar() {
  const data = uiState.bootstrap;
  const project = activeProject();
  const currentAgent = conversationAgent(data, { overview: uiState.neuralOverview, newAgentId: uiState.activeChatAgentId, newProjectId: uiState.newChatProjectId });

  return ui`
    <header class="topbar">
      <div class="topbar-left">
        <button class="pill-button" data-action="open-command-palette">
          Quick actions
          <span class="meta-label">Cmd/Ctrl+K</span>
        </button>
      </div>

      <div class="topbar-center">
        <div class="mode-switch">
          ${data.modes
            // Cowork / Code modes are hidden for now — keeping them in
            // MODE_DEFS so persisted chats and the command palette still
            // round-trip, but not showing the tabs in the topbar until
            // we decide what those pages should actually be.
            .filter(mode => mode.id === 'chat')
            .map(
              mode => ui`
                <button
                  class="mode-button ${
                    data.settings.activeMode === mode.id ? 'is-active' : ''
                  }"
                  data-action="switch-mode"
                  data-mode="${mode.id}"
                >
                  ${escapeHtml(mode.label)}
                </button>
              `,
            )
            .join('')}
        </div>
      </div>

      <div class="topbar-right status-group">
        ${
          currentAgent
            ? ui`<div class="status-pill">${escapeHtml(currentAgent.name)}</div>`
            : ''
        }
        <div class="status-pill">
          <span class="status-dot"></span>
          ${!uiState.neuralOverview && activeChat()?.modelSelection ? t("本对话") : currentAgent?.model ? 'Agent 默认' : t("默认")} · ${escapeHtml(modelLabel((!uiState.neuralOverview && activeChat()?.modelSelection?.model) || currentAgent?.model || data.settings.config.model))}
        </div>
      </div>
    </header>
  `;
}

function syncModelPickerPosition() {
  const panel = document.querySelector('#model-picker-panel');
  const trigger = document.querySelector('.model-picker-trigger');
  if (!panel || !trigger) return;
  if (typeof panel.showPopover === 'function' && !panel.matches(':popover-open')) panel.showPopover();
  const anchor = trigger.getBoundingClientRect();
  const position = modelPanelPosition(anchor, { width: panel.offsetWidth, height: panel.offsetHeight }, { width: innerWidth, height: innerHeight });
  panel.style.left = `${position.left}px`;
  panel.style.top = `${position.top}px`;
}
window.addEventListener('resize', syncModelPickerPosition);

function composerPlaceholder() {
  if (!activeChat()) {
    return t("问问 Melo，或输入 / 使用命令…");
  }

  switch (uiState.bootstrap?.settings.activeMode) {
    case 'cowork':
      return 'What are we solving together?';
    case 'code':
      return 'Ask about files, builds, code changes, or your workspace...';
    case 'chat':
    default:
      return t("今天有什么可以帮你？");
  }
}

// Phase 3.3.3 — slash-command palette popover. Rendered inside the
// composer input frame above the textarea. Returns empty string when the
// palette isn't open OR there's nothing to show; this is the normal state.
function renderSlashPalette() {
  if (!uiState.slashPalette.open) return '';
  const matches = slashPaletteMatches();
  if (!matches.length) {
    return ui`
      <div class="slash-palette" role="listbox">
        <div class="slash-palette-empty">No skills match /${escapeHtml(uiState.slashPalette.query)}</div>
      </div>
    `;
  }
  const selectedIndex = Math.min(
    Math.max(0, uiState.slashPalette.selectedIndex | 0),
    matches.length - 1,
  );
  return ui`
    <div class="slash-palette" role="listbox">
      ${matches
        .map((skill, i) => ui`
          <button
            type="button"
            class="slash-palette-item ${i === selectedIndex ? 'is-active' : ''}"
            data-action="pick-slash-skill"
            data-skill-id="${escapeHtml(skill.id)}"
            role="option"
          >
            <span class="slash-palette-id">/${escapeHtml(skill.id)}</span>
            <span class="slash-palette-name">${escapeHtml(skill.name)}</span>
            ${skill.description
              ? ui`<span class="slash-palette-desc">${escapeHtml(skill.description)}</span>`
              : ''}
          </button>
        `)
        .join('')}
      <div class="slash-palette-hint">↑↓ to move · Enter to pick · Esc to close</div>
    </div>
  `;
}

function effectiveModelSetupDraft() {
  // Pure merge lives in `connectorDraft.js` so node:test can pin the
  // saved-config + live-draft + masked-secret semantics that Customize
  // → Connectors and Settings → Model both depend on.
  return buildConnectorDraft(
    uiState.bootstrap?.settings?.config,
    uiState.modelSetupDraft,
  );
}

function modelDefaultsForAuthMode(authMode) {
  return MODEL_SETUP_DEFAULTS[authMode] || MODEL_SETUP_DEFAULTS.codex;
}

function modelOptionsForAuthMode(authMode) {
  const config = uiState.bootstrap?.settings?.config || {};
  if (!authMode || authMode === config.authMode) return connectionModelOptions(config);
  const catalogs = config.modelCatalogs || {};
  const mode = authMode || config.authMode || 'codex';
  const selectedModel =
    (uiState.modelSetupDraft?.authMode || config.authMode || 'codex') === mode
      ? uiState.modelSetupDraft?.model || config.model
      : config.model;

  return Array.from(
    new Set(
      [...(catalogs[mode] || []), ...(mode === config.authMode ? config.availableModels || [] : []), selectedModel]
        .map(value => String(value || '').trim())
        .filter(Boolean),
    ),
  );
}

function renderComposerCommandDeck({ inline = false } = {}) {
  const suggestions = filteredComposerCommands();
  const showSuggestions = uiState.composer.trim().startsWith('/') && suggestions.length;
  if (inline && !showSuggestions) {
    return '';
  }

  return ui`
    <div class="command-deck ${inline ? 'is-inline' : ''}">
      ${
        inline
          ? ''
          : ui`
            <div class="chip-row command-chip-row">
              ${HOME_PROMPT_PRESETS.map(
                preset => ui`
                  <button
                    class="chip chip-button"
                    type="button"
                    data-action="apply-home-prompt"
                    data-preset-id="${preset.id}"
                  >
                    ${escapeHtml(preset.label)}
                  </button>
                `,
              ).join('')}
            </div>
          `
      }
      ${
        showSuggestions
          ? ui`
            <div class="command-suggestions">
              ${suggestions
                .map(
                  item => ui`
                    <button class="command-suggestion" type="button" data-action="insert-command" data-command="${escapeHtml(
                      item.command,
                    )}">
                      <span class="list-row-title mono">${escapeHtml(item.command)}</span>
                      <span class="list-row-meta">${escapeHtml(item.label)}</span>
                    </button>
                  `,
                )
                .join('')}
            </div>
          `
          : ''
      }
    </div>
  `;
}

async function previewTaskBackup(operationId) {
  try { uiState.taskRestore = await api('/api/tasks/restore-preview', {method:'POST',body:{operationId}}); render(); } catch(error) { showError(error.message); }
}
async function confirmTaskRestore(token) {
  try { const result = await api('/api/tasks/restore-confirm', {method:'POST',body:{token}}); uiState.taskRestore = null; showFlashToast(`已恢复；恢复前的内容也已备份：${result.safetyBackupId}`); render(); } catch(error) { showError(error.message); }
}
function renderTaskPanel({ compact = false } = {}) {
  const tasks = activeTasks();
  const config = uiState.bootstrap?.settings?.config || {};

  return ui`
    <section class="surface-card ${compact ? 'compact-surface-card' : ''}">
      <div class="header-row">
        <div>
          <h2 class="pane-title">任务</h2>
          <details class="quality-details"><summary>当前模型计价（可选）</summary><p>填写服务实际单价，单位 USD / 百万 token。缺少单价时费用显示未知；订阅用量不换算成 API 账单。</p><form data-form="task-pricing">${[['input','普通输入'],['output','输出'],['cached','缓存读取'],['cacheWrite','缓存写入']].map(([key,label])=>ui`<label>${label}<input type="number" min="0" step="any" id="pricing-${key}" name="${key}" value="${escapeHtml(uiState.taskPricing?.[key] ?? config.modelPricing?.[key] ?? '')}" data-task-pricing="${key}" placeholder="未填写" /></label>`).join('')}</form></details>
          ${uiState.taskRestore ? ui`<section class="quality-details"><h3>恢复预览 · ${escapeHtml(uiState.taskRestore.action)}</h3><p>${escapeHtml(uiState.taskRestore.path)}</p><p>${uiState.taskRestore.currentBytes} → ${uiState.taskRestore.restoredBytes} 字节${uiState.taskRestore.truncated ? ' · 内容预览已截断' : ''}</p><details><summary>查看当前与恢复后的内容</summary><p>当前</p><pre>${escapeHtml(uiState.taskRestore.currentPreview)}</pre><p>恢复后</p><pre>${escapeHtml(uiState.taskRestore.restoredPreview)}</pre></details><button class="small-button" data-action="confirm-task-restore" data-token="${uiState.taskRestore.token}">确认恢复此文件</button></section>` : ''}
        </div>
        <button class="small-button" data-action="toggle-task-form">
          ${uiState.showTaskForm ? t("收起") : t("新建任务")}
        </button>
      </div>
      ${(() => {
        // Lane row: main is the default agent, so it stays as the primary
        // chip. The other three live behind a "⋯" overflow menu — pre-
        // 2026-04-27 we shipped all four chips inline, but Codex audit
        // flagged the density (Tasks region had 4+ persistent buttons).
        const lanes = ['main', 'research', 'builder', 'reviewer'];
        const primary = lanes[0];
        const overflow = lanes.slice(1);
        const primaryProfile = agentProfileById(primary);
        const overflowOpen = uiState.taskLaneOverflowOpen;
        return ui`
          <div class="chip-row task-lane-row task-lane-overflow-anchor">
            <button class="chip chip-button" data-action="run-task-lane" data-owner="${primary}">
              执行下一项 · ${primary}
            </button>
            <button class="chip chip-button task-lane-overflow-toggle"
                    type="button"
                    aria-haspopup="true"
                    aria-expanded="${overflowOpen ? 'true' : 'false'}"
                    data-action="toggle-task-lane-overflow"
                    title="Run other agents">
              ⋯
            </button>
            ${overflowOpen ? ui`
              <div class="task-lane-overflow-menu">
                ${overflow.map(owner => {
                  const ownerProfile = agentProfileById(owner);
                  return ui`
                    <button class="task-lane-overflow-item" type="button" data-action="run-task-lane" data-owner="${owner}">
                      执行下一项 · ${owner}
                    </button>
                  `;
                }).join('')}
              </div>
            ` : ''}
          </div>
        `;
      })()}
      ${
        uiState.showTaskForm
          ? ui`
            <form class="config-form" data-form="task-create">
              <label class="label">
                任务名称
                <input class="input" name="title" value="${escapeHtml(uiState.draftTask.title)}" />
              </label>
              <label class="label">
                目标与验收要求
                <textarea class="config-textarea" name="summary">${escapeHtml(uiState.draftTask.summary)}</textarea>
              </label>
              <div class="project-form-grid">
                <label class="label">
                  执行Agent
                  <select class="config-select" name="owner">
                    ${['main', 'research', 'builder', 'reviewer']
                      .map(
                        owner => ui`
                          <option value="${owner}" ${uiState.draftTask.owner === owner ? 'selected' : ''}>
                            ${owner}
                          </option>
                        `,
                      )
                      .join('')}
                  </select>
                </label>
                <label class="label">
                  任务类型
                  <select class="config-select" name="kind">
                    ${['task', 'agent']
                      .map(
                        kind => ui`
                          <option value="${kind}" ${uiState.draftTask.kind === kind ? 'selected' : ''}>
                            ${kind}
                          </option>
                        `,
                      )
                      .join('')}
                  </select>
                </label>
              </div>
              <button class="small-button is-primary" type="submit">创建任务</button>
            </form>
          `
          : ''
      }
      <div class="mini-list">
        ${
          tasks.length
            ? tasks
                .slice(0, compact ? 4 : 24)
                .map(
                  task => {
                    const ownerProfile = agentProfileById(task.owner);
                    return ui`
                    <article class="run-card">
                      <div class="thread-meta">
                        <span class="chip is-accent">${escapeHtml(task.kind === 'agent' ? t("Agent任务") : t("任务"))}</span>
                        <span class="chip">${escapeHtml(task.ownerLabel)}</span>

                        <span class="chip">${escapeHtml(task.statusLabel)}</span>
                        <span class="meta-label">${escapeHtml(task.updatedLabel)}</span>
                      </div>
                      <div class="list-row-title">${escapeHtml(task.title)}</div>
                      ${task.handoff && task.handoff.revision === task.syncRevision ? ui`<p class="alert compact-alert">收到手机接力请求。检查现有结果后点击“继续 / 修复”；工具权限仍在本机确认。</p>` : ""}
                      ${
                        task.summary
                          ? ui`<div class="list-row-meta">${escapeHtml(task.summary)}</div>`
                          : ''
                      }
                      ${
                        task.latestNotePreview
                          ? ui`<div class="workspace-root">${escapeHtml(task.latestNotePreview)}</div>`
                          : ''
                      }
                      <div class="thread-meta">
                        <span class="meta-label">${escapeHtml(task.lastRunLabel)}</span>
                        <span class="meta-label">已执行 ${task.runCount} 次</span>
                      </div>
                      ${task.status === 'blocked' ? ui`<button class="small-button" data-action="task-operations" data-task-id="${task.id}">检查中断操作</button>${(uiState.taskOperations?.[task.id] || []).filter(r=>r.uncertain).map(r=>ui`<p>${escapeHtml(r.toolId)} · 执行效果不明。请先核对目标系统或文件。<button class="small-button" data-action="task-operation-retry" data-task-id="${task.id}" data-key="${r.key}">已核对未产生效果，允许重试</button></p>`).join('')}` : ''}
                      ${task.status !== 'running' ? ui`<details class="quality-details"><summary>多Agent协作 · 职责与费用</summary><p>每个成员都会独立调用模型；仅服务报告用量时计数。含执行成员时串行运行，调查与复核最多并发 2 个。停止对话会取消所有成员。</p><select id="team-plan-${task.id}"><option value="parallel-research">并行调研</option><option value="research-build-review">调研 → 实施 → 复核</option><option value="review-loop">实施 / 复核循环（最多 2 轮）</option></select><button class="small-button" data-action="run-task-team" data-task-id="${task.id}" ${uiState.sending ? 'disabled' : ''}>按此分工执行</button></details>` : ''}
                      ${task.acceptance?.team ? ui`<details class="quality-details" open><summary>各成员结果与成本</summary>${task.acceptance.team.results.map(r=>ui`<p>${escapeHtml(r.role)} · ${r.ok ? '待核对' : t("失败")} · ${(r.durationMs/1000).toFixed(1)} 秒 · ${r.usage?.unknown || !r.usage?.requests ? '用量未报告' : `${r.usage.input+r.usage.output} tokens`} · ${r.usage?.estimatedCost == null ? '费用未知' : `估算 $${r.usage.estimatedCost.toFixed(5)}`}</p>`).join('')}</details>` : ''}
                      ${task.runHistory?.length ? ui`<details class="quality-details"><summary>历次执行对比 · ${task.runHistory.length}</summary>${task.runHistory.map(r=>ui`<p>${escapeHtml(r.startedAt || r.createdAt)} · ${escapeHtml(r.status)} · ${r.startedAt && r.finishedAt ? ((Date.parse(r.finishedAt)-Date.parse(r.startedAt))/1000).toFixed(1) : '—'} 秒 · ${r.usage?.estimatedCost == null ? '费用未知' : `$${r.usage.estimatedCost.toFixed(5)}`} · ${r.qualityScore == null ? '尚未验收评分' : `${r.qualityScore}/5`}</p>`).join('')}</details>` : ''}
                      ${task.acceptance ? ui`<details class="quality-details" ${task.status === 'review' || task.status === 'blocked' ? 'open' : ''}><summary>验收与恢复 · ${task.acceptance.tools?.length || 0} 条工具记录</summary>
                      ${(task.acceptance.failures || []).map(f => ui`<p class="alert compact-alert">${escapeHtml(f.name)} · ${escapeHtml(f.error)}</p>`).join('')}
                      ${(task.acceptance.criteria || []).map(c => ui`<label class="toggle-row"><input type="checkbox" data-task-check="${escapeHtml(task.id)}" data-criterion="${escapeHtml(c.id)}" ${(uiState.taskChecks?.[task.id]?.runId === task.execution?.runId ? uiState.taskChecks[task.id][c.id] : c.checked) ? 'checked' : ''} ${task.status !== 'review' ? 'disabled' : ''} />${escapeHtml(c.label)}</label>`).join('')}
                      ${(task.acceptance.tools || []).map(t => ui`<p>${escapeHtml(t.toolName)} · ${t.ok ? t("成功") : t("失败")}${t.exitCode != null ? ` · 退出码 ${t.exitCode}` : ''} ${escapeHtml(t.path || '')}${t.backupOperationId ? ui`<button class="small-button" data-action="preview-task-backup" data-operation-id="${escapeHtml(t.backupOperationId)}">预览恢复</button>` : ''}</p>`).join('')}
                      ${task.status === 'review' ? ui`<label>验收评分<select id="quality-score-${task.id}"><option value="">暂不评分</option><option value="5">5 · 满足要求</option><option value="4">4 · 小幅改善</option><option value="3">3 · 部分满足</option><option value="2">2 · 明显不足</option><option value="1">1 · 不可用</option></select></label>` : ''}
                      </details>` : ''}
                      <div class="inline-actions">
                        ${
                          task.status !== 'running'
                            ? ui`<button class="small-button is-primary" data-action="run-task" data-task-id="${task.id}" ${uiState.sending ? 'disabled' : ''}>${task.runCount ? t("继续 / 修复") : t("开始执行")}</button>`
                            : ui`<span class="meta-label">在对话中查看进度或停止</span>`
                        }
                        ${task.execution?.chatId ? ui`<button class="small-button" data-action="open-chat" data-chat-id="${escapeHtml(task.execution.chatId)}">查看执行记录</button>` : ''}
                        ${task.status === 'review' ? ui`<button class="small-button" data-action="set-task-status" data-task-id="${task.id}" data-status="done">验收完成</button>` : ''}
                        ${task.status === 'done' ? ui`<button class="small-button" data-action="set-task-status" data-task-id="${task.id}" data-status="todo">重新打开</button>` : ''}
                      </div>
                    </article>
                  `;
                  },
                )
                .join('')
            : ui`<div class="empty-state compact">还没有任务。创建后可执行、查看记录并验收。</div>`
        }
      </div>
    </section>
  `;
}

function renderApprovalPanel({ compact = false } = {}) {
  const approvals = approvalQueue();
  let displayedCompleted = 0;
  const visibleApprovals = approvals.filter(item => ['pending', 'running', 'uncertain'].includes(item.status) || displayedCompleted++ < (compact ? 4 : 24));

  return ui`
    <section class="surface-card ${compact ? 'compact-surface-card' : ''}">
      <div class="header-row">
        <div>
          <h2 class="pane-title">操作审批</h2>
          <p class="page-kicker">命令、文件写入与外部工具的审批和执行记录。</p>
        </div>
        <span class="chip is-accent">${approvals.filter(item => item.status === 'pending').length} 待确认 · ${approvals.filter(item => item.status === 'uncertain').length} 待核对</span>
      </div>
      <div class="mini-list">
        ${
          approvals.length
            ? visibleApprovals
                .map(
                  approval => ui`
                    <article class="run-card">
                      <div class="thread-meta">
                        <span class="chip is-accent">${escapeHtml(approval.kind)}</span>
                        <span class="chip">${escapeHtml(({pending:t("等待确认"),running:t("执行中"),uncertain:'结果待核对',approved:t("已执行"),rejected:t("已关闭")})[approval.status] || approval.status)}</span>
                        <span class="meta-label">${escapeHtml(approval.updatedLabel)}</span>
                      </div>
                      <div class="list-row-title">${escapeHtml(approval.title)}</div>
                      ${
                        approval.description
                          ? ui`<div class="list-row-meta">${escapeHtml(approval.description)}</div>`
                          : ''
                      }
                      ${
                        approval.resultSummary
                          ? ui`<div class="workspace-root">${escapeHtml(approval.resultSummary)}</div>`
                          : ''
                      }
                      ${
                        approval.status === 'pending'
                          ? ui`
                            <div class="inline-actions">
                              <button class="small-button is-primary" data-action="execute-approval" data-approval-id="${approval.id}">
                                同意并执行
                              </button>
                              <button class="small-button" data-action="reject-approval" data-approval-id="${approval.id}">
                                拒绝
                              </button>
                            </div>
                          `
                          : approval.status === 'uncertain' ? ui`<div class="inline-actions"><button class="small-button" data-action="reject-approval" data-approval-id="${escapeHtml(approval.id)}">已核对，关闭记录</button></div>` : ''
                      }
                    </article>
                  `,
                )
                .join('')
            : ui`<div class="empty-state compact">暂无审批记录。</div>`
        }
      </div>
    </section>
  `;
}

function renderComposerCard({ inline = false } = {}) {
  const data = uiState.bootstrap;
  const composerChat = !uiState.neuralOverview ? activeChat() : null;
  const project = data.projects.find(p=>p.id===(composerChat ? composerChat.projectId : uiState.newChatProjectId));
  const workspace = data.workspace || {};
  const selectedFile = workspace.selectedFile;
  const voiceSupported = voiceInputSupported();
  const isHomeComposer = !inline;
  const voicePreviewMarkup = renderVoiceInput(uiState.voice, escapeHtml);
  const footerMarkup =
    isHomeComposer || selectedFile
      ? ui`
        <div class="composer-footer">
          <div class="composer-footer-copy">
            ${project ? `Project: ${escapeHtml(project.name)}` : 'Local-first Melo chat is ready.'}
          </div>
          ${
            selectedFile
              ? ui`<div class="composer-footer-copy is-secondary">Selected file: ${escapeHtml(selectedFile.path)}</div>`
              : ''
          }
        </div>
      `
      : '';

  return ui`
    <div class="composer-shell">
      <div class="composer-conversation-choice agent-chip-anchor">${renderAgentSelectorChip()}${uiState.agentSelectionSaving?ui`<span class="list-row-meta" role="status">正在切换Agent…</span>`:''}</div>
      ${renderExecutionPanel()}
      ${uiState.composerRetry?.interrupted && uiState.composerRetry.chatId === composerChat?.id ? ui`<div class="alert">上次请求已中断，可能已有部分操作完成。请先核对对话与执行记录。<button type="button" class="small-button" data-action="restart-interrupted-send">已核对，作为新请求重新执行</button></div>` : ''}
      ${
        !conversationConnectionReady(data.settings.config, composerChat ? composerChat.modelSelection : uiState.newChatModel)
          ? ui`
            <div class="alert">
              ${
                data.settings.config.authMode === 'codex'
                  ? 'OAuth is not configured yet. Open Model and start the Codex login flow.'
                  : data.settings.config.authMode === 'local'
                    ? 'Local model mode is not configured yet. Open Model and enter your local endpoint and model.'
                    : 'API mode is not configured yet. Open Model and add your API key.'
              }
            </div>
          `
          : ''
      }

      ${uiState.sending ? ui`<div class="thinking-banner">${escapeHtml(thinkingLabel())}</div>` : ''}

      <div class="composer-card ${inline ? 'is-thread' : ''}">
        <form data-form="composer" class="composer-form">
          <div class="composer-core">
            ${footerMarkup}
            <div class="composer-actions">
              <div class="composer-bottom-left">
                <button
                  class="composer-icon-button"
                  type="button"
                  data-action="toggle-composer-attachment-menu"
                  title="添加附件"
                >
                  <span class="toolbar-icon">${icon.plus}</span>
                </button>
                ${renderComposerAttachmentMenu()}
                <span class="composer-status-copy">${escapeHtml(composerHintText({ inline }))}</span>
              </div>

              <div class="composer-bottom-right">
                <details class="conversation-context"><summary>多 Agent 协作</summary><input class="input" id="chat-team-members" placeholder="成员 Agent ID，逗号分隔；空为默认成员"><select id="chat-team-template"><option value="research-build-review">调研 → 实施 → 复核</option><option value="parallel-research">并行调研</option><option value="review-loop">实施 / 复核循环</option></select><button type="button" class="small-button" data-action="run-chat-team" ${uiState.sending?'disabled':''}>执行输入框中的团队任务</button></details>
                ${renderConversationContext({chat:!uiState.neuralOverview?activeChat():null,projectId:uiState.newChatProjectId,artifactIds:uiState.newChatArtifactIds,projects:data.projects,artifacts:data.artifacts,disabled:uiState.sending},escapeHtml)}
                ${renderModelPicker({
                  config: data.settings.config,
                  selection:!uiState.neuralOverview && activeChat() ? activeChat().modelSelection : uiState.newChatModel,
                  models: modelOptionsForAuthMode(data.settings.config.authMode),
                  agent: conversationAgent(data, { overview: uiState.neuralOverview, newAgentId: uiState.activeChatAgentId, newProjectId: uiState.newChatProjectId }),
                  open: uiState.modelPickerOpen,
                  saving: uiState.modelPickerSaving,
                }, escapeHtml)}

                <div class="tts-voice-panel-anchor">
                  ${renderTtsVoicePanel()}
                  ${renderAtomicButton()}
                </div>

                <select class="voice-language" aria-label="语音识别语言" data-voice-language ${voiceInputActive(uiState.voice) || uiState.agentSelectionSaving ? 'disabled' : ''}>
                  ${[['zh-CN', t("中文")], ['en-US', 'English'], ['system', t("系统语言")]].map(([value, label]) => ui`<option value="${value}" ${(uiState.voiceLanguage || 'zh-CN') === value ? 'selected' : ''}>${label}</option>`).join('')}
                </select>
                <button
                  class="composer-icon-button ${uiState.voice.recording ? 'is-recording' : ''}"
                  type="button"
                  data-action="toggle-voice-input"
                  ${!uiState.sending && uiState.voice.status !== 'stopping' ? '' : 'disabled'}
                  aria-label="${escapeHtml(voiceInputLabel(uiState.voice))}"
                  aria-pressed="${voiceInputActive(uiState.voice)}"
                  title="${voiceSupported ? escapeHtml(voiceInputLabel(uiState.voice)) : '当前浏览器不支持语音识别，点击查看说明'}"
                >
                  <span class="toolbar-icon">${uiState.voice.recording ? icon.stop : icon.mic}</span>
                </button>

                ${
                  uiState.sending
                    ? ui`
                      <button class="composer-icon-button is-stop" type="button" data-action="stop-send" title="停止生成">
                        <span class="toolbar-icon">${icon.stop}</span>
                      </button>
                    `
                    : ui`
                      <button class="composer-icon-button is-primary" type="submit" title="发送消息" ${voiceInputActive(uiState.voice) || uiState.agentSelectionSaving ? 'disabled' : ''}>
                        <span class="toolbar-icon">${icon.send}</span>
                      </button>
                    `
                }
              </div>
            </div>

            ${voicePreviewMarkup}

            <div
              class="composer-input-frame ${uiState.voice.recording ? 'is-recording' : ''} ${
                uiState.composerDragActive ? 'is-drop-target' : ''
              }"
            >
              ${renderSlashPalette()}
              <textarea
                id="composer"
                class="composer-textarea"
                placeholder="${escapeHtml(inline ? t("回复…") : composerPlaceholder())}"
                aria-label="消息输入框"
              >${escapeHtml(uiState.composer)}</textarea>
            </div>

            ${renderImageTaskControls(uiState.composerAttachments)}
            ${renderAttachmentPreviewList(uiState.composerAttachments)}
            ${
              uiState.composerDragActive
                ? ui`
                  <div class="composer-drop-banner">
                    Drop image, audio, video, or PDF here. Media extraction runs best-effort before the model sees it.
                  </div>
                `
                : ''
            }
          </div>
        </form>
      </div>
    </div>
  `;
}

// Render a placeholder mount point for the viz block attached to an
// assistant message (if any). The real renderer is instantiated AFTER
// the DOM is swapped, in syncVizBlocks(). Keeping the scaffold in the
// static HTML means the viz block participates in the normal message
// layout flow (spacing, scroll anchoring, etc.).
function renderAssistantVizMount(message) {
  if (!message || message.role !== 'assistant') return '';
  const viz = message.viz;
  if (!viz || typeof viz !== 'object') return '';
  return renderVizMountHtml(message.id, viz);
}

// Collect viz specs from the currently active chat's assistant messages
// and mount them into the DOM. Called once per render() pass, after the
// innerHTML swap.
function syncVizBlocks() {
  const chat = activeChat();
  if (!chat || !Array.isArray(chat.messages)) return;
  const specsById = new Map();
  for (const message of chat.messages) {
    if (message.role !== 'assistant') continue;
    if (!message.viz || typeof message.viz !== 'object') continue;
    specsById.set(message.id, message.viz);
  }
  if (!specsById.size) return;
  mountVizBlocks(app, specsById);
}

function renderMessageActions(message) {
  if (message.role !== 'assistant') return '';
  const isSpeaking = uiState.ttsSpeakingMessageId === message.id;
  const isLoading = !isSpeaking && uiState.ttsSpeakingLoadingId === message.id;
  return ui`
    <div class="message-actions">
      <button
        class="message-action-btn ${isSpeaking ? 'is-speaking' : ''} ${isLoading ? 'is-tts-loading' : ''}"
        type="button"
        data-action="speak-message"
        data-message-id="${escapeHtml(message.id)}"
        title="${isSpeaking ? 'Stop speaking' : 'Read aloud'}"
        aria-label="${isSpeaking ? 'Stop speaking' : 'Read aloud'}"
      >
        <span class="toolbar-icon">${isSpeaking ? icon.speakOff : icon.speak}</span>
      </button>
    </div>
  `;
}

// G-1d slice 2 (2026-05-12): renders persisted tool execution metadata
// under assistant messages in chat history.  Extracted to
// `./messageToolResults.js` (same pattern as activeToolCallsStrip.js)
// so the pure-string renderer is testable without a DOM.
function renderMessageToolResults(message) {
  return _renderMessageToolResultsFromModule(message, escapeHtml);
}

function renderMessageList(chat) {
  return ui`
    <div class="message-list">
      ${chat.messages
        .map(selectedMessagePresentation)
        .map(
          message => ui`
            <article class="message ${message.role} ${
              uiState.highlightedMessageId === message.id ? 'is-highlighted' : ''
            }" data-message-id="${escapeHtml(message.id)}">
              <div class="message-role">
                ${message.role === 'assistant' ? `${renderAgentAvatar((uiState.bootstrap.customize?.agents || []).find(a=>a.id===message.metadata?.agent?.id) || {name:message.metadata?.agent?.name || 'Melo'}, escapeHtml, 24)} ${escapeHtml(message.metadata?.agent?.name || 'Melo')}` : `${renderAgentAvatar(uiState.bootstrap.profile, escapeHtml, 24)} ${escapeHtml(uiState.bootstrap.profile.name)}`}
              </div>
              ${renderMessageBlocks(message)}
              ${renderAssistantVizMount(message)}
              ${renderMessageToolResults(message)}
              ${renderMessageAttachments(message)}
              ${renderModelReceipt(message, escapeHtml)}
              ${renderSceneReplay(message)}
              ${renderMessageActions(message)}
            </article>
          `,
        )
        .join('')}
      ${renderStreamingAssistantMessage(chat)}
    </div>
  `;
}

function renderThreadArtifactStrip(artifacts) {
  if (!artifacts.length) {
    return '';
  }

  return ui`
    <section class="surface-card thread-artifact-strip">
      <div class="header-row">
        <div>
          <h2 class="pane-title">本对话成果</h2>
        </div>
        <button class="small-button" data-action="open-view" data-view="artifacts">
          Open shelf
        </button>
      </div>

      <div class="card-grid compact-grid">
        ${artifacts
          .slice(0, 3)
          .map(
            artifact => ui`
              <button
                class="artifact-card artifact-mini-card"
                data-action="open-artifact"
                data-artifact-id="${artifact.id}"
              >
                <div class="thread-meta">
                  <span class="chip is-accent">${escapeHtml(
                    artifact.language || artifact.kind,
                  )}</span>
                </div>
                <h3 class="card-title">${escapeHtml(artifact.title)}</h3>
                <p class="card-summary">${escapeHtml(truncate(artifact.content, 140))}</p>
              </button>
            `,
          )
          .join('')}
      </div>
    </section>
  `;
}

function renderAgentSelectorChip() {
  const agent = activeChatAgentProfile();
  if (!agent) return '';
  return ui`
    <button type="button" class="chip chip-btn ${uiState.agentSelectorOpen ? 'is-active' : ''}"
            data-action="toggle-agent-selector"
            aria-haspopup="dialog" aria-expanded="${uiState.agentSelectorOpen}" aria-controls="agent-selector-panel"
            title="选择对话Agent" aria-label="选择对话 Agent" ${uiState.sending || uiState.agentSelectionSaving ? 'disabled' : ''}>
      <span class="agent-selector-caption">Agent</span>${renderAgentAvatar(agent, escapeHtml, 22)} ${escapeHtml(agent.name)}
      <span style="margin-left:4px;opacity:.6;font-size:.75em">▾</span>
    </button>
  `;
}

function renderAgentSelectorDropdown() {
  if (!uiState.agentSelectorOpen) return '';
  const agents = allChatAgentProfiles();
  if (!agents.length) return '';
  return ui`
    <div id="agent-selector-panel" class="agent-selector-dropdown agent-selector-slide-up" popover="manual" role="dialog" aria-label="选择对话Agent">
      <header><strong>选择对话 Agent</strong><p>默认Agent和你创建的Agent都在这里。切换只影响后续回复。</p></header>
      ${agents.map(agent => ui`
        <button type="button" class="agent-selector-row ${activeChatAgentProfile()?.id === agent.id ? 'is-selected' : ''}" aria-pressed="${activeChatAgentProfile()?.id === agent.id}"
                data-action="select-chat-agent" ${uiState.agentSelectionSaving?'disabled':''}
                data-agent-id="${escapeHtml(agent.id)}">
          ${renderAgentAvatar(agent, escapeHtml, 28)}<span class="agent-selector-name">${escapeHtml(agent.name)}</span>

          ${agent.id === 'main' ? ui`<span class="agent-selector-tag">默认</span>` : agent.isCustom ? ui`<span class="agent-selector-tag">自定义</span>` : ''}
        </button>
      `).join('')}
    </div>
  `;
}

function renderRegularChatPage() {
  const chat = activeChat();
  const project = uiState.bootstrap.projects.find(p=>p.id===chat?.projectId);
  const chatAgent = conversationAgent(uiState.bootstrap, { newAgentId: uiState.activeChatAgentId, newProjectId: uiState.newChatProjectId });

  if (!chat) {
    return ui`<section class="page is-chat neural-chat-home"><div class="neural-chat-intro"><div class="neural-overview-kicker">A NEW CONNECTION</div><h1>此刻，你在想什么？</h1><p>与 Melo 一起，把想法延伸下去。</p></div>${renderComposerCard()}</section>`;
  }

  return ui`
    <section class="page is-chat">
      <div class="chat-thread">
        <div class="thread-header">
          <div>
            <h1 class="page-title compact">
              ${escapeHtml(chat.title)}
              <span class="thread-title-caret">${icon.chevronDown}</span>
            </h1>
            <div class="thread-meta">
              ${
                project ? ui`<span class="chip">${escapeHtml(project.name)}</span>` : ''
              }
            </div>
          </div>
          <div class="inline-actions">
            <button
              class="small-button is-outline"
              type="button"
              data-action="save-chat-as-skill"
              data-chat-id="${chat.id}"
              title="Draft a reusable skill from this conversation. You confirm before it saves."
            >
              Save as skill
            </button>
          </div>
        </div>

        <div class="thread-scroll-region">
          ${renderMessageList(chat)}
        </div>
        <div class="thread-footer">
          ${
            // "Jump to latest" floating button — appears only while the user has
            // scrolled away from the bottom. While AI is still streaming, the
            // existing updateThreadAutoFollow() keeps threadAutoFollow=false so
            // their reading position is preserved across each chunk; this
            // button lets them pull back to the newest output on demand (same
            // UX as claude.ai). Hidden when the user is already at the bottom
            // so it doesn't cover the reply.
            //
            // Wrapped with the composer in .thread-footer so the button can be
            // anchored directly above the composer card (bottom: 100% of the
            // footer) regardless of how tall the composer grows when the user
            // types multi-line, opens the slash palette, attaches files, etc.
            !uiState.threadAutoFollow && chat.messages.length
              ? ui`
                <button
                  class="thread-scroll-jump-button"
                  type="button"
                  data-action="scroll-thread-to-bottom"
                  title="Jump to latest"
                  aria-label="Jump to latest message"
                >
                  ${icon.chevronDown}
                </button>
              `
              : ''
          }
          ${renderComposerCard({ inline: true })}
        </div>
      </div>
    </section>
  `;
}

function renderWorkspaceExplorer() {
  const workspace = uiState.bootstrap.workspace;

  if (!connectorEnabled('local-files')) {
    return '<div class="empty-state compact">Local Files connector is disabled.</div>';
  }

  if (!workspace.exists) {
    return ui`
      <div class="empty-state compact">
        Workspace path is unavailable. Update the project workspace path to start browsing files.
      </div>
    `;
  }

  return ui`
    <div class="workspace-root mono">${escapeHtml(workspace.rootPath)}</div>
    <div class="file-tree">
      ${workspace.entries
        .map(entry => {
          const indent = 14 + entry.depth * 18;
          if (entry.type === 'directory') {
            return ui`
              <div class="tree-row is-directory" style="padding-left:${indent}px">
                <span class="tree-icon">${icon.folder}</span>
                <span>${escapeHtml(entry.name)}</span>
              </div>
            `;
          }

          return ui`
            <button
              class="tree-row is-file ${
                workspace.selectedFilePath === entry.path ? 'is-active' : ''
              }"
              style="padding-left:${indent}px"
              data-action="select-file"
              data-file-path="${escapeHtml(entry.path)}"
            >
              <span class="tree-icon">${icon.file}</span>
              <span>${escapeHtml(entry.name)}</span>
            </button>
          `;
        })
        .join('')}
    </div>
  `;
}

// Wrap each line of a file preview in a span carrying a 1-based
// `data-line-number` attribute so the post-render scroll hook can locate
// any specific hit line via CSS selector.  We use `<span>` rather than
// `<div>` so the `<pre>` layout keeps its normal line breaks — the spans
// only exist as named anchors.
function renderCodePreviewLines(content = '') {
  const text = String(content || '');
  if (!text) return '';
  const lines = text.split('\n');
  return lines
    .map(
      (line, index) =>
        ui`<span class="code-line" data-line-number="${index + 1}">${escapeHtml(
          line,
        )}</span>`,
    )
    .join('\n');
}

function renderSelectedFilePreview() {
  const workspace = uiState.bootstrap.workspace;
  const selectedFile = workspace.selectedFile;

  if (!connectorEnabled('local-files')) {
    return '<div class="empty-state compact">Enable Local Files to inject file context into code mode.</div>';
  }

  if (!selectedFile) {
    return '<div class="empty-state compact">Select a file to preview it here.</div>';
  }

  const isEditing =
    uiState.fileEditMode && uiState.fileDraftPath === selectedFile.path;

  return ui`
    <div class="selected-file-card">
      <div class="thread-meta selected-file-meta">
        <span class="chip is-accent">${escapeHtml(selectedFile.language)}</span>
        <span class="chip">${escapeHtml(selectedFile.name)}</span>
        ${
          selectedFile.truncated
            ? '<span class="chip">Truncated preview</span>'
            : ''
        }
        ${
          isEditing
            ? '<span class="chip">Editing</span>'
            : ''
        }
      </div>
      <div class="workspace-root">${escapeHtml(selectedFile.path)}</div>
      <div class="inline-actions">
        ${
          isEditing
            ? ui`
              <button class="small-button is-primary" type="submit" form="file-save-form">
                Queue save
              </button>
              <button class="small-button" data-action="cancel-edit-file">
                Discard
              </button>
            `
            : ui`
              <button class="small-button is-primary" data-action="start-edit-file">
                Edit file
              </button>
            `
        }
      </div>
      ${
        isEditing
          ? ui`
            <form id="file-save-form" data-form="file-save">
              <textarea class="textarea code-editor" id="selected-file-editor">${escapeHtml(
                uiState.fileDraftContent,
              )}</textarea>
            </form>
            ${renderPatchPreviewBlock(
              'Patch preview',
              selectedFile.path,
              selectedFile.content,
              uiState.fileDraftContent,
            )}
          `
          : ui`<pre class="code-preview" data-copyable-surface><code>${renderCodePreviewLines(
              selectedFile.content,
            )}</code></pre>`
      }
    </div>
  `;
}

function renderCommandRunner() {
  const workspace = uiState.bootstrap.workspace;

  if (!connectorEnabled('local-command')) {
    return '<div class="empty-state compact">Local Command is disabled.</div>';
  }

  return ui`
    <div class="command-stack">
      ${workspace.commandTemplates
        .map(
          template => ui`
            <form class="command-card" data-form="command-run" data-template-id="${template.id}">
              <div class="list-row-title">${escapeHtml(template.label)}</div>
              <div class="list-row-meta">${escapeHtml(template.description)}</div>
              ${
                template.requiresInput
                  ? ui`
                    <input
                      class="input slim"
                      name="query"
                      value="${escapeHtml(uiState.commandInputs[template.id] || '')}"
                      data-command-input="${template.id}"
                      placeholder="${escapeHtml(template.inputPlaceholder || '')}"
                    />
                  `
                  : ''
              }
              <button class="small-button is-primary" type="submit">Queue run</button>
            </form>
          `,
        )
        .join('')}
    </div>

    <div class="run-list">
      ${(workspace.commandRuns || []).length
        ? workspace.commandRuns
            .map(
              run => ui`
                <article class="run-card">
                  <div class="thread-meta">
                    <span class="chip ${run.success ? 'is-accent' : ''}">${escapeHtml(
                      run.label,
                    )}</span>
                    <span class="chip">${run.success ? 'Success' : 'Needs attention'}</span>
                    <span class="meta-label">${escapeHtml(run.executedLabel)}</span>
                  </div>
                  <div class="workspace-root mono">${escapeHtml(run.command)}</div>
                  <pre class="run-output" data-copyable-surface><code>${escapeHtml(truncate(run.output, 700))}</code></pre>
                </article>
              `,
            )
            .join('')
        : '<div class="empty-state compact">No command runs yet for this project.</div>'}
    </div>
  `;
}

function renderProjectArtifactShelf() {
  const artifacts = activeProjectArtifacts();

  if (!connectorEnabled('artifacts')) {
    return '<div class="empty-state compact">Artifacts are disabled for model context.</div>';
  }

  if (!artifacts.length) {
    return '<div class="empty-state compact">No project artifacts yet. Save one from Artifacts to reuse it here.</div>';
  }

  return ui`
    <div class="mini-list">
      ${artifacts
        .slice(0, 4)
        .map(
          artifact => ui`
            <button
              class="mini-list-item"
              data-action="open-artifact"
              data-artifact-id="${artifact.id}"
            >
              <div class="list-row-title">${escapeHtml(artifact.title)}</div>
              <div class="list-row-meta">${escapeHtml(
                truncate(artifact.content, 140),
              )}</div>
            </button>
          `,
        )
        .join('')}
    </div>
  `;
}

function renderCodePage() {
  const project = activeProject();
  const chat = activeChat();
  const workspace = uiState.bootstrap.workspace;

  return ui`
    <section class="page page-code">
      <div class="code-layout">
        <div class="code-main">
          <section class="surface-card code-thread-card">
            <div class="thread-header">
              <div>
                <h1 class="page-title compact">
                  ${escapeHtml(chat?.title || `${project?.name || 'Melo'} code workspace`)}
                </h1>
                <div class="thread-meta">
                  <span class="chip is-accent">CODE</span>
                  ${
                    project ? ui`<span class="chip">${escapeHtml(project.name)}</span>` : ''
                  }
                  <span class="chip">${workspace.fileCount || 0} files indexed</span>
                </div>
              </div>

              <div class="inline-actions">
                <button class="small-button" data-action="open-view" data-view="projects">
                  Project
                </button>
                <button class="small-button" data-action="open-view" data-view="customize">
                  Connectors
                </button>
              </div>
            </div>

            ${
              chat && chat.messages.length
                ? renderMessageList(chat)
                : ui`
                  <div class="code-empty">
                    <h2 class="card-title">Ready to work in code mode</h2>
                    <p class="card-summary">
                      Browse files, run safe local commands, and keep artifacts beside the conversation.
                    </p>
                    <div class="chip-row">
                      <span class="chip">${escapeHtml(
                        workspace.exists ? workspace.rootPath : 'Workspace unavailable',
                      )}</span>
                      <span class="chip">${workspace.commandTemplates.length} command templates</span>
                      <span class="chip">${activeProjectArtifacts().length} project artifacts</span>
                    </div>
                  </div>
                `
            }

            ${renderThreadArtifactStrip(uiState.bootstrap.activeChatArtifacts || [])}
            ${renderComposerCard({ inline: true })}
          </section>
        </div>

        <div class="code-sidebar">
          <section class="inspector-card">
            <div class="inspector-header">
              <div>
                <div class="eyebrow">Project context</div>
                <h2 class="pane-title">${escapeHtml(project?.name || 'No active project')}</h2>
              </div>
            </div>

            ${
              project
                ? ui`
                  <p class="inspector-copy">${escapeHtml(project.summary)}</p>
                  <div class="chip-row">
                    <span class="chip is-accent">${escapeHtml(project.tag)}</span>
                    <span class="chip">${project.chatCount} chats</span>
                    <span class="chip">${project.artifactCount} artifacts</span>
                  </div>
                  <div class="subsection">
                    <div class="meta-block-label">Instructions</div>
                    <div class="detail-copy">${escapeHtml(project.instructions)}</div>
                  </div>
                `
                : '<div class="empty-state compact">Choose a project to anchor this code session.</div>'
            }
          </section>

          <section class="inspector-card">
            <div class="inspector-header">
              <div>
                <div class="eyebrow">Workspace</div>
                <h2 class="pane-title">Files</h2>
              </div>
              <span class="chip">${workspace.fileCount || 0}</span>
            </div>
            ${renderWorkspaceExplorer()}
          </section>

          <section class="inspector-card">
            <div class="inspector-header">
              <div>
                <div class="eyebrow">Context</div>
                <h2 class="pane-title">Selected file</h2>
              </div>
            </div>
            ${renderSelectedFilePreview()}
          </section>

          <section class="inspector-card">
            <div class="inspector-header">
              <div>
                <div class="eyebrow">Diagnostics</div>
                <h2 class="pane-title">Command runner</h2>
              </div>
            </div>
            ${renderCommandRunner()}
          </section>

          ${renderTaskPanel({ compact: true })}

          ${renderApprovalPanel({ compact: true })}

          <section class="inspector-card">
            <div class="inspector-header">
              <div>
                <div class="eyebrow">Reusable outputs</div>
                <h2 class="pane-title">Project artifacts</h2>
              </div>
              <button class="small-button" data-action="open-view" data-view="artifacts">
                Manage
              </button>
            </div>
            ${renderProjectArtifactShelf()}
          </section>
        </div>
      </div>
    </section>
  `;
}

function renderChatsPage() {
  const chats = filteredChats();
  return ui`
    <section class="page">
      <div class="page-grid">
        <div class="header-row">
          <div>
            <h1 class="page-title compact">Chats</h1>
          </div>
        </div>

        <input
          class="search-input"
          id="chat-search"
          type="search"
          value="${escapeHtml(uiState.chatSearch)}"
          placeholder="Search chats..."
        />

        <div class="chat-list">
          ${
            chats.length
              ? chats
                  .map(
                    chat => ui`
                      <button class="chat-row" data-action="open-chat" data-chat-id="${chat.id}">
                        <div class="chat-row__body">
                          <h2 class="chat-row__title">${escapeHtml(chat.title)}</h2>
                          <p class="chat-row__preview">${escapeHtml(chat.preview)}</p>
                        </div>
                        <div class="chat-row__meta">
                          ${
                            chat.projectId
                              ? ui`<span class="chip is-muted">${escapeHtml(
                                  uiState.bootstrap.projects.find(
                                    project => project.id === chat.projectId,
                                  )?.name || 'Project',
                                )}</span>`
                              : ''
                          }
                          <span class="meta-label">${escapeHtml(chat.updatedLabel)}</span>
                          <span class="meta-label">${chat.messageCount} messages</span>
                        </div>
                      </button>
                    `,
                  )
                  .join('')
              : '<div class="empty-state">No chats match this search yet.</div>'
          }
        </div>
      </div>
    </section>
  `;
}

// Projects page is a two-mode view:
//
// - Overview: Claude-style grid of project cards (or a full empty state with
//   a single CTA when there are zero projects). Search + "New project"
//   sit in a tidy top bar.
// - Detail: opens when a card is clicked (selectedProjectId is set). Shows a
//   back button, an edit form, related chats, and artifacts.
//
// There's no split "list-on-left, detail-on-right" split anymore — clicking
// a card navigates into the detail, and a Back button returns to the grid.
function renderProjectsPage() {
  const project = activeProject();
  if (project) {
    return renderProjectsDetailView(project);
  }
  return renderProjectsOverview();
}

function renderProjectsOverview() {
  const projects = filteredProjects();
  const totalProjects = uiState.bootstrap?.projects?.length || 0;
  const searchActive = uiState.projectSearch.trim().length > 0;

  const createForm = uiState.showProjectForm ? renderProjectCreateForm() : '';

  // Zero projects + no active form → full empty state with a primary CTA.
  if (totalProjects === 0 && !uiState.showProjectForm) {
    return ui`
      <section class="page">
        <div class="page-grid">
          <div class="header-row">
            <div>
              <h1 class="page-title compact">项目</h1>
              <p class="page-kicker">把同一目标下的对话、资料与工作要求放在一起。</p>
            </div>
          </div>

          <div class="surface-card project-empty-hero">
            <div class="project-empty-hero__icon">${icon.folder}</div>
            <h2 class="project-empty-hero__title">还没有项目</h2>
            <p class="project-empty-hero__body">
              为一件持续进行的事创建项目，写下目标与要求，再把相关对话放进来。每次继续对话都会带上项目背景。
            </p>
            <button class="ghost-button is-primary" data-action="toggle-project-form">
              <span class="toolbar-icon">${icon.plus}</span>
              创建第一个项目
            </button>
          </div>
        </div>
      </section>
    `;
  }

  return ui`
    <section class="page">
      <div class="page-grid">
        <div class="header-row project-overview-header">
          <div>
            <h1 class="page-title compact">项目</h1>
            <p class="page-kicker">${totalProjects} 个项目</p>
          </div>

          <div class="inline-actions">
            <button class="ghost-button" data-action="toggle-archived-projects">${uiState.showArchivedProjects?'查看进行中的项目':'查看已归档项目'}</button>
            <button class="ghost-button is-primary" data-action="toggle-project-form">
              <span class="toolbar-icon">${icon.plus}</span>
              新建项目
            </button>
          </div>
        </div>

        ${createForm}

        <div class="surface-card project-search-card">
          <div class="search-row">
            <input
              class="search-input"
              id="project-search"
              type="search"
              value="${escapeHtml(uiState.projectSearch)}"
              placeholder="搜索项目…"
            />
          </div>
        </div>

        ${
          projects.length
            ? ui`
              <div class="project-grid">
                ${projects.map(renderProjectCard).join('')}
              </div>
            `
            : ui`
              <div class="surface-card empty-state compact">
                ${
                  searchActive
                    ? `没有匹配“${escapeHtml(uiState.projectSearch)}”的项目。`
                    : '还没有项目，先创建一个目标。'
                }
              </div>
            `
        }
      </div>
    </section>
  `;
}

function renderProjectCard(item) {
  // A single project card in the overview grid. Clicking anywhere on the
  // card opens the detail view. Action buttons (开启项目对话 / 处理项目代码)
  // stop propagation so they don't also trigger the card click.
  return ui`
    <button
      class="project-card"
      data-action="focus-project"
      data-project-id="${item.id}"
    >
      <div class="project-card__header">
        <span class="chip is-accent">${escapeHtml(item.tag)}</span>
        <span class="meta-label">${escapeHtml(item.updatedLabel)}</span>
      </div>
      <div class="project-card__title">${escapeHtml(item.name)}</div>
      <div class="project-card__summary">${escapeHtml(item.summary)}</div>
      <div class="project-card__footer">
        <span class="project-card__metric">
          <span class="toolbar-icon">${icon.bubble}</span>
          ${item.chatCount} 段对话
        </span>
        <span class="project-card__metric">
          <span class="toolbar-icon">${icon.box}</span>
          ${item.artifactCount} 份资料与成果
        </span>
      </div>
    </button>
  `;
}

function renderProjectCreateForm() {
  return ui`
    <form class="project-form-card surface-card" data-form="project-create">
      <div class="project-form-grid">
        <label class="label">
          项目名称
          <input class="input" name="name" value="${escapeHtml(
            uiState.draftProject.name,
          )}" placeholder="例如：旅行规划、产品开发" />
        </label>
        <label class="label">
          分类
          <input class="input" name="tag" value="${escapeHtml(
            uiState.draftProject.tag,
          )}" placeholder="例如：生活、工作" />
        </label>
      </div>

      <label class="label">
        项目文件夹
        <input class="input" name="workspacePath" value="${escapeHtml(
          uiState.draftProject.workspacePath,
        )}" placeholder="可选；留空将创建独立项目文件夹" />
      </label>

      <label class="label">
        项目目标
        <input class="input" name="summary" value="${escapeHtml(
          uiState.draftProject.summary,
        )}" placeholder="希望完成什么？" />
      </label>
      <label class="label">
        持续工作要求
        <textarea class="textarea" name="instructions" placeholder="这个项目里，Melo 应遵守哪些要求？">${escapeHtml(
          uiState.draftProject.instructions,
        )}</textarea>
      </label>
      <div class="inline-actions">
        <button class="small-button is-primary" type="submit">创建项目</button>
        <button class="small-button is-outline" type="button" data-action="toggle-project-form">
          取消
        </button>
      </div>
    </form>
  `;
}

function renderProjectsDetailView(project) {
  const relatedChats = activeProjectChats();
  const relatedArtifacts = activeProjectArtifacts();

  return ui`
    <section class="page">
      <div class="page-grid project-detail-layout">
        <div class="header-row project-detail-header">
          <div class="project-detail-heading">
            <button
              class="small-button is-outline project-back-button"
              type="button"
              data-action="clear-project-selection"
            >
              <span class="toolbar-icon">${icon.chevronLeft}</span>
              返回项目列表
            </button>
            <h1 class="page-title compact">${escapeHtml(project.name)}</h1>
            ${
              project.summary
                ? ui`<p class="page-kicker">${escapeHtml(project.summary)}</p>`
                : ''
            }
          </div>

          <div class="inline-actions">
            <button
              class="small-button"
              data-action="chat-from-project"
              data-project-id="${project.id}"
              ${project.archived?'disabled':''}
            >
              开启项目对话
            </button>
            <button
              class="small-button is-primary"
              data-action="code-from-project"
              data-project-id="${project.id}"
              ${project.archived?'disabled':''}
            >
              处理项目代码
            </button>
            <button class="small-button is-outline" data-action="archive-project" data-project-id="${project.id}" data-archived="${!project.archived}">${project.archived?t("恢复项目"):t("归档项目")}</button>
          </div>
        </div>

        <div class="chip-row">
          <span class="chip is-accent">${escapeHtml(project.tag)}</span>
          ${project.archived?ui`<span class="chip">已归档 · 对话与资料保留</span>`:''}
          <span class="chip">${project.chatCount ?? relatedChats.length} 段对话</span>
          <span class="chip">${project.artifactCount ?? relatedArtifacts.length} 份资料与成果</span>
          ${
            project.workspacePath
              ? ui`<span class="chip mono" title="${escapeHtml(project.workspacePath)}">${escapeHtml(project.workspacePath)}</span>`
              : '<span class="chip mono is-muted">No workspace set</span>'
          }
        </div>

        <div class="project-detail-grid">
          <section class="surface-card project-detail-panel">
            <h2 class="subsection-title">项目设置</h2>
            <form
              class="project-form-card"
              data-form="project-update"
              data-project-id="${project.id}"
            >
              <div class="project-form-grid">
                <label class="label">
                  项目名称
                  <input class="input" name="name" value="${escapeHtml(project.name)}" />
                </label>
                <label class="label">
                  分类
                  <input class="input" name="tag" value="${escapeHtml(project.tag)}" />
                </label>
              </div>
              <label class="label">
                项目文件夹
                <input
                  class="input"
                  name="workspacePath"
                  value="${escapeHtml(project.workspacePath)}"
                  placeholder="可选；留空将创建独立项目文件夹"
                />
              </label>
              ${project.workspaceNeedsConfirmation ? ui`<label class="label"><input type="checkbox" name="confirmWorkspace" />确认允许此项目使用 Melo 程序目录；也可以重新选择文件夹。</label>` : ''}
              <label class="label">
                项目目标
                <input
                  class="input"
                  name="summary"
                  value="${escapeHtml(project.summary)}"
                />
              </label>
              <label class="label">
                持续工作要求
                <textarea class="textarea" name="instructions">${escapeHtml(
                  project.instructions,
                )}</textarea>
              </label>
              <fieldset class="context-materials"><legend>项目共享资料</legend><p>这些资料用于项目内所有对话，与对话单独选用的资料去重后合计最多 8 份、24000 字。</p>
                ${(uiState.bootstrap.artifacts || []).filter(a=>a.content?.trim()).map(a=>ui`<label><input type="checkbox" name="knowledgeIds" value="${escapeHtml(a.id)}" ${(project.knowledgeIds || []).includes(a.id)?'checked':''}>${escapeHtml(a.title)}</label>`).join('') || ui`<p>先在知识分支保存资料。</p>`}
              </fieldset>
              <div class="inline-actions">
                <button class="small-button is-primary" type="submit">
                  <span class="toolbar-icon">${icon.save}</span>
                  保存项目
                </button>
              </div>
            </form>
          </section>

          <aside class="project-detail-aside">
            <section class="surface-card project-detail-panel">
              <div class="header-row">
                <h2 class="subsection-title">相关对话</h2>
                <span class="meta-label">${relatedChats.length} 段</span>
              </div>
              <div class="mini-list">
                ${
                  relatedChats.length
                    ? relatedChats
                        .slice(0, 6)
                        .map(
                          chat => ui`
                            <button
                              class="mini-list-item"
                              data-action="open-chat"
                              data-chat-id="${chat.id}"
                            >
                              <div class="list-row-title">${escapeHtml(chat.title)}</div>
                              <div class="list-row-meta">${escapeHtml(chat.preview)}</div>
                            </button>
                          `,
                        )
                        .join('')
                    : ui`<div class="empty-state compact">还没有相关对话，点击上方开启项目对话。</div>`
                }
              </div>
            </section>

            <section class="surface-card project-detail-panel">
              <div class="header-row">
                <h2 class="subsection-title">资料与成果</h2>
                <span class="meta-label">${relatedArtifacts.length} 份</span>
              </div>
              <div class="mini-list">
                ${
                  relatedArtifacts.length
                    ? relatedArtifacts
                        .slice(0, 6)
                        .map(
                          artifact => ui`
                            <button
                              class="mini-list-item"
                              data-action="open-artifact"
                              data-artifact-id="${artifact.id}"
                            >
                              <div class="list-row-title">${escapeHtml(artifact.title)}</div>
                              <div class="list-row-meta">${escapeHtml(
                                truncate(artifact.content, 150),
                              )}</div>
                            </button>
                          `,
                        )
                        .join('')
                    : ui`<div class="empty-state compact">还没有保存的资料或成果。</div>`
                }
              </div>
            </section>
          </aside>
        </div>
      </div>
    </section>
  `;
}

function renderAgentCapabilities(selected,draft) {
  const c=draft?.capabilities || selected.capabilities || selected.capabilityMigration?.proposed;
  if (!c) return '';
  const value=k=>draft?.['cap_'+k] ?? c[k];
  const checked=k=>value(k)===true||value(k)==='on';
  const collaboration=draft?.collaboration || selected.collaboration || {};
  const pending=selected.pendingCapabilityChange;
  const settingText=value=>typeof value==='boolean'?t(value?'开启':'关闭'):Array.isArray(value)?value.join(', '):String(value);
  const pendingChanges=pending ? [
    ...Object.entries(selected.capabilityLabels||{}).filter(([key])=>pending.requested.capabilities[key]&&!selected.capabilities?.[key]).map(([,label])=>label),
    ...[['mcpServers','MCP 服务'],['skills','技能'],['connectors','连接器']].flatMap(([key,label])=>pending.requested.capabilities[key].filter(id=>!selected.capabilities?.[key]?.includes(id)).map(id=>`${t(label)}: ${id}`)),
    ...[['canDelegate','允许委派'],['delegateTargets','委派对象'],['maxDelegationDepth','委派深度'],['maxIterations','成员轮数'],['maxTokens','成员 token 上限'],['timeoutMs','成员超时（毫秒）']].filter(([key])=>JSON.stringify(pending.baseline.current.collaboration[key])!==JSON.stringify(pending.requested.collaboration[key])).map(([key,label])=>`${t(label)}: ${settingText(pending.baseline.current.collaboration[key])} → ${settingText(pending.requested.collaboration[key])}`),
    ...[['projects','项目指引'],['knowledge','共享知识'],['memory','记忆']].filter(([key])=>pending.baseline.current.contextSources[key]!==pending.requested.contextSources[key]).map(([,label])=>`${t(label)}: ${t('开启')}`),
  ] : [];
  return ui`<details class="agent-settings-section agent-capabilities" data-agent-section="${selected.id}:capabilities" ${pending || uiState.agentOpenSections[`${selected.id}:capabilities`] ? 'open' : ''}><summary>能力范围与协作</summary><p>关闭的能力在工具执行时拒绝；MCP 服务可自行执行命令，请只授权可信服务。</p>
    ${selected.editingScope==='project'?`<p>${escapeHtml(t('项目能力与协作设置只能收紧全局设置；需要更多能力时，请先编辑此 Agent 的全局设置。'))}</p>`:''}
    ${pending?`<section role="status"><strong>${escapeHtml(t('同步权限变更待桌面确认'))}</strong><p>${escapeHtml(t('收紧部分已生效。以下新增能力及协作、上下文变更尚未生效：'))}</p><p>${escapeHtml(pendingChanges.join('、')||t('协作或上下文设置'))}</p><button type="button" class="small-button" data-action="confirm-agent-settings" data-id="${escapeHtml(pending.id)}" data-expected="${escapeHtml(pending.fingerprint)}" data-accept="true" ${!selected.capabilities?'disabled':''}>${escapeHtml(t('确认应用同步设置'))}</button><button type="button" class="small-button" data-action="confirm-agent-settings" data-id="${escapeHtml(pending.id)}" data-expected="${escapeHtml(pending.fingerprint)}" data-accept="false">${escapeHtml(t('拒绝放宽，保留当前权限'))}</button></section>`:''}
    <input type="hidden" name="capabilityVersion" value="1">
    ${!selected.capabilities?`<p>迁移预览：${escapeHtml(selected.capabilityMigration.note)}</p><p>将失去的工具：${escapeHtml([...selected.capabilityMigration.lostTools,...(selected.capabilityMigration.lostActions||[])].join(', ') || '无')}</p><input type="hidden" name="capabilityMigrationExpected" value="${escapeHtml(selected.capabilityMigration.fingerprint)}"><label><input type="checkbox" name="confirmCapabilityMigration" ${draft?.confirmCapabilityMigration==='on'?'checked':''}>确认应用这份能力配置；保存后生效</label>`:''}
    <div class="agent-capability-flags">${Object.entries(selected.capabilityLabels || {}).map(([key,label])=>`<label class="label"><input type="checkbox" name="cap_${key}" ${checked(key)?'checked':''}>${escapeHtml(t(label))}</label>`).join('')}</div>
    <div class="agent-settings-grid">${[['skills','技能白名单'],['mcpServers','MCP 服务白名单'],['connectors','连接器白名单']].map(([key,label])=>`<label class="label">${escapeHtml(t(label))}<input class="config-input" name="cap_${key}" value="${escapeHtml(Array.isArray(value(key))?value(key).join(','):value(key)||'')}" placeholder="${escapeHtml(t('ID，逗号分隔；空表示不允许'))}"></label>`).join('')}
    </div><p>可用技能：${escapeHtml((selected.capabilityOptions||[]).map(s=>s.id).join(', '))}</p>
    <div class="agent-settings-grid"><label class="checkbox-row"><input type="checkbox" name="canDelegate" ${(draft?.canDelegate !== undefined ? draft.canDelegate === 'on' : collaboration.canDelegate)?'checked':''}>允许委派</label>
    <label class="label">目标 Agent ID<input class="config-input" name="delegateTargets" value="${escapeHtml(draft?.delegateTargets ?? (collaboration.delegateTargets||[]).join(','))}"></label>
    ${[['maxDelegationDepth','委派深度',1,3],['maxIterations','成员轮数',8,20],['maxTokens','成员 token 上限',32000,200000],['timeoutMs','成员超时（毫秒）',180000,900000]].map(([key,label,fallback,max])=>`<label class="label">${escapeHtml(t(label))}<input class="config-input" type="number" min="1" max="${max}" name="${key}" value="${escapeHtml(String(draft?.[key]??collaboration[key]??fallback))}"></label>`).join('')}
    </div><p>上下文来源</p><div class="agent-capability-flags">${[['projects','项目指引'],['knowledge','共享知识'],['memory','记忆']].map(([key,label])=>`<label class="checkbox-row"><input type="checkbox" name="context_${key}" ${(draft?.['context_'+key]!==undefined?draft['context_'+key]==='on':selected.contextSources?.[key]!==false)?'checked':''}>${escapeHtml(t(label))}</label>`).join('')}
  </div></details>`;
}

function renderAgentPersonaFields(selected, draft) {
  return ui`
    ${uiState.bootstrap?.syncPendingPersonas?.some(row => row.kind === 'agent' && row.id === selected.id || row.kind === 'project' && row.id === activeProject()?.id && selectedAgentScope() === 'project') ? ui`<p role="status">此 Agent 的新版人设尚未同步。全文已保留在本机，其他聊天继续同步。</p>` : ''}
    <label class="label">Agent 名称<input class="config-input" name="name" value="${escapeHtml(draft?.name ?? selected.name ?? '')}" /></label>
    <label class="label">一句话定位<textarea class="textarea agent-control-editor" name="description" rows="2">${escapeHtml(draft?.description ?? selected.description ?? '')}</textarea></label>
    <label class="label">人设与工作要求<textarea class="textarea agent-content-editor" name="instructions" rows="7" placeholder="可分节填写身份、风格和补充要求。">${escapeHtml(draft?.instructions ?? selected.instructions ?? '')}</textarea></label>
    <div class="inline-actions agent-document-actions">
      <label class="small-button agent-file-button">导入 Markdown<input type="file" accept=".md,.txt,text/markdown,text/plain" data-agent-document="${escapeHtml(selected.id)}" /></label>
      <button class="small-button" type="button" data-action="export-agent-document" data-agent-id="${escapeHtml(selected.id)}">导出 Markdown</button>
      <span class="meta-label">导入后先预览，点击保存修改生效。</span>
    </div>`;
}

function renderAgentWorkbench(selected) {
  if (!selected) {
    return ui`<section class="surface-card"><div class="empty-state">新增 Agent，设置它的人设与能力。</div></section>`;
  }

  const project = activeProject();
  const scope = selectedAgentScope();
  const draft = agentDraftFor(selected);
  const formId = `agent-profile-form-${selected.id}`;
  const telegramChannel = draft?.channels?.telegram || selected.channels?.find?.(channel => channel.id === 'telegram') || selected.channels?.telegram || {};
  const discordChannel = draft?.channels?.discord || selected.channels?.find?.(channel => channel.id === 'discord') || selected.channels?.discord || {};
  const telegramSecretVisible = Boolean(
    uiState.agentSecretVisibility[agentSecretVisibilityKey(selected.id, 'telegram')],
  );
  const discordSecretVisible = Boolean(
    uiState.agentSecretVisibility[agentSecretVisibilityKey(selected.id, 'discord')],
  );
  // Keep both channel panels mounted so saving includes edits made on either tab.
  // Only the active panel is visible; all fields share the explicit save boundary.
  const VALID_CHANNEL_TABS = ['telegram', 'discord'];
  const activeChannelTab = VALID_CHANNEL_TABS.includes(uiState.agentChannelTab[selected.id])
    ? uiState.agentChannelTab[selected.id]
    : 'telegram';
  const channelTabDefs = [
    {
      id: 'telegram',
      label: 'Telegram',
      status: telegramChannel.statusLabel || telegramChannel.lastStatus || 'idle',
      connected: telegramChannel.lastStatus === 'connected',
      enabled: Boolean(telegramChannel.enabled),
    },
    {
      id: 'discord',
      label: 'Discord',
      status: discordChannel.statusLabel || discordChannel.lastStatus || 'idle',
      connected: discordChannel.lastStatus === 'connected',
      enabled: Boolean(discordChannel.enabled),
    },
  ];

  return ui`
    <section class="surface-card agent-workbench-card">
      <div class="agent-scope-row">
        <span class="meta-label">设置范围</span>
        <div class="chip-row">
          <button class="chip chip-button ${scope === 'global' ? 'is-accent' : ''}" type="button" data-action="switch-agent-scope" data-scope="global">全局默认</button>
          ${project ? ui`<button class="chip chip-button ${scope === 'project' ? 'is-accent' : ''}" type="button" data-action="switch-agent-scope" data-scope="project">${escapeHtml(project.name)}</button>` : ''}
        </div>
      </div>

      <form
        id="${formId}"
        class="config-form"
        data-form="agent-profile-update"
        data-agent-id="${selected.id}"
      >
        <section class="agent-settings-section agent-identity-section">
        <div class="agent-avatar-editor">${renderAgentAvatar({...selected,...draft}, escapeHtml, 40)}<label class="small-button agent-file-button">上传头像<input type="file" accept="image/png,image/jpeg,image/webp" data-agent-avatar="${escapeHtml(selected.id)}" aria-label="上传Agent头像"></label>${agentDraftFor(selected)?.avatarData?ui`<button type="button" class="small-button" data-action="clear-agent-avatar" data-agent-id="${escapeHtml(selected.id)}">恢复默认</button>`:''}<span>头像只保存在 Melo，预览后点击保存修改生效。</span></div>
        ${renderAgentPersonaFields(selected, draft)}

        <label class="label">
          模型覆盖
          <input
            class="config-input"
            type="text"
            name="model"
            value="${escapeHtml(draft?.model || '')}"
            placeholder="留空使用全局模型"
          />
        </label>

        </section>
        ${renderAgentCapabilities(selected, draft)}

        <details class="agent-settings-section agent-channels" data-agent-section="${selected.id}:channels" ${uiState.agentOpenSections[`${selected.id}:channels`] ? 'open' : ''}>
          <summary>消息渠道</summary>
          <p class="agent-section-note">连接 Telegram 或 Discord，使用已保存的配置测试连接。</p>
        <div class="agent-channel-tabs" role="tablist">
          ${channelTabDefs
            .map(
              tab => ui`
                <button
                  type="button"
                  role="tab"
                  class="agent-channel-tab ${activeChannelTab === tab.id ? 'is-active' : ''} ${tab.enabled ? 'is-enabled' : ''}"
                  data-action="switch-agent-channel-tab"
                  data-agent-id="${selected.id}"
                  data-channel-id="${tab.id}"
                  aria-selected="${activeChannelTab === tab.id ? 'true' : 'false'}"
                >
                  <span class="agent-channel-tab-label">${escapeHtml(tab.label)}</span>
                  <span class="agent-channel-tab-status ${tab.connected ? 'is-accent' : ''}">${escapeHtml(tab.status)}</span>
                </button>
              `,
            )
            .join('')}
        </div>

        <div class="agent-channel-panel">
          ${ui`
                <section class="selected-file-card agent-channel-card" ${activeChannelTab === 'telegram' ? '' : 'hidden'}>
                  <div class="agent-editor-header">
                    <div class="agent-editor-heading">
                      <div class="meta-block-label">Telegram</div>
                      <div class="list-row-meta">通过 Bot token 连接此 Agent。</div>
                    </div>
                    <span class="chip ${telegramChannel.lastStatus === 'connected' ? 'is-accent' : ''}">
                      ${escapeHtml(telegramChannel.statusLabel || telegramChannel.lastStatus || 'idle')}
                    </span>
                  </div>
                  <label class="checkbox-row">
                    <input type="checkbox" name="telegramEnabled" ${telegramChannel.enabled ? 'checked' : ''} />
                    <span>启用 Telegram</span>
                  </label>
                  <label class="checkbox-row">
                    <input type="checkbox" name="telegramVoiceReply" ${telegramChannel.voiceReply ? 'checked' : ''} />
                    <span>文字回复后发送语音</span>
                  </label>
                  <label class="label">
                    语音回复模式
                    <select class="config-select" name="voiceReplyMode">
                      <option value="summary" ${(draft?.voiceReplyMode || 'summary') === 'summary' ? 'selected' : ''}>简短口述摘要</option>
                      <option value="full" ${draft?.voiceReplyMode === 'full' ? 'selected' : ''}>朗读完整回复</option>
                      <option value="off" ${draft?.voiceReplyMode === 'off' ? 'selected' : ''}>不发送语音</option>
                    </select>
                  </label>
                  <label class="label">
                    Edge TTS 音色
                    <input class="config-input" name="edgeTtsVoice" value="${escapeHtml(
                      draft?.edgeTtsVoice || '',
                    )}" placeholder="自动选择音色" />
                  </label>
                  <label class="label">
                    语音风格要求
                    <textarea class="textarea" name="voicePersonality" rows="3" placeholder="可选：语气、常用表达或语言要求">${escapeHtml(
                      draft?.voicePersonality || '',
                    )}</textarea>
                  </label>
                  <label class="label">
                    Bot token
                    <div class="secure-input-row">
                      <input class="config-input" type="${telegramSecretVisible ? 'text' : 'password'}" name="telegramBotToken" value="${escapeHtml(
                        telegramChannel.botToken || '',
                      )}" placeholder="123456:telegram-bot-token" />
                      <button
                        class="icon-toggle-button"
                        type="button"
                        data-action="toggle-agent-secret"
                        data-agent-id="${selected.id}"
                        data-channel-id="telegram"
                        aria-label="${telegramSecretVisible ? t('隐藏 Bot token') : t('显示 Bot token')}"
                        title="${telegramSecretVisible ? t('隐藏 Bot token') : t('显示 Bot token')}"
                      >
                        ${telegramSecretVisible ? icon.eyeOff : icon.eye}
                      </button>
                    </div>
                  </label>
                  <label class="label">
                    默认聊天 ID（可选）
                    <input class="config-input" type="text" name="telegramChatId" value="${escapeHtml(
                      telegramChannel.chatId || '',
                    )}" placeholder="默认消息发送目标" />
                  </label>
                  ${
                    telegramChannel.lastError
                      ? ui`<div class="list-row-meta danger-copy">${escapeHtml(telegramChannel.lastError)}</div>`
                      : ''
                  }
                  ${renderChannelRuntimeCard(telegramChannel, { showRoute: true })}
                  <div class="inline-actions">
                    <button class="small-button" type="button" data-action="test-agent-channel" data-channel-id="telegram">
                      测试 Telegram
                    </button>
                  </div>
                </section>
          `}
          ${ui`
                <section class="selected-file-card agent-channel-card" ${activeChannelTab === 'discord' ? '' : 'hidden'}>
                  <div class="agent-editor-header">
                    <div class="agent-editor-heading">
                      <div class="meta-block-label">Discord</div>
                      <div class="list-row-meta">通过 Bot token 连接此 Agent。</div>
                    </div>
                    <span class="chip ${discordChannel.lastStatus === 'connected' ? 'is-accent' : ''}">
                      ${escapeHtml(discordChannel.statusLabel || discordChannel.lastStatus || 'idle')}
                    </span>
                  </div>
                  <label class="checkbox-row">
                    <input type="checkbox" name="discordEnabled" ${discordChannel.enabled ? 'checked' : ''} />
                    <span>启用 Discord</span>
                  </label>
                  <label class="checkbox-row">
                    <input type="checkbox" name="discordVoiceReply" ${discordChannel.voiceReply ? 'checked' : ''} />
                    <span>文字回复后发送语音</span>
                  </label>
                  <div class="list-row-meta" style="margin:0 0 8px 0;">
                    语音设置由 Telegram 和 Discord 共用，可在 Telegram 标签页修改。
                  </div>
                  <label class="label">
                    Bot token
                    <div class="secure-input-row">
                      <input class="config-input" type="${discordSecretVisible ? 'text' : 'password'}" name="discordBotToken" value="${escapeHtml(
                        discordChannel.botToken || '',
                      )}" placeholder="Discord bot token" />
                      <button
                        class="icon-toggle-button"
                        type="button"
                        data-action="toggle-agent-secret"
                        data-agent-id="${selected.id}"
                        data-channel-id="discord"
                        aria-label="${discordSecretVisible ? t('隐藏 Bot token') : t('显示 Bot token')}"
                        title="${discordSecretVisible ? t('隐藏 Bot token') : t('显示 Bot token')}"
                      >
                        ${discordSecretVisible ? icon.eyeOff : icon.eye}
                      </button>
                    </div>
                  </label>
                  <label class="label">
                    Discord 服务器 ID
                    <input class="config-input" type="text" name="discordGuildId" value="${escapeHtml(
                      discordChannel.guildId || '',
                    )}" placeholder="Discord guild id" />
                  </label>
                  <label class="label">
                    Discord 频道 ID
                    <input class="config-input" type="text" name="discordChannelId" value="${escapeHtml(
                      discordChannel.channelId || '',
                    )}" placeholder="Discord channel id" />
                  </label>
                  ${
                    discordChannel.lastError
                      ? ui`<div class="list-row-meta danger-copy">${escapeHtml(discordChannel.lastError)}</div>`
                      : ''
                  }
                  ${renderChannelRuntimeCard(discordChannel)}
                  <div class="inline-actions">
                    <button class="small-button" type="button" data-action="test-agent-channel" data-channel-id="discord">
                      测试 Discord
                    </button>
                  </div>
                </section>
          `}

        </div>

        </details>
        <div class="inline-actions">
          ${
            scope === 'project' && selected.hasProjectOverride
              ? ui`
                <button
                  class="small-button"
                  type="button"
                  data-action="reset-project-agent-override"
                  data-agent-id="${selected.id}"
                >
                  恢复全局设置
                </button>
              `
              : ''
          }
        </div>
      </form>
    </section>
  `;
}

function renderAgentPage() {
  const selected = selectedAgentProfile();
  return ui`
    <section class="page agent-page">
      <div class="page-grid agent-page-grid">
        <div class="header-row agent-page-header">
          <h1 class="page-title compact">Agent</h1>
          <div class="inline-actions">
            <select class="config-select agent-select" data-action="select-agent-profile" aria-label="选择 Agent">
              ${(uiState.bootstrap?.customize?.agents || []).map(agent => ui`<option value="${agent.id}" ${selected?.id === agent.id ? 'selected' : ''}>${escapeHtml(agent.name)}</option>`).join('')}
            </select>
            <button class="small-button agent-create-button" type="button" data-action="create-custom-agent" ${uiState.agentCreating ? 'disabled' : ''}>${uiState.agentCreating ? t('正在创建…') : t('新增 Agent')}</button>
          </div>
        </div>
        <div class="agent-detail-column">${renderAgentWorkbench(selected)}</div>
      </div>
    </section>
  `;
}

function renderModelPage() {
  const config = uiState.bootstrap.settings.config;
  const draft = effectiveModelSetupDraft();
  return ui`
    <section class="page page-model">
      <div class="model-page-titlebar">
        <h1 class="page-title compact">模型与连接</h1>
      </div>
      <div class="model-connection-summary">
        <div><small>GLOBAL DEFAULT</small><strong>${escapeHtml(modelLabel(config.model))}</strong><span>${escapeHtml(config.model)} · ${escapeHtml(config.authMode === 'codex' ? 'Codex OAuth' : config.authMode === 'local' ? '本地连接' : 'API')}</span></div>
        <p>默认连接用于回答；开启额外快速后，短判断可自动分配给其他已配置模型。Agent指令保持不变。每条回复的“模型记录”显示服务端实际返回的标识。</p>
      </div>
      ${renderDefaultModelSettings(config, escapeHtml)}
      ${renderLlmConnections(config)}
      ${renderExtraFast(config)}
      ${renderImageSettings(config)}
      <details class="model-prompt-settings"><summary>全局系统提示词</summary>
        <section class="surface-card">
          <p>应用于模型请求的基础指令。保存这里不会更换模型连接。</p>
          <form id="model-config-form" class="config-form" data-form="model-config">
            <label class="label">系统提示词
              <textarea class="config-textarea" name="systemPrompt">${escapeHtml(draft.systemPrompt || '')}</textarea>
            </label>
          </form>
        </section>
      </details>
    </section>
  `;
}

function renderConnectorDetails(selected) {
  if (!selected) {
    return '<div class="empty-state">Select a skill, agent, or connector to inspect it.</div>';
  }

  if (uiState.bootstrap.settings.selectedCustomizeSection === 'agents') {
    return renderAgentWorkbench(selected);
  }

  if (uiState.bootstrap.settings.selectedCustomizeSection === 'skills') {
    const isCustomSkill = selected.source === 'custom';
    const isExecutable = selected.type === 'executable';
    const allowedAgentIds = Array.isArray(selected.allowedAgentIds) ? selected.allowedAgentIds : null;
    const isGlobalSkill = !allowedAgentIds || allowedAgentIds.length === 0;
    const toolWhitelist = Array.isArray(selected.toolWhitelist) ? selected.toolWhitelist : null;
    // Phase 3 — Overview | Markdown tabs.
    const activeTab = uiState.skillDetailTab || 'overview';
    if (activeTab === 'markdown') {
      return renderSkillMarkdownTab(selected);
    }
    return ui`
      <div class="detail-card">
        <div class="header-row">
          <div>
            <h2 class="pane-title">${escapeHtml(selected.name)}</h2>
            <p class="page-kicker">${escapeHtml(selected.description)}</p>
          </div>
          <div class="chip-row">
            <span class="chip ${isCustomSkill ? 'is-accent' : ''}">${escapeHtml(selected.sourceLabel || 'Built-in skill')}</span>
            <span class="chip ${isExecutable ? 'is-accent' : ''}">${isExecutable ? 'Executable' : 'Prompt'}</span>
            <span class="chip">${isGlobalSkill ? 'Global' : `Scoped to ${allowedAgentIds.length} agent(s)`}</span>
            ${selected._suspicious ? '<span class="chip is-danger">⚠ suspicious</span>' : ''}
          </div>
        </div>

        ${renderSkillDetailTabs(selected, activeTab)}

        <div class="meta-grid">
          <div>
            <div class="meta-block-label">Added by</div>
            <div>${escapeHtml(selected.addedBy)}</div>
          </div>
          <div>
            <div class="meta-block-label">Invoked by</div>
            <div>${escapeHtml(selected.invokedBy)}</div>
          </div>
          <div>
            <div class="meta-block-label">Max iterations</div>
            <div>${Number(selected.maxIterations || 6)}</div>
          </div>
          <div>
            <div class="meta-block-label">Tool whitelist</div>
            <div>${toolWhitelist ? escapeHtml(toolWhitelist.join(', ')) : '(all tools)'}</div>
          </div>
        </div>

        <div class="detail-meta">
          <div>${escapeHtml(selected.systemPrompt)}</div>
          <div class="chip-row">
            ${(selected.folders || [])
              .map(folder => ui`<span class="chip">${escapeHtml(folder)}</span>`)
              .join('')}
          </div>
          ${
            !isGlobalSkill
              ? ui`<div class="chip-row">
                   <span class="meta-label">Only visible to:</span>
                   ${allowedAgentIds
                     .map(aid => ui`<span class="chip">${escapeHtml(aid)}</span>`)
                     .join('')}
                 </div>`
              : ''
          }
        </div>

        <div class="toggle-row">
          <div>
            <div class="list-row-title">Enabled</div>
            <div class="list-row-meta">Make this skill discoverable to agents that have skills turned on.</div>
          </div>
          <button
            class="toggle-switch ${selected.enabled ? 'is-on' : ''}"
            data-action="toggle-skill"
            data-skill-id="${selected.id}"
          ></button>
        </div>

        ${isCustomSkill ? ui`
          <form id="skill-custom-update-form-${selected.id}" class="config-form" data-form="skill-custom-update" data-skill-id="${selected.id}">
            <div class="detail-meta">
              <div class="meta-block-label">Edit custom skill</div>
            </div>
            <label class="label">
              Name
              <input class="input" name="name" value="${escapeHtml(selected.name)}" required />
            </label>
            <label class="label">
              Description
              <input class="input" name="description" value="${escapeHtml(selected.description || '')}" />
            </label>
            <label class="label">
              Added by
              <input class="input" name="addedBy" value="${escapeHtml(selected.addedBy || '')}" />
            </label>
            <label class="label">
              Invoked by
              <input class="input" name="invokedBy" value="${escapeHtml(selected.invokedBy || '')}" />
            </label>
            <label class="label">
              System prompt
              <textarea class="config-textarea" name="systemPrompt">${escapeHtml(selected.systemPrompt || '')}</textarea>
            </label>
            <label class="label">
              Type
              <select class="input" name="type">
                <option value="executable" ${selected.type === 'executable' ? 'selected' : ''}>Executable — callable as a tool via the loop</option>
                <option value="prompt" ${selected.type === 'prompt' ? 'selected' : ''}>Prompt — injected verbatim into the system prompt</option>
              </select>
            </label>
            <label class="label">
              Max iterations (executable only)
              <input class="input" type="number" name="maxIterations" min="1" max="16" value="${Number(selected.maxIterations || 6)}" />
            </label>
            <label class="label">
              Allowed agents (comma-separated IDs — leave empty for all)
              <input class="input mono" name="allowedAgentIds" value="${escapeHtml((selected.allowedAgentIds || []).join(', '))}" />
            </label>
            <label class="label">
              Tool whitelist (comma-separated tool IDs — leave empty for all)
              <input class="input mono" name="toolWhitelist" value="${escapeHtml((selected.toolWhitelist || []).join(', '))}" />
            </label>
            <label class="label">
              Folders (comma-separated)
              <input class="input" name="folders" value="${escapeHtml((selected.folders || []).join(', '))}" />
            </label>
            <div class="inline-actions">
              <button class="small-button is-primary" type="submit">Save changes</button>
              <button
                class="small-button is-danger"
                type="button"
                data-action="remove-custom-skill"
                data-skill-id="${selected.id}"
              >Remove skill</button>
            </div>
          </form>
        ` : ''}
      </div>
    `;
  }

  const workspace = uiState.bootstrap.workspace;
  let extra = '';

  if (selected.type === 'external-mcp') {
    // External-MCP connectors are now managed from Customize → Advanced.
    // The list filter on Customize → Connectors hides them, but a stale
    // selectedConnectorId can still point here — render a redirect notice
    // instead of the legacy edit form (Codex audit / config edits deferred).
    return ui`
      <div class="detail-card">
        <div class="header-row">
          <div>
            <h2 class="pane-title">${escapeHtml(selected.name)}</h2>
            <p class="page-kicker">External MCP connectors moved to Customize → Advanced.</p>
          </div>
          <span class="chip is-accent">Experimental</span>
        </div>
        <div class="detail-meta">
          <div>Status, reload, and disconnect are available there. Configuration editing is deferred until the dedicated MCP UI lands.</div>
        </div>
      </div>
    `;
  }

  if (selected.id === 'openai-compatible') {
    // Read editable values from the shared draft so that any background
    // render (mcpAuthSurface poll, undo-toast tick, autosave response)
    // doesn't blow away in-flight typing. Read-only fields (codexAuth,
    // masked* / has* status flags) keep coming from selected.config.
    const draft = effectiveModelSetupDraft();
    // Visible save-status chip for masked credential inputs
    // (Codex audit 2026-04-29 — user reported "保存不了" when in
    // fact every save was succeeding; the password mask hid the
    // confirmation).  The pure state machine lives in
    // `desktop-ui/credentialChip.js` so it's covered by node:test;
    // we only translate the state here into the visible chip
    // markup. The "saved" state is reached when autosave clears
    // the secret from `modelSetupDraft` (handled in
    // `scheduleConnectorAutosave` post-fetch) — without that
    // clear the chip would stay stuck on "pending" forever.
    const credentialChip = fieldName => {
      const { state, masked } = credentialChipState(
        fieldName,
        uiState.modelSetupDraft,
        selected.config,
      );
      if (state === 'pending') {
        return ui`<span class="chip is-warning is-tiny">● 待保存（点击保存后生效）</span>`;
      }
      if (state === 'saved') {
        return ui`<span class="chip is-success is-tiny">✓ 已保存 · ${escapeHtml(masked)}</span>`;
      }
      return ui`<span class="chip is-tiny">● 未配置</span>`;
    };
    extra = ui`
      <p>模型地址、密钥和登录授权在模型连接中统一管理。</p>
      <button type="button" class="small-button" data-action="open-view" data-view="model">打开模型连接</button>
      <form id="connector-config-form" class="config-form" data-form="connector-config">
        <div class="detail-meta">
          <div class="meta-block-label">Whisper transcription</div>
          <div>
            Used for audio and voice-message transcription.<br>
            <b>API key mode</b>: automatically uses your main API key — no extra config needed.<br>
            <b>Local mode</b>: automatically uses your local Ollama endpoint — no auth needed.<br>
            <b>Codex OAuth mode</b>: automatically tries local Ollama (<code>http://127.0.0.1:11434/v1</code>). Run <code>ollama serve</code> to enable, or set a dedicated Whisper key below.<br>
            The fields below override automatic selection for any mode.
          </div>
        </div>
        <label class="label">
          <span class="label-row">Whisper API key (optional override) ${credentialChip('whisperApiKey')}</span>
          <input
            class="input"
            name="whisperApiKey"
            type="password"
            value=""
            placeholder="${escapeHtml(selected.config.maskedWhisperApiKey || 'Leave blank to use auto-detected key')}"
          />
        </label>
        <div class="list-row-meta">
          ${selected.config.hasWhisperKey ? `Override key saved: ${escapeHtml(selected.config.maskedWhisperApiKey)}` : 'No override key — using automatic detection per auth mode.'}
          Leave blank to keep the current setting.
        </div>
        <label class="label">
          Whisper base URL (optional override)
          <input
            class="input"
            name="whisperBaseUrl"
            value="${escapeHtml(draft.whisperBaseUrl || '')}"
            placeholder="Leave blank to use auto-detected endpoint"
          />
        </label>

        <div class="detail-meta">
          <div class="meta-block-label">MiniMax T2A V2 (cloned voice TTS)</div>
          <div>
            Powers the "自定义语音" option in the voice panel.
            Sign up at <code>minimaxi.com</code>, create or clone a voice,
            then paste the credentials below. Use the test button to verify
            without leaving this page.
          </div>
        </div>
        <label class="label">
          <span class="label-row">MiniMax API key ${credentialChip('minimaxApiKey')}</span>
          <input
            class="input"
            name="minimaxApiKey"
            type="password"
            value=""
            placeholder="${escapeHtml(selected.config.maskedMinimaxApiKey || 'Leave blank to keep current')}"
          />
        </label>
        <div class="list-row-meta">
          ${selected.config.hasMinimaxKey ? `Saved key: ${escapeHtml(selected.config.maskedMinimaxApiKey)}` : 'No MiniMax key — TTS will fall back to OpenAI / Edge.'}
          Leave blank to preserve the current value.
        </div>
        <label class="label">
          MiniMax Group ID
          <input
            class="input"
            name="minimaxGroupId"
            value="${escapeHtml(draft.minimaxGroupId || '')}"
            placeholder="From the MiniMax dashboard"
          />
        </label>
        <label class="label">
          Default Voice ID
          <input
            class="input"
            name="minimaxVoiceId"
            value="${escapeHtml(draft.minimaxVoiceId || '')}"
            placeholder="moss_audio_… or any cloned voice id"
          />
        </label>
        <div class="chip-row">
          <button
            class="small-button is-outline"
            type="button"
            data-action="test-minimax-tts"
          >
            Test playback
          </button>
          <span class="meta-label" data-tts-test-status></span>
        </div>

        <button class="small-button is-primary" type="submit">
          Save connector settings
        </button>
      </form>
    `;
  } else if (selected.id === 'local-files') {
    extra = ui`
      <div class="detail-meta">
        <div class="meta-block-label">Workspace root</div>
        <div class="mono">${escapeHtml(selected.config.workspaceRoot || '(none)')}</div>
      </div>
      <div class="chip-row">
        <span class="chip is-accent">${selected.config.fileCount || 0} files</span>
        <span class="chip">${selected.config.exists ? 'Available' : 'Unavailable'}</span>
        ${
          selected.config.selectedFilePath
            ? ui`<span class="chip">${escapeHtml(selected.config.selectedFilePath)}</span>`
            : ''
        }
      </div>
      ${workspace.selectedFile ? renderSelectedFilePreview() : ''}
    `;
  } else if (selected.id === 'local-command') {
    extra = ui`
      <div class="chip-row">
        ${(workspace.commandTemplates || [])
          .map(
            template => ui`
              <span class="chip">${escapeHtml(template.label)}</span>
            `,
          )
          .join('')}
      </div>
      ${(workspace.commandRuns || []).length ? renderCommandRunner() : '<div class="empty-state compact">No command runs yet.</div>'}
    `;
  } else if (selected.id === 'artifacts') {
    extra = ui`
      <div class="chip-row">
        <span class="chip is-accent">${selected.config.totalArtifacts} total</span>
        <span class="chip">${selected.config.projectArtifacts} in active project</span>
      </div>
      ${renderProjectArtifactShelf()}
    `;
  } else if (selected.id === 'projects') {
    extra = ui`
      <div class="chip-row">
        <span class="chip is-accent">${escapeHtml(
          selected.config.activeProject || '(none)',
        )}</span>
        <span class="chip mono">${escapeHtml(selected.config.workspacePath || '')}</span>
      </div>
    `;
  }

  return ui`
    <div class="detail-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">${escapeHtml(selected.name)}</h2>
          <p class="page-kicker">${escapeHtml(selected.description)}</p>
        </div>
      </div>

      <div class="detail-meta">
        <div>${escapeHtml(selected.details)}</div>
      </div>

      <div class="toggle-row">
        <div>
          <div class="list-row-title">Enabled</div>
          <div class="list-row-meta">Expose this connector in Melo Desktop and prompt context.</div>
        </div>
        <button
          class="toggle-switch ${selected.enabled ? 'is-on' : ''}"
          data-action="toggle-connector"
          data-connector-id="${selected.id}"
        ></button>
      </div>

      ${extra}
    </div>
  `;
}

// Phase 3.3.2 — filter bar shown above the Customize → Skills list. Three
// controls: free-text search input, a horizontally scrollable row of tag
// chips (with an "All tags" reset chip), and a select for state.
function renderSkillFilterBar() {
  const { query, tag, state } = uiState.skillFilter;
  const tags = allSkillTags();
  const totalCount = (uiState.bootstrap?.customize?.skills || []).length;
  const filteredCount = filteredSkills().length;
  const isFiltering = Boolean(query || tag || state !== 'all');

  return ui`
    <div class="skill-filter-bar">
      <div class="skill-filter-row">
        <input
          class="input skill-filter-query"
          type="search"
          placeholder="Search skills by name, tag, or trigger…"
          value="${escapeHtml(query)}"
          data-action="set-skill-filter-query"
        />
        <select class="input skill-filter-state" data-action="set-skill-filter-state">
          <option value="all"      ${state === 'all' ? 'selected' : ''}>All</option>
          <option value="enabled"  ${state === 'enabled' ? 'selected' : ''}>Enabled</option>
          <option value="disabled" ${state === 'disabled' ? 'selected' : ''}>Disabled</option>
          <option value="builtin"  ${state === 'builtin' ? 'selected' : ''}>Built-in</option>
          <option value="custom"   ${state === 'custom' ? 'selected' : ''}>Custom</option>
          <option value="disk"     ${state === 'disk' ? 'selected' : ''}>On disk</option>
        </select>
      </div>
      ${tags.length
        ? ui`
          <div class="skill-filter-tags">
            <button
              type="button"
              class="chip chip-button ${!tag ? 'is-accent' : ''}"
              data-action="set-skill-filter-tag"
              data-tag=""
            >All tags</button>
            ${tags
              .map(
                t => ui`
                  <button
                    type="button"
                    class="chip chip-button ${tag === t ? 'is-accent' : ''}"
                    data-action="set-skill-filter-tag"
                    data-tag="${escapeHtml(t)}"
                  >${escapeHtml(t)}</button>
                `,
              )
              .join('')}
          </div>
        `
        : ''}
      <div class="skill-filter-status">
        ${isFiltering
          ? ui`Showing ${filteredCount} of ${totalCount} skills · <button type="button" class="link-button" data-action="reset-skill-filter">reset</button>`
          : `${totalCount} skills`}
      </div>
    </div>
  `;
}

function renderCustomSkillCreateCard() {
  return ui`
    <div class="detail-card create-connector-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">Add custom skill</h2>
        </div>
      </div>

      <form id="skill-custom-create-form" class="config-form" data-form="skill-custom-create">
        <label class="label">
          ID
          <input class="input mono" name="id" placeholder="my-skill" required />
        </label>
        <label class="label">
          Name
          <input class="input" name="name" placeholder="My Skill" required />
        </label>
        <label class="label">
          Description
          <input class="input" name="description" placeholder="What this skill does." />
        </label>
        <label class="label">
          Added by
          <input class="input" name="addedBy" placeholder="User" value="User" />
        </label>
        <label class="label">
          Invoked by
          <input class="input" name="invokedBy" placeholder="User or Melo" value="User or Melo" />
        </label>
        <label class="label">
          System prompt
          <textarea class="config-textarea" name="systemPrompt" placeholder="Instructions injected into the agent system prompt when this skill is active."></textarea>
        </label>
        <label class="label">
          Type
          <select class="input" name="type">
            <option value="executable" selected>Executable — callable as a tool via the loop</option>
            <option value="prompt">Prompt — injected verbatim into the system prompt</option>
          </select>
        </label>
        <label class="label">
          Max iterations (executable only)
          <input class="input" type="number" name="maxIterations" min="1" max="16" value="6" />
        </label>
        <label class="label">
          Allowed agents (comma-separated IDs — leave empty for all)
          <input class="input mono" name="allowedAgentIds" placeholder="main, planner" />
        </label>
        <label class="label">
          Tool whitelist (comma-separated tool IDs — leave empty for all)
          <input class="input mono" name="toolWhitelist" placeholder="web_search, read_file" />
        </label>
        <label class="label">
          Folders (comma-separated)
          <input class="input" name="folders" placeholder="plans, references" />
        </label>
        <div class="inline-actions">
          <button class="small-button is-primary" type="submit">Create skill</button>
        </div>
      </form>
    </div>
  `;
}

// Render the "skill proposals" panel on top of the skills list — a thin UI
// surface for the Phase 3D background clusterer. Each proposal is one click
// to either dismiss or promote into the /save-as-skill flow.
/**
 * Phase 3.3.4 — Skill health panel. Summarises per-skill run counts,
 * success rate, P50 duration, and the most recent errors. Fetched
 * lazily on first render; a refresh button re-queries.
 */
async function refreshSkillRunStats() {
  if (uiState.skillRunStats.loading) return;
  uiState.skillRunStats.loading = true;
  uiState.skillRunStats.error = null;
  bgRender();
  try {
    const response = await api('/api/skills/runs/stats');
    uiState.skillRunStats.skills = Array.isArray(response?.skills) ? response.skills : [];
    uiState.skillRunStats.loaded = true;
  } catch (err) {
    uiState.skillRunStats.error = err?.message || 'Failed to load skill runs';
  } finally {
    uiState.skillRunStats.loading = false;
    bgRender();
  }
}

function formatSuccessRate(row) {
  if (!row || typeof row.successRate !== 'number') return '—';
  return `${Math.round(row.successRate * 100)}%`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function formatLastRunAt(epochMs) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '—';
  const secondsAgo = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (secondsAgo < 60) return `${secondsAgo}s ago`;
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)}m ago`;
  if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)}h ago`;
  return `${Math.floor(secondsAgo / 86400)}d ago`;
}

// ───────────────────────────────────────────────────────────────────────
// Phase 3 — Memory panel
// ───────────────────────────────────────────────────────────────────────

async function refreshAdvancedStatus() {
  if (uiState.advanced.loading) return;
  uiState.advanced.loading = true;
  uiState.advanced.error = null;
  bgRender();
  try {
    // Fan out — three independent endpoints, none of which block the
    // others, so a slow one doesn't gate the rest.
    const [serversResp, pluginsResp, tasksResp, diagnosticsResp] = await Promise.all([
      api('/api/mcp/servers').catch(err => ({ _error: err?.message || 'mcp/servers failed' })),
      api('/api/plugins').catch(err => ({ _error: err?.message || 'plugins failed' })),
      api('/api/background-tasks/list').catch(err => ({ _error: err?.message || 'background-tasks/list failed' })),
      api('/api/diagnostics?storage=1').catch(err => ({ _error: err?.message || 'diagnostics failed' })),
    ]);
    const errors = [serversResp, pluginsResp, tasksResp, diagnosticsResp]
      .filter(r => r && r._error)
      .map(r => r._error);
    if (errors.length === 4) {
      uiState.advanced.error = errors.join(' · ');
    } else {
      uiState.advanced.cliServers = Array.isArray(serversResp?.servers) ? serversResp.servers : [];
      uiState.advanced.plugins = Array.isArray(pluginsResp?.plugins) ? pluginsResp.plugins : [];
      uiState.advanced.tasks = Array.isArray(tasksResp?.runs) ? tasksResp.runs : [];
      uiState.advanced.diagnostics = diagnosticsResp?._error ? null : diagnosticsResp;
      uiState.advanced.loaded = true;
      // Surface partial errors without blanking the panel.
      if (errors.length > 0) {
        uiState.advanced.error = `Partial load: ${errors.join(' · ')}`;
      }
    }
  } catch (err) {
    uiState.advanced.error = err?.message || 'Failed to load advanced status';
  } finally {
    uiState.advanced.loading = false;
    render();
  }
}

async function handleReloadMcpServers() {
  try {
    const resp = await api('/api/mcp/reload', { method: 'POST' });
    uiState.advanced.cliServers = Array.isArray(resp?.servers) ? resp.servers : [];
    showError(`Reloaded ${uiState.advanced.cliServers.length} MCP server(s).`);
    render();
  } catch (err) {
    showError(`MCP reload failed: ${err?.message || err}`);
  }
}

async function handleDisconnectMcpServer(name) {
  if (!name) return;
  try {
    await api('/api/mcp/disconnect', { method: 'POST', body: { name } });
    // Refresh the list so the UI reflects the new state.
    await refreshAdvancedStatus();
  } catch (err) {
    showError(`Disconnect failed: ${err?.message || err}`);
  }
}

async function handleKillBackgroundTask(runId) {
  if (!runId) return;
  try {
    await api('/api/background-tasks/kill', { method: 'POST', body: { runId } });
    await refreshAdvancedStatus();
  } catch (err) {
    showError(`Kill task failed: ${err?.message || err}`);
  }
}

async function handleMemoryRepairAction(action) {
  const m = uiState.memoryStatus;
  if (action === 'memory-pause') { m.pauseRepair = true; return; }
  if (m.repairBusy) return;
  const connection = action === 'memory-connect' ? { baseUrl: document.getElementById('memory-embed-url')?.value, model: document.getElementById('memory-embed-model')?.value } : null;
  m.repairBusy = true; m.pauseRepair = false; bgRender();
  try {
    if (action === 'memory-repair') {
      do {
        const result = await api('/api/memory/repair', { method: 'POST', body: {} });
        if (m.snapshot) m.snapshot.repair = result;
        bgRender();
        if (result.status !== 'paused') break;
      } while (!m.pauseRepair);
      await refreshMemoryStatus();
      m.diagnosis = null;
    } else {
      m.diagnosis = await api(connection ? '/api/memory/connect' : '/api/memory/diagnose', connection ? { method: 'POST', body: connection } : {});
    }
  } catch (error) { showError(error.message); }
  finally { m.repairBusy = false; bgRender(); }
}

async function handleMemoryFactAction(action, id) {
  if (uiState.memoryFactBusy) return;
  if (action === 'memory-fact-edit') { uiState.memoryFactEditing=id; const row=uiState.memoryFacts?.records.find(r=>r.id===id); uiState.memoryFactDraft={text:row?.text||'',scope:row?.scope||'chat'}; memoryFactEdit.begin(); uiState.memoryFactFeedback=null; bgRender(); return; }
  if (action === 'memory-fact-cancel') { uiState.memoryFactEditing=null; uiState.memoryFactDraft=null; memoryFactEdit.cancel(); bgRender(); return; }
  if (action === 'memory-fact-search') { uiState.memoryFactQuery=document.getElementById('memory-fact-query')?.value || ''; uiState.memoryFactOffset=0; await refreshMemoryStatus(); return; }
  if (action === 'memory-fact-prev' || action === 'memory-fact-next') { uiState.memoryFactOffset=Math.max(0,(uiState.memoryFactOffset || 0)+(action.endsWith('next')?50:-50)); await refreshMemoryStatus(); return; }
  if(action==='memory-fact-save' && !memoryFactEdit.start()) return;
  const patch=action === 'memory-fact-save' ? {...uiState.memoryFactDraft} : {forgotten:action==='memory-fact-forget'};
  uiState.memoryFactBusy=true; bgRender();
  try { await api('/api/memory/facts/update',{method:'POST',body:{id,patch}});memoryFactEdit.saved();uiState.memoryFactFeedback={id,message:action==='memory-fact-save'?t("已保存"):action==='memory-fact-forget'?'已停止使用':'已恢复使用'};uiState.memoryFactEditing=null;uiState.memoryFactDraft=null;await refreshMemoryStatus(); }
  catch(error) { memoryFactEdit.failed(error); showError(error.message); }
  finally { uiState.memoryFactBusy=false;bgRender(); }
}

async function refreshMemoryStatus() {
  if (uiState.memoryStatus.loading) return;
  uiState.memoryStatus.loading = true;
  uiState.memoryStatus.error = null;
  bgRender();
  try {
    const [response, facts] = await Promise.all([api('/api/memory/status'), api(`/api/memory/facts?q=${encodeURIComponent(uiState.memoryFactQuery || '')}&offset=${uiState.memoryFactOffset || 0}`)]);
    uiState.memoryFacts = facts;
    uiState.memoryStatus.snapshot = response;
    if (!uiState.memoryConnection && response.connection) uiState.memoryConnection = response.connection;
    uiState.memoryStatus.loaded = true;
  } catch (err) {
    uiState.memoryStatus.error = err?.message || 'Failed to load memory status';
  } finally {
    uiState.memoryStatus.loading = false;
    bgRender();
  }
}

// ── Safety allowlist (Phase 3b/3c) ─────────────────────────────────────
//
// Backed by the persistent fileSafetyAllowlist (config-stored).
// pendingRemoveId is set while the DELETE is in flight so the row can
// disable its button without flashing on optimistic re-render.

async function refreshSafetyAllowlist() {
  if (uiState.safetyAllowlist.loading) return;
  uiState.safetyAllowlist.loading = true;
  uiState.safetyAllowlist.error = null;
  bgRender();
  try {
    const [response, tools, audit] = await Promise.all([api('/api/safety/file-allowlist'), api('/api/tools/permission-rules'), api('/api/permissions/audit')]);
    uiState.safetyAllowlist.audit = audit.events || [];
    uiState.safetyAllowlist.rules = [...(response.rules || []), ...(tools.rules || []).map(r => ({ ...r, id: `tool:${r.id || r.toolId}`, toolId: r.toolId, operation: r.action, scope: 'tool', realPath: r.toolId })), ...(audit.commands || []).map(r=>({...r,id:`command:${r.id}`,commandRuleId:r.id,operation:'bash',scope:'command',realPath:`${r.template.command} · ${r.template.cwd}`}))];
    uiState.safetyAllowlist.loaded = true;
  } catch (err) {
    uiState.safetyAllowlist.error = err?.message || 'Failed to load safety rules';
  } finally {
    uiState.safetyAllowlist.loading = false;
    bgRender();
  }
}

async function removeSafetyAllowlistRule(id) {
  if (!id || uiState.safetyAllowlist.pendingRemoveId === id) return;
  uiState.safetyAllowlist.pendingRemoveId = id;
  bgRender();
  try {
    const selectedRule = uiState.safetyAllowlist.rules.find(r => r.id === id);
    if (selectedRule?.commandRuleId) { await api('/api/permissions/command/remove',{method:'POST',body:{id:selectedRule.commandRuleId}}); await refreshSafetyAllowlist(); return; }
    const toolId = selectedRule?.toolId;
    await api(toolId ? '/api/tools/permission-rules/remove' : '/api/safety/file-allowlist/remove', {
      method: 'POST', body: toolId ? { toolId, id:selectedRule.id.startsWith('tool:') && selectedRule.permissionScope ? selectedRule.id.slice(5) : undefined } : { id },
    });
    await refreshSafetyAllowlist();
  } catch (err) {
    uiState.safetyAllowlist.error = err?.message || 'Failed to revoke rule';
  } finally {
    uiState.safetyAllowlist.pendingRemoveId = null;
    render();
  }
}

// ── Domain cookies (Phase 4) ──────────────────────────────────────────
//
// Same shape as refreshSafetyAllowlist / removeSafetyAllowlistRule but
// for the domainCookies map. The GET response intentionally omits the
// cookie string so the listing UI never shows session secrets — add /
// upsert ships the new value, remove drops it.

async function refreshDomainCookies() {
  if (uiState.domainCookies.loading) return;
  uiState.domainCookies.loading = true;
  uiState.domainCookies.error = null;
  bgRender();
  try {
    const response = await api('/api/settings/domain-cookies');
    uiState.domainCookies.hosts = Array.isArray(response.hosts) ? response.hosts : [];
    uiState.domainCookies.loaded = true;
  } catch (err) {
    uiState.domainCookies.error = err?.message || 'Failed to load cookies';
  } finally {
    uiState.domainCookies.loading = false;
    bgRender();
  }
}

async function upsertDomainCookie() {
  if (uiState.domainCookies.addInFlight) return;
  const host = String(uiState.domainCookies.addHost || '').trim();
  const cookieString = String(uiState.domainCookies.addCookie || '').trim();
  if (!host) {
    uiState.domainCookies.addError = 'Host is required.';
    bgRender();
    return;
  }
  if (!cookieString) {
    uiState.domainCookies.addError = 'Cookie string is required.';
    bgRender();
    return;
  }
  uiState.domainCookies.addInFlight = true;
  uiState.domainCookies.addError = '';
  render();
  try {
    await api('/api/settings/domain-cookies/upsert', {
      method: 'POST',
      body: { host, cookieString },
    });
    uiState.domainCookies.addHost = '';
    uiState.domainCookies.addCookie = '';
    uiState.domainCookies.loaded = false;
    await refreshDomainCookies();
  } catch (err) {
    uiState.domainCookies.addError = err?.message || 'Failed to save cookie';
  } finally {
    uiState.domainCookies.addInFlight = false;
    render();
  }
}

async function removeDomainCookie(host) {
  if (!host || uiState.domainCookies.pendingRemoveHost === host) return;
  uiState.domainCookies.pendingRemoveHost = host;
  render();
  try {
    await api('/api/settings/domain-cookies/remove', {
      method: 'POST',
      body: { host },
    });
    uiState.domainCookies.loaded = false;
    await refreshDomainCookies();
  } catch (err) {
    uiState.domainCookies.error = err?.message || 'Failed to remove cookie';
  } finally {
    uiState.domainCookies.pendingRemoveHost = null;
    render();
  }
}

async function doWipeEmbeddings() {
  if (uiState.memoryStatus.wipeInFlight) return;
  uiState.memoryStatus.wipeInFlight = true;
  uiState.memoryStatus.wipeResult = null;
  render();
  try {
    const response = await api('/api/memory/wipe-embeddings', {
      method: 'POST',
      body: { confirm: 'YES, WIPE EMBEDDINGS' },
    });
    uiState.memoryStatus.wipeResult = `Cleared ${response.cleared} embeddings (dims=${response.dims}).`;
  } catch (err) {
    uiState.memoryStatus.wipeResult = `Wipe failed: ${err?.message || 'unknown error'}`;
  } finally {
    uiState.memoryStatus.wipeInFlight = false;
    uiState.memoryStatus.wipeConfirmOpen = false;
    render();
    // Refresh to reflect the new counts.
    refreshMemoryStatus();
  }
}

function fmtMemoryBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtMemoryRelTime(ms) {
  if (ms == null) return '—';
  const age = Date.now() - ms;
  const s = Math.floor(age / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function renderSafetyPane() {
  const { loading, loaded, error, pendingRemoveId } = uiState.safetyAllowlist;
  const filters = uiState.safetyAllowlist.filters || {};
  const matches = row => (!filters.role || (row.permissionScope?.role || row.role || 'global') === filters.role) && (!filters.project || (row.permissionScope?.project || row.project || 'none') === filters.project) && (!filters.operation || row.operation === filters.operation);
  const allRules = uiState.safetyAllowlist.rules || [];
  const rules = allRules.filter(matches);
  const audit = (uiState.safetyAllowlist.audit || []).filter(matches);
  if (!loaded && !loading && !error) {
    Promise.resolve().then(refreshSafetyAllowlist);
  }

  const opLabel = (op, scope) => {
    if (scope === 'tool') return op === 'allow' ? t("始终允许此工具") : t("拒绝此工具");
    const opPart = op === 'read' ? t("读取") : op === 'write' ? t("写入") : op === 'edit' ? t("编辑") : op;
    const scopePart = scope === 'dir' ? t("整个目录") : t("当前文件");
    return `${opPart} — ${scopePart}`;
  };

  const fmtTimestamp = (ms) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return '';
    }
  };

  const body = (() => {
    if (loading && !loaded) {
      return ui`<div class="empty-state compact">正在读取授权…</div>`;
    }
    if (error) {
      return ui`<div class="alert compact-alert">${escapeHtml(error)}</div>`;
    }
    if (!rules.length) {
      return ui`
        <div class="empty-state compact">
          还没有长期授权。
          点击权限弹窗中的 <strong>Always allow</strong> 后，可在这里查看和撤销。
        </div>
      `;
    }
    return ui`
      <div class="safety-rule-list">
        ${rules.map(rule => ui`
          <div class="safety-rule-row">
            <div class="safety-rule-main">
              <div class="safety-rule-op">${escapeHtml(opLabel(rule.operation, rule.scope))}</div>
              <div class="safety-rule-path mono small">${escapeHtml(rule.realPath)}</div>
<div class="list-row-meta">${escapeHtml(rule.permissionScope ? `Agent ${rule.permissionScope.role} · 项目 ${rule.permissionScope.project || "无"} · ${rule.permissionScope.workspace?.path || "无工作目录"}` : "原有全局授权")} · 保存于 ${escapeHtml(fmtTimestamp(rule.createdAt))}</div>
            </div>
            <button class="small-button is-danger"
              data-action="safety-allowlist-remove"
              data-rule-id="${escapeHtml(rule.id)}"
              ${pendingRemoveId === rule.id ? 'disabled' : ''}>
              ${pendingRemoveId === rule.id ? '撤销中…' : t("撤销")}
            </button>
          </div>
        `).join('')}
      </div>
    `;
  })();

  return ui`
    <div class="detail-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">权限与隐私</h2>
          <p class="page-kicker">
            管理你通过 Always allow 保存的工具与文件授权。撤销后，下次操作将重新询问。
          </p>
        </div>
        <div class="inline-actions">
          <button class="small-button" data-action="refresh-safety-allowlist">刷新</button>
        </div>
      </div>
      <div class="inline-actions">${[['role',t("Agent"),r=>r.permissionScope?.role || r.role || 'global'],['project',t("项目"),r=>r.permissionScope?.project || r.project || 'none'],['operation',t("操作"),r=>r.operation]].map(([key,label,get])=>ui`<label>${label}<select data-permission-filter="${key}"><option value="">全部</option>${[...new Set([...allRules,...(uiState.safetyAllowlist.audit || [])].map(get))].filter(Boolean).map(value=>ui`<option value="${escapeHtml(value)}" ${filters[key]===value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></label>`).join('')}</div>
      ${body}
      <details class="quality-details"><summary>最近授权使用记录 · ${audit.length}</summary>${audit.slice(0,80).map(e=>ui`<p>${escapeHtml(e.at)} · ${escapeHtml(e.operation)} · ${escapeHtml(e.decision)} · ${escapeHtml(e.reason)} · ${escapeHtml(e.role || '未指定Agent')}${e.path ? ` · ${escapeHtml(e.path)}` : ''}</p>`).join('') || ui`<p>尚无记录。</p>`}</details>
      <p class="list-row-meta" style="margin-top: 16px;">
        Sensitive paths (~/.ssh, /etc, MELO_HOME, …) are <strong>never</strong> allow-listable
        — the dialog only offers Allow once / Deny for them. Move and delete operations are
        also excluded from "Always allow" by design.
      </p>

      ${renderDomainCookiesPane()}
    </div>
  `;
}

function renderDomainCookiesPane() {
  const { loading, loaded, hosts, error, addHost, addCookie, addInFlight, addError, pendingRemoveHost } = uiState.domainCookies;
  if (!loaded && !loading && !error) {
    Promise.resolve().then(refreshDomainCookies);
  }

  const list = (() => {
    if (loading && !loaded) {
      return ui`<div class="empty-state compact">Loading…</div>`;
    }
    if (error) {
      return ui`<div class="alert compact-alert">${escapeHtml(error)}</div>`;
    }
    if (!hosts.length) {
      return ui`
        <div class="empty-state compact">
          No domain cookies configured. Add one for sites that need an authenticated session
          (Xiaohongshu, Douyin, Bilibili, …) — yt-dlp / fetch_url will pick it up automatically.
        </div>
      `;
    }
    return ui`
      <div class="safety-rule-list">
        ${hosts.map(entry => ui`
          <div class="safety-rule-row">
            <div class="safety-rule-main">
              <div class="safety-rule-op">${escapeHtml(entry.host)}</div>
              <div class="list-row-meta">
                Cookie length: ${entry.length}${entry.fingerprint ? ui` · fingerprint <code>${escapeHtml(entry.fingerprint)}</code>` : ''}
              </div>
            </div>
            <button class="small-button is-danger"
              data-action="domain-cookie-remove"
              data-host="${escapeHtml(entry.host)}"
              ${pendingRemoveHost === entry.host ? 'disabled' : ''}>
              ${pendingRemoveHost === entry.host ? 'Removing…' : 'Remove'}
            </button>
          </div>
        `).join('')}
      </div>
    `;
  })();

  return ui`
    <div class="meta-block-label" style="margin-top: 24px;">Web-fetch cookies</div>
    <p class="list-row-meta" style="margin-bottom: 8px;">
      Per-domain Cookie strings sent with web-fetch (fetch_url) and platform extractors
      (yt-dlp). The list never displays the saved value — only its length + a sha256
      fingerprint — so session tokens stay out of the rendered DOM. Hostname only
      (no protocol / no path).
    </p>
    <p class="list-row-meta" style="margin-bottom: 12px;">
      <strong>Recommended hosts to add</strong> (Phase 6 social-link extractor uses
      these for authenticated reads — without them, posts behind login walls return
      OpenGraph preview only):<br>
      <code>xiaohongshu.com</code> · <code>xhslink.com</code> · <code>douyin.com</code>
      · <code>v.douyin.com</code> · <code>iesdouyin.com</code> · <code>bilibili.com</code>
    </p>

    <div class="domain-cookie-form">
      <input type="text"
        class="domain-cookie-host"
        placeholder="hostname (e.g. xiaohongshu.com)"
        value="${escapeHtml(addHost)}"
        data-domain-cookie-host
        ${addInFlight ? 'disabled' : ''} />
      <textarea
        class="domain-cookie-string"
        placeholder='Cookie header value: "name1=val1; name2=val2; …"'
        data-domain-cookie-string
        rows="2"
        ${addInFlight ? 'disabled' : ''}>${escapeHtml(addCookie)}</textarea>
      <div class="inline-actions">
        <button class="small-button is-primary"
          data-action="domain-cookie-save"
          ${addInFlight ? 'disabled' : ''}>
          ${addInFlight ? 'Saving…' : 'Save cookie'}
        </button>
        <button class="small-button" data-action="refresh-domain-cookies">Refresh list</button>
      </div>
      ${addError ? ui`<div class="alert compact-alert" style="margin-top: 8px;">${escapeHtml(addError)}</div>` : ''}
    </div>

    ${list}
  `;
}

function renderMemoryPane() {
  const { loading, loaded, snapshot, error, wipeConfirmOpen, wipeInFlight, wipeResult } = uiState.memoryStatus;
  if (!loaded && !loading && !error) {
    // Kick off the first fetch; re-render happens inside refreshMemoryStatus.
    Promise.resolve().then(refreshMemoryStatus);
  }
  const content = (() => {
    if (loading && !snapshot) {
      return ui`<div class="empty-state compact">正在检查记忆…</div>`;
    }
    if (error) {
      return ui`<div class="alert compact-alert">${escapeHtml(error)}</div>`;
    }
    if (!snapshot) {
      return ui`<div class="empty-state compact">暂无状态，点击刷新检查。</div>`;
    }
    const s = snapshot;
    const drift = s.embedding?.drift || {};
    const diagnosis = uiState.memoryStatus.diagnosis;
    const needsRebuild = diagnosis ? diagnosis.issues.some(issue => ['model_changed', 'missing_index'].includes(issue.code)) : drift.hasDrift;
    const semanticStatus = diagnosis?.available === false ? '暂不可用' : needsRebuild ? '需要重建' : diagnosis?.available ? '检测通过' : drift.inferredProvider ? '已配置 · 待检测' : drift.probeAttempted ? '暂不可用' : '未检测';
    const metaRows = s.meta
      ? Object.entries(s.meta)
          .map(([k, v]) => ui`<div class="meta-label">${escapeHtml(k)}</div><div class="mono">${escapeHtml(String(v))}</div>`)
          .join('')
      : '<div class="list-row-meta">(not yet populated)</div>';
    return ui`
      <div class="detail-card memory-card">
        <div class="header-row">
          <div>
            <h2 class="pane-title">记忆</h2>
            <p class="page-kicker">查看 Melo 记住了什么，以及哪些检索能力当前可用。</p>
          </div>
          <div class="inline-actions">
            <button class="small-button" data-action="refresh-memory-status">刷新</button>
          </div>
        </div>

        ${s.derivedIndex ? ui`<p class="page-kicker" role="status">${escapeHtml(({ready:'最近保存的内容已进入检索索引',pending:'内容已保存，检索索引正在后台更新',deferred:'内容已保存，索引更新暂缓，稍后自动重试',inline:'当前以本机同步方式更新索引'})[s.derivedIndex.status] || '正在检查索引状态')}</p>` : ''}
        ${drift.hasDrift ? ui`
          <div class="alert compact-alert">
            <strong>Embedding model drift detected.</strong>
            Stored vectors were written by <span class="mono">${escapeHtml(drift.stored || '?')}</span>
            but the active provider reports <span class="mono">${escapeHtml(drift.inferredProvider || '?')}</span>.
            Recall quality may degrade until old vectors are rebuilt.
          </div>
        ` : ''}

        <div class="quality-status-grid">
          <div class="quality-status-card"><span>已保存记忆</span><strong>${s.counts.memories ?? '—'}</strong><small>记录保存在本机</small></div>
          <div class="quality-status-card"><span>关键词索引</span><strong>${s.counts.memoriesFts == null ? '未确认' : s.counts.memoriesFts > 0 ? '已建立' : '等待内容'}</strong><small>可按文字检索已有记录</small></div>
          <div class="quality-status-card"><span>语义检索</span><strong>${semanticStatus}</strong><small>${diagnosis?.available === false ? '当前使用关键词检索；已有文字记忆保留' : diagnosis?.available ? '以实际检索结果为准' : '点击检测模型，验证检索是否可用'}</small></div>
        </div>
        <section class="quality-details">
          <h3>检索模型与索引</h3>
          <p>模型就绪后会在后台分批建立索引。需要修复时可安全重建，原文与旧索引保留到新索引通过验证。</p>
          <div class="inline-actions"><button class="small-button" data-action="memory-diagnose" ${uiState.memoryStatus.repairBusy ? 'disabled' : ''}>检测模型</button>
          <button class="small-button" data-action="memory-repair" ${uiState.memoryStatus.repairBusy ? 'disabled' : ''}>${s.repair?.completed && s.repair.status !== 'complete' ? '继续修复' : '安全重建索引'}</button>
          ${uiState.memoryStatus.repairBusy ? ui`<button class="small-button" data-action="memory-pause">本批完成后暂停</button>` : ''}</div>
          ${s.repair ? ui`<p role="status">${escapeHtml(s.repair.status === 'complete' ? '已验证并切换' : s.repair.status === 'failed' ? '修复暂停' : '待继续')} · ${s.repair.completed}/${s.repair.total} · ${escapeHtml(s.repair.error || s.repair.note || '')}</p>` : ''}
          ${uiState.memoryStatus.diagnosis ? ui`<p role="status">${escapeHtml(uiState.memoryStatus.diagnosis.available ? '实际嵌入请求成功' : '关键词检索模式')} · ${escapeHtml(uiState.memoryStatus.diagnosis.issues.map(i => i.message).join(' '))}</p>` : ''}
          <p>Melo 内置多语言嵌入模型，在本机后台运行，无需安装其他软件。模型资源随应用提供；检索不会自动调用外部服务。</p>
        </section>
        ${renderMemoryFacts(uiState.memoryFacts,{query:uiState.memoryFactQuery,editing:uiState.memoryFactEditing,busy:uiState.memoryFactBusy,draft:uiState.memoryFactDraft,session:memoryFactEdit,feedback:uiState.memoryFactFeedback})}
        <details class="quality-details"><summary>技术详情与维护</summary>
        <div class="meta-block-label">Store</div>
        <div class="meta-grid">
          <div><div class="meta-label">Path</div><div class="mono small">${escapeHtml(s.store.path)}</div></div>
          <div><div class="meta-label">Exists</div><div>${s.store.exists ? 'yes' : 'no'}</div></div>
          <div><div class="meta-label">Size</div><div>${fmtMemoryBytes(s.store.sizeBytes)}</div></div>
          <div><div class="meta-label">Memories</div><div>${s.counts.memories ?? '—'}</div></div>
          <div><div class="meta-label">FTS rows</div><div>${s.counts.memoriesFts ?? '—'}</div></div>
          <div><div class="meta-label">Vectors</div><div>${s.counts.vecMemories ?? '—'}</div></div>
          <div><div class="meta-label">Embed cache</div><div>${s.counts.embeddingCache ?? '—'}</div></div>
        </div>

        <div class="meta-block-label">Embedding</div>
        <div class="meta-grid">
          <div><div class="meta-label">Provider</div><div class="mono">${escapeHtml(s.embedding.provider)}</div></div>
          <div><div class="meta-label">Dims (configured)</div><div>${s.embedding.dimsConfigured}</div></div>
          <div><div class="meta-label">Model (stored)</div><div class="mono">${escapeHtml(s.embedding.storedModelId || '(not yet recorded)')}</div></div>
          <div><div class="meta-label">Model (live)</div><div class="mono">${escapeHtml(drift.inferredProvider || (drift.probeAttempted ? '(provider unavailable)' : '(probe skipped)'))}</div></div>
        </div>

        <div class="meta-block-label">Recall tuning (env)</div>
        <div class="meta-grid">
          <div><div class="meta-label">MMR λ</div><div class="mono">${s.tuning.mmrLambda}</div></div>
          <div><div class="meta-label">Recency half-life</div><div class="mono">${s.tuning.recencyHalfLifeDays}d</div></div>
        </div>
        <p class="list-row-meta">
          Set <span class="mono">MELO_MMR_LAMBDA</span> and <span class="mono">MELO_RECENCY_HALF_LIFE_DAYS</span>
          in the launch environment to override.
        </p>

        <div class="meta-block-label">Dreams</div>
        <div class="meta-grid">
          <div><div class="meta-label">Directory</div><div class="mono small">${escapeHtml(s.dreams.dir)}</div></div>
          <div><div class="meta-label">Count</div><div>${s.dreams.count}</div></div>
          <div><div class="meta-label">Latest</div><div class="mono">${escapeHtml(s.dreams.latest?.name || '—')}</div></div>
          <div><div class="meta-label">Last written</div><div>${fmtMemoryRelTime(s.dreams.latest?.mtimeMs)}</div></div>
        </div>

        <div class="subsection">
          <div class="meta-block-label">Maintenance</div>
          <div class="toggle-row">
            <div>
              <div class="list-row-title">Wipe stored embeddings</div>
              <div class="list-row-meta">
                Clears every <span class="mono">embedding</span> column and drops <span class="mono">vec_memories</span>.
                The next embed pass repopulates from the current provider's vector space.
                Memory rows themselves stay; only vectors are cleared. Use this after a deliberate
                provider swap.
              </div>
            </div>
            <button class="small-button is-danger" data-action="memory-wipe-open" ${wipeInFlight ? 'disabled' : ''}>
              Wipe embeddings…
            </button>
          </div>
          ${wipeConfirmOpen ? ui`
            <div class="alert compact-alert">
              <div><strong>This clears every stored vector.</strong> Memory rows and settings are untouched.</div>
              <div class="inline-actions" style="margin-top: 8px;">
                <button class="small-button is-danger" data-action="memory-wipe-confirm" ${wipeInFlight ? 'disabled' : ''}>
                  ${wipeInFlight ? 'Wiping…' : 'Yes, wipe embeddings'}
                </button>
                <button class="small-button" data-action="memory-wipe-cancel" ${wipeInFlight ? 'disabled' : ''}>Cancel</button>
              </div>
            </div>
          ` : ''}
          ${wipeResult ? ui`<div class="list-row-meta" style="margin-top: 8px;">${escapeHtml(wipeResult)}</div>` : ''}
        </div>

        <div class="subsection">
          <div class="meta-block-label">_meta table</div>
          <div class="meta-grid">${metaRows}</div>
        </div>
        </details>
      </div>
    `;
  })();
  return ui`<div class="customize-pane">${content}</div>`;
}

// ───────────────────────────────────────────────────────────────────────
// Phase 3 — Skill Overview | Markdown tab switcher
// ───────────────────────────────────────────────────────────────────────

function renderSkillDetailTabs(selected, activeTab) {
  return ui`
    <div class="skill-tab-strip">
      <button
        class="skill-tab ${activeTab === 'overview' ? 'is-active' : ''}"
        data-action="skill-detail-tab"
        data-skill-id="${escapeHtml(selected.id)}"
        data-tab="overview"
      >Overview</button>
      <button
        class="skill-tab ${activeTab === 'markdown' ? 'is-active' : ''}"
        data-action="skill-detail-tab"
        data-skill-id="${escapeHtml(selected.id)}"
        data-tab="markdown"
      >SKILL.md</button>
    </div>
  `;
}

async function refreshSkillMarkdown(skillId) {
  const current = uiState.skillMarkdown[skillId] || {};
  if (current.loading) return;
  uiState.skillMarkdown[skillId] = { ...current, loading: true, error: null };
  bgRender();
  try {
    const response = await api(`/api/skills/export?id=${encodeURIComponent(skillId)}`);
    uiState.skillMarkdown[skillId] = {
      loading: false,
      markdown: response?.markdown || '',
      error: null,
      copyToast: null,
    };
  } catch (err) {
    uiState.skillMarkdown[skillId] = {
      loading: false,
      markdown: '',
      error: err?.message || 'Failed to load SKILL.md',
    };
  } finally {
    bgRender();
  }
}

function renderSkillMarkdownTab(selected) {
  const activeTab = 'markdown';
  const cached = uiState.skillMarkdown[selected.id] || {};
  const body = (() => {
    if (cached.loading) return ui`<div class="empty-state compact">Loading SKILL.md…</div>`;
    if (cached.error) return ui`<div class="alert compact-alert">${escapeHtml(cached.error)}</div>`;
    if (!cached.markdown) {
      // Kick off initial load when rendered for the first time.
      Promise.resolve().then(() => refreshSkillMarkdown(selected.id));
      return ui`<div class="empty-state compact">Loading SKILL.md…</div>`;
    }
    return ui`<pre class="skill-markdown-block">${escapeHtml(cached.markdown)}</pre>`;
  })();
  return ui`
    <div class="detail-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">${escapeHtml(selected.name)}</h2>
          <p class="page-kicker">SKILL.md — the on-disk representation used by agentskills.io / Claude Code.</p>
        </div>
        <div class="inline-actions">
          <button class="small-button" data-action="copy-skill-markdown" data-skill-id="${escapeHtml(selected.id)}" ${cached.markdown ? '' : 'disabled'}>
            ${cached.copyToast || 'Copy SKILL.md'}
          </button>
        </div>
      </div>

      ${renderSkillDetailTabs(selected, activeTab)}

      ${body}
    </div>
  `;
}

function renderSkillHealthPanel() {
  const { loading, loaded, skills, error } = uiState.skillRunStats;
  const nameFor = id => {
    const found = (uiState.bootstrap?.customize?.skills || []).find(s => s.id === id);
    return found?.name || id;
  };
  return ui`
    <div class="detail-card skill-health-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">Skill health</h2>
          <p class="page-kicker">Last 30 days — success rate, speed, and recent errors per skill.</p>
        </div>
        <button class="small-button" data-action="refresh-skill-runs">
          ${loading ? 'Loading…' : loaded ? 'Refresh' : 'Load'}
        </button>
      </div>
      ${error ? ui`<div class="banner is-warning">${escapeHtml(error)}</div>` : ''}
      ${
        !loaded && !loading
          ? ui`<div class="empty-state compact">Click "Load" to see run statistics.</div>`
          : skills.length === 0 && loaded
            ? ui`<div class="empty-state compact">No skill runs recorded yet.</div>`
            : ui`
              <div class="list-stack">
                ${skills
                  .map(row => {
                    const rate = formatSuccessRate(row);
                    const durLabel = formatDurationMs(row.p50DurationMs ?? row.avgDurationMs);
                    const lastAt = formatLastRunAt(row.lastRunAt);
                    const metaLabel = `${row.runs} runs • ${rate} ok • p50 ${durLabel} • last ${lastAt}`;
                    const errHtml = (row.recentErrors || [])
                      .slice(0, 3)
                      .map(e => ui`
                        <div class="skill-health-error">
                          <span class="meta-label">${escapeHtml(e.errorType || 'error')}</span>
                          <span>${escapeHtml((e.errorMessage || '').slice(0, 160))}</span>
                        </div>
                      `)
                      .join('');
                    const isDegraded = typeof row.successRate === 'number' && row.successRate < 0.7 && row.runs >= 3;
                    return ui`
                      <div class="list-row skill-health-row ${isDegraded ? 'is-degraded' : ''}">
                        <div>
                          <div class="list-row-title">${escapeHtml(nameFor(row.skillId))}</div>
                          <div class="list-row-meta">${escapeHtml(metaLabel)}</div>
                          ${errHtml ? ui`<div class="skill-health-errors">${errHtml}</div>` : ''}
                        </div>
                      </div>
                    `;
                  })
                  .join('')}
              </div>
            `
      }
    </div>
  `;
}

function renderSkillProposalsPanel() {
  const proposals = uiState.bootstrap?.customize?.skillProposals || [];
  if (proposals.length === 0) return '';
  return ui`
    <div class="detail-card skill-proposals-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">Skill proposals</h2>
          <p class="page-kicker">Workflows you've repeated recently. Save the useful ones, dismiss the rest.</p>
        </div>
        <span class="chip is-accent">${proposals.length}</span>
      </div>
      <div class="list-stack">
        ${proposals
          .map(p => ui`
            <div class="list-row">
              <div>
                <div class="list-row-title">${escapeHtml(p.summary || '(workflow)')}</div>
                <div class="list-row-meta">
                  ${escapeHtml(
                    [
                      `${p.occurrences || 1}× seen`,
                      `${p.toolCallCount || 0} tool calls`,
                      p.involvesConnectors ? 'connector' : '',
                      p.involvesWrites ? 'file-write' : '',
                    ]
                      .filter(Boolean)
                      .join(' • '),
                  )}
                </div>
              </div>
              <div class="inline-actions">
                <button
                  class="small-button is-primary"
                  data-action="promote-skill-proposal"
                  data-seed-id="${escapeHtml(p.seedId)}"
                >Save as skill</button>
                <button
                  class="small-button"
                  data-action="dismiss-skill-proposal"
                  data-seed-id="${escapeHtml(p.seedId)}"
                >Dismiss</button>
              </div>
            </div>
          `)
          .join('')}
      </div>
    </div>
  `;
}

// renderAdvancedPage moved to ./advancedPage.js so its branches can be
// covered by node:test smoke tests.  The call site below threads the
// runtime closures (escapeHtml, scheduleRefresh) explicitly so the
// extracted module stays a pure function.


function renderCustomizePage() {
  const data = uiState.bootstrap;
  const selected = selectedCustomizeItem();
  // Old saved settings may still carry 'runtime' from before the
  // Advanced page replaced it — coerce here so the user lands on the
  // new section without an extra click.
  const rawSection = data.settings.selectedCustomizeSection;
  const section = rawSection === 'runtime' ? 'advanced' : rawSection;
  if (section === 'agents') return renderAgentPage();

  return ui`
    <section class="page page-customize">
      <div class="customize-layout">
        <div class="customize-pane">
          <div class="customize-pane-header">
            <h2 class="pane-title">Customize</h2>
          </div>

          <div class="section-nav">
            <button
              class="section-button ${section === 'skills' ? 'is-active' : ''}"
              data-action="open-customize-section"
              data-section="skills"
            >
              <div class="list-row-title">Skills</div>
              <div class="list-row-meta">Shape role-level behavior and prompt strategy.</div>
            </button>
            <button
              class="section-button ${section === 'agents' ? 'is-active' : ''}"
              data-action="open-customize-section"
              data-section="agents"
            >
              <div class="list-row-title">Agents</div>
              <div class="list-row-meta">设置 Agent 的人设、能力与消息渠道</div>
            </button>
            <button
              class="section-button ${section === 'connectors' ? 'is-active' : ''}"
              data-action="open-customize-section"
              data-section="connectors"
            >
              <div class="list-row-title">Connectors</div>
              <div class="list-row-meta">Model access, files, commands, projects, and artifacts.</div>
            </button>
            <button
              class="section-button ${section === 'advanced' ? 'is-active' : ''}"
              data-action="open-customize-section"
              data-section="advanced"
            >
              <div class="list-row-title">
                系统状态
              </div>
              <div class="list-row-meta">任务、能力状态与扩展管理。</div>
            </button>
            <button
              class="section-button ${section === 'memory' ? 'is-active' : ''}"
              data-action="open-customize-section"
              data-section="memory"
            >
              <div class="list-row-title">记忆</div>
              <div class="list-row-meta">Inspect the memory store, embedding model, and dreaming activity.</div>
            </button>
            <button
              class="section-button ${section === 'safety' ? 'is-active' : ''}"
              data-action="open-customize-section"
              data-section="safety"
            >
              <div class="list-row-title">权限与隐私</div>
              <div class="list-row-meta">Persistent file-access rules — review and revoke "Always allow" grants.</div>
            </button>
          </div>
        </div>

        ${
          section === 'advanced'
            ? renderAdvancedPage({
                data: uiState.bootstrap,
                adv: uiState.advanced,
                escapeHtml,
                scheduleRefresh: () => Promise.resolve().then(refreshAdvancedStatus),
                statePathHint: uiState.advanced.diagnostics?.paths?.configPath || '',
                mcpPresets: uiState.bootstrap?.customize?.mcpPresets || [],
                taskPanelHtml: renderTaskPanel(),
                approvalPanelHtml: renderApprovalPanel(),
              })
            : section === 'memory'
              ? renderMemoryPane()
            : section === 'safety'
              ? renderSafetyPane()
              : ui`
        <div class="customize-pane">
          <div class="customize-pane-header">
            <h2 class="pane-title">${
              section === 'skills' ? 'Skills' : section === 'agents' ? 'Agents' : 'Connectors'
            }</h2>
          </div>

          ${section === 'skills' ? renderSkillFilterBar() : ''}

          <div class="list-stack">
            ${(section === 'skills'
              ? filteredSkills()
              : section === 'agents'
                ? data.customize.agents
                : (data.customize.connectors || []).filter(c => c.type !== 'external-mcp'))
              .map(item => {
                const isActive =
                  section === 'skills'
                    ? data.settings.selectedSkillId === item.id
                    : section === 'agents'
                      ? data.settings.selectedAgentId === item.id
                      : data.settings.selectedConnectorId === item.id;
                return ui`
                  <button
                    class="list-row ${isActive ? 'is-active' : ''}"
                    data-action="select-customize-item"
                    data-section="${section}"
                    data-id="${item.id}"
                  >
                    <div class="list-row-title">
                      ${escapeHtml(item.name)}

                    </div>
                    <div class="list-row-meta">${escapeHtml(
                      section === 'agents' ? item.laneLabel : item.description,
                    )}</div>
                  </button>
                `;
              })
              .join('')}
            ${section === 'skills' && filteredSkills().length === 0
              ? ui`<div class="empty-state compact">No skills match the current filter.</div>`
              : ''}
          </div>
        </div>

        <div class="customize-pane">
          ${renderConnectorDetails(selected)}
          ${
            section === 'skills'
              ? ui`
                ${renderSkillHealthPanel()}
                ${renderSkillProposalsPanel()}
                <div class="subsection">${renderCustomSkillCreateCard()}</div>
              `
              : ''
          }
        </div>
          `
        }
      </div>
    </section>
  `;
}

function renderArtifactsPage() {
  const artifacts = artifactShelfRows();
  const active = selectedArtifact();
  const project = activeProject();

  return ui`
    <section class="page">
      <div class="page-grid">
        <div class="header-row">
          <div>
            <h1 class="page-title compact">${uiState.artifactCollection==='results'?'成果':'知识库'}</h1><p class="page-kicker">知识由你主动保存和选用。成果来自回复中的代码块，不自动加入知识上下文。</p><div class="inline-actions"><button class="small-button" data-action="artifact-collection" data-collection="knowledge">知识</button><button class="small-button" data-action="artifact-collection" data-collection="results">成果</button></div>
          </div>

          <div class="inline-actions">
            <button class="ghost-button is-primary" data-action="toggle-artifact-form">
              <span class="toolbar-icon">${icon.plus}</span>
              添加资料
            </button>
          </div>
        </div>

        ${
          uiState.showArtifactForm
            ? ui`
              <form class="project-form-card surface-card" data-form="artifact-create">
                <div class="project-form-grid">
                  <label class="label">
                    标题
                    <input class="input" name="title" value="${escapeHtml(
                      uiState.draftArtifact.title,
                    )}" placeholder="资料标题" />
                  </label>
                  <label class="label">
                    格式或语言
                    <input class="input" name="language" value="${escapeHtml(
                      uiState.draftArtifact.language,
                    )}" placeholder="markdown" />
                  </label>
                </div>
                <label class="label">
                  类别
                  <input class="input" name="kind" value="${escapeHtml(
                    uiState.draftArtifact.kind,
                  )}" placeholder="note" />
                </label>
                <label class="label">
                  正文
                  <textarea class="textarea" name="content" placeholder="写入背景资料、笔记或保存成果">${escapeHtml(
                    uiState.draftArtifact.content,
                  )}</textarea>
                </label>
                <div class="inline-actions">
                  <button class="small-button is-primary" type="submit">保存资料</button>
                  <button class="small-button is-outline" type="button" data-action="toggle-artifact-form">
                    Cancel
                  </button>
                  ${
                    project ? ui`<span class="meta-label">Attached to ${escapeHtml(project.name)}</span>` : ''
                  }
                </div>
              </form>
            `
            : ''
        }

        <div class="artifact-workbench">
          <section class="surface-card artifact-list-panel">
            <div class="mini-list">
              ${
                artifacts.length
                  ? artifacts
                      .map(
                        artifact => ui`
                          <button
                            class="artifact-card ${
                              active?.id === artifact.id ? 'is-active' : ''
                            }"
                            data-action="select-artifact"
                            data-artifact-id="${artifact.id}"
                          >
                            <div class="thread-meta">
                              <span class="chip is-accent">${escapeHtml(
                                artifact.language || artifact.kind,
                              )}</span>
                              ${
                                artifact.projectId
                                  ? ui`<span class="chip">${escapeHtml(
                                      uiState.bootstrap.projects.find(
                                        item => item.id === artifact.projectId,
                                      )?.name || 'Project',
                                    )}</span>`
                                  : ''
                              }
                            </div>
                            <h2 class="card-title">${escapeHtml(artifact.title)}</h2>
                            <p class="card-summary">${escapeHtml(
                              truncate(artifact.content, 140),
                            )}</p>
                          </button>
                        `,
                      )
                      .join('')
                  : '<div class="empty-state compact">此分类暂时没有内容。</div>'
              }
            </div>
          </section>

          <section class="surface-card artifact-detail-panel">
            ${
              active
                ? uiState.editingArtifactId === active.id
                  ? ui`
                    <form class="project-form-card surface-card" data-form="artifact-update">
                      <div class="project-form-grid">
                        <label class="label">
                          标题
                          <input class="input" name="title" value="${escapeHtml(
                            uiState.editingArtifactDraft.title,
                          )}" />
                        </label>
                        <label class="label">
                          格式或语言
                          <input class="input" name="language" value="${escapeHtml(
                            uiState.editingArtifactDraft.language,
                          )}" />
                        </label>
                      </div>
                      <label class="label">
                        类别
                        <input class="input" name="kind" value="${escapeHtml(
                          uiState.editingArtifactDraft.kind,
                        )}" />
                      </label>
                      <label class="label">
                        正文
                        <textarea class="textarea tall" name="content">${escapeHtml(
                          uiState.editingArtifactDraft.content,
                        )}</textarea>
                      </label>
                      <div class="inline-actions">
                        <button class="small-button is-primary" type="submit">保存修改</button>
                        <button class="small-button is-outline" type="button" data-action="cancel-edit-artifact">
                          Cancel
                        </button>
                      </div>
                    </form>
                  `
                  : ui`
                    <div class="header-row">
                      <div>
                        <h2 class="pane-title">${escapeHtml(active.title)}</h2>
                        <div class="thread-meta">
                          <span class="chip is-accent">${escapeHtml(active.language)}</span>
                          <span class="chip">${escapeHtml(active.kind)}</span>
                          ${
                            active.projectId
                              ? ui`<span class="chip">${escapeHtml(
                                  uiState.bootstrap.projects.find(
                                    item => item.id === active.projectId,
                                  )?.name || 'Project',
                              )}</span>`
                              : ''
                          }
                        </div>
                      </div>

                      <div class="inline-actions">
                        <button
                          class="small-button is-outline"
                          data-action="start-edit-artifact"
                          data-artifact-id="${active.id}"
                        >
                          Edit
                        </button>
                        <button
                          class="small-button is-danger"
                          data-action="delete-artifact"
                          data-artifact-id="${active.id}"
                        >
                          Delete
                        </button>
                        ${
                          uiState.bootstrap.workspace?.selectedFilePath
                            ? ui`
                              <button
                                class="small-button is-primary"
                                data-action="apply-artifact-to-selected-file"
                                data-artifact-id="${active.id}"
                              >
                                Queue write to ${escapeHtml(
                                  uiState.bootstrap.workspace.selectedFilePath,
                                )}
                              </button>
                            `
                            : ''
                        }
                      </div>
                    </div>

                    ${
                      uiState.bootstrap.workspace?.selectedFile
                        ? renderPatchPreviewBlock(
                            'Artifact to file preview',
                            uiState.bootstrap.workspace.selectedFile.path,
                            uiState.bootstrap.workspace.selectedFile.content,
                            active.content,
                          )
                        : ''
                    }

                    ${['note','text','markdown',''].includes(active.kind) || ['text','markdown',''].includes(active.language) ? ui`<div class="message-text-block" data-copyable-surface>${renderTextBlock(active.content)}</div>` : ui`<pre class="code-preview tall" data-copyable-surface><code>${escapeHtml(active.content)}</code></pre>`}
                  `
                : ui`<div class="empty-state">选择一份资料查看或编辑。</div>`
            }
          </section>
        </div>
      </div>
    </section>
  `;
}

function renderSearchPage() {
  return createSearchPageRenderer({ uiState, escapeHtml, truncate, icon, searchResultIcon, searchBucketsForRender, currentSearchItems }).renderSearchPage();
}

function renderPage() {
  const view = uiState.bootstrap.settings.activeView;
  const modeId = uiState.bootstrap.settings.activeMode;

  if (view === 'chat' && modeId === 'code') {
    return renderCodePage();
  }

  switch (view) {
    case 'projects':
      return renderProjectsPage();
    case 'agent':
      return renderAgentPage();
    case 'model':
      return renderModelPage();
    case 'settings':
      return renderLocalSettings(uiState.bootstrap);
    case 'customize':
      return renderCustomizePage();
    case 'artifacts':
      return renderArtifactsPage();
    case 'search':
      return renderSearchPage();
    case 'chats':
      return renderChatsPage();
    case 'chat':
    default:
      return renderRegularChatPage();
  }
}

function renderCommandPalette() {
  if (!uiState.commandPalette.open) {
    return '';
  }

  const commands = filteredPaletteCommands();
  const selectedIndex = Math.min(
    uiState.commandPalette.selectedIndex,
    Math.max(commands.length - 1, 0),
  );

  return ui`
    <div class="palette-backdrop" data-action="close-command-palette">
      <div class="palette-shell" onclick="event.stopPropagation()">
        <div class="palette-header">
          <input
            id="command-palette-input"
            class="palette-input"
            type="text"
            value="${escapeHtml(uiState.commandPalette.query)}"
            placeholder="Search actions, files, projects, approvals, and worker lanes..."
          />
        </div>
        <div class="palette-list">
          ${
            commands.length
              ? commands
                  .map(
                    (command, index) => ui`
                      <button
                        class="palette-item ${index === selectedIndex ? 'is-active' : ''}"
                        data-action="select-palette-command"
                        data-command-id="${command.id}"
                      >
                        <div class="list-row-title">${escapeHtml(command.title)}</div>
                        <div class="list-row-meta">${escapeHtml(command.subtitle || '')}</div>
                      </button>
                    `,
                  )
                  .join('')
              : '<div class="empty-state compact">No actions match that search.</div>'
          }
        </div>
      </div>
    </div>
  `;
}

// ─── Tool permission dialog ────────────────────────────────────────────────────

function renderToolPermissionDialog() {
  const pending = uiState.pendingToolPermissions;
  if (!pending.length) return '';
  const entry = pending[0];

  if (entry.kind === 'file_safety') {
    return renderFileSafetyDialog(entry);
  }

  const { requestId, toolId, args } = entry;
  const argsText = args && Object.keys(args).length
    ? JSON.stringify(args, null, 2)
    : '(no arguments)';

  return ui`
    <div class="tool-permission-backdrop" role="dialog" aria-modal="true" aria-label="Tool permission request">
      <div class="tool-permission-shell">
        <div class="tool-permission-header">
          <span class="tool-permission-icon">${icon.chip}</span>
          <div>
            <div class="tool-permission-title">需要你的授权</div>
            <div class="tool-permission-subtitle">确认这次操作的范围</div>
          </div>
        </div>
        <div class="tool-permission-body">
          <div class="tool-permission-tool-name">${escapeHtml(entry.agentId || 'Agent')} · ${escapeHtml(toolId)}</div>
          ${entry.confirmError ? ui`<div class="file-safety-warn" role="alert">${escapeHtml(entry.confirmError)}</div>` : ''}
          <p class="page-kicker-tip">Allow once 仅限本次；Always allow 保存到当前Agent、项目与真实工作目录。无项目时仅限当前Agent的非项目对话。可在权限页撤销；文件与命令仍按具体操作检查。</p>
          <pre class="tool-permission-args">${escapeHtml(argsText)}</pre>
        </div>
        <div class="tool-permission-footer">
          <fieldset class="inline-actions permission-actions" ${entry.submitting ? 'disabled aria-busy="true"' : ''}>
            <button class="small-button is-primary"
              data-action="tool-permission-allow-once"
              data-request-id="${escapeHtml(requestId)}"
              data-tool-id="${escapeHtml(toolId)}">
              Allow once
            </button>
            <button class="small-button"
              data-action="tool-permission-deny"
              data-request-id="${escapeHtml(requestId)}"
              data-tool-id="${escapeHtml(toolId)}">
              Deny
            </button>
            <button class="small-button"
              data-action="tool-permission-allow-always"
              data-request-id="${escapeHtml(requestId)}"
              data-tool-id="${escapeHtml(toolId)}">
              Always allow
            </button>
          </fieldset>
        </div>
      </div>
    </div>
  `;
}

// ── File-safety dialog ───────────────────────────────────────────────────────
//
// fileSafetyGate.js emits SSE events with `kind: 'file_safety'` and an
// operation discriminator (read / write_overwrite / edit / move /
// delete / bash / read_batch). Each operation has a different payload
// and a different set of valid scope choices, so the renderer dispatches
// per operation. Scopes routed back to the server:
//   'once' / 'file' / 'dir'  → granted=true, scope=<choice>
//   (deny button)            → granted=false  (server sets scope='deny')
//
// Sensitivity caveats (from gate header line 491-507):
//   - Reads of sensitive paths (~/.ssh, /etc, …) accept ONLY 'once'.
//   - Batch reads, moves, and bash are always one-shot per gate API.
//   - Delete is two-stage; stage 'confirm' renders an input field that
//     must match expectedConfirmation (the gate validates server-side).
function _fileSafetyTitle(operation, payload) {
  const stage = payload?.stage;
  switch (operation) {
    case 'read':         return 'Read file';
    case 'read_batch':   return 'Read multiple files';
    case 'write_new':    return 'Create new file';
    case 'write_overwrite': return 'Overwrite file';
    case 'edit':         return 'Edit file';
    case 'move':         return 'Move / rename file';
    case 'delete':       return stage === 'confirm' ? 'Confirm delete' : 'Delete file(s)';
    case 'bash':         return 'Run shell command';
    default:             return 'File operation';
  }
}

function _fileSafetyBody(operation, payload) {
  const wsBadge = payload?.withinWorkspace
    ? ui`<span class="file-safety-badge is-ok">workspace</span>`
    : ui`<span class="file-safety-badge is-warn">outside workspace</span>`;
  const symlinkWarn = (flag, real) => flag
    ? ui`<div class="file-safety-warn">⚠ symlink chain — real target: <code>${escapeHtml(real || '?')}</code></div>`
    : '';
  const sensitiveWarn = payload?.sensitive
    ? ui`<div class="file-safety-warn">⚠ sensitive path (category: ${escapeHtml(payload?.category || 'unknown')}). Approval is one-shot — no session-wide grant.</div>`
    : '';

  switch (operation) {
    case 'read':
      return ui`
        <div class="file-safety-row"><strong>Path:</strong> <code>${escapeHtml(payload.path || '')}</code> ${wsBadge}</div>
        ${symlinkWarn(payload.hasSymlinkInChain, payload.realPath)}
        ${sensitiveWarn}
        ${payload.size != null ? ui`<div class="file-safety-row"><strong>Size:</strong> ${payload.size} bytes</div>` : ''}
        ${payload.exists === false ? ui`<div class="file-safety-warn">File does not exist yet — read will fail.</div>` : ''}
      `;
    case 'read_batch':
      return ui`
        <div class="file-safety-row"><strong>Files:</strong> ${payload.fileCount || 0} ${wsBadge}</div>
        ${payload.dir ? ui`<div class="file-safety-row"><strong>Dir:</strong> <code>${escapeHtml(payload.dir)}</code></div>` : ''}
        ${payload.byteRange ? ui`<div class="file-safety-row"><strong>Bytes:</strong> ${escapeHtml(JSON.stringify(payload.byteRange))}</div>` : ''}
        ${Array.isArray(payload.extensions) && payload.extensions.length ? ui`<div class="file-safety-row"><strong>Extensions:</strong> ${escapeHtml(payload.extensions.join(', '))}</div>` : ''}
        ${payload.hasSymlinks ? ui`<div class="file-safety-warn">⚠ batch contains symlink-traversed paths.</div>` : ''}
        ${Array.isArray(payload.sample) && payload.sample.length ? ui`<details class="file-safety-details"><summary>Sample (${payload.sample.length})</summary><pre class="tool-permission-args">${escapeHtml(payload.sample.map(s => s.lexicalPath + (s.realPath !== s.lexicalPath ? ` → ${s.realPath}` : '')).join('\n'))}</pre></details>` : ''}
      `;
    case 'write_new':
    case 'write_overwrite':
      return ui`
        <div class="file-safety-row"><strong>Path:</strong> <code>${escapeHtml(payload.path || '')}</code> ${wsBadge}</div>
        ${symlinkWarn(payload.hasSymlinkInChain, payload.realPath)}
        ${payload.contentSize != null ? ui`<div class="file-safety-row"><strong>New size:</strong> ${payload.contentSize} bytes</div>` : ''}
        ${payload.diffPreview ? ui`<details class="file-safety-details" open><summary>Diff preview</summary><pre class="tool-permission-args">${escapeHtml(payload.diffPreview)}</pre></details>` : (payload.contentPreview ? ui`<details class="file-safety-details"><summary>Content preview</summary><pre class="tool-permission-args">${escapeHtml(payload.contentPreview)}</pre></details>` : '')}
      `;
    case 'edit':
      return ui`
        <div class="file-safety-row"><strong>Path:</strong> <code>${escapeHtml(payload.path || '')}</code> ${wsBadge}</div>
        ${symlinkWarn(payload.hasSymlinkInChain, payload.realPath)}
        ${payload.diffPreview ? ui`<details class="file-safety-details" open><summary>Diff</summary><pre class="tool-permission-args">${escapeHtml(payload.diffPreview)}</pre></details>` : ''}
        ${(!payload.diffPreview && (payload.oldExcerpt || payload.newExcerpt)) ? ui`<details class="file-safety-details"><summary>Replacement</summary><pre class="tool-permission-args">- ${escapeHtml(payload.oldExcerpt || '')}\n+ ${escapeHtml(payload.newExcerpt || '')}</pre></details>` : ''}
      `;
    case 'move':
      return ui`
        <div class="file-safety-row"><strong>From:</strong> <code>${escapeHtml(payload.src || '')}</code></div>
        <div class="file-safety-row"><strong>To:</strong> <code>${escapeHtml(payload.dst || '')}</code> ${wsBadge}</div>
        ${symlinkWarn(payload.srcHasSymlinkInChain, payload.srcRealPath)}
        ${symlinkWarn(payload.dstHasSymlinkInChain, payload.dstRealPath)}
      `;
    case 'delete': {
      const intent = payload.stage !== 'confirm';
      const paths = Array.isArray(payload.paths) ? payload.paths : [];
      return ui`
        <div class="file-safety-row"><strong>Targets:</strong> ${paths.length} ${wsBadge}</div>
        <pre class="tool-permission-args">${escapeHtml(paths.join('\n'))}</pre>
        ${payload.hasSymlinks ? ui`<div class="file-safety-warn">⚠ at least one path traverses a symlink.</div>` : ''}
        ${payload.reason ? ui`<div class="file-safety-row"><strong>Reason:</strong> ${escapeHtml(payload.reason)}</div>` : ''}
        ${intent
          ? ui`<div class="file-safety-row">Files will be moved to <code>.melo-trash/</code> (recoverable). Confirm to proceed to type-to-confirm step.</div>`
          : ui`<div class="file-safety-row">Type <code>${escapeHtml(payload.expectedConfirmation || '')}</code> to confirm:</div>
             <input type="text" class="file-safety-confirm-input" data-file-safety-confirm-input placeholder="${escapeHtml(payload.expectedConfirmation || '')}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />`}
      `;
    }
    case 'bash': {
      const risks = Array.isArray(payload.risks) ? payload.risks : [];
      return ui`
        <div class="file-safety-row"><strong>Command:</strong></div>
        <pre class="tool-permission-args">${escapeHtml(payload.command || '')}</pre>
        ${risks.length ? ui`<div class="file-safety-warn">⚠ ${risks.length} risk${risks.length > 1 ? 's' : ''} detected: ${escapeHtml(risks.map(r => r.kind).join(', '))}</div>` : ''}
        ${payload.workspacePath ? ui`<div class="file-safety-row"><strong>Workspace:</strong> <code>${escapeHtml(payload.workspacePath)}</code></div>` : ''}
        ${payload.effectiveCwd ? ui`<div class="file-safety-row"><strong>Cwd:</strong> <code>${escapeHtml(payload.effectiveCwd)}</code> ${payload.cwdInsideWorkspace === false ? '<span class="file-safety-badge is-warn">outside workspace</span>' : ''}</div>` : ''}
      `;
    }
    default:
      return ui`<pre class="tool-permission-args">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
  }
}

function _fileSafetyButtons(operation, payload, requestId) {
  const confirm = operation === 'delete' && payload?.stage === 'confirm';
  const persistent = payload?.persistentAllowed === true;
  return ui`
    <button class="small-button is-primary" data-action="${confirm ? 'file-safety-confirm-delete' : 'file-safety-allow'}" data-scope="once" data-request-id="${escapeHtml(requestId)}">Allow once</button>
    <button class="small-button" data-action="file-safety-deny" data-request-id="${escapeHtml(requestId)}">Deny</button>
    <button class="small-button" data-action="file-safety-allow" data-scope="file" data-persistent="1" data-request-id="${escapeHtml(requestId)}" ${persistent ? '' : 'disabled'}>Always allow</button>
    <p class="page-kicker-tip">${persistent ? (operation === 'bash' ? '只保存此固定 npm 命令、Agent与真实工作目录；package.json 变化后重新确认，不放行其他命令。' : '长期授权仅限当前文件、操作、Agent与项目，重启后仍有效，可在权限页撤销。') : '此操作需要逐次确认，不支持长期授权。'}${operation === 'delete' ? ' 删除仍需输入文件名确认。' : ''}</p>`;
}

function renderFileSafetyDialog(entry) {
  const { requestId, operation, payload = {}, confirmError = '' } = entry;
  const title = _fileSafetyTitle(operation, payload);
  const body = _fileSafetyBody(operation, payload);
  const buttons = _fileSafetyButtons(operation, payload, requestId);
  // confirmError is set by handleFileSafetyResponse when the gate reports
  // a recoverable mismatch on delete stage 2 — the dialog stays open and
  // surfaces the message instead of disappearing silently.
  const errorBanner = confirmError
    ? ui`<div class="file-safety-warn">${escapeHtml(confirmError)}</div>`
    : '';
  return ui`
    <div class="tool-permission-backdrop" role="dialog" aria-modal="true" aria-label="File operation approval">
      <div class="tool-permission-shell file-safety-shell">
        <div class="tool-permission-header">
          <span class="tool-permission-icon">${icon.chip}</span>
          <div>
            <div class="tool-permission-title">${escapeHtml(title)}</div>
            <div class="tool-permission-subtitle">File-safety approval required</div>
          </div>
        </div>
        <div class="tool-permission-body">
          <p>${escapeHtml(entry.agentId || 'Agent')}</p>
          ${errorBanner}
          ${body}
        </div>
        <div class="tool-permission-footer">
          <fieldset class="inline-actions permission-actions" ${entry.submitting ? 'disabled aria-busy="true"' : ''}>
            ${buttons}
          </fieldset>
        </div>
      </div>
    </div>
  `;
}

// ─── Tool call status strip (shown while tool is executing) ───────────────────
//
// G-1f (2026-05-12): extracted to ./activeToolCallsStrip.js so the renderer
// can be exercised by node --test without a DOM.  This wrapper closes over
// uiState + the icon table + escapeHtml; the sibling module is pure
// (deps injected).  The sibling also adds evidence-trail rendering under
// each pill when the trail is informative (failure path OR multi-tier
// fallback) — same heuristic as the G-1e prompt-side surfacing.
function renderActiveToolCallsStrip() {
  return _renderActiveToolCallsStripFromModule(uiState.activeToolCalls, {
    escapeHtml,
    terminalIcon: icon.terminal,
  });
}

// ─── Tool permission handlers ─────────────────────────────────────────────────

async function submitPermission(requestId, body) {
  const entry = uiState.pendingToolPermissions.find(p => p.requestId === requestId);
  if (!entry || entry.submitting) return;
  entry.submitting = true;
  entry.confirmError = '';
  render();
  let response = null;
  let error = null;
  try { response = await api('/api/tools/permission-response', { method: 'POST', body: { requestId, ...body } }); }
  catch (err) { error = err; }
  const decision = decideFileSafetyResponseAction({ entry, response, error });
  entry.submitting = false;
  if (decision.action === 'remove') uiState.pendingToolPermissions = uiState.pendingToolPermissions.filter(p => p.requestId !== requestId);
  else entry.confirmError = decision.message;
  render();
}
async function handleToolPermissionResponse(requestId, toolId, granted, scope) {
  return submitPermission(requestId, { toolId, granted, scope });
}
async function handleFileSafetyResponse(requestId, granted, scope, confirmInput = '', persistent = false) {
  return submitPermission(requestId, { granted, scope, kind: 'file_safety', confirmInput, persistent });
}

function _positionAgentDropdown() {
  const chip = document.querySelector('[data-action="toggle-agent-selector"]');
  const dropdown = document.querySelector('.agent-selector-dropdown');
  if (!chip || !dropdown) return;
  // A fixed child of the transformed composer still inherits its containing
  // block; the top layer gives this menu actual viewport coordinates.
  if (typeof dropdown.showPopover === 'function') {
    if (!dropdown.matches(':popover-open')) dropdown.showPopover();
  } else {
    document.querySelector('#app').appendChild(dropdown);
  }
  const position = modelPanelPosition(chip.getBoundingClientRect(), { width: dropdown.offsetWidth, height: dropdown.offsetHeight }, { width: innerWidth, height: innerHeight });
  dropdown.style.top = `${position.top}px`;
  dropdown.style.left = `${position.left}px`;
}
window.addEventListener('resize', _positionAgentDropdown);
window.addEventListener('scroll', _positionAgentDropdown, { capture: true, passive: true });

// Generic scroll preservation: any nested scrollable pane that isn't already
// covered by a dedicated capture/restore path would reset to 0 whenever
// render() rewrites the DOM — including the 4-second agent runtime refresh.
// This walks known scrollable selectors and saves scrollTop keyed by position
// within the DOM, so the same instance can be found again after re-render.
const { captureScrollPositions, restoreScrollPositions, captureFormTextareaScrolls, restoreFormTextareaScrolls, captureThreadAnchor, restoreThreadAnchor } = createScrollPreservation({ document, HTMLElement, HTMLTextAreaElement, HTMLFormElement });

// Helper for non-user-initiated renders — refresh polls, EventSource pushes,
// fetch().then() chains, error-toast clearance setTimeouts, etc. Goes through
// the typing/scroll guards so a backend update can't tear down the scroller
// while the user has finger inertia in flight. User-initiated paths
// (click handlers, form submits, keyboard shortcuts) keep calling bare
// `render()` so they get immediate feedback.
function bgRender(opts = {}) {
  return render({ ...opts, background: true });
}

function render({ background = false, changedSections = null } = {}) {
  if (uiState.loading && !uiState.bootstrap) {
    window.MeloLaunch?.show({ phase: 'workspace' }, () => loadBootstrap());
    return;
  }

  if (!uiState.bootstrap) {
    window.MeloLaunch?.show({ phase: 'error', detail: uiState.error }, () => loadBootstrap());
    return;
  }

  if (document.querySelector('.melo-launch')) window.MeloLaunch?.dismiss();

  // ── Typing guard ──────────────────────────────────────────────────────────
  // If this render was triggered by a background path (autosave response,
  // 4-s runtime poll, toast timer clearing, etc.) AND the user hit a key in
  // an input/textarea in the last 500 ms AND the focused element is STILL an
  // editable input, defer. The full innerHTML swap below wipes
  // document.activeElement — if we let it run mid-typing, restoreFocusedInputState
  // can miss (e.g. when another input with the same `name` resolves to a
  // different DOM node after rebuild, or when IME composition state is lost
  // mid-character) and the user sees their caret jump to a different field.
  //
  // Foreground (user-action) renders are NOT blocked — those are needed for
  // immediate UI feedback (slash palette opening, project search filtering,
  // etc.). Only background renders wait. scheduleDeferredRender re-invokes
  // us as a background render once the user goes idle for one check interval.
  if (background && userIsActivelyTyping()) {
    const active = document.activeElement;
    const isEditable =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable);
    if (isEditable) {
      scheduleDeferredRender();
      return;
    }
  }

  // ── Scroll guard ──────────────────────────────────────────────────────────
  // Defer background renders while the user is actively scrolling the chat
  // thread. The full innerHTML swap below tears down the .thread-scroll-region
  // element — if that happens mid momentum-scroll, the browser's native scroll
  // velocity is killed and the viewport snaps to whatever scrollTop was saved
  // at the render entry point. The user perceives this as "卡顿 + 跳"
  // (User-reported 2026-05-05). Foreground renders (user clicked a button,
  // sent a message) are NOT deferred — those need immediate feedback.
  if (background && userIsActivelyScrolling()) {
    scheduleDeferredRender();
    return;
  }

  captureAgentScrollState();
  captureAgentEditorState();

  // Generic focus preservation — app.innerHTML = ... below destroys every DOM
  // node (and therefore document.activeElement). Without this, typing in any
  // input that is NOT the agent-content-editor textarea causes the caret to
  // disappear (or worse, jump to the first input in the page) on every render.
  // Pair with restoreFocusedInputState() after the innerHTML swap.
  const _savedFocusedInput = captureFocusedInputState();

  // Generic scroll preservation for any nested scrollable pane. Catches
  // .customize-pane, .search-panel-body, etc. so that a background bootstrap
  // refresh (agent runtime poll every 4s) doesn't kick scroll back to 0.
  const _savedNestedScrolls = captureScrollPositions();

  // Generic scroll preservation for ALL named textareas (voicePersonality,
  // systemPrompt, task summary, connector prompt, etc.) — even when none
  // of them are focused. Without this, a user reading a long Voice
  // personality or system prompt textarea watches it snap back to line 1
  // every time a background render fires (autosave, runtime poll, toast
  // expiry). See captureFormTextareaScrolls for the full rationale.
  const _savedTextareaScrolls = captureFormTextareaScrolls();

  // Save content scroll position — render() rebuilds the DOM and would reset it to 0
  const _contentScroller = document.querySelector('.content-scroll');
  const _savedContentScroll = _contentScroller instanceof HTMLElement ? _contentScroller.scrollTop : -1;

  // Save thread scroll position separately — .thread-scroll-region is the actual chat scroller
  const _threadScroller = document.querySelector('.thread-scroll-region');
  const _savedThreadScroll = _threadScroller instanceof HTMLElement ? _threadScroller.scrollTop : -1;

  // ── Viz-anchored scroll preservation ──────────────────────────────────────
  // When a message with a Demon viz card is rendered, the viz <div> starts as
  // a ZERO-HEIGHT shell and only grows after `syncVizBlocks()` hydrates it
  // into the actual renderer (SVG, canvas, scene3d). For scene3d cards the
  // WebGL mount is async (queueMicrotask inside Scene3DRenderer; fully
  // dynamic `import()` for globe-flight) — so the viz can grow hundreds of
  // pixels AFTER we've already restored scrollTop. That growth, applied
  // above the user's current viewport, shifts every later message down —
  // which manifests as "I scrolled to image 2 and the view jumped to image
  // 3". CSS `overflow-anchor: none` isn't enough in WKWebView.
  //
  // The fix: instead of (or in addition to) restoring scrollTop, ANCHOR on
  // whatever .message article was closest to the top of the viewport before
  // the swap. After the swap, find the element with the same data-message-id
  // and shift scrollTop by the delta between its old and new top offsets.
  // Also stash the anchor on `uiState` so the async viz hydration path can
  // re-apply it once more after scene3d canvases finish mounting.
  //
  // SCOPE: only enable for chats that ACTUALLY contain a viz card. For plain
  // text chats the anchor system was a strict net-negative — every render
  // (streaming chunk, autosave, runtime poll, TTS state) ran a 5-retry
  // restoreThreadAnchor loop AND captureThreadAnchor's per-message
  // getBoundingClientRect scan, fighting the user's own scroll gestures
  // ("拖到底跳回中间") and forcing N layout reflows per render at
  // streaming cadence ("帧数明显不对，有卡顿"). User-reported 2026-05-05.
  // Use the same `isRenderableViz` predicate that renderVizMountHtml uses,
  // so a chat carrying ONLY legacy/invalid viz metadata (e.g.
  // `{ type: 'mermaid', source }` from older threads — preserved by the
  // hydration layer but never producing a real mount) does NOT erroneously
  // enable the anchor + 5-retry loop. Codex C-grade gate fix 2026-05-05.
  const _chat = activeChat();
  const _chatHasViz = !!(
    _chat &&
    Array.isArray(_chat.messages) &&
    _chat.messages.some(m => m && isRenderableViz(m.viz))
  );
  const _vizAnchor = _threadScroller instanceof HTMLElement && _chatHasViz
    ? captureThreadAnchor(_threadScroller)
    : null;
  uiState.pendingVizAnchor = _vizAnchor;

  // Compute whether thread content will change this render — if the signature matches the
  // last rendered signature it's a UI-only render (voice panel, checkbox, etc.) and we must
  // restore the thread scroll manually (syncThreadViewport returns early for same-signature).
  // If the signature differs, syncThreadViewport will scroll the thread; don't interfere.
  const _threadSig = _chat
    ? `${_chat.id}:${_chat.messages.length}:${_chat.updatedAt || ''}:${
        uiState.highlightedMessageId || ''
      }:${uiState.streamingChatId === _chat.id ? uiState.streamingAssistantText.length : 0}:${
        uiState.sending && uiState.streamingChatId === _chat.id ? 1 : 0
      }`
    : '';
  const _threadContentUnchanged = _threadSig === uiState.lastThreadScrollSignature;

  // Single-scroller mode for chat view: when the active page is .is-chat
  // AND there's an active chat thread (i.e. .thread-scroll-region is the
  // inner scroller), the page-level .content-scroll is set to
  // overflow:hidden so the only scroller is .thread-scroll-region. Two
  // nested scrollers were the root cause of the month-long "拉到底跳到中间"
  // — even with overscroll-behavior set on the inner scroller, WKWebView
  // still occasionally chained scroll to the outer one in some
  // momentum-scroll edge cases. Removing the outer scroller from the
  // equation eliminates the entire failure mode.
  //
  // The empty chat-home view (greeting + composer, no thread) does NOT get
  // is-chat-view because there's no inner scroller — disabling the outer
  // one too would clip the home content on short windows / when composer
  // grows multi-line. Codex P1 follow-up 2026-05-05.
  const _isChatView =
    uiState.bootstrap?.settings?.activeView === 'chat' && !!_chat && !uiState.neuralOverview;
  applyLocalAppearance(uiState.bootstrap, uiState);
  const neuralGroup = uiState.neuralGroup || groupForSettings(uiState.bootstrap.settings);
  const neuralBefore = captureNeuralLayout();
  const neuralStage = resolveWorkspaceStage(uiState.neuralOverview, uiState.neuralExpanded);
  if (uiState.commandPalette.open || uiState.pendingToolPermissions.length) { uiState.modelPickerOpen = false; uiState.agentSelectorOpen = false; }
  const currentPage = app.querySelector('main.content-scroll');
  const keepPage = background && changedSections && !uiState.neuralOverview && !uiState.sending &&
    !pageAffected(uiState.bootstrap.settings.activeView, changedSections) && currentPage;
  const pageHtml = keepPage ? preserveNeuralRegion(currentPage) :
    ui`<main class="content-scroll" data-neural-key="page-${uiState.neuralOverview ? 'overview' : escapeHtml(uiState.bootstrap.settings.activeView + ':' + (uiState.bootstrap.settings.selectedCustomizeSection || ''))}">${uiState.neuralOverview ? renderNeuralOverview(uiState.bootstrap, neuralGroup, { composer: renderComposerCard() }) : renderPage()}</main>`;
  updateNeuralWorkspace(app, ui`
    <div data-neural-key="workspace" class="shell neural-shell ${uiState.neuralOverview ? 'is-overview' : 'is-working'}" data-neural-stage="${neuralStage}" data-neural-busy="${uiState.sending}" data-neural-permission="${!!uiState.pendingToolPermissions?.length}" data-neural-group="${neuralGroup}">
      <div class="neural-cosmos" aria-hidden="true"></div>
      <div class="neural-core-anchor" aria-hidden="true"></div>
      ${renderNeuralNavigation(uiState.bootstrap, neuralGroup, { overview: uiState.neuralOverview, still: uiState.neuralStill })}
      <div class="neural-activity" role="status">${uiState.sending ? escapeHtml(thinkingLabel()) : t("本地工作空间")}</div>
      <div class="neural-preview" role="status" aria-live="polite" hidden></div>
      <div data-neural-key="dashboard" class="workspace neural-dashboard">
        ${renderTopbar()}
        ${renderSyncConflicts(uiState.bootstrap.syncConflicts,escapeHtml)}
        ${renderSyncConflicts(uiState.bootstrap.agentSettingsConflicts,escapeHtml,true)}
        ${uiState.bootstrap.agentPersonaRecoveries?.length ? `<details><summary>本机人设恢复副本</summary><p>冲突选择前保留的全文；可复制到 Agent 编辑器后明确保存。</p>${uiState.bootstrap.agentPersonaRecoveries.map(row=>`<details><summary>${escapeHtml(row.key)} · ${escapeHtml(row.createdAt)}</summary><pre tabindex="0">${escapeHtml(JSON.stringify(row.agents,null,2))}</pre></details>`).join('')}</details>` : ''}
        <div class="neural-dashboard-label"><span>${uiState.neuralOverview ? 'CONSTELLATION / OVERVIEW' : 'WORKSPACE / '+neuralGroup.toUpperCase()}</span><button data-action="neural-back">${neuralStage==='detail'?t("返回分支"):t("返回总览")} ↗</button></div>
        <div class="content-shell${_isChatView ? ' is-chat-view' : ''}">
          ${pageHtml}
          <div class="content-scrollbar" aria-hidden="true">
            <div class="content-scrollbar-thumb"></div>
          </div>
        </div>
      </div>
    </div>
    ${renderAgentSelectorDropdown()}
    <input id="composer-attachment-input" class="hidden-file-input" type="file" multiple />
    ${renderCommandPalette()}
    ${renderEditContextMenu()}
    ${renderCopyContextMenu()}
    ${renderRecentContextMenu()}
    ${renderAudioContextMenu()}
    ${renderToolPermissionDialog()}
    ${uiState.error ? ui`<div class="toast">${escapeHtml(uiState.error)}</div>` : ''}
  `);

  settingsFormEditors.decorate(app);
  syncNeuralComposer(app, uiState.composer);
  animateNeuralLayout(neuralBefore, uiState.neuralStill);
  syncNeuralScene(uiState.neuralStill);
  syncExecutionPanel({ chat: activeChat(), still: uiState.neuralStill, autoCollapse: uiState.bootstrap.settings.localPreferences?.autoCollapse !== false, onImageRetry: retryMissingImages, onSelectionChanged: bgRender });
  syncModelPickerPosition();

  activeEditableContextTarget = null;
  activeCopyContextTarget = null;

  // Restore content scroll position (must happen before syncThreadViewport)
  if (_savedContentScroll > 0) {
    const _newScroller = document.querySelector('.content-scroll');
    if (_newScroller instanceof HTMLElement) {
      _newScroller.scrollTop = _savedContentScroll;
    }
  }

  // Restore thread scroll only on UI-only renders (same thread signature).
  // When thread content changed, syncThreadViewport handles scrolling — don't interfere.
  if (_savedThreadScroll >= 0 && _threadContentUnchanged) {
    const _newThread = document.querySelector('.thread-scroll-region');
    if (_newThread instanceof HTMLElement) {
      _newThread.scrollTop = _savedThreadScroll;
    }
  }

  bindContentScrollbar();
  syncContentScrollbar();
  syncThreadViewport();
  restoreAgentScrollState();
  // Restore AFTER agent-specific restore so the generic path covers the panes
  // the agent logic doesn't know about (e.g. customize-pane on non-agent views).
  restoreScrollPositions(_savedNestedScrolls);
  // Restore named-textarea scrollTop for every form textarea we saved above.
  // Runs BEFORE restoreAgentEditorState so the agent-content-editor's
  // dedicated restore still has the last word for that one textarea (it also
  // restores selection + focus, which this generic path deliberately doesn't
  // touch — we only care about scrollTop here).
  restoreFormTextareaScrolls(_savedTextareaScrolls);
  syncAgentRuntimeRefresh();
  syncSearchFieldFocus();
  syncFileEditorGoToLine();
  syncComposerTextareaHeight();
  restoreAgentEditorState();
  // Put the caret back into whichever input/textarea was focused before the
  // page update. Runs AFTER restoreAgentEditorState so the agent-specific
  // textarea restore wins for that one input; this helper covers everything
  // else (Discord Guild ID, Telegram bot token, nickname lists, etc.).
  restoreFocusedInputState(_savedFocusedInput);
  _positionAgentDropdown();
  // Mount Demon viz blocks (projectile, tree, ...) into the message bubbles
  // that carry a validated `viz` spec. Runs AFTER the DOM swap so it can
  // query freshly rendered `.viz-mount` shells and attach canvases/SVGs.
  syncVizBlocks();

  // Viz cards just grew (projectile SVG, tree layout, scene3d shells). Pin
  // the user's viewport to whatever message they were looking at BEFORE the
  // render ran. Scene3d canvases mount one microtask later, and globe-flight
  // mounts fully async — so we also re-apply the anchor on the next two
  // animation frames to catch that layout delta. See captureThreadAnchor()
  // for the "why".
  if (_vizAnchor) {
    restoreThreadAnchor(_vizAnchor);
    // Microtask — covers scene3d `queueMicrotask(build)` path.
    queueMicrotask(() => restoreThreadAnchor(_vizAnchor));
    // Two RAFs — covers the first paint after WebGL canvas is attached.
    requestAnimationFrame(() => {
      restoreThreadAnchor(_vizAnchor);
      requestAnimationFrame(() => restoreThreadAnchor(_vizAnchor));
    });
    // And one more after the globe-flight lazy import typically resolves
    // (probe + dynamic import + scene build). 600ms is a conservative upper
    // bound — if the anchor is already stable, restoreThreadAnchor short-
    // circuits at the 1px threshold.
    setTimeout(() => {
      restoreThreadAnchor(_vizAnchor);
      // Clear the stashed anchor on uiState so stale references don't
      // leak — the async globe-flight path reads this to re-pin after it
      // finishes hydrating.
      if (uiState.pendingVizAnchor === _vizAnchor) uiState.pendingVizAnchor = null;
    }, 600);
  } else {
    uiState.pendingVizAnchor = null;
  }
}

function contentScrollElements() {
  const threadScroller = document.querySelector('.thread-scroll-region');
  return {
    scroller:
      threadScroller instanceof HTMLElement
        ? threadScroller
        : document.querySelector('.content-scroll'),
    scrollbar: document.querySelector('.content-scrollbar'),
    thumb: document.querySelector('.content-scrollbar-thumb'),
  };
}

function scheduleContentScrollbarHide() {
  window.clearTimeout(contentScrollbarHideTimer);
  contentScrollbarHideTimer = window.setTimeout(() => {
    const { scrollbar } = contentScrollElements();
    if (scrollbar instanceof HTMLElement) {
      scrollbar.classList.remove('is-visible');
    }
  }, 640);
}

function syncContentScrollbar({ forceVisible = false } = {}) {
  const { scroller, scrollbar, thumb } = contentScrollElements();
  if (
    !(scroller instanceof HTMLElement) ||
    !(scrollbar instanceof HTMLElement) ||
    !(thumb instanceof HTMLElement)
  ) {
    return;
  }

  // Align the bar's vertical extent to whatever the actual scroller is.
  // On chat pages the scroller is .thread-scroll-region (NOT the page-level
  // .content-scroll), and the composer sits BELOW the thread region — without
  // realignment the bar's CSS-default top/bottom (anchored to .content-shell)
  // makes it run all the way down past the composer to the very bottom of the
  // app, while the actual scrollable area ends above the composer. On non-chat
  // pages the scroller fills the shell, so we reset to the static CSS defaults.
  const shell = scrollbar.parentElement;
  const isThreadScroller = scroller.classList.contains('thread-scroll-region');
  if (shell instanceof HTMLElement && isThreadScroller) {
    const scrollerRect = scroller.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    scrollbar.style.top = `${Math.max(0, scrollerRect.top - shellRect.top)}px`;
    scrollbar.style.bottom = `${Math.max(0, shellRect.bottom - scrollerRect.bottom)}px`;
  } else {
    scrollbar.style.top = '';
    scrollbar.style.bottom = '';
  }

  const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
  if (maxScroll <= 1) {
    scrollbar.classList.remove('is-enabled', 'is-visible');
    thumb.style.height = '0px';
    thumb.style.transform = 'translateY(0px)';
    return;
  }

  scrollbar.classList.add('is-enabled');
  const trackHeight = Math.max(scrollbar.clientHeight, 0);
  const minThumbHeight = trackHeight * 0.1;
  const maxThumbHeight = trackHeight * 0.25;
  const thumbHeight = Math.min(
    maxThumbHeight,
    Math.max(minThumbHeight, trackHeight * (scroller.clientHeight / scroller.scrollHeight)),
  );
  const maxThumbTravel = Math.max(trackHeight - thumbHeight, 0);
  const scrollRatio = maxScroll > 0 ? scroller.scrollTop / maxScroll : 0;
  const thumbOffset = Math.min(maxThumbTravel, Math.max(0, maxThumbTravel * scrollRatio));

  thumb.style.height = `${thumbHeight}px`;
  thumb.style.transform = `translateY(${thumbOffset}px)`;

  if (forceVisible) {
    scrollbar.classList.add('is-visible');
    scheduleContentScrollbarHide();
  }
}

function updateThreadAutoFollow(scroller) {
  if (!(scroller instanceof HTMLElement)) {
    return;
  }

  if (uiState.bootstrap?.settings?.activeView !== 'chat' || !activeChat()) {
    return;
  }

  const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
  const distanceFromBottom = Math.max(0, maxScroll - scroller.scrollTop);
  const nextAutoFollow = distanceFromBottom <= 56;
  const autoFollowChanged = nextAutoFollow !== uiState.threadAutoFollow;
  uiState.threadAutoFollow = nextAutoFollow;
  // Always track the last known scroll position so we can restore it after re-renders
  uiState.lastKnownScrollTop = scroller.scrollTop;

  // If the auto-follow state flipped (user scrolled away from, or back to, the
  // bottom), we need a render so the "jump to latest" floating button shows or
  // hides. Skipping this render means the button only appears on the next
  // unrelated render — e.g. not until the next streaming chunk arrives — which
  // feels laggy when the user scrolls up after streaming has finished.
  //
  // Marked as `background: true` so the scroll guard above defers it past any
  // momentum-scroll in flight — jump-to-latest button visibility is allowed
  // to lag a few hundred ms, but tearing down the scroller mid-momentum kills
  // the user's swipe and is what they reported as "拉到底跳到这" on 2026-05-05.
  if (autoFollowChanged) {
    render({ background: true });
  }
}

function bindContentScrollbar() {
  const { scroller } = contentScrollElements();
  if (!(scroller instanceof HTMLElement) || scroller.dataset.scrollbarBound === 'true') {
    return;
  }

  scroller.dataset.scrollbarBound = 'true';

  scroller.addEventListener(
    'scroll',
    () => {
      // Stamp the scroll-guard clock — render() reads this to defer
      // background renders that would tear down the scroller mid momentum
      // scroll. See SCROLL_GUARD_WINDOW_MS comment for the user-reported
      // symptom this fixes.
      lastUserScrollAt = Date.now();
      updateThreadAutoFollow(scroller);
      syncContentScrollbar({ forceVisible: true });
    },
    { passive: true },
  );

  scroller.addEventListener(
    'wheel',
    () => {
      // Stamp guard on wheel too — wheel fires BEFORE the scroll event the
      // browser dispatches in response to it, so a background render that
      // races between wheel and scroll would still tear the scroller down.
      lastUserScrollAt = Date.now();
      syncContentScrollbar({ forceVisible: true });
    },
    { passive: true },
  );

  window.addEventListener(
    'resize',
    () => {
      syncContentScrollbar();
    },
    { passive: true },
  );
}

function syncThreadViewport() {
  const chat = activeChat();
  if (
    uiState.bootstrap?.settings?.activeView !== 'chat' ||
    !chat?.messages?.length
  ) {
    uiState.lastThreadScrollSignature = '';
    uiState.lastThreadChatId = null;
    uiState.threadAutoFollow = true;
    return;
  }

  const isNewThread = uiState.lastThreadChatId !== chat.id;
  if (isNewThread) {
    uiState.lastThreadChatId = chat.id;
    uiState.threadAutoFollow = true;
  }

  const signature = `${chat.id}:${chat.messages.length}:${chat.updatedAt || ''}:${
    uiState.highlightedMessageId || ''
  }:${uiState.streamingChatId === chat.id ? uiState.streamingAssistantText.length : 0}:${
    uiState.sending && uiState.streamingChatId === chat.id ? 1 : 0
  }`;
  if (signature === uiState.lastThreadScrollSignature) {
    return;
  }

  uiState.lastThreadScrollSignature = signature;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const scroller = document.querySelector('.thread-scroll-region');
      const highlightedMessage = uiState.highlightedMessageId
        ? document.querySelector(`[data-message-id="${uiState.highlightedMessageId}"]`)
        : null;
      if (highlightedMessage instanceof HTMLElement) {
        uiState.threadAutoFollow = false;
        highlightedMessage.scrollIntoView({ block: 'center', behavior: 'auto' });
        return;
      }

      if (!uiState.threadAutoFollow) {
        // Restore the user's saved scroll position — new DOM starts at 0
        if (scroller instanceof HTMLElement && uiState.lastKnownScrollTop > 0) {
          scroller.scrollTop = uiState.lastKnownScrollTop;
        }
        return;
      }

      if (scroller instanceof HTMLElement) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
  });
}

// P3 follow-up #1: after the user opens a search result that pointed at a
// specific line inside a file, scroll the file preview so that line lands
// in the middle of the viewport.  We defer to a double-rAF (same trick as
// `syncThreadScroll`) so the preview DOM is actually mounted before we go
// looking for the `[data-line-number]` anchor span.  The request is
// consumed once the scroll happens so later re-renders of the same file
// (e.g. after unrelated state updates) don't keep jumping the viewport.
function syncFileEditorGoToLine() {
  const pending = uiState.pendingGoToLine;
  if (!pending || !Number.isFinite(pending.line) || pending.line <= 0) {
    return;
  }

  const selectedFile = uiState.bootstrap?.workspace?.selectedFile;
  if (!selectedFile || selectedFile.path !== pending.filePath) {
    // The file we wanted isn't mounted yet (or the user navigated away).
    // Leave the request in place; a future render cycle will either mount
    // it or the next `handleSelectWorkspaceFile` call will overwrite it.
    return;
  }

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const preview = document.querySelector('.code-preview');
      if (!(preview instanceof HTMLElement)) {
        return;
      }
      const target = preview.querySelector(
        `.code-line[data-line-number="${pending.line}"]`,
      );
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ block: 'center', behavior: 'auto' });
        target.classList.add('code-line-hit');
        window.setTimeout(() => {
          target.classList.remove('code-line-hit');
        }, 1600);
      }
      // Consume the request whether or not the target existed — if the line
      // was out of range (truncated preview, short file) we don't want to
      // keep retrying on every render.
      uiState.pendingGoToLine = null;
    });
  });
}

function syncSearchFieldFocus() {
  if (
    !uiState.shouldFocusSearch ||
    uiState.bootstrap?.settings?.activeView !== 'search'
  ) {
    return;
  }

  window.requestAnimationFrame(() => {
    const input = document.querySelector('#global-search');
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    input.focus();
    input.selectionStart = input.selectionEnd = input.value.length;
    uiState.shouldFocusSearch = false;
  });
}

// 2026-05-23 Codex C 闭环: shared activation for link/PDF cards rendered as
// `<div role="link" tabindex="0" data-external-url=...>` (the WIP made the
// whole card the link target instead of an inner <a>).  Both the global
// click delegation AND the keydown handler below route through this one
// function so the click path and the keyboard (Enter/Space) path can never
// drift — keyboard activation was missing entirely before, an a11y regression
// for a focusable role=link element.  Returns true if it consumed the event.
function activateExternalCardElement(externalCard) {
  if (!(externalCard instanceof HTMLElement)) return false;
  const route = routeHttpUrlClick(externalCard.dataset.externalUrl || '', location.origin);
  if (route.kind === 'same-origin') {
    location.assign(route.href);
    return true;
  }
  if (route.kind === 'external') {
    if (!openExternalUrl(route.href)) {
      showError('Melo could not open this link.');
    }
    return true;
  }
  // 'invalid' — data attribute was empty / non-http; surface the error so the
  // activation is not silently dead.
  showError('Melo could not open this link.');
  return true;
}

// Keyboard activation for the focusable link/PDF cards: Enter matches native
// <a> (role=link) semantics; Space is accepted too for forgiveness (and
// preventDefault'd so it doesn't scroll the page).  Guarded to the focused
// card itself so Enter inside any future child control isn't hijacked.
document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
  const externalCard = event.target?.closest?.('[data-external-url]');
  if (!(externalCard instanceof HTMLElement)) return;
  if (document.activeElement !== externalCard) return;
  event.preventDefault();
  activateExternalCardElement(externalCard);
});

document.addEventListener('click', async event => {
  const copyLink = event.target.closest('[data-copy-link]');
  if (copyLink instanceof HTMLElement) {
    event.preventDefault();
    event.stopPropagation();
    try {
      await copyLinkText(copyLink.dataset.copyLink);
      showFlashToast('链接已复制');
    } catch {
      showError('复制失败，请选中链接后按 ⌘C 复制。');
    }
    return;
  }
  let closedAttachmentMenu = false;
  const editMenu = document.querySelector('#edit-context-menu');
  if (
    editMenu instanceof HTMLElement &&
    editMenu.classList.contains('is-open') &&
    !event.target.closest('#edit-context-menu')
  ) {
    closeEditableContextMenu();
  }
  const copyMenu = document.querySelector('#copy-context-menu');
  if (
    copyMenu instanceof HTMLElement &&
    copyMenu.classList.contains('is-open') &&
    !event.target.closest('#copy-context-menu')
  ) {
    closeCopyContextMenu();
  }
  const recentMenu = document.querySelector('#recent-context-menu');
  if (
    recentMenu instanceof HTMLElement &&
    recentMenu.classList.contains('is-open') &&
    !event.target.closest('#recent-context-menu')
  ) {
    closeRecentContextMenu();
  }
  const audioMenu = document.querySelector('#audio-context-menu');
  if (
    audioMenu instanceof HTMLElement &&
    audioMenu.classList.contains('is-open') &&
    !event.target.closest('#audio-context-menu')
  ) {
    closeAudioContextMenu();
  }

  if (
    uiState.composerAttachmentMenuOpen &&
    !event.target.closest('.composer-bottom-left')
  ) {
    uiState.composerAttachmentMenuOpen = false;
    closedAttachmentMenu = true;
  }

  if (uiState.modelPickerOpen && !event.target.closest('.model-picker-anchor')) {
    uiState.modelPickerOpen = false;
    render();
  }

  if (uiState.agentSelectorOpen && !event.target.closest('.agent-chip-anchor, #agent-selector-panel')) {
    uiState.agentSelectorOpen = false;
    render();
  }

  if (
    uiState.ttsVoicePanelOpen &&
    !event.target.closest('.tts-voice-panel-anchor')
  ) {
    uiState.ttsVoicePanelOpen = false;
    render();
  }

  if (
    uiState.taskLaneOverflowOpen &&
    !event.target.closest('.task-lane-overflow-anchor')
  ) {
    uiState.taskLaneOverflowOpen = false;
    render();
  }

  const anchor = event.target.closest('a[href]');
  if (anchor instanceof HTMLAnchorElement) {
    const route = routeHttpUrlClick(anchor.href, location.origin);
    if (route.kind === 'same-origin') {
      event.preventDefault();
      location.assign(route.href);
      return;
    }
    if (route.kind === 'external') {
      event.preventDefault();
      if (!openExternalUrl(route.href)) {
        showError('Melo could not open this link.');
      }
      return;
    }
    // 'invalid' (non-http(s) like #anchor / mailto / javascript:) — fall
    // through to default browser behavior.
  }

  const externalCard = event.target.closest('[data-external-url]');
  if (externalCard instanceof HTMLElement) {
    // 2026-05-23 Codex C 闭环: route through the shared activator so the
    // click and keydown paths stay identical (all three route kinds
    // preventDefault, same as before).
    event.preventDefault();
    activateExternalCardElement(externalCard);
    return;
  }

  const trigger = event.target.closest('[data-action]');
  if (!trigger || !uiState.bootstrap) {
    if (closedAttachmentMenu) {
      render();
    }
    return;
  }

  const action = trigger.dataset.action;
  if (action?.startsWith('image-')) {
    event.preventDefault();
    try { await handleImageAction(action, { config: uiState.bootstrap.settings.config, attachments: uiState.composerAttachments, api, render, refresh: () => loadBootstrap(uiState.searchQuery, { quiet: true }) }); } catch (error) { window.alert(error.message); }
    return;
  }
  if (['new-chat', 'open-chat'].includes(action)) clearImageTask();
  if (action?.startsWith('extra-fast-') && trigger.tagName === 'BUTTON') {
    event.preventDefault();
    await handleExtraFast(action, { config: uiState.bootstrap.settings.config, api, render, refresh: () => loadBootstrap(uiState.searchQuery, { quiet: true }) });
    return;
  }
  if (action?.startsWith('llm-') && trigger.tagName === 'BUTTON') {
    event.preventDefault();
    await handleLlmConnection(action, { config: uiState.bootstrap.settings.config, api, render, refresh: () => loadBootstrap(uiState.searchQuery, { quiet: true }), openUrl: openExternalUrl, chatgptLogin: handleStartModelOAuthLogin });
    return;
  }
  if (['new-chat','open-view','open-chat','focus-project','open-artifact','select-agent-profile','open-customize-section','select-palette-command','open-search-result','select-customize-item'].includes(action)) {
    uiState.neuralOverview = false;
    uiState.neuralGroup = null;
  }

  try {
    switch (action) {
      case 'toggle-model-picker':
        uiState.modelPickerOpen = !uiState.modelPickerOpen;
        uiState.ttsVoicePanelOpen = false;
        uiState.composerAttachmentMenuOpen = false;
        render();
        if (uiState.modelPickerOpen) document.querySelector('.model-picker-option.is-selected')?.focus();
        break;
      case 'pick-default-model': {
        if (uiState.modelPickerSaving) break;
        if (uiState.sending) break;
        const model = trigger.dataset.model;
        const selection = model ? {model, profileId:trigger.dataset.profileId || ''} : null;
        uiState.modelPickerSaving = true;
        render();
        try {
          if (activeChat() && !uiState.neuralOverview) applyBootstrapPreservingDrafts(await api('/api/chats/update', {method:'POST', body:{chatId:activeChat().id, patch:{modelSelection:selection}}}));
          else uiState.newChatModel = selection;
          uiState.modelPickerOpen = false;
        } finally {
          uiState.modelPickerSaving = false;
          render();
          document.querySelector('.model-picker-trigger')?.focus();
        }
        break;
      }
      case 'neural-group':
        if (!neuralGroups.some(group => group.id === trigger.dataset.group)) break;
        await flushPendingAgentMarkdownAutosave();
        await flushPendingAgentChannelAutosave();
        uiState.neuralGroup = trigger.dataset.group;
        uiState.neuralExpanded = true;
        uiState.neuralOverview = true;
        render();
        break;
      case 'neural-back':
        await flushPendingAgentMarkdownAutosave();
        await flushPendingAgentChannelAutosave();
        uiState.neuralExpanded = !uiState.neuralOverview;
        uiState.neuralOverview = true;
        render();
        break;
      case 'neural-overview':
        uiState.neuralExpanded = false;
        await flushPendingAgentMarkdownAutosave();
        await flushPendingAgentChannelAutosave();
        uiState.neuralOverview = true;
        render();
        break;
      case 'neural-motion':
        applyBootstrap(await api('/api/settings/local', {method:'POST',body:{preferences:{motion:uiState.bootstrap.settings.localPreferences?.motion === 'reduced' ? 'system' : 'reduced'}}}));
        break;
      case 'copy-surface-selection':
      case 'copy-surface-all':
      case 'copy-surface-select-all':
        await handleCopyContextAction(action);
        break;
      case 'editable-undo':
      case 'editable-redo':
      case 'editable-cut':
      case 'editable-copy':
      case 'editable-paste':
      case 'editable-select-all':
        await handleEditableContextAction(action);
        break;
      case 'toggle-chat-lock':
        if (activeRecentContextChatId) {
          await handleToggleChatLock(activeRecentContextChatId);
        }
        break;
      case 'delete-chat':
        if (activeRecentContextChatId) {
          await handleDeleteChat(activeRecentContextChatId);
        }
        break;
      case 'transcribe-audio-message':
        await handleTranscribeAudio();
        break;
      case 'new-chat':
        await handleOpenNewChatHome();
        break;
      case 'restart-interrupted-send':
        uiState.composerRetry = null;
        await handleSendMessage();
        break;
      case 'stop-send':
        handleStopSending();
        break;
      case 'open-view':
        uiState.highlightedMessageId = null;
        uiState.shouldFocusSearch = trigger.dataset.view === 'search';
        // Flush any pending agent autosaves before leaving the agent view —
        // otherwise a user typing a Discord token who hits the left sidebar
        // before the 3-second idle timer fires will lose the edit. See
        // feedback_preserve_user_config.md.
        if (uiState.bootstrap?.settings?.activeView === 'agent') {
          await flushPendingAgentMarkdownAutosave();
          await flushPendingAgentChannelAutosave();
        }
        await patchSettings({ activeView: trigger.dataset.view });
        if (trigger.dataset.view === 'search' && uiState.searchQuery.trim()) {
          await loadBootstrap(uiState.searchQuery, { quiet: true });
        }
        break;
      case 'clear-search-query':
        uiState.searchQuery = '';
        uiState.highlightedMessageId = null;
        uiState.shouldFocusSearch = true;
        await loadBootstrap('', { quiet: true });
        break;
      case 'open-search-result':
        await handleOpenSearchResult(
          currentSearchResultById(trigger.dataset.resultId),
        );
        break;
      case 'toggle-search-group-hits': {
        // Flip the expansion flag for one file-group row so its hit sub-list
        // shows / hides.  Keyed by filePath (stable across re-streams).
        const filePath = trigger.dataset.filePath || '';
        if (!filePath) break;
        const current = uiState.expandedSearchGroups || {};
        if (current[filePath]) {
          delete current[filePath];
        } else {
          current[filePath] = true;
        }
        uiState.expandedSearchGroups = { ...current };
        render();
        break;
      }
      case 'open-file-match-line': {
        // Direct drill-down from an expanded sub-hit: open the file at the
        // exact line the user clicked.  We credit the click boost to the
        // parent group-level result id so ranking still learns from
        // sub-hit interactions.
        const filePath = trigger.dataset.filePath || '';
        const lineNumber = Number(trigger.dataset.lineNumber) || 0;
        const parentId = trigger.dataset.parentResultId || '';
        if (!filePath) break;
        if (parentId) recordSearchClickBoost(parentId);
        uiState.highlightedMessageId = null;
        uiState.shouldFocusSearch = false;
        await handleSelectWorkspaceFile(filePath, { lineNumber });
        break;
      }
      case 'open-command-palette':
        uiState.shouldFocusSearch = false;
        openCommandPalette();
        break;
      case 'start-model-oauth':
        await handleStartModelOAuthLogin();
        break;
      case 'refresh-model-status':
        await handleRefreshModelStatus();
        break;
      case 'submit-agent-profile': {
        const formId = trigger.dataset.formId;
        const form = formId ? document.getElementById(formId) : null;
        if (form instanceof HTMLFormElement) {
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          } else {
            form.dispatchEvent(
              new Event('submit', {
                bubbles: true,
                cancelable: true,
              }),
            );
          }
        }
        break;
      }
      case 'set-model-auth-mode': {
        const nextAuthMode = trigger.dataset.authMode || 'codex';
        const defaults = modelDefaultsForAuthMode(nextAuthMode);
        uiState.modelSetupDraft = {
          ...(uiState.modelSetupDraft || effectiveModelSetupDraft()),
          authMode: nextAuthMode,
          baseUrl: defaults.baseUrl,
          model: modelOptionsForAuthMode(nextAuthMode)[0] || defaults.model,
        };
        render();
        // Settings → Model 用按钮切换 authMode（不是 <select>），所以
        // input/change listener 都不会触发新增的 connector autosave。
        // 直接走同一管线，让 "切到 api-key 后等 3 秒切走" 也能保存。
        // scheduleConnectorAutosave 内部已经过滤 authMode='codex'（避免
        // 把已保存 OAuth 切换的瞬间清掉用户存的 OpenAI key），所以这里
        // 无脑接入即可。
        //
        // ⚠️ render() 之上的 `trigger` 节点已被 app.innerHTML 重建
        // 从 DOM detach；走 trigger 的 closest-form 查找会拿到 orphan
        // form 或直接 null，scheduleConnectorAutosave 的 FormData 就
        // 读不到新 SSR 值，整条接线静默失败。改用稳定 id 在 render
        // 之后重新查 *活的* form 节点。Codex audit 2026-04-28。
        const authForm = document.getElementById('model-config-form');
        if (authForm instanceof HTMLFormElement) {
          // Settings are committed only by the explicit Save action.
        }
        break;
      }
      case 'load-model-options': {
        const form = trigger.closest('form');
        if (form instanceof HTMLFormElement) {
          await handleLoadModelOptions(form);
        }
        break;
      }
      case 'close-command-palette':
        closeCommandPalette();
        break;
      case 'switch-mode':
        uiState.highlightedMessageId = null;
        uiState.shouldFocusSearch = false;
        await patchSettings({
          activeMode: trigger.dataset.mode,
          activeView: 'chat',
        });
        break;
      case 'apply-home-prompt': {
        const preset = homePromptPresetById(trigger.dataset.presetId);
        if (!preset) {
          break;
        }
        if (preset.mode) {
          await patchSettings({
            activeMode: preset.mode,
            activeView: 'chat',
          });
        }
        uiState.composer = preset.prompt;
        render();
        focusComposerSoon();
        break;
      }
      case 'open-chat': {
        prepareThreadNavigation({
          highlightedMessageId: null,
          autoFollow: true,
        });
        uiState.shouldFocusSearch = false;
        const chat = uiState.bootstrap.chats.find(item => item.id === trigger.dataset.chatId);
        await patchSettings({
          selectedChatId: trigger.dataset.chatId,
          activeView: 'chat',
          activeMode: chat?.mode || 'chat',
          selectedProjectId:
            chat?.projectId || null,
          selectedFilePath: null,
        });
        break;
      }
      case 'select-project':
      case 'focus-project':
        await patchSettings({
          selectedProjectId: trigger.value || trigger.dataset.projectId,
          activeView: action === 'focus-project' ? 'projects' : uiState.bootstrap.settings.activeView,
        });
        break;
      case 'clear-project-selection':
        // Return from the detail view to the grid overview. Keep activeView
        // pinned to 'projects' so we stay on this page.
        await patchSettings({
          selectedProjectId: null,
          activeView: 'projects',
        });
        break;
      case 'chat-from-project':
        await startProjectSession(trigger.dataset.projectId, 'chat');
        break;
      case 'code-from-project':
        await startProjectSession(trigger.dataset.projectId, 'code');
        break;
      case 'confirm-agent-settings': {
        await api('/api/agent-settings-sync/confirm',{method:'POST',body:{id:trigger.dataset.id,expected:trigger.dataset.expected,accept:trigger.dataset.accept==='true'}});
        applyBootstrap(await api('/api/bootstrap')); break;
      }
      case 'resolve-sync-conflict': {
        const settings=trigger.dataset.settings==='true';
        const row=(settings?uiState.bootstrap.agentSettingsConflicts:uiState.bootstrap.syncConflicts).find(r=>r.kind===trigger.dataset.kind&&r.id===trigger.dataset.id);
        const index=Number(trigger.dataset.index);
        await api(settings?'/api/agent-settings-sync/resolve':'/api/mobile-sync/resolve',{method:'POST',body:{kind:row.kind,id:row.id,index,expected:row.versions[index]}});
        applyBootstrap(await api('/api/bootstrap')); break;
      }
      case 'toggle-project-form':
        uiState.showProjectForm = !uiState.showProjectForm;
        render();
        break;
      case 'toggle-archived-projects':
        uiState.showArchivedProjects = !uiState.showArchivedProjects; render(); break;
      case 'archive-project':
        applyBootstrap(await api('/api/projects/update',{method:'POST',body:{projectId:trigger.dataset.projectId,patch:{archived:trigger.dataset.archived==='true'}}}));
        break;
      case 'toggle-task-form':
        uiState.showTaskForm = !uiState.showTaskForm;
        render();
        break;
      case 'toggle-artifact-form':
        uiState.showArtifactForm = !uiState.showArtifactForm;
        render();
        break;
      case 'open-customize-section':
        await patchSettings({
          activeView: 'customize',
          selectedCustomizeSection: trigger.dataset.section,
        });
        break;
      case 'memory-fact-search':
      case 'memory-fact-prev':
      case 'memory-fact-next':
      case 'memory-fact-edit':
      case 'memory-fact-cancel':
      case 'memory-fact-save':
      case 'memory-fact-forget':
      case 'memory-fact-restore':
        await handleMemoryFactAction(action,trigger.dataset.id || trigger.closest('[data-memory-record]')?.dataset.memoryRecord);
        break;
      case 'memory-pause':
      case 'memory-diagnose':
      case 'memory-connect':
      case 'memory-repair':
        await handleMemoryRepairAction(action);
        break;
      case 'refresh-memory-status':
        // Reset cache so re-opening the panel forces a fresh collect.
        uiState.memoryStatus.loaded = false;
        await refreshMemoryStatus();
        break;
      case 'refresh-safety-allowlist':
        uiState.safetyAllowlist.loaded = false;
        await refreshSafetyAllowlist();
        break;
      case 'safety-allowlist-remove':
        await removeSafetyAllowlistRule(trigger.dataset.ruleId);
        break;
      case 'refresh-domain-cookies':
        uiState.domainCookies.loaded = false;
        await refreshDomainCookies();
        break;
      case 'domain-cookie-save': {
        // Pull the current input values into state right before save —
        // input listeners only sync on the next keystroke, so reading
        // the DOM directly here ensures we don't miss the last char.
        const hostInput = document.querySelector('[data-domain-cookie-host]');
        const cookieInput = document.querySelector('[data-domain-cookie-string]');
        if (hostInput) uiState.domainCookies.addHost = hostInput.value || '';
        if (cookieInput) uiState.domainCookies.addCookie = cookieInput.value || '';
        await upsertDomainCookie();
        break;
      }
      case 'domain-cookie-remove':
        await removeDomainCookie(trigger.dataset.host);
        break;
      case 'memory-wipe-open':
        uiState.memoryStatus.wipeConfirmOpen = true;
        uiState.memoryStatus.wipeResult = null;
        render();
        break;
      case 'memory-wipe-cancel':
        uiState.memoryStatus.wipeConfirmOpen = false;
        render();
        break;
      case 'memory-wipe-confirm':
        await doWipeEmbeddings();
        break;
      case 'skill-detail-tab':
        // Phase 3 — switch between Overview and Markdown tabs for a Skill.
        uiState.skillDetailTab = trigger.dataset.tab || 'overview';
        render();
        if (uiState.skillDetailTab === 'markdown') {
          const id = trigger.dataset.skillId;
          if (id && !uiState.skillMarkdown[id]?.markdown) {
            refreshSkillMarkdown(id);
          }
        }
        break;
      case 'copy-skill-markdown': {
        const id = trigger.dataset.skillId;
        const cached = id ? uiState.skillMarkdown[id]?.markdown : null;
        if (cached && navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(cached);
            uiState.skillMarkdown[id] = { ...uiState.skillMarkdown[id], copyToast: 'Copied' };
            render();
            setTimeout(() => {
              if (uiState.skillMarkdown[id]) {
                uiState.skillMarkdown[id] = { ...uiState.skillMarkdown[id], copyToast: null };
                bgRender();
              }
            }, 1500);
          } catch (err) {
            uiState.skillMarkdown[id] = { ...uiState.skillMarkdown[id], copyToast: 'Copy failed' };
            render();
          }
        }
        break;
      }
      case 'select-agent-profile':
        await flushPendingAgentMarkdownAutosave();
        await flushPendingAgentChannelAutosave();
        await patchSettings({
          activeView: 'agent',
          selectedAgentId: trigger.dataset.agentId || trigger.value || 'main',
        });
        break;
      case 'create-custom-agent':
        await handleCreateCustomAgent();
        break;
      case 'switch-agent-scope':
        await flushPendingAgentMarkdownAutosave();
        await flushPendingAgentChannelAutosave();
        await patchSettings({
          activeView:
            uiState.bootstrap.settings.activeView === 'agent' ? 'agent' : 'customize',
          selectedCustomizeSection: 'agents',
          selectedAgentScope: trigger.dataset.scope === 'project' ? 'project' : 'global',
        });
        break;
      case 'export-agent-document': {
        const draft = agentDraftFor(agentProfileById(trigger.dataset.agentId));
        const text = draft?.instructions ?? '';
        if (window.webkit?.messageHandlers?.meloVoice) {
          const result = await nativeSettings('savePortableArchive', {text, name:'AGENT.md'});
          showFlashToast(result.cancelled ? t('已取消导出。') : t('已导出 Markdown。'));
          return;
        }
        const url = URL.createObjectURL(new Blob([text], {type:'text/markdown;charset=utf-8'}));
        const link = document.createElement('a'); link.href=url; link.download='AGENT.md'; link.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
        return;
      }
      case 'select-agent-editor-tab':
        await flushPendingAgentMarkdownAutosave();
        await flushPendingAgentChannelAutosave();
        uiState.agentEditorTab = trigger.dataset.tab === 'soul' ? 'soul' : 'identity';
        uiState.shouldFocusAgentEditor = true;
        render();
        break;
      case 'import-agent-preset':
        await handleImportAgentPreset(trigger.dataset.agentId, trigger.dataset.presetId);
        break;
      case 'reset-agent-draft': {
        const agentId = trigger.dataset.agentId;
        if (agentId) {
          delete uiState.agentDrafts[agentDraftKey(agentId)];
          render();
        }
        break;
      }
      case 'reset-project-agent-override':
        await handleResetProjectAgentOverride(trigger.dataset.agentId);
        break;
      case 'toggle-agent-tool': {
        const agentId = trigger.dataset.agentId;
        const toolId = trigger.dataset.toolId;
        const draftKey = agentDraftKey(agentId);
        const currentDraft = {
          ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
        };
        const nextTools = new Set(currentDraft.tools || []);
        if (nextTools.has(toolId)) {
          nextTools.delete(toolId);
        } else {
          nextTools.add(toolId);
        }
        currentDraft.tools = [...nextTools];
        uiState.agentDrafts[draftKey] = currentDraft;
        render();
        break;
      }
      case 'toggle-agent-skill': {
        // Toggle a specific skill ID in the per-agent skill whitelist.
        // null draft value means "no restriction" — first toggle initialises it to [skillId].
        const agentId = trigger.dataset.agentId;
        const skillId = trigger.dataset.skillId;
        const draftKey = agentDraftKey(agentId);
        const currentDraft = {
          ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
        };
        const currentIds = Array.isArray(currentDraft.enabledSkillIds)
          ? new Set(currentDraft.enabledSkillIds)
          : new Set(); // null → treat as empty set so first click adds the skill
        if (currentIds.has(skillId)) {
          currentIds.delete(skillId);
        } else {
          currentIds.add(skillId);
        }
        currentDraft.enabledSkillIds = [...currentIds];
        uiState.agentDrafts[draftKey] = currentDraft;
        render();
        break;
      }
      case 'reset-agent-skill-whitelist': {
        // Reset to "no restriction" (null = all skills allowed)
        const agentId = trigger.dataset.agentId;
        const draftKey = agentDraftKey(agentId);
        const currentDraft = {
          ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
        };
        currentDraft.enabledSkillIds = null;
        uiState.agentDrafts[draftKey] = currentDraft;
        render();
        break;
      }
      case 'toggle-agent-connector': {
        // Toggle a specific external connector ID in the per-agent connector whitelist.
        const agentId = trigger.dataset.agentId;
        const connectorId = trigger.dataset.connectorId;
        const draftKey = agentDraftKey(agentId);
        const currentDraft = {
          ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
        };
        const currentIds = Array.isArray(currentDraft.enabledConnectorIds)
          ? new Set(currentDraft.enabledConnectorIds)
          : new Set();
        if (currentIds.has(connectorId)) {
          currentIds.delete(connectorId);
        } else {
          currentIds.add(connectorId);
        }
        currentDraft.enabledConnectorIds = [...currentIds];
        uiState.agentDrafts[draftKey] = currentDraft;
        render();
        break;
      }
      case 'reset-agent-connector-whitelist': {
        const agentId = trigger.dataset.agentId;
        const draftKey = agentDraftKey(agentId);
        const currentDraft = {
          ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
        };
        currentDraft.enabledConnectorIds = null;
        uiState.agentDrafts[draftKey] = currentDraft;
        render();
        break;
      }
      case 'toggle-agent-mcp-server': {
        // Toggle a specific stdio MCP server id in the per-agent whitelist.
        // No "All servers" sentinel here — MCP defaults to deny-all, the
        // user has to add each server explicitly.
        //
        // Rules:
        //   - Removing (whitelist already contains the id) is always
        //     allowed, even when the server is globally disabled. This
        //     lets the user revoke stale authorisations after toggling
        //     a server off in Advanced (without it, a re-enable later
        //     would silently grant the old access back — Codex 🔵
        //     2026-04-28 audit).
        //   - Adding a new authorisation for a globally-disabled
        //     server is refused with a flash-toast pointing the user
        //     at Advanced. Better than failing silently.
        const agentId = trigger.dataset.agentId;
        const mcpServerId = trigger.dataset.mcpServerId;
        const presetEnabled = trigger.dataset.presetEnabled === '1';
        const presetUnpinned = trigger.dataset.presetUnpinned === '1';
        const draftKey = agentDraftKey(agentId);
        const currentDraft = {
          ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
        };
        // Decision lives in `desktop-ui/agentMcpAuthorise.js` so node:test
        // can pin the remove-always-allowed / add-refused-on-disabled-or-
        // unpinned table without simulating click events.
        const decision = decideAgentMcpAuthAction({
          currentIds: currentDraft.enabledMcpServerIds,
          serverId: mcpServerId,
          presetEnabled,
          presetUnpinned,
        });
        if (decision.action.startsWith('refused-') || decision.action === 'refused-invalid') {
          if (decision.toast) showFlashToast(decision.toast);
          break;
        }
        currentDraft.enabledMcpServerIds = decision.nextIds;
        uiState.agentDrafts[draftKey] = currentDraft;
        render();
        break;
      }
      case 'toggle-mcp-preset': {
        // Advanced page MCP toggle — flip the corresponding `enable*Mcp`
        // config flag and re-bootstrap the MCP servers so the change
        // takes effect immediately.  Server-side validates that the flag
        // is one of the whitelisted built-ins.
        const flag = trigger.dataset.presetFlag;
        const nextEnabled = trigger.dataset.nextEnabled === '1';
        if (!flag) break;
        try {
          await api('/api/mcp/preset-toggle', {
            method: 'POST',
            body: { flag, enabled: nextEnabled },
          });
          // Refresh the bootstrap so mcpPresets[].enabled reflects the new
          // flag values; also clear the Advanced cache so the connected-
          // tools count updates on the next render.
          uiState.advanced = { ...uiState.advanced, loaded: false };
          await loadBootstrap(uiState.searchQuery, { quiet: true });
          await refreshAdvancedStatus();
        } catch (err) {
          uiState.error = `Toggle failed: ${err?.message || err}`;
          render();
          setTimeout(() => { uiState.error = null; render(); }, 4000);
        }
        break;
      }
      case 'toggle-agent-secret': {
        const agentId = trigger.dataset.agentId;
        const channelId = trigger.dataset.channelId;
        if (agentId && channelId) {
          const key = agentSecretVisibilityKey(agentId, channelId);
          uiState.agentSecretVisibility[key] = !uiState.agentSecretVisibility[key];
          render();
        }
        break;
      }
      case 'switch-agent-channel-tab': {
        const agentId = trigger.dataset.agentId;
        const channelId = trigger.dataset.channelId;
        const VALID_TABS = ['telegram', 'discord', 'lark'];
        if (agentId && VALID_TABS.includes(channelId)) {
          // Flush any pending debounced autosave before switching tabs so
          // in-flight edits (e.g. a bot token typed <350ms ago) are not lost
          // when the re-render discards the draft.
          if (pendingAgentChannelAutosave && pendingAgentChannelAutosave.agentId === agentId) {
            if (agentChannelAutosaveTimer) {
              window.clearTimeout(agentChannelAutosaveTimer);
              agentChannelAutosaveTimer = null;
            }
            const snapshot = pendingAgentChannelAutosave;
            pendingAgentChannelAutosave = null;
            try {
              await saveAgentChannelSnapshot(snapshot);
            } catch (error) {
              showError(error.message);
              return;
            }
          }
          uiState.agentChannelTab[agentId] = channelId;
          render();
        }
        break;
      }
      case 'test-agent-channel':
        await handleTestAgentChannel(trigger);
        break;
      case 'copy-melo-state-path': {
        const path = trigger.dataset.path || '~/.melo/desktop/state.json';
        if (navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(path);
            showFlashToast(`Copied ${path}`);
          } catch {
            showFlashToast('Copy failed — clipboard access denied');
          }
        } else {
          showFlashToast('Copy unavailable in this browser');
        }
        break;
      }
      case 'select-customize-item':
        if (trigger.dataset.section === 'skills') {
          await patchSettings({
            activeView: 'customize',
            selectedCustomizeSection: 'skills',
            selectedSkillId: trigger.dataset.id,
          });
        } else if (trigger.dataset.section === 'agents') {
          await patchSettings({
            activeView: 'customize',
            selectedCustomizeSection: 'agents',
            selectedAgentId: trigger.dataset.id,
          });
        } else {
          await patchSettings({
            activeView: 'customize',
            selectedCustomizeSection: 'connectors',
            selectedConnectorId: trigger.dataset.id,
          });
        }
        break;
      case 'toggle-skill':
        // Use preserving variant — user could have another form open (agent channel
        // autosave draft, connector config, etc.) and toggling a skill chip must not
        // wipe their mid-typed text elsewhere.
        applyBootstrapPreservingDrafts(
          await api('/api/customize/skill-toggle', {
            method: 'POST',
            body: { skillId: trigger.dataset.skillId },
          }),
        );
        break;
      case 'scroll-thread-to-bottom': {
        // User clicked the floating "jump to latest" arrow. Re-enable
        // auto-follow so subsequent streaming chunks keep the view pinned to
        // the bottom, and snap to bottom immediately (instant, not smooth —
        // a smooth animation fires scroll events mid-animation that would
        // briefly flip auto-follow back off and make the button flicker).
        uiState.threadAutoFollow = true;
        uiState.lastKnownScrollTop = 0;
        const scroller = document.querySelector('.thread-scroll-region');
        if (scroller instanceof HTMLElement) {
          scroller.scrollTop = scroller.scrollHeight;
        }
        render();
        break;
      }
      case 'set-skill-filter-tag': {
        // Phase 3.3.2 — empty string ("All tags" chip) clears the tag filter.
        const nextTag = trigger.dataset.tag || '';
        uiState.skillFilter.tag = nextTag ? nextTag : null;
        render();
        break;
      }
      case 'reset-skill-filter':
        uiState.skillFilter = { query: '', tag: null, state: 'all' };
        render();
        break;
      case 'pick-slash-skill': {
        // Phase 3.3.3 — replace the "/<query>" prefix with "/<skillId> " and
        // close the palette. Leaving a trailing space lets the user type args
        // immediately (e.g., "/pdf-maker summarize <file>").
        const skillId = trigger.dataset.skillId || '';
        if (skillId) {
          uiState.composer = `/${skillId} `;
          uiState.slashPalette.open = false;
          uiState.slashPalette.query = '';
          uiState.slashPalette.selectedIndex = 0;
          render();
          // Refocus the composer and move cursor to end after render.
          queueMicrotask(() => {
            const ta = document.querySelector('#composer');
            if (ta) {
              ta.focus();
              ta.setSelectionRange(ta.value.length, ta.value.length);
            }
          });
        }
        break;
      }
      case 'refresh-skill-runs':
        refreshSkillRunStats();
        break;
      case 'dismiss-skill-proposal':
        await api('/api/skill-proposals/dismiss', {
          method: 'POST',
          body: { seedId: trigger.dataset.seedId },
        });
        // Drop the proposal from the in-memory bootstrap immediately so the
        // user sees it vanish without waiting for a full refresh.
        if (uiState.bootstrap?.customize?.skillProposals) {
          uiState.bootstrap.customize.skillProposals =
            uiState.bootstrap.customize.skillProposals.filter(
              p => p.seedId !== trigger.dataset.seedId,
            );
          render();
        }
        break;
      case 'promote-skill-proposal': {
        // Jump the user to the custom-skill create card with the
        // proposal's summary pre-filled. The actual LLM-backed drafting
        // still goes through /save-as-skill on the CLI or Telegram side —
        // the UI path is a "seed the form" shortcut so the user finishes
        // the wording themselves.
        const seedId = trigger.dataset.seedId;
        const proposal = (uiState.bootstrap?.customize?.skillProposals || []).find(
          p => p.seedId === seedId,
        );
        await patchSettings({
          activeView: 'customize',
          selectedCustomizeSection: 'skills',
        });
        if (proposal) {
          // Drop the proposal once the user engages with it so the panel
          // doesn't keep re-offering it on every render.
          await api('/api/skill-proposals/dismiss', {
            method: 'POST',
            body: { seedId },
          });
          uiState.bootstrap.customize.skillProposals =
            uiState.bootstrap.customize.skillProposals.filter(p => p.seedId !== seedId);
          // Populate the create-skill form with a starting point.
          setTimeout(() => {
            const form = document.querySelector('[data-form="skill-custom-create"]');
            if (!form) return;
            form.elements.description && (form.elements.description.value = proposal.summary || '');
            form.elements.systemPrompt
              && (form.elements.systemPrompt.value =
                `Reusable workflow auto-suggested from ${proposal.occurrences || 1}× repetition.`);
            form.elements.id?.focus();
          }, 0);
        }
        break;
      }
      case 'save-chat-as-skill': {
        // Phase 5C — the chat / agent equivalent of /save-as-skill.
        // 1. Call the drafting endpoint with the active chatId.
        // 2. Navigate to Customize → Skills.
        // 3. Pre-fill the create form with the returned draft so the user
        //    can review, tweak, and confirm before it is persisted. We
        //    never auto-save because the workflow usually touches external
        //    bots — explicit confirmation is the whole point.
        const chatId =
          trigger.dataset.chatId
          || activeChat()?.id
          || uiState.bootstrap?.settings?.selectedChatId
          || '';
        if (!chatId) {
          showError('Open a chat first before saving it as a skill.');
          break;
        }
        const hint = trigger.dataset.hint || '';
        let result;
        try {
          result = await api('/api/skills/draft-from-chat', {
            method: 'POST',
            body: { chatId, hint },
          });
        } catch (err) {
          showError(`Skill drafting failed: ${err?.message || err}`);
          break;
        }
        if (!result?.ok || !result.skill) {
          const reason = result?.reason || result?.error || 'Unknown drafting error.';
          showError(`Could not draft a skill from this chat: ${reason}`);
          break;
        }
        const drafted = result.skill;
        await patchSettings({
          activeView: 'customize',
          selectedCustomizeSection: 'skills',
        });
        setTimeout(() => {
          const form = document.querySelector('[data-form="skill-custom-create"]');
          if (!form) return;
          form.elements.id && (form.elements.id.value = drafted.id || '');
          form.elements.name && (form.elements.name.value = drafted.name || '');
          form.elements.description
            && (form.elements.description.value = drafted.description || '');
          form.elements.systemPrompt
            && (form.elements.systemPrompt.value = drafted.systemPrompt || '');
          if (form.elements.type) {
            form.elements.type.value =
              drafted.type === 'prompt' ? 'prompt' : 'executable';
          }
          if (form.elements.maxIterations && Number.isFinite(drafted.maxIterations)) {
            form.elements.maxIterations.value = String(drafted.maxIterations);
          }
          if (form.elements.allowedAgentIds && Array.isArray(drafted.allowedAgentIds)) {
            form.elements.allowedAgentIds.value = drafted.allowedAgentIds.join(', ');
          }
          if (form.elements.toolWhitelist && Array.isArray(drafted.toolWhitelist)) {
            form.elements.toolWhitelist.value = drafted.toolWhitelist.join(', ');
          }
          form.elements.name?.focus();
        }, 0);
        break;
      }
      case 'toggle-connector':
        // Same rationale as toggle-skill: a connector toggle chip click must not
        // wipe an in-flight agent-channel or connector-config draft.
        applyBootstrapPreservingDrafts(
          await api('/api/customize/connector-toggle', {
            method: 'POST',
            body: { connectorId: trigger.dataset.connectorId },
          }),
        );
        break;
      case 'select-artifact':
        uiState.selectedArtifactId = trigger.dataset.artifactId;
        render();
        break;
      case 'artifact-collection':
        uiState.artifactCollection=trigger.dataset.collection;uiState.selectedArtifactId=null;render();break;
      case 'open-artifact':
        uiState.artifactCollection=uiState.bootstrap.results?.some(a=>a.id===trigger.dataset.artifactId)?'results':'knowledge';
        uiState.selectedArtifactId = trigger.dataset.artifactId;
        await patchSettings({ activeView: 'artifacts' });
        break;
      case 'select-file':
      case 'open-file':
        await handleSelectWorkspaceFile(trigger.dataset.filePath);
        break;
      case 'start-edit-file':
        startSelectedFileEdit();
        break;
      case 'cancel-edit-file':
        resetFileEditor();
        render();
        break;
      case 'apply-artifact-to-selected-file':
        await handleApplyArtifactToSelectedFile(trigger.dataset.artifactId);
        break;
      case 'start-edit-artifact':
        handleStartEditArtifact(trigger.dataset.artifactId);
        break;
      case 'cancel-edit-artifact':
        handleCancelEditArtifact();
        break;
      case 'delete-artifact':
        await handleDeleteArtifact(trigger.dataset.artifactId);
        break;
      case 'ping-connector':
        await handlePingExternalConnector(trigger.dataset.connectorId);
        break;
      case 'refresh-advanced-status':
        await refreshAdvancedStatus();
        break;
      case 'reload-mcp-servers':
        await handleReloadMcpServers();
        break;
      case 'disconnect-mcp-server':
        await handleDisconnectMcpServer(trigger.dataset.serverName);
        break;
      case 'kill-background-task':
        await handleKillBackgroundTask(trigger.dataset.runId);
        break;
      case 'remove-custom-skill':
        await handleRemoveCustomSkill(trigger.dataset.skillId);
        break;
      case 'execute-approval':
        await handleExecuteApproval(trigger.dataset.approvalId);
        break;
      case 'reject-approval':
        await handleRejectApproval(trigger.dataset.approvalId);
        break;
      case 'tool-permission-allow-once':
        await handleToolPermissionResponse(
          trigger.dataset.requestId,
          trigger.dataset.toolId,
          true,
          'once',
        );
        break;
      case 'tool-permission-allow-always':
        await handleToolPermissionResponse(
          trigger.dataset.requestId,
          trigger.dataset.toolId,
          true,
          'always',
        );
        break;
      case 'tool-permission-deny':
        await handleToolPermissionResponse(
          trigger.dataset.requestId,
          trigger.dataset.toolId,
          false,
          'once',
        );
        break;
      case 'file-safety-allow':
        await handleFileSafetyResponse(
          trigger.dataset.requestId,
          true,
          trigger.dataset.scope || 'once',
          '',
          trigger.dataset.persistent === '1',
        );
        break;
      case 'file-safety-deny':
        await handleFileSafetyResponse(
          trigger.dataset.requestId,
          false,
          'deny',
        );
        break;
      case 'file-safety-confirm-delete': {
        const input = document.querySelector('[data-file-safety-confirm-input]');
        const confirmInput = input ? String(input.value || '') : '';
        await handleFileSafetyResponse(
          trigger.dataset.requestId,
          true,
          'once',
          confirmInput,
        );
        break;
      }
      case 'preview-task-backup':
        await previewTaskBackup(trigger.dataset.operationId);
        break;
      case 'confirm-task-restore':
        await confirmTaskRestore(trigger.dataset.token);
        break;
      case 'set-task-status':
        if (trigger.dataset.status === 'done') {
          const acceptanceChecks = Object.fromEntries([...document.querySelectorAll('[data-task-check]')].filter(el => el.dataset.taskCheck === trigger.dataset.taskId).map(el => [el.dataset.criterion, el.checked]));
          try { applyBootstrap(await api('/api/tasks/update', { method:'POST', body: { taskId:trigger.dataset.taskId, patch:{status:'done',acceptanceChecks,qualityScore:document.getElementById(`quality-score-${trigger.dataset.taskId}`)?.value} } })); render(); } catch(error) { showError(error.message); }
          break;
        }
        await handleUpdateTaskStatus(trigger.dataset.taskId, trigger.dataset.status);
        break;
      case 'task-operations':
        try { uiState.taskOperations ||= {}; uiState.taskOperations[trigger.dataset.taskId] = (await api(`/api/tasks/operations?taskId=${encodeURIComponent(trigger.dataset.taskId)}`)).operations; render(); } catch(error) { showError(error.message); }
        break;
      case 'task-operation-retry':
        try { await api('/api/tasks/operations/retry',{method:'POST',body:{taskId:trigger.dataset.taskId,key:trigger.dataset.key,confirm:'verified-not-applied'}}); uiState.taskOperations[trigger.dataset.taskId] = uiState.taskOperations[trigger.dataset.taskId].filter(r=>r.key!==trigger.dataset.key); render(); } catch(error) { showError(error.message); }
        break;
      case 'run-chat-team': {
        const chat=activeChat(), content=uiState.composer.trim();
        if(!content) {showError('请先在输入框写下团队任务。');break;}
        await handleSendMessage({chatId:chat?.id,content,teamPlan:{templateId:document.getElementById('chat-team-template')?.value || 'research-build-review',...(document.getElementById('chat-team-members')?.value?.trim()?{members:document.getElementById('chat-team-members').value.split(',').map(s=>s.trim()).filter(Boolean)}:{})}});break;
      }
      case 'run-task-team':
        await handleRunTask(trigger.dataset.taskId, {templateId:document.getElementById(`team-plan-${trigger.dataset.taskId}`)?.value || 'research-build-review'});
        break;
      case 'run-task':
        await handleRunTask(trigger.dataset.taskId);
        break;
      case 'run-task-lane':
        // Close the overflow menu after picking a non-primary lane so the
        // user doesn't have to dismiss it manually.
        uiState.taskLaneOverflowOpen = false;
        await handleRunTaskLane(trigger.dataset.owner);
        break;
      case 'toggle-task-lane-overflow':
        uiState.taskLaneOverflowOpen = !uiState.taskLaneOverflowOpen;
        render();
        break;
      case 'insert-command':
        uiState.composer = trigger.dataset.command || '/';
        render();
        break;
      case 'toggle-composer-attachment-menu':
        uiState.composerAttachmentMenuOpen = !uiState.composerAttachmentMenuOpen;
        render();
        break;
      case 'pick-composer-attachment':
        openComposerAttachmentPicker(trigger.dataset.accept || 'image/*,video/*,audio/*');
        break;
      case 'add-link-attachment':
        promptComposerLinkAttachment();
        break;
      case 'remove-composer-attachment':
        uiState.composerAttachments = uiState.composerAttachments.filter(
          attachment => attachment.id !== trigger.dataset.attachmentId,
        );
        render();
        break;
      case 'cancel-voice-input':
        voiceInput.cancel();
        break;
      case 'toggle-voice-input':
        toggleVoiceInput();
        break;
      case 'speak-message':
        await handleSpeakMessage(trigger);
        break;
      case 'toggle-tts-autoplay':
        uiState.ttsVoicePanelOpen = !uiState.ttsVoicePanelOpen;
        // Lazy-load macOS voices the first time the panel opens so users
        // see the actual /usr/bin/say voices in the dropdown rather than
        // the (irrelevant) browser speechSynthesis list.
        if (uiState.ttsVoicePanelOpen && !uiState.ttsMacosVoicesLoaded) {
          loadMacosVoices();
        }
        render();
        break;
      case 'toggle-tts-enable':
        uiState.ttsAutoPlay = !uiState.ttsAutoPlay;
        localStorage.setItem('melo-tts-autoplay', uiState.ttsAutoPlay ? '1' : '0');
        if (!uiState.ttsAutoPlay) stopCurrentTts();
        // Sync to server config so Telegram polling can read it for voice replies.
        // Background call — must preserve drafts so it doesn't wipe mid-typed form state.
        api('/api/settings/model', {
          method: 'POST',
          body: { ttsAutoPlay: uiState.ttsAutoPlay },
        }).then(payload => applyBootstrapPreservingDrafts(payload)).catch(() => {});
        render();
        break;
      case 'set-tts-engine': {
        uiState.ttsEngine = trigger.dataset.engine || 'auto';
        localStorage.setItem('melo-tts-engine', uiState.ttsEngine);
        // Switching to "API voice" clears the Edge-TTS custom provider so
        // the OpenAI /audio/speech path takes over. We must NOT clear a
        // 'minimax' provider here — the speak-text MiniMax fast path is
        // gated on `ttsProvider === 'minimax'`, and dropping it falls back
        // to the Fish-Speech path which most users have no config for.
        // 'activate-edge-tts' / 'activate-minimax-voice' own their own
        // provider transitions; this radio toggle never should.
        const currentProvider = String(uiState.bootstrap?.settings?.config?.ttsProvider || '').trim();
        if (uiState.ttsEngine === 'api' && currentProvider === 'edge') {
          api('/api/settings/model', {
            method: 'POST',
            body: { ttsProvider: '' },
          }).then(payload => applyBootstrapPreservingDrafts(payload)).catch(() => {});
        }
        render();
        break;
      }
      case 'activate-edge-tts': {
        uiState.ttsEngine = 'api';
        localStorage.setItem('melo-tts-engine', 'api');
        api('/api/settings/model', {
          method: 'POST',
          body: { ttsProvider: 'edge' },
        }).then(payload => applyBootstrapPreservingDrafts(payload)).catch(() => {});
        render();
        break;
      }
      case 'activate-local-voice-pack': {
        uiState.ttsEngine = 'api';
        localStorage.setItem('melo-tts-engine', 'api');
        api('/api/settings/model', {
          method: 'POST',
          body: { whisperBaseUrl: 'http://127.0.0.1:7860/v1', ttsProvider: '' },
        }).then(payload => applyBootstrapPreservingDrafts(payload)).catch(() => {});
        uiState.ttsVoicePanelOpen = false;
        render();
        break;
      }
      case 'test-minimax-tts': {
        // Send whatever the user has typed; the server falls back to the
        // saved config for any blank field (so the masked password input
        // doesn't force users to retype an already-saved key). Status
        // renders inline next to the button. Mirror handleSaveConnectorConfig:
        // the password input always renders empty, so prefer the shared
        // draft (kept up to date by the form input handler) before
        // falling back to FormData.
        const form = trigger.closest('form#connector-config-form');
        const status = form?.querySelector('[data-tts-test-status]');
        const fd = form ? new FormData(form) : null;
        const draft = uiState.modelSetupDraft || {};
        const apiKey  = pickConnectorField(draft, fd, 'minimaxApiKey');
        const groupId = pickConnectorField(draft, fd, 'minimaxGroupId');
        const voiceId = pickConnectorField(draft, fd, 'minimaxVoiceId');
        // Pre-flight: at least one path (form or saved) must yield a key
        // and a voice id. The server re-checks both via getResolvedConfig
        // so the UI message stays advisory.
        const savedKey   = Boolean(uiState.bootstrap?.settings?.config?.hasMinimaxKey);
        const savedVoice = Boolean(uiState.bootstrap?.settings?.config?.minimaxVoiceId);
        if (!apiKey && !savedKey) {
          if (status) status.textContent = 'Enter or save a MiniMax API key first';
          break;
        }
        if (!voiceId && !savedVoice) {
          if (status) status.textContent = 'Voice ID is required';
          break;
        }
        if (status) status.textContent = 'Synthesising…';
        try {
          const result = await api('/api/tts/test-minimax', {
            method: 'POST',
            body: {
              apiKey,
              groupId,
              voiceId,
              text: '你好，这是 MiniMax 测试朗读。Hello from MiniMax.',
            },
          });
          if (result?.ok) {
            if (status) status.textContent = `OK · ${result.bytes} bytes synthesised`;
          } else {
            if (status) status.textContent = result?.error || 'Test failed';
          }
        } catch (err) {
          if (status) status.textContent = err?.message || 'Test failed';
        }
        break;
      }
      case 'activate-minimax-voice': {
        // Delegate to the shared resolver (src/shared/minimaxVoiceResolver.js)
        // so the priority chain — cache valid / saved default / first
        // agent / nothing — is locked by node-side unit tests instead of
        // re-derived in browser logic. Fixes Codex C #14 (silent wipe)
        // and C #15 (stale cache wins over fresh save).
        const agentVoiceIds = allChatAgentProfiles()
          .map(a => a.minimaxVoiceId)
          .filter(Boolean);
        const savedDefault = uiState.bootstrap?.settings?.config?.minimaxVoiceId || '';
        const { voiceId, droppedStaleCache } = resolveActiveMinimaxVoiceId({
          cachedId: uiState.ttsCustomVoiceId,
          agentVoiceIds,
          savedDefault,
        });

        // If the cache no longer matches any valid voice, drop it now —
        // both in-memory and in localStorage — so a future activation
        // doesn't see the stale value again.
        if (droppedStaleCache) {
          uiState.ttsCustomVoiceId = '';
          localStorage.removeItem('melo-tts-custom-voice-id');
        }

        if (!voiceId) {
          showError('Configure a MiniMax voice first — set a Default Voice ID in Settings → Connector or bind one to an agent.');
          break;
        }

        uiState.ttsEngine = 'api';
        localStorage.setItem('melo-tts-engine', 'api');
        if (uiState.ttsCustomVoiceId !== voiceId) {
          uiState.ttsCustomVoiceId = voiceId;
          localStorage.setItem('melo-tts-custom-voice-id', voiceId);
        }
        api('/api/settings/model', {
          method: 'POST',
          body: {
            ttsProvider: 'minimax',
            ...minimaxTtsConfigPatchForVoice(voiceId),
          },
        }).then(payload => applyBootstrapPreservingDrafts(payload)).catch(() => {});
        render();
        break;
      }
      case 'clear-agent-avatar': {
        mergeAgentDraft(trigger.dataset.agentId,{avatarData:''});
        render(); break;
      }
      case 'toggle-agent-selector': {
        uiState.agentSelectorOpen = !uiState.agentSelectorOpen;
        render();
        if (uiState.agentSelectorOpen) document.querySelector('.agent-selector-row.is-selected')?.focus({ preventScroll: true });
        break;
      }
      case 'select-chat-agent': {
        const agentId = trigger.dataset.agentId;
        if (uiState.sending || uiState.agentSelectionSaving || !allChatAgentProfiles().some(a=>a.id===agentId)) break;
        const chat = !uiState.neuralOverview ? activeChat() : null;
        uiState.agentSelectionSaving=true; render();
        try {
          if(chat) applyBootstrapPreservingDrafts(await api('/api/chats/update',{method:'POST',body:{chatId:chat.id,patch:{agentId}}}));
          else {uiState.activeChatAgentId=agentId;localStorage.setItem('melo-active-chat-agent',agentId);}
          uiState.agentSelectorOpen=false;
        } finally {uiState.agentSelectionSaving=false;render();}
        break;
      }
      case 'select-palette-command': {
        const command = filteredPaletteCommands().find(
          item => item.id === trigger.dataset.commandId,
        );
        await executePaletteCommand(command);
        break;
      }
      default:
        break;
    }
  } catch (error) {
    showError(error.message);
  }
});

document.addEventListener('input', event => {
  const target = event.target;
  if(target.id==='memory-fact-text'||target.id==='memory-fact-scope'){if(uiState.memoryFactDraft&&!uiState.memoryFactBusy){uiState.memoryFactDraft[target.id.endsWith('text')?'text':'scope']=target.value;memoryFactEdit.change();const button=document.querySelector('[data-action=memory-fact-save]');if(button){button.disabled=false;button.closest('.settings-edit-toolbar').dataset.editStatus='dirty';button.closest('.settings-edit-toolbar').querySelector('.settings-save-status').textContent=t("有未保存的修改");}}return;}
  if (
    !(
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    )
  ) {
    return;
  }

  // Stamp the typing-guard clock on EVERY keystroke in ANY input/textarea,
  // before any per-form logic below. The guard is read by render() to defer
  // background-initiated renders that would otherwise wipe document.activeElement
  // mid-keystroke and cause the "cursor jumped to another input" bug.
  lastUserKeystrokeAt = Date.now();
  if (target.dataset.memoryConnection) { uiState.memoryConnection ||= {}; uiState.memoryConnection[target.dataset.memoryConnection] = target.value; return; }
  if (target.dataset.taskPricing) { uiState.taskPricing ||= {}; uiState.taskPricing[target.dataset.taskPricing] = target.value; return; }
  if (handleImageInput(target, uiState.bootstrap?.settings?.config || {})) return;
  if (editExtraFast(target)) return;
  if (editLlmConnection(target, uiState.bootstrap?.settings?.config || {})) return;

  if (target.id === 'composer') {
    uiState.composer = target.value;
    resetComposerHistoryNavigation();
    syncComposerTextareaHeight();
    // Phase 3.3.3 — open/close slash palette based on current composer value.
    const slashQuery = parseSlashQuery(target.value);
    if (slashQuery !== null) {
      if (!uiState.slashPalette.open
          || uiState.slashPalette.query !== slashQuery) {
        uiState.slashPalette.open = true;
        uiState.slashPalette.query = slashQuery;
        uiState.slashPalette.selectedIndex = 0;
        render();
      }
    } else if (uiState.slashPalette.open) {
      uiState.slashPalette.open = false;
      uiState.slashPalette.query = '';
      uiState.slashPalette.selectedIndex = 0;
      render();
    }
    return;
  }

  if (target.id === 'project-search') {
    uiState.projectSearch = target.value;
    render();
    return;
  }

  if (target.id === 'chat-search') {
    uiState.chatSearch = target.value;
    render();
    return;
  }

  // Phase 3.3.2 — skill filter query. Select handling lives in the 'change'
  // listener below because this 'input' handler is typed to inputs/textareas
  // only and excludes <select>.
  if (target.dataset?.action === 'set-skill-filter-query') {
    uiState.skillFilter.query = target.value;
    render();
    return;
  }

  if (target.id === 'global-search') {
    uiState.searchQuery = target.value;
    render();
    scheduleSearchRefresh();
    return;
  }

  if (target.id === 'command-palette-input') {
    uiState.commandPalette.query = target.value;
    uiState.commandPalette.selectedIndex = 0;
    render();
    return;
  }

  if (target.id === 'selected-file-editor') {
    uiState.fileDraftContent = target.value;
    return;
  }

  if (target.dataset.commandInput) {
    uiState.commandInputs[target.dataset.commandInput] = target.value;
    return;
  }

  // Phase 4 — domain cookie form. Sync to state so render() doesn't
  // wipe user input mid-typing. No render() call here: the typing
  // guard above defers re-renders, and the form value already lives
  // in DOM, so the next render-from-elsewhere will reflect the same
  // value through `${escapeHtml(addHost/addCookie)}`.
  if (target.dataset.domainCookieHost !== undefined) {
    uiState.domainCookies.addHost = target.value;
    return;
  }
  if (target.dataset.domainCookieString !== undefined) {
    uiState.domainCookies.addCookie = target.value;
    return;
  }

  if (target.form?.dataset.form === 'project-create') {
    uiState.draftProject[target.name] = target.value;
    return;
  }

  if (target.form?.dataset.form === 'artifact-create') {
    uiState.draftArtifact[target.name] = target.value;
    return;
  }

  if (target.form?.dataset.form === 'artifact-update') {
    uiState.editingArtifactDraft[target.name] = target.value;
    return;
  }

  if (target.form?.dataset.form === 'task-create') {
    uiState.draftTask[target.name] = target.value;
    return;
  }

  // connector-config (Customize → Connectors → OpenAI) and
  // model-config (Settings → Model) edit the same underlying config
  // (apiKey / baseUrl / model / whisper* / minimax*). Mirror the
  // typed/pasted value onto the shared draft on every keystroke
  // so a background render — autosave response, MCP preset poll,
  // undo-toast tick — can't rebuild the masked password inputs
  // back to value="" before Save reads them. Only authMode (a
  // <select>) needs an immediate render, and that fires through
  // the `change` listener below: the type guard at the top of
  // this `input` listener already filters <select> out.
  if (
    target.form?.dataset.form === 'connector-config' ||
    target.form?.dataset.form === 'model-config'
  ) {
    const dispatch = applyFormInputToDraft({
      formName: target.form.dataset.form,
      fieldName: target.name,
      value: target.value,
      currentDraft: uiState.modelSetupDraft,
      fallbackDraft: {},
      modelDefaultsForAuthMode,
    });
    if (dispatch) {
      uiState.modelSetupDraft = dispatch.nextDraft;
      // shouldRender is always false from this listener: <select>
      // doesn't reach here, so authMode never matches. Keep the
      // gate anyway so the helper contract stays one-way.
      if (dispatch.shouldRender) render();
      // 3-second idle autosave: snapshot the submit body now (in
      // case the form gets unmounted by a page switch before the
      // timer fires) and queue the actual POST.
      // Settings are committed only by the explicit Save action.
    }
    return;
  }

  if (target.form?.dataset.form === 'agent-profile-update') {
    const agentId = target.form.dataset.agentId;
    if (['telegramBotToken', 'telegramChatId', 'discordBotToken', 'discordGuildId', 'discordChannelId'].includes(target.name)) {
      const channelId = target.name.startsWith('telegram') ? 'telegram' : 'discord';
      const fieldName =
        target.name === 'telegramBotToken' || target.name === 'discordBotToken'
          ? 'botToken'
          : target.name === 'telegramChatId'
            ? 'chatId'
            : target.name === 'discordGuildId'
              ? 'guildId'
              : 'channelId';
      updateAgentChannelDraft(agentId, channelId, {
        [fieldName]: target.value,
      });
      // Schedule autosave on every keystroke so the token isn't lost if the
      // user switches tabs or hits the Test button before the field blurs.
      // Debounced inside scheduleAgentChannelAutosave (350ms).
      // Settings are committed only by the explicit Save action.
      return;
    }

    // voiceReplyMode / edgeTtsVoice / voicePersonality are agent-level fields
    // edited on the Telegram panel. Persist them through the same channel
    // autosave pipeline so they don't get lost when applyBootstrap() clears
    // agent drafts.
    if (['voiceReplyMode', 'edgeTtsVoice', 'voicePersonality'].includes(target.name)) {
      mergeAgentDraft(agentId, {
        [target.name]: target.type === 'checkbox' ? (target.checked ? 'on' : '') : target.value,
      });
      // Settings are committed only by the explicit Save action.
      return;
    }

    const nextDraft = mergeAgentDraft(agentId, {
      [target.name]: target.type === 'checkbox' ? (target.checked ? 'on' : '') : target.value,
    });
    if (target.name === 'identity') {
      nextDraft.identify = target.value;
      captureAgentEditorState();
      // Settings are committed only by the explicit Save action.
    } else if (target.name === 'soul.md' || target.name === 'instructions') {
      captureAgentEditorState();
      // Settings are committed only by the explicit Save action.
    }
  }
});

document.addEventListener(
  'scroll',
  event => {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement && target.classList.contains('agent-content-editor')) {
      captureAgentEditorState();
      if (pendingAgentMarkdownAutosave) {
        agentMarkdownLastInteractionAt = Date.now();
      }
      return;
    }

    if (target instanceof HTMLElement && target.classList.contains('agent-detail-column')) {
      captureAgentScrollState();
      if (pendingAgentMarkdownAutosave) {
        agentMarkdownLastInteractionAt = Date.now();
      }
    }
  },
  true,
);

document.addEventListener('change', async event => {
  const target = event.target;
  if(target.id==='memory-fact-text'||target.id==='memory-fact-scope'){if(uiState.memoryFactDraft&&!uiState.memoryFactBusy){uiState.memoryFactDraft[target.id.endsWith('text')?'text':'scope']=target.value;memoryFactEdit.change();const button=document.querySelector('[data-action=memory-fact-save]');if(button){button.disabled=false;button.closest('.settings-edit-toolbar').dataset.editStatus='dirty';button.closest('.settings-edit-toolbar').querySelector('.settings-save-status').textContent=t("有未保存的修改");}}return;}
  if (target.dataset?.chatContext) {
    const chat = !uiState.neuralOverview ? activeChat() : null;
    const patch = target.dataset.chatContext === 'project' ? {projectId:target.value || null} : {contextArtifactIds:[...document.querySelectorAll('[data-chat-context="artifact"]:checked')].map(el=>el.value)};
    try {
      if (uiState.sending) throw new Error('请等待当前回复结束后再修改。');
      if (chat) applyBootstrapPreservingDrafts(await api('/api/chats/update',{method:'POST',body:{chatId:chat.id,patch}}));
      else if (Object.hasOwn(patch,'projectId')) uiState.newChatProjectId = patch.projectId;
      else {
        const notes=uiState.bootstrap.artifacts.filter(a=>patch.contextArtifactIds.includes(a.id));
        if(notes.length>8 || notes.reduce((sum,n)=>sum+n.content.length,0)>24000) throw new Error('最多选用 8 份、合计 24000 字资料。');
        uiState.newChatArtifactIds=patch.contextArtifactIds;
      }
    } catch(error) { showError(error.message); }
    render(); return;
  }
  if (target instanceof HTMLInputElement && target.dataset.agentDocument) {
    const agentId = target.dataset.agentDocument;
    const editIsCurrent = settingsFormEditors.editToken(target.form);
    const key = agentDraftKey(agentId);
    try {
      const file=target.files?.[0]; if(!file) return;
      if(file.size > 1000000) throw new Error('Markdown 文件过大，请控制在 1 MB 内。');
      const instructions=await file.text();
      if(instructions.length > 200100) throw new Error('Agent 人设文档超过 200100 字符。');
      if(!editIsCurrent()) return;
      uiState.agentDrafts[key]={...agentDraftFor(agentProfileById(agentId)),instructions};
      render();
    } catch(error) { showError(error.message); }
    return;
  }
  if (target instanceof HTMLInputElement && target.dataset.agentAvatar) {
    const isCurrentEdit=settingsFormEditors.editToken(target.form);
    const draftKey=agentDraftKey(target.dataset.agentAvatar);
    const originalDraft=agentDraftFor(agentProfileById(target.dataset.agentAvatar));
    try {
      const avatarData = await readAgentAvatar(target.files?.[0]);
      if(!isCurrentEdit()) return;
      uiState.agentDrafts[draftKey]={...originalDraft,...uiState.agentDrafts[draftKey],avatarData};
      render();
    }
    catch (error) { showError(error.message); }
    return;
  }

  if (
    !(
      target instanceof HTMLSelectElement ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    )
  ) {
    return;
  }

  if (target.dataset.taskPricing) { uiState.taskPricing ||= {}; uiState.taskPricing[target.dataset.taskPricing] = target.value; return; }
  if (target.dataset.taskCheck) { uiState.taskChecks ||= {}; const task=activeTasks().find(t=>t.id===target.dataset.taskCheck); uiState.taskChecks[target.dataset.taskCheck] ||= {}; Object.assign(uiState.taskChecks[target.dataset.taskCheck],{runId:task?.execution?.runId,[target.dataset.criterion]:target.checked}); return; }
  if (target.dataset.permissionFilter) { uiState.safetyAllowlist.filters ||= {}; uiState.safetyAllowlist.filters[target.dataset.permissionFilter] = target.value; render(); return; }
  if (handleImageInput(target, uiState.bootstrap?.settings?.config || {})) { render(); return; }
  if (editExtraFast(target)) return;
  if (editLlmConnection(target, uiState.bootstrap?.settings?.config || {})) { render(); return; }

  try {
    if (target.id === 'composer-attachment-input') {
      await queueComposerFiles(target.files);
      return;
    }

    // Phase 3.3.2 — skill state filter select.
    if (target.dataset.action === 'set-skill-filter-state') {
      const allowed = new Set(['all', 'enabled', 'disabled', 'builtin', 'custom', 'disk']);
      uiState.skillFilter.state = allowed.has(target.value) ? target.value : 'all';
      render();
      return;
    }

    if (target.dataset.action === 'select-project') {
      await patchSettings({ selectedProjectId: target.value });
      return;
    }

    if (target.dataset.action === 'select-agent-profile') {
      await patchSettings({
        activeView: 'agent',
        selectedAgentId: target.value || 'main',
      });
      return;
    }

    if (target.dataset.action === 'save-model-select') {
      // Changing the top-bar model select must not wipe any in-flight form drafts.
      applyBootstrapPreservingDrafts(
        await api('/api/settings/model', {
          method: 'POST',
          body: { model: target.value },
        }),
      );
      return;
    }

    if (target.dataset.action === 'select-tts-api-voice') {
      uiState.ttsApiVoice = target.value;
      localStorage.setItem('melo-tts-api-voice', target.value);
      return;
    }

    if (target.dataset.action === 'select-tts-browser-voice') {
      uiState.ttsBrowserVoiceName = target.value;
      localStorage.setItem('melo-tts-browser-voice', target.value);
      return;
    }

    if (target.dataset.action === 'select-tts-macos-voice') {
      uiState.ttsMacosVoiceName = target.value;
      localStorage.setItem('melo-tts-macos-voice', target.value);
      return;
    }

    if (target.dataset.action === 'select-tts-edge-voice') {
      uiState.ttsEdgeVoice = target.value;
      localStorage.setItem('melo-tts-edge-voice', target.value);
      api('/api/settings/model', {
        method: 'POST',
        body: { ttsEdgeVoice: target.value },
      }).then(payload => applyBootstrapPreservingDrafts(payload)).catch(() => {});
      return;
    }

    if (target.dataset.action === 'select-tts-custom-voice') {
      uiState.ttsCustomVoiceId = target.value;
      localStorage.setItem('melo-tts-custom-voice-id', target.value);
      api('/api/settings/model', {
        method: 'POST',
        body: minimaxTtsConfigPatchForVoice(target.value),
      }).then(payload => applyBootstrapPreservingDrafts(payload)).catch(() => {});
      return;
    }

    if (target.dataset.action === 'toggle-tts-enable') {
      uiState.ttsAutoPlay = target.checked;
      localStorage.setItem('melo-tts-autoplay', uiState.ttsAutoPlay ? '1' : '0');
      if (!uiState.ttsAutoPlay) stopCurrentTts();
      api('/api/settings/model', {
        method: 'POST',
        body: { ttsAutoPlay: uiState.ttsAutoPlay },
      }).then(payload => applyBootstrapPreservingDrafts(payload)).catch(() => {});
      render();
      return;
    }

    // Both `model-config` (Settings → Model page) and `connector-config`
    // (Customize → Connectors → OpenAI) edit the same underlying config.
    // The dispatcher in `connectorDraftDispatch.js` decides whether the
    // change needs an immediate `render()` — only authMode does. Every
    // other field (text, textarea, masked password) just mirrors onto
    // the shared draft and lets the browser's own input buffer keep
    // showing what the user typed. The earlier cut blindly called
    // `render()` on every keystroke; that synchronous DOM rebuild
    // snapped freshly-pasted password values back to "" because the
    // mask contract renders password inputs with SSR `value=""` and
    // `restoreFocusedInputState` only preserves caret position.
    const draftDispatch = applyFormInputToDraft({
      formName: target.form?.dataset.form,
      fieldName: target.name,
      value: target.value,
      currentDraft: uiState.modelSetupDraft,
      fallbackDraft: {},
      modelDefaultsForAuthMode,
    });
    if (draftDispatch) {
      uiState.modelSetupDraft = draftDispatch.nextDraft;
      if (draftDispatch.shouldRender) render();
      // Same 3-second idle autosave as the input listener — covers
      // the authMode <select>, which doesn't fire `input` events.
      // Settings are committed only by the explicit Save action.
      return;
    }

    if (target.form?.dataset.form === 'task-create') {
      uiState.draftTask[target.name] = target.value;
      return;
    }

    if (target.form?.dataset.form === 'agent-profile-update') {
      const agentId = target.form.dataset.agentId;
      if (['telegramEnabled', 'discordEnabled'].includes(target.name)) {
        const channelId = target.name === 'telegramEnabled' ? 'telegram' : 'discord';
        updateAgentChannelDraft(agentId, channelId, {
          enabled: target.checked,
        });
        // Settings are committed only by the explicit Save action.
        render();
        return;
      }

      // Send voice reply checkbox: belongs to the Telegram channel (voiceReply),
      // not to a top-level agent field. Before this was routed through the
      // fallthrough below and got written to draft[target.name] as the string
      // "on" — which made render() read back the stale channels.telegram.voiceReply
      // and visibly bounce the checkbox back to unchecked.
      if (target.name === 'telegramVoiceReply' || target.name === 'discordVoiceReply') {
        const channelId = target.name === 'telegramVoiceReply' ? 'telegram' : 'discord';
        updateAgentChannelDraft(agentId, channelId, {
          voiceReply: target.checked,
        });
        // Settings are committed only by the explicit Save action.
        render();
        return;
      }

      if (['telegramBotToken', 'telegramChatId', 'discordBotToken', 'discordGuildId', 'discordChannelId'].includes(target.name)) {
        const channelId = target.name.startsWith('telegram') ? 'telegram' : 'discord';
        const fieldName =
          target.name === 'telegramBotToken' || target.name === 'discordBotToken'
            ? 'botToken'
            : target.name === 'telegramChatId'
              ? 'chatId'
              : target.name === 'discordGuildId'
                ? 'guildId'
                : 'channelId';
        updateAgentChannelDraft(agentId, channelId, {
          [fieldName]: target.value,
        });
        // Settings are committed only by the explicit Save action.
        return;
      }

      // voiceReplyMode / edgeTtsVoice / voicePersonality are agent-level (not
      // channel-level) but the user edits them on the Telegram panel next to
      // the channel toggles. Route them through the channel autosave so they
      // persist on change without requiring the user to hit a separate save
      // button.
      if (['voiceReplyMode', 'edgeTtsVoice', 'voicePersonality'].includes(target.name)) {
        mergeAgentDraft(agentId, {
          [target.name]: target.type === 'checkbox' ? (target.checked ? 'on' : '') : target.value,
        });
        // Settings are committed only by the explicit Save action.
        render();
        return;
      }

      const nextDraft = mergeAgentDraft(agentId, {
        [target.name]: target.type === 'checkbox' ? (target.checked ? 'on' : '') : target.value,
      });
      if (target.name === 'identity') {
        nextDraft.identify = target.value;
      }
      // Text/number blur precedes the Save click. Replacing the form here
      // detaches that button mid-click and can also reset its input value.
      if (target instanceof HTMLSelectElement || ['checkbox', 'radio'].includes(target.type)) {
        render();
      }
    }
  } catch (error) {
    showError(error.message);
  }
});

document.addEventListener('dragover', event => {
  if (!hasFileTransfer(event)) {
    return;
  }

  event.preventDefault();
  const isComposerTarget = Boolean(composerDropTargetFromEvent(event));
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = isComposerTarget ? 'copy' : 'none';
  }
  setComposerDragActive(isComposerTarget);
});

document.addEventListener('dragleave', event => {
  if (!hasFileTransfer(event)) {
    return;
  }

  const relatedTarget = event.relatedTarget;
  if (
    relatedTarget instanceof Element &&
    relatedTarget.closest('.composer-input-frame')
  ) {
    return;
  }

  if (!composerDropTargetFromEvent(event)) {
    setComposerDragActive(false);
  }
});

document.addEventListener('drop', async event => {
  if (!hasFileTransfer(event)) {
    return;
  }

  event.preventDefault();
  const isComposerTarget = Boolean(composerDropTargetFromEvent(event));
  setComposerDragActive(false);

  if (!isComposerTarget) {
    return;
  }

  try {
    await queueComposerFiles(event.dataTransfer?.files);
  } catch (error) {
    showError(error.message);
  }
});

document.addEventListener('dragend', () => {
  setComposerDragActive(false);
});

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();

  const editTicket=settingsFormEditors.start(form);
  if(editTicket===false) return;
  let saveError=null;
  if(editTicket) queueMicrotask(()=>render());
  try {
    switch (form.dataset.form) {
      case 'composer':
        await handleSendMessage();
        break;
      case 'project-create':
        await handleCreateProject();
        break;
      case 'project-update':
        await handleUpdateProject(form);
        break;
      case 'task-pricing': {
        const body=Object.fromEntries(new FormData(form));
        await api('/api/tasks/pricing',{method:'POST',body});
        uiState.taskPricing=null;
        await loadBootstrap(uiState.searchQuery,{quiet:true});
        break;
      }
      case 'agent-profile-update':
        await handleUpdateAgentProfile(form);
        break;
      case 'connector-config':
        await handleSaveConnectorConfig(form);
        break;
      case 'model-config':
        await handleSaveConnectorConfig(form);
        break;
      case 'default-model-config':
        applyBootstrap(await api('/api/settings/model', {method: 'POST', body: {model: new FormData(form).get('model')}}));
        break;
      case 'skill-custom-create':
        await handleCreateCustomSkill(form);
        break;
      case 'skill-custom-update':
        await handleUpdateCustomSkill(form);
        break;
      case 'artifact-create':
        await handleCreateArtifact();
        break;
      case 'artifact-update':
        await handleUpdateArtifact();
        break;
      case 'task-create':
        await handleCreateTask();
        break;
      case 'file-save':
        await handleSaveWorkspaceFile();
        break;
      case 'command-run':
        await handleRunCommand(form);
        break;
      default:
        break;
    }
  } catch (error) {
    saveError=error;
    showError(error.message);
  }
  finally { if(editTicket) settingsFormEditors.finish(editTicket,saveError); }
});

// Keep a deliberately opened receipt visible inside the existing thread scroller.
document.addEventListener('toggle', event => {
  const receipt = event.target;
  if (receipt instanceof HTMLElement && receipt.matches('.model-receipt[open]')) {
    requestAnimationFrame(() => { if (receipt.isConnected) receipt.scrollIntoView({ block: 'nearest', behavior: 'auto' }); });
  }
}, true);

document.addEventListener('keydown', async event => {
  const target = event.target;
  const isEditable =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable;

  // Stamp the typing-guard clock on keydown (not just input) so that keys
  // which don't produce an input event (arrow keys moving the caret inside
  // the token input, IME composition intermediate states, etc.) also defer
  // background renders. The combined input+keydown stamping catches every
  // form of active editing.
  if (isEditable) {
    lastUserKeystrokeAt = Date.now();
  }

  if (uiState.modelPickerOpen && event.key === 'Escape') {
    event.preventDefault();
    uiState.modelPickerOpen = false;
    render();
    document.querySelector('.model-picker-trigger')?.focus();
    return;
  }
  if (uiState.agentSelectorOpen && event.key === 'Escape') {
    event.preventDefault();
    uiState.agentSelectorOpen = false;
    render();
    document.querySelector('[data-action="toggle-agent-selector"]')?.focus({ preventScroll: true });
    return;
  }
  if (uiState.agentSelectorOpen && target?.closest('#agent-selector-panel') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const options = [...document.querySelectorAll('.agent-selector-row:not(:disabled)')];
    const index = options.indexOf(target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
    return;
  }
  if (uiState.modelPickerOpen && target?.closest('.model-picker-panel') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const options = [...document.querySelectorAll('.model-picker-option:not(:disabled)')];
    const index = options.indexOf(target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
    return;
  }

  // Phase 3.3.3 — slash palette keyboard navigation. Intercepts arrow keys,
  // Enter, and Escape when the palette is open so they don't fall through to
  // composer history, send, or other handlers.
  if (target?.id === 'composer' && uiState.slashPalette.open) {
    const matches = slashPaletteMatches();
    if (event.key === 'Escape') {
      event.preventDefault();
      uiState.slashPalette.open = false;
      uiState.slashPalette.query = '';
      uiState.slashPalette.selectedIndex = 0;
      render();
      return;
    }
    if (event.key === 'ArrowDown' && matches.length) {
      event.preventDefault();
      uiState.slashPalette.selectedIndex =
        (uiState.slashPalette.selectedIndex + 1) % matches.length;
      render();
      return;
    }
    if (event.key === 'ArrowUp' && matches.length) {
      event.preventDefault();
      uiState.slashPalette.selectedIndex =
        (uiState.slashPalette.selectedIndex - 1 + matches.length) % matches.length;
      render();
      return;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && matches.length && !event.shiftKey) {
      event.preventDefault();
      const pick = matches[
        Math.min(
          Math.max(0, uiState.slashPalette.selectedIndex | 0),
          matches.length - 1,
        )
      ];
      if (pick) {
        uiState.composer = `/${pick.id} `;
        uiState.slashPalette.open = false;
        uiState.slashPalette.query = '';
        uiState.slashPalette.selectedIndex = 0;
        render();
        queueMicrotask(() => {
          const ta = document.querySelector('#composer');
          if (ta) {
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
          }
        });
      }
      return;
    }
  }

  if (
    target?.id === 'composer' &&
    event.key === 'ArrowUp' &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    target.selectionStart === 0 &&
    target.selectionEnd === 0
  ) {
    event.preventDefault();
    navigateComposerHistory('older');
    return;
  }

  if (
    target?.id === 'composer' &&
    event.key === 'ArrowDown' &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    target.selectionStart === target.value.length &&
    target.selectionEnd === target.value.length
  ) {
    event.preventDefault();
    navigateComposerHistory('newer');
    return;
  }

  if (
    target?.id === 'composer' &&
    shouldSendOnEnter(event, uiState.bootstrap?.settings?.localPreferences) &&
    !uiState.commandPalette.open
  ) {
    event.preventDefault();
    await handleSendMessage();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key === ',') {
    event.preventDefault(); await patchSettings({activeView:'settings'}); return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (uiState.commandPalette.open) {
      closeCommandPalette();
    } else {
      openCommandPalette();
    }
    return;
  }

  if (!uiState.commandPalette.open) {
    if (event.key === 'Escape') {
      closeEditableContextMenu();
      closeCopyContextMenu();
      closeRecentContextMenu();
    }
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    closeCommandPalette();
    return;
  }

  const commands = filteredPaletteCommands();
  if (!commands.length) {
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    uiState.commandPalette.selectedIndex =
      (uiState.commandPalette.selectedIndex + 1) % commands.length;
    render();
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    uiState.commandPalette.selectedIndex =
      (uiState.commandPalette.selectedIndex - 1 + commands.length) % commands.length;
    render();
    return;
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    if (isEditable || target?.id === 'command-palette-input') {
      event.preventDefault();
    }
    await executePaletteCommand(commands[uiState.commandPalette.selectedIndex] || commands[0]);
  }
});

window.addEventListener('melo-voice', event => {
  handleVoiceBridgeEvent(event.detail || {});
});

// TTS playback events from Swift's AVAudioPlayerDelegate / `say` exit.
// Routing decision delegated to selectTtsBridgeCallback (see
// ttsBridgeRouter.js + .test.js) so the cross-engine stale-event guard is
// covered by unit tests instead of inline event-listener logic.
window.addEventListener('melo-tts', event => {
  const cb = selectTtsBridgeCallback(event?.detail, _ttsAudio);
  if (cb) cb();
});

// A viz card finished hydrating (scene3d canvas mounted, globe-flight dynamic
// import resolved, …). Its height just changed, so re-apply the pending
// scroll anchor we captured in render(). Without this, the final layout
// shift pushes the user's viewport to a later message — "I scrolled to the
// flight globe but the view jumped to the molecule card below it".
document.addEventListener('melo:viz:hydrated', () => {
  if (uiState.pendingVizAnchor) {
    restoreThreadAnchor(uiState.pendingVizAnchor);
  }
});

document.addEventListener('contextmenu', event => {
  const target = event.target;
  const recentTarget = target instanceof Element ? target.closest('.recent-item') : null;
  const audioCardTarget = target instanceof Element ? target.closest('[data-audio-url]') : null;
  const copyableTarget =
    target instanceof Element ? target.closest('[data-copyable-surface]') : null;
  if (recentTarget instanceof HTMLElement) {
    event.preventDefault();
    closeEditableContextMenu();
    closeCopyContextMenu();
    closeAudioContextMenu();
    openRecentContextMenu(recentTarget.dataset.chatId, event.clientX, event.clientY);
    return;
  }

  if (audioCardTarget instanceof HTMLElement && audioCardTarget.dataset.audioUrl) {
    event.preventDefault();
    closeEditableContextMenu();
    closeCopyContextMenu();
    closeRecentContextMenu();
    openAudioContextMenu(audioCardTarget.dataset.audioUrl, event.clientX, event.clientY);
    return;
  }

  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  ) {
    event.preventDefault();
    closeCopyContextMenu();
    closeAudioContextMenu();
    openEditableContextMenu(target, event.clientX, event.clientY);
    return;
  }

  if (copyableTarget instanceof HTMLElement) {
    event.preventDefault();
    closeEditableContextMenu();
    closeAudioContextMenu();
    openCopyContextMenu(copyableTarget, event.clientX, event.clientY);
    return;
  }

  closeEditableContextMenu();
  closeCopyContextMenu();
  closeRecentContextMenu();
  closeAudioContextMenu();
});

// Install the citation side drawer once, AFTER document.body exists. The
// drawer survives chat root re-renders because it lives directly under
// <body>. Preview fetches flow through our api() helper and carry the
// active project id so the backend can resolve paths against the right
// workspace.
installCitationDrawer({
  fetchPreview: ({ filePath }) =>
    api('/api/workspace/citation-preview', {
      method: 'POST',
      body: {
        filePath,
        projectId:
          activeProject()?.id ||
          uiState.bootstrap?.settings?.selectedProjectId ||
          null,
      },
    }),
});

loadBootstrap();
initBrowserVoices();

// Stop capture when the page leaves; reopening a chat never restarts listening.
window.addEventListener('pagehide', () => stopVoiceCaptureIfNeeded());
document.addEventListener('visibilitychange', () => { if (document.hidden) stopVoiceCaptureIfNeeded(); });
document.addEventListener('change', event => {
  if (event.target.matches?.('[data-voice-language]')) {
    uiState.voiceLanguage = event.target.value;
    api('/api/settings/local',{method:'POST',body:{preferences:{voiceLanguage:event.target.value}}}).then(data=>applyBootstrapPreservingDrafts(data)).catch(error=>showError(error.message));
  }
});

function retryMissingImages({ chatId, query, task }) {
  if (uiState.sending || chatId !== uiState.bootstrap?.settings?.selectedChatId || !task?.retryOf) return;
  handleSendMessage({ chatId, content: query || '继续图片任务', imageTask: task });
}

installLanguageControls({api,applyBootstrap,render});
installLocalSettings({api,uiState,render,stopSpeech:stopCurrentTts,applyBootstrap,patchSettings,reload:()=>loadBootstrap(),openVoice:async()=>{await patchSettings({activeView:'chat'});uiState.ttsVoicePanelOpen=true;loadMacosVoices();render();}});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{if(uiState.bootstrap)render();});
window.addEventListener('melo-open-settings',()=>patchSettings({activeView:'settings'}));
