import {handleManagementAction} from './managementActions.js';
import {askFileDecision} from './chatFiles.js';
import { isAgentChannelAvailable } from '/shared/channelAvailability.js';
import { t, ui } from './i18n.js';
import { installLanguageControls } from './languageControls.js';
import { renderExtraFast, editExtraFast, handleExtraFast } from './extraFast.js';
import { olderBootstrap, changedBootstrapSections, pageAffected } from './bootstrapPatch.js';
import { createSharedApi } from './sharedApi.js';
import { createSettingsFormEditors, installUnsavedSettingsGuard } from './settingsEdit.js';
import { createActionRegistry } from './features/registry.js';
import { installMemoryFeature } from './features/memory/index.js';
import { installProjectsFeature } from './features/projects/index.js';
import { installAgentsFeature } from './features/agents/index.js';
import { installChatFeature } from './features/chat/index.js';
import { installApprovalsFeature } from './features/approvals/index.js';
import { renderLocalSettings, installLocalSettings, applyLocalAppearance, shouldSendOnEnter, notifyLocalCompletion, nativeSettings } from './localSettings.js';
import { installImagePreview } from './imagePreview.js';
import { renderSyncConflicts } from './syncConflicts.js';
import { renderReplyDocument } from './replyDocument.js';
import { renderImageSettings, clearImageTask, handleImageInput, handleImageAction } from './imageControls.js';
import { renderLlmConnections, editLlmConnection, handleLlmConnection } from './llmConnections.js';
import { renderExecutionPanel, syncExecutionPanel, receiveExecutionScene, renderSceneReplay, selectedMessagePresentation, liveSceneFor, cancelLiveScene } from './executionPanel.js';
import { DEFAULT_MODELS_BY_AUTH_MODE } from '/shared/modelCatalog.js';
import { modelLabel, modelPanelPosition, conversationAgents, conversationAgent, connectionModelOptions, renderDefaultModelSettings } from './modelPresentation.js';
import { updateNeuralWorkspace, syncNeuralComposer, preserveNeuralRegion } from './neuralDom.js';
import { resolveWorkspaceStage } from './neuralLayout.js';
import { captureNeuralLayout, animateNeuralLayout } from './neuralMotion.js';
import { neuralGroups, groupForSettings, renderNeuralNavigation, renderNeuralOverview, syncNeuralScene } from './neuralShell.js';
import {
  renderInlineSegmentWithCites,
  installCitationDrawer,
  resetCitationPreviewCache,
} from './viz/citationRenderer.js';
import { promoteTextUrlsToAttachments } from '/shared/urlDetector.js';
import { extractTextUrls } from '/shared/textUrls.js';
import { renderCopyLinkButton, copyLinkText } from './linkActions.js';
import { createSearchPageRenderer } from './searchPage.js';
import { createScrollPreservation } from './scrollPreservation.js';
import { renderTeamPanel, collectTeamPlan, noteTeamMemberToggle } from './teamPanel.js';
import { routeHttpUrlClick } from './anchorRouting.js';
import { selectTtsBridgeCallback } from './ttsBridgeRouter.js';
import {
  UNDO_TOAST_DEFAULT_MS,
  formatUndoToastLabel,
  nextCountdownTickMs,
} from './undoToast.js';
import { buildConnectorDraft, pickConnectorField } from './connectorDraft.js';
import { applyFormInputToDraft } from './connectorDraftDispatch.js';
import { CREDENTIAL_FIELDS } from './credentialChip.js';
import {
  decideFileSafetyPreflight,
  decideFileSafetyResponseAction,
} from './fileSafetyResponse.js';
import { installCustomizeFeature } from './features/customize/index.js';

const app = document.querySelector('#app');
// The Agent feature owns the agent-profile-update form's draft (agentsFeature,
// installed below; these callbacks only run on later events).
const settingsFormEditors = createSettingsFormEditors({render,
  ownsDraft: form => agentsFeature.ownsFormDraft(form),
  scope: form => form.dataset.agentId ? agentsFeature.formDraftScope(form) : form.dataset.form==='task-pricing' ? uiState.bootstrap?.settings?.config?.model || '' : '',
  onCancel: form => {
    if(form.dataset.agentId) agentsFeature.discardFormDraft(form);
    if(form.dataset.form==='task-pricing') uiState.taskPricing=null;
    if(['connector-config','model-config'].includes(form.dataset.form)) clearModelFormDraft(form);
  },
});
settingsFormEditors.install(document);
document.addEventListener('toggle', event => {
  agentsFeature.handleToggle(event);
  memoryFeature.handleToggle(event);
}, true);
installUnsavedSettingsGuard(window);


const uiState = {
  neuralGroup: null,
  neuralOverview: true,
  neuralExpanded: false,
  neuralStill: false,
  bootstrap: null,
  loading: true,
  modelPickerOpen: false,
  modelPickerSaving: false,
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
  // Phase 3.3.4 — skill-run telemetry shown in the Customize → Skills
  // health panel. Lazily populated when the user opens the Skills tab;
  // `loading` guards concurrent refetches.
  skillRunStats: {
    loading: false,
    loaded: false,
    skills: [],
    error: null,
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
  showArtifactForm: false,
  selectedArtifactId: null,
  fileEditMode: false,
  fileDraftPath: null,
  fileDraftContent: '',
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
  commandInputs: {},
  commandPalette: {
    open: false,
    query: '',
    selectedIndex: 0,
  },
  // Task panel "Run agent" overflow menu — shows main as the primary
  // button and tucks research/builder/reviewer behind a "⋯" dropdown so
  // the lane row doesn't sprout four equal-weight chips.
  taskLaneOverflowOpen: false,
  shouldFocusSearch: false,
  error: '',
  // Tool execution UI state
  // pendingToolPermissions: array of one dialog descriptor per pending request.
  // Two shapes share this queue, distinguished by `kind`:
  //   - tool-runner   { kind: 'tool',         requestId, toolId, args }
  //   - file-safety   { kind: 'file_safety',  requestId, operation, payload }
  pendingToolPermissions: [],
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
};

let contentScrollbarHideTimer = 0;
let activeSearchFileSource = null;
let activeSearchFileSequence = 0;
let activeEditableContextTarget = null;
let activeCopyContextTarget = null;
let activeRecentContextChatId = null;
let activeAudioContextUrl = null;

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

// Feature modules (architecture plan P2, desktop-ui/features/README.md).
// Each feature owns its state and gets a narrow context (named accessors and
// callbacks, never uiState); it registers its click actions and form submits
// once, and the click / submit listeners ask these registries before their
// own switch. Installed here, after uiState and icon exist, before any
// listener or render can run.
// The shared request layer (sharedApi.js): the one request helper app.js
// and every feature use. Created before the features below receive it.
const api = createSharedApi({ getBootstrap: () => uiState.bootstrap, onRecoveryChange: () => bgRender() });
const featureActions = createActionRegistry('action');
const featureForms = createActionRegistry('form');
const memoryFeature = installMemoryFeature({ api, render, bgRender, showError, activeProject, escapeHtml });
featureActions.register(memoryFeature.actions, 'memory');
featureForms.register(memoryFeature.forms, 'memory');
const projectsFeature = installProjectsFeature({
  getBootstrap: () => uiState.bootstrap,
  api, render, showError, patchSettings, applyBootstrap, applyBootstrapPreservingDrafts, startProjectSession,
  activeProject, activeProjectChats, activeProjectArtifacts,
  renderMemoryBook: memoryFeature.renderProjectBook,
  escapeHtml, truncate, icon,
});
featureActions.register(projectsFeature.actions, 'projects');
featureForms.register(projectsFeature.forms, 'projects');
// Capability elevation (2026-10-20): the capability prompt card answers the
// entries of kind 'capability' the reply stream puts into the permission queue;
// the «临时授权» list appears in Agent settings and Customize → Safety.
const approvalsFeature = installApprovalsFeature({
  getBootstrap: () => uiState.bootstrap,
  app, api, render, bgRender, showFlashToast,
  refreshBootstrap: () => loadBootstrap(uiState.searchQuery, { quiet: true }),
  toolPermissions: () => uiState.pendingToolPermissions,
  setToolPermissions: list => { uiState.pendingToolPermissions = list; },
  escapeHtml, icon,
});
featureActions.register(approvalsFeature.actions, 'approvals');
const agentsFeature = installAgentsFeature({
  getBootstrap: () => uiState.bootstrap,
  app, api, render, bgRender, showError, showFlashToast, patchSettings, applyBootstrap, applyBootstrapPreservingDrafts,
  refreshBootstrap: () => loadBootstrap(uiState.searchQuery, { quiet: true }),
  activeProject, agentProfileById, minimaxTtsConfigPatchForVoice,
  beginFormEdit: form => settingsFormEditors.begin(form),
  formEditToken: form => settingsFormEditors.editToken(form),
  nativeSettings, isAgentChannelAvailable, escapeHtml, icon,
  renderCapabilityGrants: agentId => approvalsFeature.renderGrantList({ agentId }),
});
featureActions.register(agentsFeature.actions, 'agents');
featureForms.register(agentsFeature.forms, 'agents');
const chatFeature = installChatFeature({
  getBootstrap: () => uiState.bootstrap,
  // The optimistic user message and the restore after a failed send replace
  // the page data without a render, exactly as the moved code did.
  setBootstrap: payload => { uiState.bootstrap = payload; },
  app, api, render, bgRender, showError, applyBootstrap, applyBootstrapPreservingDrafts,
  refreshBootstrap: () => loadBootstrap(uiState.searchQuery, { quiet: true }),
  activeChat,
  isOverview: () => uiState.neuralOverview,
  leaveOverview: () => { uiState.neuralOverview = false; uiState.neuralGroup = null; },
  // The next new chat's Agent, project, knowledge and model (shared with
  // startProjectSession and the composer's context picker).
  newChatSelection: () => ({ agentId: uiState.activeChatAgentId, projectId: uiState.newChatProjectId, artifactIds: uiState.newChatArtifactIds, model: uiState.newChatModel }),
  selectNewChatAgent: agentId => { uiState.activeChatAgentId = agentId; localStorage.setItem('melo-active-chat-agent', agentId); },
  activeChatAgentProfile, allChatAgentProfiles, composerTeamPlan,
  modelPicker: () => ({ open: uiState.modelPickerOpen, saving: uiState.modelPickerSaving }),
  closeModelPicker: () => { uiState.modelPickerOpen = false; },
  // The approval dialog (app.js) answers the permission requests the reply stream queues.
  toolPermissions: () => uiState.pendingToolPermissions,
  setToolPermissions: list => { uiState.pendingToolPermissions = list; },
  commandPaletteOpen: () => uiState.commandPalette.open,
  voiceLanguage: () => uiState.voiceLanguage,
  handleComposerCommand, handleSpeakMessage, handleDeleteChat,
  speakingState: () => ({ messageId: uiState.ttsSpeakingMessageId, loadingId: uiState.ttsSpeakingLoadingId }),
  stopCurrentTts, _isTtsActive, _streamTtsStart, _streamTtsPushChunk, _streamTtsOnToolCall, _streamTtsReset, _streamTtsFlush,
  // _streamTts is declared with the TTS helpers further down; resolve at call time.
  setStreamTtsBuffer: text => { _streamTts.buffer = text; },
  notifyLocalCompletion, shouldSendOnEnter, extractTextUrls, promoteTextUrlsToAttachments,
  renderExecutionPanel, receiveExecutionScene, liveSceneFor, cancelLiveScene, renderSceneReplay, selectedMessagePresentation,
  renderMessageRefs: message => memoryFeature.renderMessageRefs(message),
  renderTextBlock, renderWorkspaceExplorer, renderTtsVoicePanel, modelOptionsForAuthMode,
  // createScrollPreservation() runs further down; resolve at call time.
  captureThreadAnchor: scroller => captureThreadAnchor(scroller),
  restoreThreadAnchor: anchor => restoreThreadAnchor(anchor),
  escapeHtml, truncate, icon,
});
featureActions.register(chatFeature.actions, 'chat');
featureForms.register(chatFeature.forms, 'chat');
// Customize page (architecture B3): skills, connectors, safety and Tools & Tasks sections.
const customizeFeature = installCustomizeFeature({ agentsFeature, allChatAgentProfiles, api, applyBootstrap, applyBootstrapPreservingDrafts, approvalsFeature, bgRender, effectiveModelSetupDraft, escapeHtml, loadBootstrap, memoryFeature, minimaxTtsConfigPatchForVoice, patchSettings, refreshAdvancedStatus, render, renderApprovalPanel, renderCommandRunner, renderProjectArtifactShelf, renderSelectedFilePreview, renderTaskPanel, showError, uiState });
featureActions.register(customizeFeature.actions, 'customize');
featureForms.register(customizeFeature.forms, 'customize');
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

function renderTextBlock(value = '') {
  return renderReplyDocument(String(value).replace(/<viz-spec>[\s\S]*?<\/viz-spec>/gi, ''), renderInlineText, escapeHtml);
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

function agentProfileById(agentId) {
  return uiState.bootstrap?.customize?.agents?.find(agent => agent.id === agentId) || null;
}

function mainAgentProfile() {
  return agentProfileById('main');
}

// A task runs in a chat owned by the task's Agent inside the task's project,
// so its team is led by that Agent with the project's overrides applied.
function taskTeamLead(task) {
  const agents = conversationAgents(uiState.bootstrap, {overview:true,newProjectId:task.projectId || null});
  return agents.find(agent => agent.id === (task.owner || 'main')) || null;
}

// Inside a project the composer starts from the project's saved team.
function composerTeamPlan() {
  const projectId = !uiState.neuralOverview && activeChat() ? activeChat().projectId : uiState.newChatProjectId;
  return uiState.bootstrap?.projects?.find(project => project.id === projectId)?.teamPlan || null;
}

function projectDefaultAgentId(projectId) {
  const id = uiState.bootstrap?.projects?.find(project => project.id === projectId)?.defaultAgentId;
  return id && conversationAgents(uiState.bootstrap).some(agent => agent.id === id) ? id : '';
}

function activeChatAgentProfile() {
  return conversationAgent(uiState.bootstrap, {overview:uiState.neuralOverview, newAgentId:uiState.activeChatAgentId,newProjectId:uiState.newChatProjectId});
}

function allChatAgentProfiles() {
  return conversationAgents(uiState.bootstrap, {overview:uiState.neuralOverview,newProjectId:uiState.newChatProjectId});
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

function filteredChats() {
  const query = uiState.chatSearch.trim().toLowerCase();
  const chats = uiState.bootstrap?.chats || [];
  if (!query) return chats;

  return chats.filter(chat =>
    `${chat.title}\n${chat.preview}`.toLowerCase().includes(query),
  );
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
        title: t('技能'),
        items: results.skills || [],
      },
      {
        id: 'recent-connectors',
        title: t('连接器'),
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
    { id: 'skills', title: t('技能'), items: results.skills || [] },
    { id: 'connectors', title: t('连接器'), items: results.connectors || [] },
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

  chatFeature.clearHighlightedMessage();
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
      chatFeature.prepareThreadNavigation({
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
      chatFeature.prepareThreadNavigation({
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
    memoryFeature.onBootstrap(uiState.bootstrap);
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

function homePromptPresetById(presetId) {
  return HOME_PROMPT_PRESETS.find(preset => preset.id === presetId) || null;
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

function applyBootstrap(payload) {
  if (olderBootstrap(payload, uiState.bootstrap)) return;
  if (chatFeature.voiceCaptureActive() && ['activeView', 'selectedChatId', 'selectedProjectId'].some(key => payload?.settings?.[key] !== uiState.bootstrap?.settings?.[key])) chatFeature.stopVoiceCapture();
  const prevProjectId = uiState.bootstrap?.settings?.selectedProjectId || null;
  const nextProjectId = payload?.settings?.selectedProjectId || null;
  uiState.bootstrap = payload;
  memoryFeature.onBootstrap(uiState.bootstrap);
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
  memoryFeature.onBootstrap(uiState.bootstrap);
  syncSelectedArtifact();
  if (payload?.settings?.activeView !== 'search' || !uiState.searchQuery.trim()) {
    stopSearchFileStream();
  }
  // Forward the `background` flag so the typing guard in render() can defer
  // the DOM swap if the user is actively typing (see feedback: "还是跳光标").
  render({ background, changedSections });
}

async function patchSettings(patch) {
  if (['activeView', 'selectedChatId', 'selectedProjectId'].some(key => key in patch && patch[key] !== uiState.bootstrap?.settings?.[key])) chatFeature.stopVoiceCapture();
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

async function handleOpenNewChatHome() {
  uiState.neuralOverview = false;
  uiState.neuralGroup = null;
  chatFeature.resetComposerForNewChatHome();
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

let chatDeletionPending=false;
async function handleDeleteChat(chatId) {
  if(chatDeletionPending)return;
  chatDeletionPending=true;
  try {
  const preview=await api('/api/chats/delete-preview',{method:'POST',body:{chatId}});
  const fileDecision=await askFileDecision(preview);
  if(fileDecision==='cancel') return;
  applyBootstrap(
    await api('/api/chats/delete', {
      method: 'POST',
      body: { chatId, fileDecision, workspaceToken:preview.token },
    }),
  );
  closeRecentContextMenu();
  } finally {chatDeletionPending=false;}
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
  await chatFeature.createChat({ projectId, mode, agentId: projectDefaultAgentId(projectId) || uiState.activeChatAgentId || 'main' });
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
  if (chatFeature.isSending() || uiState.preparingTask) throw new Error('请先等待或停止当前执行。');
  uiState.preparingTask = true;
  try {
  const draft = chatFeature.takeComposerDraft();
  const payload = await api('/api/tasks/prepare', { method: 'POST', body: { taskId, teamPlan } });
  applyBootstrap(payload.bootstrap);
  await chatFeature.sendMessage(payload.execution);
  chatFeature.restoreComposerDraft(draft, payload.execution.content);
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
  const input = chatFeature.composerText().trim();
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
      await chatFeature.createChat();
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
  const raw = chatFeature.composerText().trim();
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

  chatFeature.setComposerText('');
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
    body: { filePath, chatId:activeChat()?.id },
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
              : ui`<div class="empty-state compact">还没有对话，从新对话开始。</div>`
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
  const showSuggestions = chatFeature.composerText().trim().startsWith('/') && suggestions.length;
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
                      ${task.status !== 'running' ? renderTeamPanel({scope:'task',target:task.id,lead:taskTeamLead(task),agents:conversationAgents(uiState.bootstrap,{overview:true,newProjectId:task.projectId || null}),disabled:chatFeature.isSending(),escapeHtml}) : ''}
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
                            ? ui`<button class="small-button is-primary" data-action="run-task" data-task-id="${task.id}" ${chatFeature.isSending() ? 'disabled' : ''}>${task.runCount ? t("继续 / 修复") : t("开始执行")}</button>`
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

function renderWorkspaceExplorer() {
  const workspace = uiState.bootstrap.workspace;


  if (!workspace.exists) {
    return ui`
      <div class="empty-state compact">
        ${workspace.requiresConfirmation ? t('请先确认项目工作区路径。') : t('这个对话还没有文件，Agent 首次创建文件后会显示在这里。')}
      </div>
    `;
  }

  return ui`
    <div class="workspace-root mono">${escapeHtml(workspace.rootPath)}</div>
    ${workspace.chatId ? ui`<button class="small-button" data-action="open-chat-files" data-chat-id="${escapeHtml(workspace.chatId)}">在 Finder 中打开</button>` : ''}
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


  if (!selectedFile) {
    return ui`<div class="empty-state compact">选择文件以预览内容。</div>`;
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

  const agent=conversationAgent(uiState.bootstrap);
  if(agent?.capabilities && !agent.capabilities.runCommands) return ui`<div class="empty-state compact">此 Agent 未开启运行命令能力。</div>`;

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
    return `<div class="empty-state compact">${t('还没有项目成果。在成果中保存一项后即可在这里复用。')}</div>`;
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
                ? chatFeature.renderMessageList(chat)
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

            ${chatFeature.renderThreadArtifactStrip(uiState.bootstrap.activeChatArtifacts || [])}
            ${chatFeature.renderComposer({ inline: true })}
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
                : '<div class="empty-state compact">文件和命令使用此对话的工作区。</div>'
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
    const [serversResp, pluginsResp, tasksResp, diagnosticsResp, retainedResp] = await Promise.all([
      api('/api/mcp/servers').catch(err => ({ _error: err?.message || 'mcp/servers failed' })),
      api('/api/plugins').catch(err => ({ _error: err?.message || 'plugins failed' })),
      api('/api/background-tasks/list').catch(err => ({ _error: err?.message || 'background-tasks/list failed' })),
      api('/api/diagnostics?storage=1').catch(err => ({ _error: err?.message || 'diagnostics failed' })),
      api('/api/workspace/retained').catch(err=>({_error:err.message})),
    ]);
    const errors = [serversResp, pluginsResp, tasksResp, diagnosticsResp, retainedResp]
      .filter(r => r && r._error)
      .map(r => r._error);
    if (errors.length === 5) {
      uiState.advanced.error = errors.join(' · ');
    } else {
      uiState.advanced.cliServers = Array.isArray(serversResp?.servers) ? serversResp.servers : [];
      uiState.advanced.plugins = Array.isArray(pluginsResp?.plugins) ? pluginsResp.plugins : [];
      uiState.advanced.tasks = Array.isArray(tasksResp?.runs) ? tasksResp.runs : [];
      uiState.advanced.diagnostics = diagnosticsResp?._error ? null : diagnosticsResp;
      uiState.advanced.retainedFiles = retainedResp?._error ? null : retainedResp;
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



async function handleKillBackgroundTask(runId) {
  if (!runId) return;
  try {
    await api('/api/background-tasks/kill', { method: 'POST', body: { runId } });
    await refreshAdvancedStatus();
  } catch (err) {
    showError(`Kill task failed: ${err?.message || err}`);
  }
}

// ── Safety allowlist (Phase 3b/3c) ─────────────────────────────────────
//
// Backed by the persistent fileSafetyAllowlist (config-stored).
// pendingRemoveId is set while the DELETE is in flight so the row can
// disable its button without flashing on optimistic re-render.



// ── Domain cookies (Phase 4) ──────────────────────────────────────────
//
// Same shape as refreshSafetyAllowlist / removeSafetyAllowlistRule but
// for the domainCookies map. The GET response intentionally omits the
// cookie string so the listing UI never shows session secrets — add /
// upsert ships the new value, remove drops it.






// ───────────────────────────────────────────────────────────────────────
// Phase 3 — Skill Overview | Markdown tab switcher
// ───────────────────────────────────────────────────────────────────────






// renderAdvancedPage moved to ./advancedPage.js so its branches can be
// covered by node:test smoke tests.  The call site below threads the
// runtime closures (escapeHtml, scheduleRefresh) explicitly so the
// extracted module stays a pure function.



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
      return projectsFeature.renderPage();
    case 'agent':
      return agentsFeature.renderPage();
    case 'model':
      return renderModelPage();
    case 'settings':
      return renderLocalSettings(uiState.bootstrap);
    case 'customize':
      return customizeFeature.renderPage();
    case 'artifacts':
      return renderArtifactsPage();
    case 'search':
      return renderSearchPage();
    case 'chats':
      return renderChatsPage();
    case 'chat':
    default:
      return chatFeature.renderPage();
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
  if (entry.kind === 'capability') return approvalsFeature.renderCapabilityPrompt(entry);

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

window.addEventListener('resize', chatFeature.positionAgentDropdown);
window.addEventListener('scroll', chatFeature.positionAgentDropdown, { capture: true, passive: true });

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

  agentsFeature.captureBeforeRender();

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
  // The composer's value and scrollTop (chat feature hook).
  const _savedComposerScroll = chatFeature.captureComposerBeforeRender();

  // Save content scroll position — render() rebuilds the DOM and would reset it to 0
  const _contentScroller = document.querySelector('.content-scroll');
  const _savedContentScroll = _contentScroller instanceof HTMLElement ? _contentScroller.scrollTop : -1;

  // Thread scrollTop, viz anchor and thread signature (chat feature hook;
  // the viz-anchoring and signature rationale lives with it).
  const _savedThread = chatFeature.captureThreadBeforeRender();
  const _chat = activeChat();

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
  if (uiState.commandPalette.open || uiState.pendingToolPermissions.length) { uiState.modelPickerOpen = false; chatFeature.closeAgentSelector(); }
  const currentPage = app.querySelector('main.content-scroll');
  const keepPage = background && changedSections && !uiState.neuralOverview && !chatFeature.isSending() &&
    !pageAffected(uiState.bootstrap.settings.activeView, changedSections) && currentPage;
  const pageHtml = keepPage ? preserveNeuralRegion(currentPage) :
    ui`<main class="content-scroll" data-neural-key="page-${uiState.neuralOverview ? 'overview' : escapeHtml(uiState.bootstrap.settings.activeView + ':' + (uiState.bootstrap.settings.selectedCustomizeSection || ''))}">${uiState.neuralOverview ? renderNeuralOverview(uiState.bootstrap, neuralGroup, { composer: chatFeature.renderComposer() }) : renderPage()}</main>`;
  updateNeuralWorkspace(app, ui`
    <div data-neural-key="workspace" class="shell neural-shell ${uiState.neuralOverview ? 'is-overview' : 'is-working'}" data-neural-stage="${neuralStage}" data-neural-busy="${chatFeature.isSending()}" data-neural-permission="${!!uiState.pendingToolPermissions?.length}" data-neural-group="${neuralGroup}">
      <div class="neural-cosmos" aria-hidden="true"></div>
      <div class="neural-core-anchor" aria-hidden="true"></div>
      ${renderNeuralNavigation(uiState.bootstrap, neuralGroup, { overview: uiState.neuralOverview, still: uiState.neuralStill })}
      <div class="neural-activity" role="status">${chatFeature.isSending() ? escapeHtml(chatFeature.thinkingLabel()) : t("本地工作空间")}</div>
      <div class="neural-preview" role="status" aria-live="polite" hidden></div>
      <div data-neural-key="dashboard" class="workspace neural-dashboard">
        ${renderSyncConflicts(uiState.bootstrap.syncConflicts,escapeHtml)}
        ${renderSyncConflicts(uiState.bootstrap.agentSettingsConflicts,escapeHtml,true)}
        ${renderSyncConflicts(uiState.bootstrap.projectMemoryConflicts,escapeHtml,'project-memory')}
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
    ${chatFeature.renderAgentSelectorDropdown()}
    <input id="composer-attachment-input" class="hidden-file-input" type="file" multiple />
    ${renderCommandPalette()}
    ${renderEditContextMenu()}
    ${renderCopyContextMenu()}
    ${renderRecentContextMenu()}
    ${renderAudioContextMenu()}
    ${renderToolPermissionDialog()}
    ${api.pendingSaves().length ? ui`<aside class="committed-save-notice surface-card" aria-live="polite">
      <p>已保存，等待刷新页面</p>
      <p class="meta-label">刷新只读取已保存的内容。</p>
      ${api.pendingSaves().map(save => ui`<button type="button" class="small-button" data-action="retry-committed-save" data-save-id="${save.id}" ${save.retrying ? 'disabled' : ''}>${save.retrying ? t('正在刷新…') : t('刷新页面')}</button>`).join('')}
    </aside>` : ''}
    ${uiState.error ? ui`<div class="toast">${escapeHtml(uiState.error)}</div>` : ''}
  `);

  settingsFormEditors.decorate(app);
  syncNeuralComposer(app, chatFeature.composerText());
  animateNeuralLayout(neuralBefore, uiState.neuralStill);
  syncNeuralScene(uiState.neuralStill);
  syncExecutionPanel({ chat: activeChat(), still: uiState.neuralStill, autoCollapse: uiState.bootstrap.settings.localPreferences?.autoCollapse !== false, onImageRetry: chatFeature.retryMissingImages, onSelectionChanged: bgRender });
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

  // Restore thread scroll only on UI-only renders (chat feature hook).
  chatFeature.restoreThreadScrollAfterRender(_savedThread);

  bindContentScrollbar();
  syncContentScrollbar();
  chatFeature.syncThreadViewport();
  agentsFeature.restoreScrollAfterRender();
  // Restore AFTER agent-specific restore so the generic path covers the panes
  // the agent logic doesn't know about (e.g. customize-pane on non-agent views).
  restoreScrollPositions(_savedNestedScrolls);
  // Restore named-textarea scrollTop for every form textarea we saved above.
  // Runs BEFORE the Agent editor restore so the agent-content-editor's
  // dedicated restore still has the last word for that one textarea (it also
  // restores selection + focus, which this generic path deliberately doesn't
  // touch — we only care about scrollTop here).
  restoreFormTextareaScrolls(_savedTextareaScrolls);
  agentsFeature.syncRuntimeRefresh();
  syncSearchFieldFocus();
  syncFileEditorGoToLine();
  chatFeature.restoreComposerAfterRender(_savedComposerScroll);
  agentsFeature.restoreEditorAfterRender();
  // Put the caret back into whichever input/textarea was focused before the
  // page update. Runs AFTER the Agent editor restore so the agent-specific
  // textarea restore wins for that one input; this helper covers everything
  // else (Discord Guild ID, Telegram bot token, nickname lists, etc.).
  restoreFocusedInputState(_savedFocusedInput);
  // A capability prompt that just appeared takes keyboard focus once (approvals hook).
  approvalsFeature.focusPromptAfterRender();
  chatFeature.positionAgentDropdown();
  // Mount Demon viz blocks (projectile, tree, ...) into the message bubbles
  // that carry a validated `viz` spec. Runs AFTER the DOM swap so it can
  // query freshly rendered `.viz-mount` shells and attach canvases/SVGs.
  chatFeature.syncVizBlocks();

  // Viz cards just grew: pin the viewport to the message the user was
  // reading (chat feature hook).
  chatFeature.restoreVizAnchorAfterRender(_savedThread);
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
      chatFeature.updateThreadAutoFollow(scroller);
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

  if (chatFeature.closeAttachmentMenuOnOutsideClick(event)) {
    closedAttachmentMenu = true;
  }

  if (uiState.modelPickerOpen && !event.target.closest('.model-picker-anchor')) {
    uiState.modelPickerOpen = false;
    render();
  }

  chatFeature.closeAgentSelectorOnOutsideClick(event);

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
  if (chatFeature.handleChatFilesToggle(action, trigger, event)) return;
  if (action?.startsWith('image-')) {
    event.preventDefault();
    try { await handleImageAction(action, { config: uiState.bootstrap.settings.config, attachments: chatFeature.composerAttachments(), api, render, refresh: () => loadBootstrap(uiState.searchQuery, { quiet: true }) }); } catch (error) { window.alert(error.message); }
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
    if(await handleManagementAction(action,trigger,{api,data:uiState.bootstrap,applyBootstrap,refresh:refreshAdvancedStatus})) return;
    if (featureActions.has(action)) { await featureActions.dispatch(action, { action, trigger, event }); return; }
    switch (action) {
      case 'retry-committed-save':
        await api.retryCommittedSave(trigger.dataset.saveId);
        break;
      case 'open-chat-files':
      case 'open-retained-files': await api('/api/workspace/open',{method:'POST',body:{chatId:trigger.dataset.chatId,retained:action==='open-retained-files'}});break;
      case 'decide-retained-files': {
        const files=await api('/api/workspace/retained');
        const record=files.directories.find(r=>r.chatId===trigger.dataset.chatId);
        if(!record) {await refreshAdvancedStatus();break;}
        const decision=await askFileDecision({...record,retained:true});
        if(decision!=='cancel') {await api('/api/workspace/retained',{method:'POST',body:{chatId:record.chatId,decision,token:record.token}});await refreshAdvancedStatus();}
        break;
      }
      case 'toggle-model-picker':
        uiState.modelPickerOpen = !uiState.modelPickerOpen;
        uiState.ttsVoicePanelOpen = false;
        chatFeature.closeAttachmentMenu();
        render();
        if (uiState.modelPickerOpen) document.querySelector('.model-picker-option.is-selected')?.focus();
        break;
      case 'pick-default-model': {
        if (uiState.modelPickerSaving) break;
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
        uiState.neuralGroup = trigger.dataset.group;
        uiState.neuralExpanded = true;
        uiState.neuralOverview = true;
        render();
        break;
      case 'neural-back':
        uiState.neuralExpanded = !uiState.neuralOverview;
        uiState.neuralOverview = true;
        render();
        break;
      case 'neural-overview':
        uiState.neuralExpanded = false;
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
      case 'open-view':
        chatFeature.clearHighlightedMessage();
        uiState.shouldFocusSearch = trigger.dataset.view === 'search';
        await patchSettings({ activeView: trigger.dataset.view });
        if (trigger.dataset.view === 'search' && uiState.searchQuery.trim()) {
          await loadBootstrap(uiState.searchQuery, { quiet: true });
        }
        break;
      case 'clear-search-query':
        uiState.searchQuery = '';
        chatFeature.clearHighlightedMessage();
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
        chatFeature.clearHighlightedMessage();
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
        // Settings are committed only by the explicit Save action.
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
        chatFeature.clearHighlightedMessage();
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
        chatFeature.setComposerText(preset.prompt);
        render();
        chatFeature.focusComposerSoon();
        break;
      }
      case 'open-chat': {
        chatFeature.prepareThreadNavigation({
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
      case 'resolve-sync-conflict': {
        const settings=trigger.dataset.settings==='true', projectMemory=trigger.dataset.settings==='project-memory';
        const row=(projectMemory?uiState.bootstrap.projectMemoryConflicts:settings?uiState.bootstrap.agentSettingsConflicts:uiState.bootstrap.syncConflicts).find(r=>r.kind===trigger.dataset.kind&&r.id===trigger.dataset.id);
        const index=Number(trigger.dataset.index);
        await api(projectMemory?'/api/project-memory-sync/resolve':settings?'/api/agent-settings-sync/resolve':'/api/mobile-sync/resolve',{method:'POST',body:{kind:row.kind,id:row.id,index,expected:row.versions[index]}});
        applyBootstrap(await api('/api/bootstrap')); break;
      }
      case 'toggle-task-form':
        uiState.showTaskForm = !uiState.showTaskForm;
        render();
        break;
      case 'toggle-artifact-form':
        uiState.showArtifactForm = !uiState.showArtifactForm;
        render();
        break;
      case 'select-agent-profile':
        await patchSettings({
          activeView: 'agent',
          selectedAgentId: trigger.dataset.agentId || trigger.value || 'main',
        });
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
      case 'refresh-advanced-status':
        await refreshAdvancedStatus();
        break;
      case 'kill-background-task':
        await handleKillBackgroundTask(trigger.dataset.runId);
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
      case 'run-task-team': {
        const team=collectTeamPlan(trigger.closest('[data-team-scope]'));
        if(team.error) {showError(t(team.error));break;}
        await handleRunTask(trigger.dataset.taskId, team.plan);
        break;
      }
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
        chatFeature.setComposerText(trigger.dataset.command || '/');
        render();
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
  if (memoryFeature.handleFieldInput(target)) return;
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
  if (memoryFeature.handleInput(target)) return;
  if (target.dataset.taskPricing) { uiState.taskPricing ||= {}; uiState.taskPricing[target.dataset.taskPricing] = target.value; return; }
  if (handleImageInput(target, uiState.bootstrap?.settings?.config || {})) return;
  if (editExtraFast(target)) return;
  if (editLlmConnection(target, uiState.bootstrap?.settings?.config || {})) return;

  if (chatFeature.handleComposerInput(target)) return;

  if (projectsFeature.handleSearchInput(target)) return;

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

  if (projectsFeature.handleDraftInput(target)) return;

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
      // Settings are committed only by the explicit Save action.
    }
    return;
  }

  if (agentsFeature.handleInput(target)) return;
});

document.addEventListener(
  'scroll',
  event => agentsFeature.handleScroll(event),
  true,
);

document.addEventListener('change', async event => {
  const target = event.target;
  if (memoryFeature.handleFieldInput(target)) return;
  if (target.name === 'team-member' && target.closest?.('[data-team-scope]')) { noteTeamMemberToggle(target); return; }
  const memoryChange = memoryFeature.handleChange(target);
  if (memoryChange) { await memoryChange; return; }
  const projectsChange = projectsFeature.handleChange(target);
  if (projectsChange) { await projectsChange; return; }
  if (target.dataset?.chatContext) {
    const chat = !uiState.neuralOverview ? activeChat() : null;
    const patch = target.dataset.chatContext === 'project' ? {projectId:target.value || null} : {contextArtifactIds:[...document.querySelectorAll('[data-chat-context="artifact"]:checked')].map(el=>el.value)};
    try {
      if (chat) applyBootstrapPreservingDrafts(await api('/api/chats/update',{method:'POST',body:{chatId:chat.id,patch}}));
      else if (Object.hasOwn(patch,'projectId')) {
        uiState.newChatProjectId = patch.projectId;
        // Picking a project for a new chat switches to that project's default Agent; the picker can still change it.
        const projectAgent = projectDefaultAgentId(patch.projectId);
        if (projectAgent) uiState.activeChatAgentId = projectAgent;
      }
      else {
        uiState.newChatArtifactIds=patch.contextArtifactIds;
      }
    } catch(error) { showError(error.message); }
    render(); return;
  }
  const agentFileChange = agentsFeature.handleFileChange(target);
  if (agentFileChange) { await agentFileChange; return; }

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
    const composerFiles = chatFeature.handleComposerFileChange(target);
    if (composerFiles) {
      await composerFiles;
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
      // Settings are committed only by the explicit Save action.
      return;
    }

    if (target.form?.dataset.form === 'task-create') {
      uiState.draftTask[target.name] = target.value;
      return;
    }

    if (agentsFeature.handleChange(target)) return;
  } catch (error) {
    showError(error.message);
  }
});

document.addEventListener('dragover', event => chatFeature.handleComposerDragOver(event));

document.addEventListener('dragleave', event => chatFeature.handleComposerDragLeave(event));

document.addEventListener('drop', event => chatFeature.handleComposerDrop(event));

document.addEventListener('dragend', () => chatFeature.handleComposerDragEnd());

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();

  const editTicket=settingsFormEditors.start(form);
  if(editTicket===false) return;
  let saveError=null;
  if(editTicket) queueMicrotask(()=>render());
  try {
    if (featureForms.has(form.dataset.form)) { await featureForms.dispatch(form.dataset.form, { form, event }); return; }
    switch (form.dataset.form) {
      case 'task-pricing': {
        const body=Object.fromEntries(new FormData(form));
        await api('/api/tasks/pricing',{method:'POST',body});
        uiState.taskPricing=null;
        await loadBootstrap(uiState.searchQuery,{quiet:true});
        break;
      }
      case 'connector-config':
        await handleSaveConnectorConfig(form);
        break;
      case 'model-config':
        await handleSaveConnectorConfig(form);
        break;
      case 'default-model-config':
        applyBootstrap(await api('/api/settings/model', {method: 'POST', body: {model: new FormData(form).get('model')}}));
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
  if (chatFeature.handleAgentSelectorKeydown(event, target)) return;
  if (uiState.modelPickerOpen && target?.closest('.model-picker-panel') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const options = [...document.querySelectorAll('.model-picker-option:not(:disabled)')];
    const index = options.indexOf(target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
    return;
  }

  const composerKey = chatFeature.handleComposerKeydown(event, target);
  if (composerKey) {
    await composerKey;
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
  chatFeature.handleVoiceBridgeEvent(event.detail || {});
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
  chatFeature.restorePendingVizAnchor();
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
        chatId: activeChat()?.id,
        projectId: activeChat()?.projectId || null,
      },
    }),
});

loadBootstrap();
initBrowserVoices();

// Stop capture when the page leaves; reopening a chat never restarts listening.
window.addEventListener('pagehide', () => chatFeature.stopVoiceCapture());
document.addEventListener('visibilitychange', () => { if (document.hidden) chatFeature.stopVoiceCapture(); });
document.addEventListener('change', event => {
  if (event.target.matches?.('[data-voice-language]')) {
    uiState.voiceLanguage = event.target.value;
    api('/api/settings/local',{method:'POST',body:{preferences:{voiceLanguage:event.target.value}}}).then(data=>applyBootstrapPreservingDrafts(data)).catch(error=>showError(error.message));
  }
});

installLanguageControls({api,applyBootstrap,render});
installLocalSettings({api,uiState,render,stopSpeech:stopCurrentTts,applyBootstrap,patchSettings,reload:()=>loadBootstrap(),openVoice:async()=>{await patchSettings({activeView:'chat'});uiState.ttsVoicePanelOpen=true;loadMacosVoices();render();}});
installImagePreview({ saveNativeImage: window.webkit?.messageHandlers?.meloVoice ? payload => nativeSettings('saveImage', payload) : undefined });
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{if(uiState.bootstrap)render();});
window.addEventListener('melo-open-settings',()=>patchSettings({activeView:'settings'}));

// A silent provider must still advance the visible wait timer.
setInterval(() => {
  if (!chatFeature.isSending() || document.hidden) return;
  for (const node of document.querySelectorAll('.thinking-banner, .neural-activity')) node.textContent = chatFeature.thinkingLabel();
}, 1000);
