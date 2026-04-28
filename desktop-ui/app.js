import {
  renderVizMountHtml,
  mountVizBlocks,
} from './viz/vizRenderer.js';
import {
  renderInlineSegmentWithCites,
  installCitationDrawer,
  resetCitationPreviewCache,
} from './viz/citationRenderer.js';
import { promoteTextUrlsToAttachments } from '/shared/urlDetector.js';
import { resolveActiveMinimaxVoiceId } from '/shared/minimaxVoiceResolver.js';
import { describeVideoExtractionStatus } from './videoStatus.js';
import { renderAdvancedPage } from './advancedPage.js';
import {
  UNDO_TOAST_DEFAULT_MS,
  formatUndoToastLabel,
  nextCountdownTickMs,
} from './undoToast.js';
import { agentDraftFromProfile, normalizeChannelsForDraft } from './agentDraft.js';
import { buildConnectorDraft, pickConnectorField } from './connectorDraft.js';
import { applyFormInputToDraft } from './connectorDraftDispatch.js';

const app = document.querySelector('#app');

const uiState = {
  bootstrap: null,
  loading: true,
  sending: false,
  sendAbortController: null,
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
  agentSaveStates: {},
  agentSecretVisibility: {},
  commandInputs: {},
  commandPalette: {
    open: false,
    query: '',
    selectedIndex: 0,
  },
  voice: {
    supported: Boolean(globalThis.webkit?.messageHandlers?.meloVoice),
    recording: false,
    status: 'idle',
    preview: '',
    error: '',
    // JS-level guard: true after the first finalText is received for a recording
    // session. Prevents duplicate text if Swift fires the event twice (e.g. the
    // kAFAssistantErrorDomain 216 cancel-error triggering a second finalText).
    finalReceived: false,
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
  error: '',
  // Tool execution UI state
  // pendingToolPermissions: array of { requestId, toolId, args } — one dialog per item
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
  agentSelectorOpen: false,
  // Demon mode — experimental toggle to the left of the model selector.
  // Persisted to localStorage so it survives reloads; currently just a UI
  // flag — downstream behavior hooks in will read `uiState.demonMode`.
  demonMode: localStorage.getItem('melo-demon-mode') === '1',
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
let deferredRenderPending = false;
let deferredRenderTimer = 0;
const TYPING_GUARD_WINDOW_MS = 500;
const TYPING_GUARD_DEFER_CHECK_MS = 120;

function userIsActivelyTyping() {
  if (!lastUserKeystrokeAt) return false;
  return Date.now() - lastUserKeystrokeAt < TYPING_GUARD_WINDOW_MS;
}

function scheduleDeferredRender() {
  if (deferredRenderPending) return;
  deferredRenderPending = true;
  const tick = () => {
    if (userIsActivelyTyping()) {
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
    model: 'gpt-5.5',
  },
  codex: {
    baseUrl: 'https://chatgpt.com/backend-api',
    model: 'gpt-5.5',
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

  if (!uiState.thinkingSince) {
    return '正在思考';
  }

  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - uiState.thinkingSince) / 1000),
  );
  return elapsedSeconds > 0 ? `正在思考 ${elapsedSeconds}s` : '正在思考';
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
  const normalized = normalizeDisplayConversationText(value);
  if (!normalized) {
    return '';
  }

  return normalized
    .split(/\n{2,}/g)
    .map(paragraph => `<p>${renderInlineText(paragraph)}</p>`)
    .join('');
}

function renderRichText(value = '') {
  return parseRenderableMessageBlocks(value)
    .map(block => {
      if (block.type === 'code') {
        return `
          <div
            class="message-code-block"
            data-copyable-surface
            data-copy-text="${escapeHtml(block.value)}"
          >
            ${
              block.language
                ? `<div class="message-code-label">${escapeHtml(block.language)}</div>`
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
  return `
    <div class="agent-runtime-metric">
      <div class="agent-runtime-metric-label">${escapeHtml(label)}</div>
      <div class="agent-runtime-metric-value">${escapeHtml(value || '—')}</div>
    </div>
  `;
}

function renderChannelRuntimeCard(channel, { showRoute = false } = {}) {
  const incomingPreview = channel?.lastIncomingPreview || '';
  const replyPreview = channel?.lastReplyPreview || '';

  return `
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
          ? `
            <div class="agent-runtime-preview-stack">
              ${
                incomingPreview
                  ? `
                    <div class="agent-runtime-preview-card">
                      <div class="agent-runtime-preview-label">Last incoming</div>
                      <div class="agent-runtime-preview-copy">${escapeHtml(incomingPreview)}</div>
                    </div>
                  `
                  : ''
              }
              ${
                replyPreview
                  ? `
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
        return `
          <div
            class="message-code-block"
            data-copyable-surface
            data-copy-text="${escapeHtml(block.text)}"
          >
            ${
              block.language
                ? `<div class="message-code-label">${escapeHtml(block.language)}</div>`
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

      const displayText = normalizeDisplayConversationText(textForDisplay);
      if (!displayText) {
        return '';
      }

      return `
        <div
          class="message-bubble"
          data-copyable-surface
          data-copy-text="${escapeHtml(displayText)}"
        >
          ${renderTextBlock(displayText)}
        </div>
      `;
    })
    .join('');

  return `
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
    const url = match[2] || match[3];
    const label = match[1] || url;
    html += `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(
      label,
    )}</a>`;
    cursor = match.index + match[0].length;
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
  return `
    <div class="source-citation-strip">
      ${citations.map(({ url, via }) => `
        <a
          class="source-citation-card"
          href="${escapeHtml(url)}"
          target="_blank"
          rel="noreferrer"
          title="${escapeHtml(url)}"
        >
          <span class="citation-icon">🔗</span>
          <span class="citation-host">${escapeHtml(citationHostname(url))}</span>
          ${via ? `<span class="citation-via">${escapeHtml(via)}</span>` : ''}
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

  return `
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
            return `<span class="diff-line ${klass}">${escapeHtml(line)}</span>`;
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

  return `
    <div class="composer-attachment-list">
      ${attachments
        .map(
          attachment => `
            <div class="composer-attachment-chip">
              <span class="chip-icon">${attachmentIcon(attachment.kind)}</span>
              <span class="composer-attachment-label">${escapeHtml(attachmentLabel(attachment))}</span>
              ${
                attachment.sizeLabel
                  ? `<span class="meta-label">${escapeHtml(attachment.sizeLabel)}</span>`
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

  return `
    <div class="composer-attachment-menu">
      <button class="composer-menu-item" type="button" data-action="pick-composer-attachment" data-accept="image/*">
        <span class="chip-icon">${icon.image}</span>
        Image
      </button>
      <button class="composer-menu-item" type="button" data-action="pick-composer-attachment" data-accept="video/*" title="Video → audio is transcribed via Whisper, and ~5 evenly-spaced keyframes are sent to the model alongside the transcript.">
        <span class="chip-icon">${icon.video}</span>
        <span class="composer-menu-item-text">
          <span>Video</span>
          <span class="composer-menu-item-hint">transcript + keyframes</span>
        </span>
      </button>
      <button class="composer-menu-item" type="button" data-action="pick-composer-attachment" data-accept="audio/*">
        <span class="chip-icon">${icon.audio}</span>
        Audio
      </button>
      <button class="composer-menu-item" type="button" data-action="pick-composer-attachment" data-accept="application/pdf,.pdf" title="PDF documents are extracted via pdf-parse and the text is sent to the model.">
        <span class="chip-icon">${icon.file}</span>
        <span class="composer-menu-item-text">
          <span>PDF</span>
          <span class="composer-menu-item-hint">extracted as text</span>
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
    `<option value="">System default</option>`,
    ...enVoices.map(v =>
      `<option value="${escapeHtml(v.name)}" ${uiState.ttsBrowserVoiceName === v.name ? 'selected' : ''}>${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`
    ),
    otherVoices.length ? `<option disabled>──────────</option>` : '',
    ...otherVoices.map(v =>
      `<option value="${escapeHtml(v.name)}" ${uiState.ttsBrowserVoiceName === v.name ? 'selected' : ''}>${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`
    ),
  ].join('');

  const radioRow = (label, hint, isActive, action, dataAttrs = '') => `
    <button class="tts-radio-row ${isActive ? 'is-active' : ''}" ${action} ${dataAttrs}>
      <span class="tts-radio-dot">${isActive ? '●' : '○'}</span>
      <span class="tts-radio-body">
        <span class="tts-radio-label">${label}</span>
        ${hint ? `<span class="tts-radio-hint">${hint}</span>` : ''}
      </span>
    </button>
  `;

  // macOS voice options — lazy-loaded via /api/tts/say-voices when the
  // panel first opens. Until then, show a placeholder so the radio still
  // renders and reflects the user's persisted selection.
  const macosVoices = uiState.ttsMacosVoices;
  const macosVoiceOptions = (() => {
    if (!uiState.ttsMacosVoicesLoaded) {
      return `<option value="">Loading…</option>`;
    }
    if (macosVoices.length === 0) {
      return `<option value="">(no /usr/bin/say voices found)</option>`;
    }
    // Group by language family — en first (most users), then everything
    // else alphabetised by lang code.
    const enMac = macosVoices.filter(v => v.lang.startsWith('en'));
    const otherMac = macosVoices.filter(v => !v.lang.startsWith('en'))
      .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    const opt = v =>
      `<option value="${escapeHtml(v.name)}" ${uiState.ttsMacosVoiceName === v.name ? 'selected' : ''}>${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`;
    return [
      `<option value="">Auto-detect by language</option>`,
      ...enMac.map(opt),
      otherMac.length ? `<option disabled>──────────</option>` : '',
      ...otherMac.map(opt),
    ].join('');
  })();

  return `
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

      ${engine === 'macos' ? `
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

      ${engine === 'browser' && browserVoices.length > 0 ? `
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

      ${isEdgeTtsActive ? `
        <div class="tts-panel-sub">
          <select class="tts-voice-select" data-action="select-tts-edge-voice">
            <option value="">Auto-detect by language</option>
            ${EDGE_TTS_VOICES.map(v =>
              `<option value="${escapeHtml(v.id)}" ${uiState.ttsEdgeVoice === v.id ? 'selected' : ''}>${escapeHtml(v.label)} — ${escapeHtml(v.desc)}</option>`
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

      ${isApiVoiceActive ? `
        <div class="tts-panel-sub">
          <select class="tts-voice-select" data-action="select-tts-api-voice">
            ${TTS_API_VOICES.map(v =>
              `<option value="${v.id}" ${uiState.ttsApiVoice === v.id ? 'selected' : ''}>${v.label} — ${v.desc}</option>`
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
              ? `Active — ${customVoices.find(v => v.id === uiState.ttsCustomVoiceId)?.label || '自定义'}`
              : 'MiniMax 克隆音色 · 需要 API Key',
            isMinimaxActive,
            'data-action="activate-minimax-voice"', ''
          )}
          ${isMinimaxActive && customVoices.length > 1 ? `
            <div class="tts-panel-sub">
              <select class="tts-voice-select" data-action="select-tts-custom-voice">
                ${customVoices.map(v =>
                  `<option value="${escapeHtml(v.id)}" ${uiState.ttsCustomVoiceId === v.id ? 'selected' : ''}>${escapeHtml(v.label)}</option>`
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
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) {
    return '';
  }

  return `
    <div class="message-attachments">
      ${attachments
        .map(attachment => {
          if (attachment.kind === 'image') {
            return `
              <figure class="message-attachment-card media-card image-card">
                <img src="${escapeHtml(attachment.url)}" alt="${escapeHtml(attachmentLabel(attachment))}" class="message-image" />
                <figcaption>${escapeHtml(attachmentLabel(attachment))}</figcaption>
              </figure>
            `;
          }

          if (attachment.kind === 'video') {
            const status = describeVideoExtractionStatus(message, attachment);
            return `
              <div class="message-attachment-card media-card">
                <video class="message-video" controls src="${escapeHtml(attachment.url)}"></video>
                <div class="media-caption">
                  ${escapeHtml(attachmentLabel(attachment))}
                  <span class="media-caption-hint">${escapeHtml(status)}</span>
                </div>
              </div>
            `;
          }

          if (attachment.kind === 'audio') {
            return `
              <div class="message-attachment-card audio-card" data-audio-url="${escapeHtml(attachment.url)}">
                <div class="audio-card-title">
                  <span class="chip-icon">${icon.audio}</span>
                  ${escapeHtml(attachmentLabel(attachment))}
                </div>
                <audio class="message-audio" controls src="${escapeHtml(attachment.url)}"></audio>
              </div>
            `;
          }

          return `
            <a class="message-attachment-card link-card" data-copyable-surface href="${escapeHtml(
              attachment.url,
            )}" target="_blank" rel="noreferrer">
              <span class="chip-icon">${icon.link}</span>
              <span>
                <strong>${escapeHtml(attachmentLabel(attachment))}</strong>
                <span class="link-card-url">${escapeHtml(attachment.url)}</span>
              </span>
            </a>
          `;
        })
        .join('')}
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

  return `
    ${toolStrip}
    <article class="message assistant is-streaming">
      <div class="message-role">Melo</div>
      <div
        class="message-bubble"
        data-copyable-surface
        data-copy-text="${escapeHtml(streamCleanText)}"
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
  bubble.setAttribute('data-copy-text', streamCleanText);

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
  return agentProfileById(uiState.activeChatAgentId) || agentProfileById('main');
}

function allChatAgentProfiles() {
  return uiState.bootstrap?.customize?.agents || [];
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
  return `${scope}:${projectId}:${agentId}`;
}

function agentSaveKey(
  agentId,
  scope = selectedAgentScope(),
  projectId = activeProject()?.id || 'global',
) {
  return `${scope}:${projectId}:${agentId}`;
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
  if (uiState.bootstrap?.settings?.activeView !== 'agent') {
    return null;
  }

  const selected = selectedAgentProfile();
  if (!selected) {
    return null;
  }

  return `${selectedAgentScope()}:${activeProject()?.id || 'global'}:${selected.id}`;
}

function currentAgentEditorStateKey() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent') {
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
  if (uiState.bootstrap?.settings?.activeView !== 'agent') {
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
  if (uiState.bootstrap?.settings?.activeView !== 'agent') {
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
  if (uiState.bootstrap?.settings?.activeView !== 'agent') {
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
// innerHTML rebuild that every render() does. Without this, any render
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
    if (!(editor instanceof HTMLTextAreaElement)) {
      return;
    }

    if (editorState) {
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

function selectedArtifact() {
  const artifacts = uiState.bootstrap?.artifacts || [];
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
  const projects = uiState.bootstrap?.projects || [];
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
          chat?.projectId || uiState.bootstrap.settings.selectedProjectId,
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
          chat?.projectId || uiState.bootstrap.settings.selectedProjectId,
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
  const artifacts = uiState.bootstrap?.artifacts || [];
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
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed.');
  }

  return payload;
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
    throw new Error(payload.error || 'Streaming request failed.');
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
          throw new Error(message.payload?.error || 'Streaming request failed.');
        } else if (message.event === 'aborted') {
          return null;
        }
      }
    }

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
    render();
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

  try {
    const normalizedQuery = query.trim();
    const suffix = normalizedQuery
      ? `?q=${encodeURIComponent(normalizedQuery)}`
      : '';
    uiState.bootstrap = await api(`/api/bootstrap${suffix}`);
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
    render({ background: quiet });
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
    render();
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
      render();
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
    render();
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
  render();
  window.clearTimeout(showError.timer);
  showError.timer = window.setTimeout(() => {
    uiState.error = '';
    render();
  }, 4800);
}

function voiceBridgeSupported() {
  return Boolean(globalThis.webkit?.messageHandlers?.meloVoice);
}

function composerHintText({ inline = false } = {}) {
  if (uiState.sending) {
    return 'Working on your message now. Live lookups can take a little longer.';
  }
  if (uiState.voice.recording) {
    return 'Listening now. Speak naturally, then tap the mic to send.';
  }
  if (uiState.voice.preview) {
    return 'Voice ready — sending…';
  }
  if (!inline && !uiState.composer.trim()) {
    return 'Type / for Melo commands, files, projects, and actions.';
  }
  if (inline) {
    return 'Reply in this thread';
  }
  return 'Enter to send. Shift+Enter for a new line.';
}

function voiceStatusLabel() {
  if (!uiState.voice.supported) {
    return 'Voice unavailable';
  }
  if (uiState.voice.recording) {
    return 'Listening';
  }
  if (uiState.voice.preview) {
    return 'Transcript ready';
  }
  if (uiState.voice.error) {
    return 'Needs attention';
  }
  return 'Voice ready';
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
  return `
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
  return `
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
  return `
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
  return `
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

function attachmentIcon(kind) {
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
      showError(`${file.name} is not supported yet. Add images, video, or audio files here.`);
      continue;
    }

    const url = await readFileAsDataUrl(file);
    nextAttachments.push({
      id: crypto.randomUUID(),
      kind,
      url,
      title: file.name,
      fileName: file.name,
      mimeType: file.type || '',
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

function stopVoiceCaptureIfNeeded() {
  if (!uiState.voice.recording || !voiceBridgeSupported()) {
    return;
  }
  globalThis.webkit.messageHandlers.meloVoice.postMessage({
    action: 'stop',
  });
}

function handleVoiceBridgeEvent(detail = {}) {
  const nextState = {
    supported: detail.supported ?? true,
    recording: detail.recording ?? uiState.voice.recording,
    status: detail.status ?? uiState.voice.status,
    preview: detail.partial ?? uiState.voice.preview,
    error: detail.error ?? '',
    finalReceived: uiState.voice.finalReceived,
  };

  // Reset the dedup guard when a new recording session starts.
  if (detail.recording === true) {
    nextState.finalReceived = false;
  }

  if (detail.finalText) {
    // Dedup guard: ignore repeated finalText events from the same recording session.
    // This prevents duplicate text if Swift fires the cancel-error callback after
    // the isFinal callback (kAFAssistantErrorDomain error 216).
    if (uiState.voice.finalReceived) {
      return;
    }
    nextState.finalReceived = true;
    nextState.preview = '';
    nextState.recording = false;
    nextState.status = 'ready';
    nextState.error = '';

    if (detail.audioData) {
      // Voice message UX: auto-submit as an audio attachment so the message is
      // displayed as a voice bubble rather than inserting text into the composer.
      setVoiceState(nextState);
      render();
      void handleVoiceMessageAutoSubmit(detail.finalText, detail.audioData);
      return;
    }

    // Fallback: insert transcript text into the composer (no audio capture available).
    appendComposerText(detail.finalText);
  }

  if (detail.error) {
    nextState.preview = '';
    nextState.recording = false;
    showError(detail.error);
  }

  setVoiceState(nextState);
  render();

  if (detail.finalText && !detail.audioData) {
    window.requestAnimationFrame(() => {
      const composer = document.querySelector('#composer');
      if (!(composer instanceof HTMLTextAreaElement)) {
        return;
      }
      composer.focus();
      composer.selectionStart = composer.selectionEnd = composer.value.length;
    });
  }
}

async function handleVoiceMessageAutoSubmit(transcript, audioData) {
  // Prepare the composer with the audio attachment and the pre-computed transcript.
  // The transcript is passed as pre-populated extractedMedia so the backend skips
  // Whisper and uses the on-device SFSpeechRecognizer result directly.
  uiState.composerAttachments = [
    {
      kind: 'audio',
      url: audioData,
      mimeType: 'audio/wav',
      fileName: 'voice-message.wav',
      title: 'Voice message',
    },
  ];
  uiState.composerVoiceTranscript = transcript;
  uiState.composer = '';
  await handleSendMessage();
}

function toggleVoiceInput() {
  if (!voiceBridgeSupported()) {
    showError('Voice input is available only in the desktop app build.');
    return;
  }

  setVoiceState({
    supported: true,
    error: '',
    status: uiState.voice.recording ? 'stopping' : 'requesting',
  });
  render();
  globalThis.webkit.messageHandlers.meloVoice.postMessage({
    action: uiState.voice.recording ? 'stop' : 'toggle',
  });
}

function applyBootstrap(payload) {
  const prevProjectId = uiState.bootstrap?.settings?.selectedProjectId || null;
  const nextProjectId = payload?.settings?.selectedProjectId || null;
  uiState.bootstrap = payload;
  uiState.agentDrafts = {};
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

// Apply a server bootstrap payload without clearing the user's in-flight
// form drafts. Used by autosave paths (channel autosave, markdown autosave,
// runtime polling) where we MUST NOT wipe whatever the user is still typing.
// applyBootstrap's unconditional `agentDrafts = {}` reset is what caused the
// "yesterday's Discord config disappeared + cursor jumps to top" symptom:
// every autosave response cleared the live draft and rebuilt every input's
// value from the server snapshot, discarding any chars the user had typed
// mid-save. See feedback_preserve_user_config.md.
function applyBootstrapPreservingDrafts(payload, { background = false } = {}) {
  uiState.bootstrap = payload;
  syncSelectedArtifact();
  if (payload?.settings?.activeView !== 'search' || !uiState.searchQuery.trim()) {
    stopSearchFileStream();
  }
  // Forward the `background` flag so the typing guard in render() can defer
  // the DOM swap if the user is actively typing (see feedback: "还是跳光标").
  render({ background });
}

async function patchSettings(patch) {
  const payload = await api('/api/settings', {
    method: 'POST',
    body: patch,
  });
  applyBootstrap(payload);
}

async function handleCreateChat({
  mode = uiState.bootstrap.settings.activeMode,
  projectId = uiState.bootstrap.settings.selectedProjectId,
  agentId = uiState.activeChatAgentId || 'main',
} = {}) {
  const payload = await api('/api/chats', {
    method: 'POST',
    body: { mode, projectId, agentId },
  });
  uiState.composer = '';
  applyBootstrap(payload);
}

async function handleOpenNewChatHome() {
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
    render();
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
  toast.innerHTML = `
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
  toast.innerHTML = `
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
  await patchSettings({
    selectedProjectId: projectId,
    activeMode: mode,
    activeView: 'chat',
  });
  await handleCreateChat({ projectId, mode });
}

async function handleSendMessage() {
  if (uiState.sending) return;
  const content = uiState.composer.trim();
  const attachments = [...uiState.composerAttachments];
  if (!content && !attachments.length) return;

  if (content && (await handleComposerCommand())) {
    return;
  }

  // Capture and clear the voice transcript before resetting composer state.
  const voiceTranscript = uiState.composerVoiceTranscript || null;
  uiState.composerVoiceTranscript = null;

  let chatId = uiState.bootstrap?.settings?.selectedChatId || null;
  uiState.sending = true;
  uiState.thinkingSince = Date.now();
  uiState.sendAbortController = new AbortController();
  const previousBootstrap = cloneBootstrapState(uiState.bootstrap);
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
        chatId,
        content,
        attachments,
        ...(voiceTranscript
          ? {
              extractedMedia: [
                {
                  kind: 'transcript',
                  text: voiceTranscript,
                  metadata: { source: 'speech-recognition', fileName: 'voice-message.wav' },
                },
              ],
            }
          : {}),
        mode: uiState.bootstrap.settings.activeMode,
        // Demon visualization mode — lets the backend decide to inject
        // viz-spec emission instructions into the system prompt for this
        // reply. Server-side gates still drop it for remote channels.
        demonMode: Boolean(uiState.demonMode),
      },
      signal: uiState.sendAbortController.signal,
      onEvent: message => {
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
          if (payloadDelta) _streamTtsPushChunk(payloadDelta);
          // Fast path: during a pure-delta stream frame, patch ONLY the
          // streaming bubble instead of doing a full `app.innerHTML = ...`
          // rebuild. Falls back to render() the first time through (DOM
          // shell doesn't exist yet) or when the bubble node can't be
          // found. This is what kills the 闪屏 the user reported.
          if (!renderStreamingFast()) render();
        } else if (message.event === 'tool_permission') {
          // Tool permission request: show dialog
          const { requestId, toolId, args } = message.payload || {};
          if (requestId && toolId) {
            // Replace any existing request for same toolId (avoid stacking)
            uiState.pendingToolPermissions = uiState.pendingToolPermissions.filter(
              p => p.toolId !== toolId,
            );
            uiState.pendingToolPermissions.push({ requestId, toolId, args: args || {} });
            render();
          }
        } else if (message.event === 'reply_text') {
          // Final reply after tool calls — populate TTS buffer so flush() can speak it
          const replyText = message.payload?.text || '';
          if (replyText && _isTtsActive()) {
            _streamTts.buffer = replyText;
          }
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
          // Tools finished: update status
          const results = message.payload?.results || [];
          for (const r of results) {
            const existing = uiState.activeToolCalls.find(t => t.id === r.id);
            if (existing) {
              existing.status = r.ok ? 'ok' : 'error';
              existing.output = r.output;
            }
          }
          // Clear completed calls after a short delay so user sees the checkmarks
          setTimeout(() => {
            uiState.activeToolCalls = uiState.activeToolCalls.filter(t => t.status === 'running');
            render();
          }, 1800);
          render();
        }
      },
    });

    if (result?.bootstrap) {
      applyBootstrap(result.bootstrap);
    } else {
      await loadBootstrap(uiState.searchQuery, { quiet: true });
    }
  } catch (error) {
    if (isAbortError(error)) {
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
    uiState.composerAttachmentMenuOpen = false;
    showError(error.message);
  } finally {
    uiState.sending = false;
    uiState.sendAbortController = null;
    uiState.thinkingSince = 0;
    uiState.activeToolCalls = [];
    uiState.pendingToolPermissions = [];

    // Flush any remaining buffered text to TTS, then reset streaming state
    if (_isTtsActive()) {
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
    // Approximate duration from file size (128 kbps mp3 ≈ 16KB/s)
    const approxMs = Math.max(3000, (base64.length * 0.75 / 16000) * 1000);
    const timer = setTimeout(() => {
      if (uiState.ttsSpeakingMessageId === messageId) {
        uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
      }
    }, approxMs);
    _ttsAudio = { pause: () => {
      clearTimeout(timer);
      if (window.webkit?.messageHandlers?.meloVoice) {
        window.webkit.messageHandlers.meloVoice.postMessage({ action: 'stopAudio' });
      }
      uiState.ttsSpeakingMessageId = null;
    }};
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
    render();
  } catch {
    uiState.ttsMacosVoices = [];
    uiState.ttsMacosVoicesLoaded = true;  // mark loaded even on failure so we don't retry every panel open
    render();
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
  window.webkit.messageHandlers.meloVoice.postMessage({ action: 'speakText', text });
  if (messageId) { uiState.ttsSpeakingMessageId = messageId; _updateTtsSpeakingUI(messageId); }
  const approxMs = Math.max(2000, text.length * 300);
  const timer = setTimeout(() => {
    if (uiState.ttsSpeakingMessageId === messageId) {
      uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
    }
  }, approxMs);
  _ttsAudio = { pause: () => {
    clearTimeout(timer);
    if (window.webkit?.messageHandlers?.meloVoice) {
      window.webkit.messageHandlers.meloVoice.postMessage({ action: 'stopAudio' });
    }
    uiState.ttsSpeakingMessageId = null; _updateTtsSpeakingUI(null);
  }};
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
  // Tool call started — discard text buffered so far (intermediate "searching..." etc.)
  _streamTts.hasToolCalls = true;
  _streamTts.buffer = '';
  _streamTts.browserBatch = '';  // also drop accumulated WKWebView Browser-voice batch
  // Stop any in-progress playback so intermediate phrases don't play.
  // Covers server TTS, in-page speechSynthesis, AND WKWebView native bridge
  // (Browser engine in desktop app could otherwise keep narrating
  // "let me search…" after the tool fires).
  api('/api/tts/speak-stop', { method: 'POST', body: {} }).catch(() => {});
  api('/api/tts/queue-clear', { method: 'POST', body: {} }).catch(() => {});
  if (globalThis.speechSynthesis?.speaking || globalThis.speechSynthesis?.pending) {
    try { speechSynthesis.cancel(); } catch {}
  }
  if (window.webkit?.messageHandlers?.meloVoice) {
    try { window.webkit.messageHandlers.meloVoice.postMessage({ action: 'stopAudio' }); } catch {}
  }
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
        const lang = _detectLang(sentence);
        api('/api/tts/native', {
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
      const lang = _detectLang(tail);
      api('/api/tts/native', {
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
      projectId: activeProject()?.id || uiState.bootstrap.settings.selectedProjectId,
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
  const artifact = uiState.bootstrap.artifacts.find(item => item.id === artifactId);
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
  const artifact = uiState.bootstrap?.artifacts?.find(item => item.id === artifactId);
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
        render();
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
  const authMode = pick('authMode') || 'codex';
  const apiKey = pick('apiKey');
  const body = {
    authMode,
    baseUrl: pick('baseUrl'),
    model: pick('model'),
    systemPrompt: pick('systemPrompt'),
    whisperApiKey: pick('whisperApiKey'),
    whisperBaseUrl: pick('whisperBaseUrl'),
    // MiniMax T2A V2. Server-side `keepIfBlank` semantics for the secret
    // keys (apiKey/groupId) treats empty as "preserve current"; the voice
    // id is non-secret and writable as text. minimaxApiKey is masked in
    // the form so blank means "no change", not "wipe key".
    minimaxApiKey: pick('minimaxApiKey'),
    minimaxGroupId: pick('minimaxGroupId'),
    minimaxVoiceId: pick('minimaxVoiceId'),
  };

  if ((authMode === 'api-key' || authMode === 'local') && apiKey) {
    body.apiKey = apiKey;
  }

  const payload = await api('/api/settings/model', {
    method: 'POST',
    body,
  });
  uiState.modelSetupDraft = null;
  applyBootstrap(payload);
}

async function handleLoadModelOptions(form) {
  const formData = new FormData(form);
  const authMode = String(formData.get('authMode') || 'codex').trim();
  const apiKey = String(formData.get('apiKey') || '').trim();
  const body = {
    authMode,
    baseUrl: String(formData.get('baseUrl') || '').trim(),
    model: String(formData.get('model') || '').trim(),
    systemPrompt: String(formData.get('systemPrompt') || '').trim(),
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
    uiState.modelSetupDraft = null;
    applyBootstrap(payload);
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
  const payload = await api('/api/agents/create-custom', {
    method: 'POST',
    body: {},
  });
  applyBootstrap(payload);
}

async function handleUpdateAgentProfile(form) {
  const formData = new FormData(form);
  const project = activeProject();
  const scope = selectedAgentScope();
  const projectId = scope === 'project' ? project?.id || 'global' : 'global';
  const saveKey = agentSaveKey(form.dataset.agentId, scope, projectId);
  const tools = String(formData.get('tools') || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const rawSkillIds = formData.get('enabledSkillIds');
  const enabledSkillIds = rawSkillIds === '__all__'
    ? null
    : String(rawSkillIds || '').split(',').map(v => v.trim()).filter(Boolean);
  const rawConnectorIds = formData.get('enabledConnectorIds');
  const enabledConnectorIds = rawConnectorIds === '__all__'
    ? null
    : String(rawConnectorIds || '').split(',').map(v => v.trim()).filter(Boolean);
  // Stdio MCP whitelist — unlike skills/connectors above, MCP defaults
  // to deny-all (`null` is coerced to `[]` by the backend normalizer),
  // so we never offer the "all servers" sentinel here.  An empty string
  // means "no MCP servers for this agent".
  const rawMcpServerIds = formData.get('enabledMcpServerIds');
  const enabledMcpServerIds = String(rawMcpServerIds || '')
    .split(',').map(v => v.trim()).filter(Boolean);
  const minimumVisibleMs = 100;
  const waitForMinimumVisibleState = new Promise(resolve => setTimeout(resolve, minimumVisibleMs));

  uiState.agentSaveStates[saveKey] = true;
  render();

  try {
    const payload = await api('/api/agents/update', {
      method: 'POST',
      body: {
        agentId: form.dataset.agentId,
        scope,
        projectId: scope === 'project' ? project?.id : null,
        activeView: uiState.bootstrap?.settings?.activeView || 'customize',
        patch: {
          name: String(formData.get('name') || '').trim(),
          laneLabel: String(formData.get('laneLabel') || '').trim(),
          description: String(formData.get('description') || '').trim(),
          identity: String(formData.get('identity') || '').trim(),
          'soul.md': String(formData.get('soul.md') || '').trim(),
          mood: String(formData.get('mood') || '').trim(),
          tools,
          enabledSkillIds,
          enabledConnectorIds,
          enabledMcpServerIds,
          model: String(formData.get('model') || '').trim(),
          systemPrompt: String(formData.get('systemPrompt') || '').trim(),
          voiceReplyMode: String(formData.get('voiceReplyMode') || 'summary').trim(),
          voicePersonality: String(formData.get('voicePersonality') || '').trim(),
          edgeTtsVoice: String(formData.get('edgeTtsVoice') || '').trim(),
          // MiniMax voice ID — surfaced explicitly in the agent editor so
          // the "自定义语音" entries in the TTS panel are no longer hidden
          // metadata. Empty string means "no MiniMax voice for this agent"
          // (the agent won't appear in the panel's voice list).
          minimaxVoiceId: String(formData.get('minimaxVoiceId') || '').trim(),
          channels: {
            telegram: {
              enabled: formData.get('telegramEnabled') === 'on',
              botToken: String(formData.get('telegramBotToken') || '').trim(),
              chatId: String(formData.get('telegramChatId') || '').trim(),
              voiceReply: formData.get('telegramVoiceReply') === 'on',
            },
            discord: {
              enabled: formData.get('discordEnabled') === 'on',
              botToken: String(formData.get('discordBotToken') || '').trim(),
              guildId: String(formData.get('discordGuildId') || '').trim(),
              channelId: String(formData.get('discordChannelId') || '').trim(),
              voiceReply: formData.get('discordVoiceReply') === 'on',
            },
          },
        },
      },
    });
    await waitForMinimumVisibleState;
    applyBootstrap(payload);
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

  // Flush any pending channel autosave before testing so a token the user just
  // typed isn't wiped out by applyBootstrap() when the test response lands.
  // Without this flush, clicking "Test Telegram" within 350ms of typing the
  // token caused the bootstrap refresh to overwrite the in-flight draft.
  if (pendingAgentChannelAutosave) {
    window.clearTimeout(agentChannelAutosaveTimer);
    const snapshot = pendingAgentChannelAutosave;
    pendingAgentChannelAutosave = null;
    try {
      await saveAgentChannelSnapshot(snapshot);
    } catch (error) {
      showError(error.message);
      return;
    }
  }

  const formData = new FormData(form);
  const channelId = trigger.dataset.channelId;
  const project = activeProject();
  const scope = selectedAgentScope();
  // Include voiceReply on the test patch so testing the Telegram connection
  // does not overwrite the persisted voiceReply setting with its default.
  // The server merges {...currentChannel, ...patch}, so carrying voiceReply
  // from the live DOM keeps the user's latest toggle state intact through
  // the post-test state refresh.
  const patch =
    channelId === 'telegram'
      ? {
          enabled: formData.get('telegramEnabled') === 'on',
          botToken: String(formData.get('telegramBotToken') || '').trim(),
          chatId: String(formData.get('telegramChatId') || '').trim(),
          voiceReply: formData.get('telegramVoiceReply') === 'on',
        }
      : {
          enabled: formData.get('discordEnabled') === 'on',
          botToken: String(formData.get('discordBotToken') || '').trim(),
          guildId: String(formData.get('discordGuildId') || '').trim(),
          channelId: String(formData.get('discordChannelId') || '').trim(),
          // Carry the Discord voiceReply tick so testing the connection doesn't
          // wipe the user's newly-toggled checkbox. Same merge semantics as
          // Telegram's telegramVoiceReply above.
          voiceReply: formData.get('discordVoiceReply') === 'on',
        };

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

window.addEventListener('pagehide', flushPendingAgentAutosavesOnUnload);
window.addEventListener('beforeunload', flushPendingAgentAutosavesOnUnload);

async function handleImportAgentPreset(agentId, presetId) {
  const preset = agentPresetById(presetId);
  if (!preset) {
    showError('Preset not found.');
    return;
  }

  const scope = selectedAgentScope();
  const project = activeProject();
  const currentAgent = selectedAgentProfile();
  const currentToolIds = Array.isArray(currentAgent?.toolIds)
    ? currentAgent.toolIds
    : Array.isArray(currentAgent?.tools)
      ? currentAgent.tools.map(tool => tool.id)
      : [];
  const payload = await api('/api/agents/update', {
    method: 'POST',
    body: {
      agentId,
      scope,
      projectId: scope === 'project' ? project?.id : null,
      activeView: uiState.bootstrap?.settings?.activeView || 'customize',
      patch: {
        identity: preset.identity || preset.identify,
        'soul.md': preset.soulMd,
        mood: preset.mood,
        tools: [...currentToolIds],
        model: currentAgent?.model || '',
        systemPrompt: currentAgent?.systemPrompt || '',
      },
    },
  });
  applyBootstrap(payload);
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
      projectId: activeProject()?.id || uiState.bootstrap.settings.selectedProjectId,
      chatId: activeChat()?.id || uiState.bootstrap.settings.selectedChatId,
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

async function handleRunTask(taskId) {
  const payload = await api('/api/tasks/run', {
    method: 'POST',
    body: { taskId },
  });
  applyBootstrap(payload);
}

async function handleRunTaskLane(owner) {
  const payload = await api('/api/tasks/run-lane', {
    method: 'POST',
    body: { owner },
  });
  applyBootstrap(payload);
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
  render();
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
      subtitle: 'Search chats, projects, artifacts, and files',
      keywords: 'search view',
      action: 'open-view',
      payload: { view: 'search' },
    },
    {
      id: 'palette-open-runtime',
      title: 'Open Runtime Browser',
      subtitle: 'Inspect live MCP-style tools, resources, and prompts',
      keywords: 'runtime mcp browser tools resources prompts',
      action: 'open-runtime',
    },
    {
      id: 'palette-open-agents',
      title: 'Open Agent',
      subtitle: 'Tune IDENTITY.md, SOUL.md, and mood for each agent lane',
      keywords: 'agent agents identity soul mood persona',
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
        projectId: activeProject()?.id || uiState.bootstrap.settings.selectedProjectId,
        chatId: activeChat()?.id || uiState.bootstrap.settings.selectedChatId,
        payload: {
          templateId,
          query: queryParts.join(' ').trim(),
          projectId: activeProject()?.id || uiState.bootstrap.settings.selectedProjectId,
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
          projectId: activeProject()?.id || uiState.bootstrap.settings.selectedProjectId,
          chatId: activeChat()?.id || uiState.bootstrap.settings.selectedChatId,
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
          projectId: activeProject()?.id || uiState.bootstrap.settings.selectedProjectId,
          chatId: activeChat()?.id || uiState.bootstrap.settings.selectedChatId,
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
  render();
  return true;
}

async function handleRunCommand(form) {
  const formData = new FormData(form);
  await createApprovalRequest({
    kind: 'command',
    title: `Run ${form.dataset.templateId}`,
    description: 'Run a curated local command inside the active project.',
    projectId: activeProject()?.id || uiState.bootstrap.settings.selectedProjectId,
    chatId: activeChat()?.id || uiState.bootstrap.settings.selectedChatId,
    payload: {
      templateId: form.dataset.templateId,
      query: String(formData.get('query') || '').trim(),
      projectId: activeProject()?.id || uiState.bootstrap.settings.selectedProjectId,
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
    projectId: activeProject()?.id || uiState.bootstrap.settings.selectedProjectId,
    chatId: activeChat()?.id || uiState.bootstrap.settings.selectedChatId,
    payload: {
      filePath,
      content: uiState.fileDraftContent,
      projectId: activeProject()?.id || uiState.bootstrap.settings.selectedProjectId,
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
    projectId: activeProject()?.id || uiState.bootstrap.settings.selectedProjectId,
    chatId: activeChat()?.id || uiState.bootstrap.settings.selectedChatId,
    payload: {
      artifactId,
      filePath: selectedFilePath,
      projectId: activeProject()?.id || uiState.bootstrap.settings.selectedProjectId,
    },
  });
}

function navItem(action, iconMarkup, label, view, subtitle = '') {
  const isActive = uiState.bootstrap?.settings.activeView === view;
  return `
    <button class="nav-item ${isActive ? 'is-active' : ''}" data-action="${action}" data-view="${view}">
      <span class="nav-icon">${iconMarkup}</span>
      <span class="nav-copy">
        <span class="nav-title">${label}</span>
        ${subtitle ? `<span class="nav-subtitle">${subtitle}</span>` : ''}
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

  return `
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
                    recent => `
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
                            ${recent.locked ? `<span class="recent-lock-badge" aria-label="Locked">${icon.lock}</span>` : ''}
                            <span>${escapeHtml(recent.title)}</span>
                          </div>
                          ${
                            data.settings.selectedChatId === recent.id &&
                            data.settings.activeView === 'chat'
                              ? `<span class="recent-item-more">${icon.dots}</span>`
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
          ${
            mainAgent
              ? ` Main agent mood: ${escapeHtml(mainAgent.moodLabel)}.`
              : ''
          }
        </div>
      </div>
    </aside>
  `;
}

function renderTopbar() {
  const data = uiState.bootstrap;
  const project = activeProject();
  const currentAgent = selectedAgentProfile() || mainAgentProfile();

  return `
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
              mode => `
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
            ? `<div class="status-pill">${escapeHtml(currentAgent.name)}${currentAgent.moodLabel ? ' · ' + escapeHtml(currentAgent.moodLabel) : ''}</div>`
            : ''
        }
        <div class="status-pill">
          <span class="status-dot"></span>
          ${escapeHtml(data.settings.config.model)}
        </div>
      </div>
    </header>
  `;
}

function composerPlaceholder() {
  if (!activeChat()) {
    return 'Ask Melo anything, or type / for Melo commands...';
  }

  switch (uiState.bootstrap?.settings.activeMode) {
    case 'cowork':
      return 'What are we solving together?';
    case 'code':
      return 'Ask about files, builds, code changes, or your workspace...';
    case 'chat':
    default:
      return 'How can I help you today?';
  }
}

// Phase 3.3.3 — slash-command palette popover. Rendered inside the
// composer input frame above the textarea. Returns empty string when the
// palette isn't open OR there's nothing to show; this is the normal state.
function renderSlashPalette() {
  if (!uiState.slashPalette.open) return '';
  const matches = slashPaletteMatches();
  if (!matches.length) {
    return `
      <div class="slash-palette" role="listbox">
        <div class="slash-palette-empty">No skills match /${escapeHtml(uiState.slashPalette.query)}</div>
      </div>
    `;
  }
  const selectedIndex = Math.min(
    Math.max(0, uiState.slashPalette.selectedIndex | 0),
    matches.length - 1,
  );
  return `
    <div class="slash-palette" role="listbox">
      ${matches
        .map((skill, i) => `
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
              ? `<span class="slash-palette-desc">${escapeHtml(skill.description)}</span>`
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
  const catalogs = config.modelCatalogs || {};
  const mode = authMode || config.authMode || 'codex';
  const selectedModel =
    (uiState.modelSetupDraft?.authMode || config.authMode || 'codex') === mode
      ? uiState.modelSetupDraft?.model || config.model
      : config.model;

  return Array.from(
    new Set(
      [selectedModel, ...(catalogs[mode] || []), ...(mode === config.authMode ? config.availableModels || [] : [])]
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

  return `
    <div class="command-deck ${inline ? 'is-inline' : ''}">
      ${
        inline
          ? ''
          : `
            <div class="chip-row command-chip-row">
              ${HOME_PROMPT_PRESETS.map(
                preset => `
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
          ? `
            <div class="command-suggestions">
              ${suggestions
                .map(
                  item => `
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

function renderTaskPanel({ compact = false } = {}) {
  const tasks = activeTasks();

  return `
    <section class="surface-card ${compact ? 'compact-surface-card' : ''}">
      <div class="header-row">
        <div>
          <h2 class="pane-title">Tasks & agents</h2>
        </div>
        <button class="small-button" data-action="toggle-task-form">
          ${uiState.showTaskForm ? 'Hide form' : 'New task'}
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
        return `
          <div class="chip-row task-lane-row task-lane-overflow-anchor">
            <button class="chip chip-button" data-action="run-task-lane" data-owner="${primary}">
              Run ${primary}${primaryProfile ? ` · ${escapeHtml(primaryProfile.moodLabel)}` : ''}
            </button>
            <button class="chip chip-button task-lane-overflow-toggle"
                    type="button"
                    aria-haspopup="true"
                    aria-expanded="${overflowOpen ? 'true' : 'false'}"
                    data-action="toggle-task-lane-overflow"
                    title="Run other agents">
              ⋯
            </button>
            ${overflowOpen ? `
              <div class="task-lane-overflow-menu">
                ${overflow.map(owner => {
                  const ownerProfile = agentProfileById(owner);
                  return `
                    <button class="task-lane-overflow-item" type="button" data-action="run-task-lane" data-owner="${owner}">
                      Run ${owner}${ownerProfile ? ` · ${escapeHtml(ownerProfile.moodLabel)}` : ''}
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
          ? `
            <form class="config-form" data-form="task-create">
              <label class="label">
                Title
                <input class="input" name="title" value="${escapeHtml(uiState.draftTask.title)}" />
              </label>
              <label class="label">
                Summary
                <textarea class="config-textarea" name="summary">${escapeHtml(uiState.draftTask.summary)}</textarea>
              </label>
              <div class="project-form-grid">
                <label class="label">
                  Owner
                  <select class="config-select" name="owner">
                    ${['main', 'research', 'builder', 'reviewer']
                      .map(
                        owner => `
                          <option value="${owner}" ${uiState.draftTask.owner === owner ? 'selected' : ''}>
                            ${owner}
                          </option>
                        `,
                      )
                      .join('')}
                  </select>
                </label>
                <label class="label">
                  Kind
                  <select class="config-select" name="kind">
                    ${['task', 'agent']
                      .map(
                        kind => `
                          <option value="${kind}" ${uiState.draftTask.kind === kind ? 'selected' : ''}>
                            ${kind}
                          </option>
                        `,
                      )
                      .join('')}
                  </select>
                </label>
              </div>
              <button class="small-button is-primary" type="submit">Create work item</button>
            </form>
          `
          : ''
      }
      <div class="mini-list">
        ${
          tasks.length
            ? tasks
                .slice(0, compact ? 4 : 8)
                .map(
                  task => {
                    const ownerProfile = agentProfileById(task.owner);
                    return `
                    <article class="run-card">
                      <div class="thread-meta">
                        <span class="chip is-accent">${escapeHtml(task.kind.toUpperCase())}</span>
                        <span class="chip">${escapeHtml(task.ownerLabel)}</span>
                        ${
                          ownerProfile
                            ? `<span class="chip">${escapeHtml(ownerProfile.moodLabel)}</span>`
                            : ''
                        }
                        <span class="chip">${escapeHtml(task.statusLabel)}</span>
                        <span class="meta-label">${escapeHtml(task.updatedLabel)}</span>
                      </div>
                      <div class="list-row-title">${escapeHtml(task.title)}</div>
                      ${
                        task.summary
                          ? `<div class="list-row-meta">${escapeHtml(task.summary)}</div>`
                          : ''
                      }
                      ${
                        task.latestNotePreview
                          ? `<div class="workspace-root">${escapeHtml(task.latestNotePreview)}</div>`
                          : ''
                      }
                      <div class="thread-meta">
                        <span class="meta-label">${escapeHtml(task.lastRunLabel)}</span>
                        <span class="meta-label">${task.runCount} runs</span>
                      </div>
                      <div class="inline-actions">
                        ${
                          task.kind === 'agent'
                            ? `<button class="small-button is-primary" data-action="run-task" data-task-id="${task.id}">Run worker</button>`
                            : ''
                        }
                        ${['todo', 'running', 'blocked', 'done']
                          .map(
                            status => `
                              <button class="small-button ${task.status === status ? 'is-primary' : ''}" data-action="set-task-status" data-task-id="${task.id}" data-status="${status}">
                                ${status}
                              </button>
                            `,
                          )
                          .join('')}
                      </div>
                    </article>
                  `;
                  },
                )
                .join('')
            : '<div class="empty-state compact">No task items yet. Create one from the command workbench or this panel.</div>'
        }
      </div>
    </section>
  `;
}

function renderApprovalPanel({ compact = false } = {}) {
  const approvals = approvalQueue();

  return `
    <section class="surface-card ${compact ? 'compact-surface-card' : ''}">
      <div class="header-row">
        <div>
          <h2 class="pane-title">Approvals</h2>
          <p class="page-kicker">Commands, file writes, and external tools queue here before execution.</p>
        </div>
        <span class="chip is-accent">${approvals.filter(item => item.status === 'pending').length} pending</span>
      </div>
      <div class="mini-list">
        ${
          approvals.length
            ? approvals
                .slice(0, compact ? 4 : 8)
                .map(
                  approval => `
                    <article class="run-card">
                      <div class="thread-meta">
                        <span class="chip is-accent">${escapeHtml(approval.kind)}</span>
                        <span class="chip">${escapeHtml(approval.status)}</span>
                        <span class="meta-label">${escapeHtml(approval.updatedLabel)}</span>
                      </div>
                      <div class="list-row-title">${escapeHtml(approval.title)}</div>
                      ${
                        approval.description
                          ? `<div class="list-row-meta">${escapeHtml(approval.description)}</div>`
                          : ''
                      }
                      ${
                        approval.resultSummary
                          ? `<div class="workspace-root">${escapeHtml(approval.resultSummary)}</div>`
                          : ''
                      }
                      ${
                        approval.status === 'pending'
                          ? `
                            <div class="inline-actions">
                              <button class="small-button is-primary" data-action="execute-approval" data-approval-id="${approval.id}">
                                Approve & run
                              </button>
                              <button class="small-button" data-action="reject-approval" data-approval-id="${approval.id}">
                                Reject
                              </button>
                            </div>
                          `
                          : ''
                      }
                    </article>
                  `,
                )
                .join('')
            : '<div class="empty-state compact">No approval requests yet.</div>'
        }
      </div>
    </section>
  `;
}

function renderComposerCard({ inline = false } = {}) {
  const data = uiState.bootstrap;
  const project = activeProject();
  const workspace = data.workspace || {};
  const selectedFile = workspace.selectedFile;
  const voiceSupported = voiceBridgeSupported() || uiState.voice.supported;
  const isHomeComposer = !inline;
  const voicePreviewMarkup = '';
  const footerMarkup =
    isHomeComposer || selectedFile
      ? `
        <div class="composer-footer">
          <div class="composer-footer-copy">
            ${project ? `Project: ${escapeHtml(project.name)}` : 'Local-first Melo chat is ready.'}
          </div>
          ${
            selectedFile
              ? `<div class="composer-footer-copy is-secondary">Selected file: ${escapeHtml(selectedFile.path)}</div>`
              : ''
          }
        </div>
      `
      : '';

  return `
    <div class="composer-shell">
      ${
        !data.settings.config.hasCredentials
          ? `
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

      ${uiState.sending ? `<div class="thinking-banner">${escapeHtml(thinkingLabel())}</div>` : ''}

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
                  title="Add attachment"
                >
                  <span class="toolbar-icon">${icon.plus}</span>
                </button>
                ${renderComposerAttachmentMenu()}
                <span class="composer-status-copy">${escapeHtml(composerHintText({ inline }))}</span>
              </div>

              <div class="composer-bottom-right">
                <button
                  class="composer-demon-toggle ${uiState.demonMode ? 'is-active' : ''}"
                  type="button"
                  data-action="toggle-demon-mode"
                  title="Demon mode"
                  aria-pressed="${uiState.demonMode ? 'true' : 'false'}"
                >
                  <span class="composer-demon-tick" aria-hidden="true">${uiState.demonMode ? '✓' : ''}</span>
                  <span class="composer-demon-label">Demon</span>
                </button>
                <div class="composer-model-select-wrap">
                  <select class="model-select composer-model-select" data-action="save-model-select" aria-label="Model">
                    ${modelOptionsForAuthMode(data.settings.config.authMode)
                      .map(
                        model => `
                          <option value="${model}" ${
                            data.settings.config.model === model ? 'selected' : ''
                          }>
                            ${model}
                          </option>
                        `,
                      )
                      .join('')}
                  </select>
                </div>

                <div class="tts-voice-panel-anchor">
                  ${renderTtsVoicePanel()}
                  <button
                    class="composer-icon-button ${uiState.ttsAutoPlay ? 'is-recording' : ''}"
                    type="button"
                    data-action="toggle-tts-autoplay"
                    title="Voice settings"
                    aria-label="Voice settings"
                  >
                    <span class="toolbar-icon">${icon.speak}</span>
                  </button>
                </div>

                <button
                  class="composer-icon-button ${uiState.voice.recording ? 'is-recording' : ''}"
                  type="button"
                  data-action="toggle-voice-input"
                  ${voiceSupported && !uiState.sending ? '' : 'disabled'}
                  title="${voiceSupported ? escapeHtml(voiceStatusLabel()) : 'Voice input requires the desktop app'}"
                >
                  <span class="toolbar-icon">${uiState.voice.recording ? icon.stop : icon.mic}</span>
                </button>

                ${
                  uiState.sending
                    ? `
                      <button class="composer-icon-button is-stop" type="button" data-action="stop-send" title="Stop generating">
                        <span class="toolbar-icon">${icon.stop}</span>
                      </button>
                    `
                    : `
                      <button class="composer-icon-button is-primary" type="submit" title="Send message">
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
                placeholder="${escapeHtml(inline ? 'Reply…' : composerPlaceholder())}"
                aria-label="Message composer"
              >${escapeHtml(uiState.composer)}</textarea>
            </div>

            ${renderAttachmentPreviewList(uiState.composerAttachments)}
            ${
              uiState.composerDragActive
                ? `
                  <div class="composer-drop-banner">
                    Drop image, audio, or video here. Videos are sent as audio transcript plus a few keyframes.
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
  return `
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

function renderMessageList(chat) {
  return `
    <div class="message-list">
      ${chat.messages
        .map(
          message => `
            <article class="message ${message.role} ${
              uiState.highlightedMessageId === message.id ? 'is-highlighted' : ''
            }" data-message-id="${escapeHtml(message.id)}">
              <div class="message-role">
                ${message.role === 'assistant' ? 'Melo' : uiState.bootstrap.profile.name}
              </div>
              ${renderMessageBlocks(message)}
              ${renderAssistantVizMount(message)}
              ${renderMessageAttachments(message)}
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

  return `
    <section class="surface-card thread-artifact-strip">
      <div class="header-row">
        <div>
          <h2 class="pane-title">Artifacts from this thread</h2>
        </div>
        <button class="small-button" data-action="open-view" data-view="artifacts">
          Open shelf
        </button>
      </div>

      <div class="card-grid compact-grid">
        ${artifacts
          .slice(0, 3)
          .map(
            artifact => `
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
  return `
    <button class="chip chip-btn ${uiState.agentSelectorOpen ? 'is-active' : ''}"
            data-action="toggle-agent-selector"
            title="Select which agent to chat with">
      ${escapeHtml(agent.name)}${agent.moodLabel ? ` · ${escapeHtml(agent.moodLabel)}` : ''}
      <span style="margin-left:4px;opacity:.6;font-size:.75em">▾</span>
    </button>
  `;
}

function renderAgentSelectorDropdown() {
  if (!uiState.agentSelectorOpen) return '';
  const agents = allChatAgentProfiles();
  if (!agents.length) return '';
  return `
    <div class="agent-selector-dropdown agent-selector-slide-up">
      ${agents.map(agent => `
        <button class="agent-selector-row ${uiState.activeChatAgentId === agent.id ? 'is-selected' : ''}"
                data-action="select-chat-agent"
                data-agent-id="${escapeHtml(agent.id)}">
          <span class="agent-selector-name">${escapeHtml(agent.name)}</span>
          ${agent.moodLabel ? `<span class="agent-selector-mood">${escapeHtml(agent.moodLabel)}</span>` : ''}
          ${agent.isCustom ? `<span class="agent-selector-tag">Custom</span>` : ''}
        </button>
      `).join('')}
    </div>
  `;
}

function renderRegularChatPage() {
  const chat = activeChat();
  const project = activeProject();
  const mainAgent = mainAgentProfile();

  if (!chat) {
    return `
      <section class="page is-chat">
        <div class="chat-home">
          <div class="greeting">
            <span class="spark">${icon.spark}</span>
            <h1 class="page-title">
              ${getGreeting()}, ${escapeHtml(uiState.bootstrap.profile.name)}
            </h1>
          </div>

          <div class="agent-chip-anchor">
            ${renderAgentSelectorDropdown()}
            ${renderAgentSelectorChip()}
          </div>

          ${renderComposerCard()}
        </div>
      </section>
    `;
  }

  return `
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
                mainAgent
                  ? `<span class="chip">${escapeHtml(mainAgent.name)} · ${escapeHtml(
                      mainAgent.moodLabel,
                    )}</span>`
                  : ''
              }
              ${
                project ? `<span class="chip">${escapeHtml(project.name)}</span>` : ''
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
              ? `
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
    return `
      <div class="empty-state compact">
        Workspace path is unavailable. Update the project workspace path to start browsing files.
      </div>
    `;
  }

  return `
    <div class="workspace-root mono">${escapeHtml(workspace.rootPath)}</div>
    <div class="file-tree">
      ${workspace.entries
        .map(entry => {
          const indent = 14 + entry.depth * 18;
          if (entry.type === 'directory') {
            return `
              <div class="tree-row is-directory" style="padding-left:${indent}px">
                <span class="tree-icon">${icon.folder}</span>
                <span>${escapeHtml(entry.name)}</span>
              </div>
            `;
          }

          return `
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
        `<span class="code-line" data-line-number="${index + 1}">${escapeHtml(
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

  return `
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
            ? `
              <button class="small-button is-primary" type="submit" form="file-save-form">
                Queue save
              </button>
              <button class="small-button" data-action="cancel-edit-file">
                Discard
              </button>
            `
            : `
              <button class="small-button is-primary" data-action="start-edit-file">
                Edit file
              </button>
            `
        }
      </div>
      ${
        isEditing
          ? `
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
          : `<pre class="code-preview" data-copyable-surface><code>${renderCodePreviewLines(
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

  return `
    <div class="command-stack">
      ${workspace.commandTemplates
        .map(
          template => `
            <form class="command-card" data-form="command-run" data-template-id="${template.id}">
              <div class="list-row-title">${escapeHtml(template.label)}</div>
              <div class="list-row-meta">${escapeHtml(template.description)}</div>
              ${
                template.requiresInput
                  ? `
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
              run => `
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

  return `
    <div class="mini-list">
      ${artifacts
        .slice(0, 4)
        .map(
          artifact => `
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

  return `
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
                    project ? `<span class="chip">${escapeHtml(project.name)}</span>` : ''
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
                : `
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
                ? `
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
  return `
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
                    chat => `
                      <button class="chat-row" data-action="open-chat" data-chat-id="${chat.id}">
                        <div class="chat-row__body">
                          <h2 class="chat-row__title">${escapeHtml(chat.title)}</h2>
                          <p class="chat-row__preview">${escapeHtml(chat.preview)}</p>
                        </div>
                        <div class="chat-row__meta">
                          ${
                            chat.projectId
                              ? `<span class="chip is-muted">${escapeHtml(
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
    return `
      <section class="page">
        <div class="page-grid">
          <div class="header-row">
            <div>
              <h1 class="page-title compact">Projects</h1>
              <p class="page-kicker">Group chats, artifacts, and instructions together.</p>
            </div>
          </div>

          <div class="surface-card project-empty-hero">
            <div class="project-empty-hero__icon">${icon.folder}</div>
            <h2 class="project-empty-hero__title">No projects yet</h2>
            <p class="project-empty-hero__body">
              Projects keep a workspace path, instructions, and related chats together so Melo
              has context every time you continue a thread.
            </p>
            <button class="ghost-button is-primary" data-action="toggle-project-form">
              <span class="toolbar-icon">${icon.plus}</span>
              Create your first project
            </button>
          </div>
        </div>
      </section>
    `;
  }

  return `
    <section class="page">
      <div class="page-grid">
        <div class="header-row project-overview-header">
          <div>
            <h1 class="page-title compact">Projects</h1>
            <p class="page-kicker">${totalProjects} ${totalProjects === 1 ? 'project' : 'projects'}</p>
          </div>

          <div class="inline-actions">
            <button class="ghost-button is-primary" data-action="toggle-project-form">
              <span class="toolbar-icon">${icon.plus}</span>
              New project
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
              placeholder="Search projects..."
            />
          </div>
        </div>

        ${
          projects.length
            ? `
              <div class="project-grid">
                ${projects.map(renderProjectCard).join('')}
              </div>
            `
            : `
              <div class="surface-card empty-state compact">
                ${
                  searchActive
                    ? `No projects match "${escapeHtml(uiState.projectSearch)}".`
                    : 'No projects yet — create your first one to get started.'
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
  // card opens the detail view. Action buttons (Open chat / Code session)
  // stop propagation so they don't also trigger the card click.
  return `
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
          ${item.chatCount} ${item.chatCount === 1 ? 'chat' : 'chats'}
        </span>
        <span class="project-card__metric">
          <span class="toolbar-icon">${icon.box}</span>
          ${item.artifactCount} ${item.artifactCount === 1 ? 'artifact' : 'artifacts'}
        </span>
      </div>
    </button>
  `;
}

function renderProjectCreateForm() {
  return `
    <form class="project-form-card surface-card" data-form="project-create">
      <div class="project-form-grid">
        <label class="label">
          Project name
          <input class="input" name="name" value="${escapeHtml(
            uiState.draftProject.name,
          )}" placeholder="e.g. Client site rebuild" />
        </label>
        <label class="label">
          Tag
          <input class="input" name="tag" value="${escapeHtml(
            uiState.draftProject.tag,
          )}" placeholder="e.g. Design" />
        </label>
      </div>

      <label class="label">
        Workspace path
        <input class="input" name="workspacePath" value="${escapeHtml(
          uiState.draftProject.workspacePath,
        )}" placeholder="Optional — absolute path to a folder on your computer" />
      </label>

      <label class="label">
        Summary
        <input class="input" name="summary" value="${escapeHtml(
          uiState.draftProject.summary,
        )}" placeholder="What is this project about?" />
      </label>
      <label class="label">
        Instructions
        <textarea class="textarea" name="instructions" placeholder="Project-specific instructions for Melo">${escapeHtml(
          uiState.draftProject.instructions,
        )}</textarea>
      </label>
      <div class="inline-actions">
        <button class="small-button is-primary" type="submit">Create project</button>
        <button class="small-button is-outline" type="button" data-action="toggle-project-form">
          Cancel
        </button>
      </div>
    </form>
  `;
}

function renderProjectsDetailView(project) {
  const relatedChats = activeProjectChats();
  const relatedArtifacts = activeProjectArtifacts();

  return `
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
              All projects
            </button>
            <h1 class="page-title compact">${escapeHtml(project.name)}</h1>
            ${
              project.summary
                ? `<p class="page-kicker">${escapeHtml(project.summary)}</p>`
                : ''
            }
          </div>

          <div class="inline-actions">
            <button
              class="small-button"
              data-action="chat-from-project"
              data-project-id="${project.id}"
            >
              Open chat
            </button>
            <button
              class="small-button is-primary"
              data-action="code-from-project"
              data-project-id="${project.id}"
            >
              Code session
            </button>
          </div>
        </div>

        <div class="chip-row">
          <span class="chip is-accent">${escapeHtml(project.tag)}</span>
          <span class="chip">${project.chatCount} ${project.chatCount === 1 ? 'chat' : 'chats'}</span>
          <span class="chip">${project.artifactCount} ${project.artifactCount === 1 ? 'artifact' : 'artifacts'}</span>
          ${
            project.workspacePath
              ? `<span class="chip mono" title="${escapeHtml(project.workspacePath)}">${escapeHtml(project.workspacePath)}</span>`
              : '<span class="chip mono is-muted">No workspace set</span>'
          }
        </div>

        <div class="project-detail-grid">
          <section class="surface-card project-detail-panel">
            <h2 class="subsection-title">Project settings</h2>
            <form
              class="project-form-card"
              data-form="project-update"
              data-project-id="${project.id}"
            >
              <div class="project-form-grid">
                <label class="label">
                  Project name
                  <input class="input" name="name" value="${escapeHtml(project.name)}" />
                </label>
                <label class="label">
                  Tag
                  <input class="input" name="tag" value="${escapeHtml(project.tag)}" />
                </label>
              </div>
              <label class="label">
                Workspace path
                <input
                  class="input"
                  name="workspacePath"
                  value="${escapeHtml(project.workspacePath)}"
                  placeholder="Optional — absolute path to a folder on your computer"
                />
              </label>
              <label class="label">
                Summary
                <input
                  class="input"
                  name="summary"
                  value="${escapeHtml(project.summary)}"
                />
              </label>
              <label class="label">
                Instructions
                <textarea class="textarea" name="instructions">${escapeHtml(
                  project.instructions,
                )}</textarea>
              </label>
              <div class="inline-actions">
                <button class="small-button is-primary" type="submit">
                  <span class="toolbar-icon">${icon.save}</span>
                  Save project
                </button>
              </div>
            </form>
          </section>

          <aside class="project-detail-aside">
            <section class="surface-card project-detail-panel">
              <div class="header-row">
                <h2 class="subsection-title">Recent chats</h2>
                <span class="meta-label">${relatedChats.length} linked</span>
              </div>
              <div class="mini-list">
                ${
                  relatedChats.length
                    ? relatedChats
                        .slice(0, 6)
                        .map(
                          chat => `
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
                    : '<div class="empty-state compact">No chats linked to this project yet.</div>'
                }
              </div>
            </section>

            <section class="surface-card project-detail-panel">
              <div class="header-row">
                <h2 class="subsection-title">Artifacts</h2>
                <span class="meta-label">${relatedArtifacts.length} saved</span>
              </div>
              <div class="mini-list">
                ${
                  relatedArtifacts.length
                    ? relatedArtifacts
                        .slice(0, 6)
                        .map(
                          artifact => `
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
                    : '<div class="empty-state compact">No artifacts for this project yet.</div>'
                }
              </div>
            </section>
          </aside>
        </div>
      </div>
    </section>
  `;
}

function renderAgentList(selectedId) {
  return `
    <div class="list-stack">
      ${(uiState.bootstrap?.customize?.agents || [])
        .map(
          agent => `
            <button
              class="list-row ${selectedId === agent.id ? 'is-active' : ''}"
              data-action="select-agent-profile"
              data-agent-id="${agent.id}"
            >
              <div class="list-row-title">
                ${escapeHtml(agent.name)}
                <span class="meta-label">${escapeHtml(agent.moodLabel)}</span>
              </div>
              <div class="list-row-meta">${escapeHtml(agent.laneLabel)}</div>
            </button>
          `,
        )
        .join('')}
      <button class="small-button agent-create-button" type="button" data-action="create-custom-agent">
        Customize
      </button>
    </div>
  `;
}

function renderAgentWorkbench(selected) {
  if (!selected) {
    return '<section class="surface-card"><div class="empty-state">Select an agent to inspect it.</div></section>';
  }

  const moodOptions = uiState.bootstrap?.customize?.moods || [];
  const toolOptions = agentToolOptions();
  const project = activeProject();
  const scope = selectedAgentScope();
  const draft = agentDraftFor(selected);
  const allSkills = uiState.bootstrap?.customize?.skills || [];
  const externalMcpConnectors = (uiState.bootstrap?.customize?.connectors || []).filter(
    c => c.type === 'external-mcp',
  );
  const formId = `agent-profile-form-${selected.id}`;
  const selectedTools = new Set(draft?.tools || []);
  const saveKey = agentSaveKey(selected.id, scope, scope === 'project' ? project?.id || 'global' : 'global');
  const saveButtonLabel = uiState.agentSaveStates[saveKey] ? 'Saving' : 'Save';
  const saveButtonStateClass = uiState.agentSaveStates[saveKey] ? ' is-saving' : '';
  const activeEditorFile = uiState.agentEditorTab === 'soul' ? 'SOUL.md' : 'IDENTITY.md';
  const activeEditorValue =
    uiState.agentEditorTab === 'soul'
      ? draft?.['soul.md'] || ''
      : draft?.identity || draft?.identify || '';
  const activeEditorPath =
    uiState.agentEditorTab === 'soul' ? selected.soulPath : selected.identityPath;
  const telegramChannel = draft?.channels?.telegram || selected.channels?.find?.(channel => channel.id === 'telegram') || selected.channels?.telegram || {};
  const discordChannel = draft?.channels?.discord || selected.channels?.find?.(channel => channel.id === 'discord') || selected.channels?.discord || {};
  const telegramSecretVisible = Boolean(
    uiState.agentSecretVisibility[agentSecretVisibilityKey(selected.id, 'telegram')],
  );
  const discordSecretVisible = Boolean(
    uiState.agentSecretVisibility[agentSecretVisibilityKey(selected.id, 'discord')],
  );
  // Active channel tab controls which single channel panel is rendered. The
  // three tabs (Telegram / Discord / Lark) sit above a full-width panel so
  // that the detail form uses the entire right-column width instead of being
  // crammed into a 2-column grid.
  const VALID_CHANNEL_TABS = ['telegram', 'discord', 'lark'];
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
    {
      id: 'lark',
      label: 'Lark',
      status: 'coming soon',
      connected: false,
      enabled: false,
    },
  ];

  return `
    <section class="surface-card agent-workbench-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">${escapeHtml(selected.name)}</h2>
          <p class="page-kicker">${escapeHtml(selected.description)}</p>
        </div>
        <div class="inline-actions">
          ${
            uiState.bootstrap?.settings?.selectedChatId
              ? `
                <button
                  class="small-button is-outline"
                  type="button"
                  data-action="save-chat-as-skill"
                  data-chat-id="${uiState.bootstrap.settings.selectedChatId}"
                  title="Draft a reusable skill from the active chat. You confirm before it saves."
                >
                  Save as skill
                </button>
              `
              : `
                <button
                  class="small-button is-outline"
                  type="button"
                  disabled
                  title="Open a chat first to enable this. The drafter needs a conversation to learn from."
                >
                  Save as skill
                </button>
              `
          }
          <button
            class="chip chip-button is-accent agent-save-button${saveButtonStateClass}"
            type="button"
            data-action="submit-agent-profile"
            data-form-id="${formId}"
            ${uiState.agentSaveStates[saveKey] ? 'disabled' : ''}
          >
            ${saveButtonLabel}
          </button>
        </div>
      </div>

      <div class="toggle-row">
        <div>
          <div class="list-row-title">Persona scope</div>
          <div class="list-row-meta">
            ${
              project
                ? `Switch between global defaults and a project override for ${escapeHtml(
                    project.name,
                  )}.`
                : 'Global defaults are active because no project override target is selected.'
            }
          </div>
        </div>
        <div class="chip-row">
          <button
            class="chip chip-button ${scope === 'global' ? 'is-accent' : ''}"
            type="button"
            data-action="switch-agent-scope"
            data-scope="global"
          >
            Global
          </button>
          <button
            class="chip chip-button ${scope === 'project' ? 'is-accent' : ''}"
            type="button"
            data-action="switch-agent-scope"
            data-scope="project"
            ${project ? '' : 'disabled'}
          >
            ${project ? escapeHtml(project.name) : 'Project override'}
          </button>
        </div>
      </div>

      <div class="agent-compact-note">
        IDENTITY.md and SOUL.md are editable here in the UI and saved to disk for this agent lane.
      </div>

      <form
        id="${formId}"
        class="config-form"
        data-form="agent-profile-update"
        data-agent-id="${selected.id}"
      >
        ${
          selected.isCustom
            ? `
              <label class="label">
                Agent name
                <input
                  class="config-input"
                  type="text"
                  name="name"
                  value="${escapeHtml(draft?.name || selected.name || '')}"
                  placeholder="Custom agent"
                />
              </label>
              <label class="label">
                Description
                <textarea class="textarea code-editor agent-control-editor" name="description" placeholder="What this custom agent is for.">${escapeHtml(
                  draft?.description || selected.description || '',
                )}</textarea>
              </label>
            `
            : `
              <div class="agent-compact-note">
                Built-in lanes keep their source-inspired names. Use Customize to add a new agent you can rename.
              </div>
            `
        }

        <div class="editor-tab-row">
          <button
            class="chip chip-button ${uiState.agentEditorTab === 'identity' ? 'is-accent' : ''}"
            type="button"
            data-action="select-agent-editor-tab"
            data-tab="identity"
          >
            IDENTITY.md
          </button>
          <button
            class="chip chip-button ${uiState.agentEditorTab === 'soul' ? 'is-accent' : ''}"
            type="button"
            data-action="select-agent-editor-tab"
            data-tab="soul"
          >
            SOUL.md
          </button>
        </div>

        <div class="selected-file-card agent-file-editor">
          <div class="agent-editor-header">
            <div class="agent-editor-heading">
              <div class="meta-block-label">Content</div>
              <div class="list-row-meta">Edit the live markdown content for this file.</div>
            </div>
          </div>
          <div class="agent-editor-path">
            ${escapeHtml(activeEditorPath || activeEditorFile)}
          </div>
          <label class="label">
            <textarea
              class="textarea code-editor agent-content-editor"
              name="${uiState.agentEditorTab === 'soul' ? 'soul.md' : 'identity'}"
            >${escapeHtml(activeEditorValue)}</textarea>
          </label>
        </div>

        ${
          uiState.agentEditorTab === 'soul'
            ? `<input type="hidden" name="identity" value="${escapeHtml(
                draft?.identity || draft?.identify || '',
              )}" />`
            : `<input type="hidden" name="soul.md" value="${escapeHtml(
                draft?.['soul.md'] || '',
              )}" />`
        }

        <div class="detail-meta">
          <div class="meta-block-label">Agent controls</div>
          <div>These fields follow the source-code agent idea: tools, model, and system prompt shape how this lane actually runs.</div>
        </div>

        <label class="label">
          Model override
          <input
            class="config-input"
            type="text"
            name="model"
            value="${escapeHtml(draft?.model || '')}"
            placeholder="Inherit global model"
          />
        </label>

        <label class="label">
          System prompt
          <textarea class="textarea code-editor agent-control-editor" name="systemPrompt" placeholder="Optional lane-specific system prompt.">${escapeHtml(
            draft?.systemPrompt || '',
          )}</textarea>
        </label>

        <input type="hidden" name="tools" value="${escapeHtml((draft?.tools || []).join(','))}" />

        <div class="detail-meta">
          <div class="meta-block-label">Tools</div>
          <div>Select which source-inspired capabilities this agent can pull into its live prompt and task context.</div>
        </div>

        <div class="chip-row">
          ${toolOptions
            .map(
              option => `
                <button
                  class="chip chip-button ${selectedTools.has(option.id) ? 'is-accent' : ''}"
                  type="button"
                  data-action="toggle-agent-tool"
                  data-agent-id="${selected.id}"
                  data-tool-id="${option.id}"
                >
                  ${escapeHtml(option.label)}
                </button>
              `,
            )
            .join('')}
        </div>

        ${
          selectedTools.has('skills') && allSkills.length
            ? (() => {
                const whitelistIds = Array.isArray(draft?.enabledSkillIds)
                  ? new Set(draft.enabledSkillIds)
                  : null; // null = all allowed
                const noRestriction = whitelistIds === null;
                return `
                  <input type="hidden" name="enabledSkillIds" value="${
                    noRestriction ? '__all__' : escapeHtml([...whitelistIds].join(','))
                  }" />
                  <div class="detail-meta">
                    <div class="meta-block-label">Skill access</div>
                    <div>Choose which skills this agent can use. Leave all unchecked to allow all enabled skills.</div>
                  </div>
                  <div class="chip-row">
                    <button
                      class="chip chip-button ${noRestriction ? 'is-accent' : ''}"
                      type="button"
                      data-action="reset-agent-skill-whitelist"
                      data-agent-id="${selected.id}"
                    >All skills</button>
                    ${allSkills
                      .map(skill => `
                        <button
                          class="chip chip-button ${!noRestriction && whitelistIds.has(skill.id) ? 'is-accent' : ''}"
                          type="button"
                          data-action="toggle-agent-skill"
                          data-agent-id="${selected.id}"
                          data-skill-id="${skill.id}"
                        >${escapeHtml(skill.name)}</button>
                      `)
                      .join('')}
                  </div>
                `;
              })()
            : '<input type="hidden" name="enabledSkillIds" value="__all__" />'
        }

        ${
          selectedTools.has('external-connectors') && externalMcpConnectors.length
            ? (() => {
                const whitelistIds = Array.isArray(draft?.enabledConnectorIds)
                  ? new Set(draft.enabledConnectorIds)
                  : null;
                const noRestriction = whitelistIds === null;
                return `
                  <input type="hidden" name="enabledConnectorIds" value="${
                    noRestriction ? '__all__' : escapeHtml([...whitelistIds].join(','))
                  }" />
                  <div class="detail-meta">
                    <div class="meta-block-label">Connector access</div>
                    <div>Choose which external MCP connectors this agent can reach. Leave all unchecked to allow all.</div>
                  </div>
                  <div class="chip-row">
                    <button
                      class="chip chip-button ${noRestriction ? 'is-accent' : ''}"
                      type="button"
                      data-action="reset-agent-connector-whitelist"
                      data-agent-id="${selected.id}"
                    >All connectors</button>
                    ${externalMcpConnectors
                      .map(c => `
                        <button
                          class="chip chip-button ${!noRestriction && whitelistIds.has(c.id) ? 'is-accent' : ''}"
                          type="button"
                          data-action="toggle-agent-connector"
                          data-agent-id="${selected.id}"
                          data-connector-id="${c.id}"
                        >${escapeHtml(c.name)}</button>
                      `)
                      .join('')}
                  </div>
                `;
              })()
            : '<input type="hidden" name="enabledConnectorIds" value="__all__" />'
        }

        ${(() => {
          // Stdio MCP server whitelist — unified across built-in presets
          // and user-configured `mcpServers`. Without this surface the
          // user's own MCP entries would register tools but never be
          // reachable via the per-agent whitelist (Codex 🔴 audit
          // 2026-04-28). Defaults to deny-all per agent.
          const presets = uiState.bootstrap?.customize?.mcpAuthSurface
            || uiState.bootstrap?.customize?.mcpPresets // legacy fallback
            || [];
          if (!presets.length) {
            return '<input type="hidden" name="enabledMcpServerIds" value="" />';
          }
          const whitelist = new Set(
            Array.isArray(draft?.enabledMcpServerIds) ? draft.enabledMcpServerIds : [],
          );
          return `
            <input type="hidden" name="enabledMcpServerIds" value="${escapeHtml([...whitelist].join(','))}" />
            <div class="detail-meta">
              <div class="meta-block-label">Stdio MCP servers</div>
              <div>Pick which built-in MCP servers this agent may call. Empty = no MCP access (default — these run local processes, opt-in per agent).</div>
            </div>
            <div class="chip-row">
              ${presets.map(preset => {
                const enabled = Boolean(preset?.enabled);
                const allowed = whitelist.has(preset.id);
                // Globally-disabled servers stay clickable when the agent
                // has them in its whitelist, so the user can always REMOVE
                // a stale authorisation. Adding a new authorisation for a
                // disabled server is rejected by the action handler with
                // a toast pointing at Advanced. The `is-disabled-preset`
                // class greys the chip without using the HTML disabled
                // attribute (which would block click entirely).
                const stale = !enabled && allowed;
                return `
                  <button
                    class="chip chip-button${allowed ? ' is-accent' : ''}${!enabled ? ' is-disabled-preset' : ''}"
                    type="button"
                    data-action="toggle-agent-mcp-server"
                    data-agent-id="${selected.id}"
                    data-mcp-server-id="${escapeHtml(preset.id)}"
                    data-preset-enabled="${enabled ? '1' : '0'}"
                    title="${enabled
                      ? 'Server enabled globally'
                      : stale
                        ? 'Server disabled globally — click to revoke the stale authorisation'
                        : 'Server disabled globally — enable in Advanced first'}"
                  >${escapeHtml(preset.id)}${enabled ? '' : ' (off)'}</button>
                `;
              }).join('')}
            </div>
          `;
        })()}

        <div class="detail-meta">
          <div class="meta-block-label">Mood</div>
          <div>${escapeHtml(selected.moodDescription)}</div>
        </div>

        <div class="chip-row">
          ${moodOptions
            .map(
              option => `
                <button
                  class="chip chip-button ${draft?.mood === option.id ? 'is-accent' : ''}"
                  type="button"
                  data-action="set-agent-mood"
                  data-mood="${option.id}"
                  data-agent-id="${selected.id}"
                >
                  ${escapeHtml(option.label)}
                </button>
              `,
            )
            .join('')}
        </div>

        <label class="label">
          Mood
          <select class="config-select" name="mood">
            ${moodOptions
              .map(
                option => `
                  <option value="${option.id}" ${draft?.mood === option.id ? 'selected' : ''}>
                    ${escapeHtml(option.label)} · ${escapeHtml(option.description)}
                  </option>
                `,
              )
              .join('')}
          </select>
        </label>

        <div class="detail-meta">
          <div class="meta-block-label">Channels</div>
          <div>Link Telegram, Discord, or Lark for this agent and test the saved credentials from here.</div>
        </div>

        <div class="agent-channel-tabs" role="tablist">
          ${channelTabDefs
            .map(
              tab => `
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
          ${
            activeChannelTab === 'telegram'
              ? `
                <section class="selected-file-card agent-channel-card">
                  <div class="agent-editor-header">
                    <div class="agent-editor-heading">
                      <div class="meta-block-label">Telegram</div>
                      <div class="list-row-meta">Attach a Telegram bot to this agent with its bot token.</div>
                    </div>
                    <span class="chip ${telegramChannel.lastStatus === 'connected' ? 'is-accent' : ''}">
                      ${escapeHtml(telegramChannel.statusLabel || telegramChannel.lastStatus || 'idle')}
                    </span>
                  </div>
                  <label class="checkbox-row">
                    <input type="checkbox" name="telegramEnabled" ${telegramChannel.enabled ? 'checked' : ''} />
                    <span>Enable Telegram for this agent</span>
                  </label>
                  <label class="checkbox-row">
                    <input type="checkbox" name="telegramVoiceReply" ${telegramChannel.voiceReply ? 'checked' : ''} />
                    <span>Send voice reply (TTS audio after each text reply)</span>
                  </label>
                  <label class="label">
                    Voice reply mode
                    <select class="config-select" name="voiceReplyMode">
                      <option value="summary" ${(draft?.voiceReplyMode || 'summary') === 'summary' ? 'selected' : ''}>Summary — concise oral summary (default)</option>
                      <option value="full" ${draft?.voiceReplyMode === 'full' ? 'selected' : ''}>Full — read entire reply as-is</option>
                      <option value="off" ${draft?.voiceReplyMode === 'off' ? 'selected' : ''}>Off — never send voice reply</option>
                    </select>
                  </label>
                  <label class="label">
                    Edge TTS voice
                    <input class="config-input" name="edgeTtsVoice" value="${escapeHtml(
                      draft?.edgeTtsVoice || '',
                    )}" placeholder="Auto-detect (e.g. ko-KR-SunHiNeural, zh-CN-XiaoxiaoNeural)" />
                  </label>
                  <label class="label">
                    Voice personality
                    <textarea class="textarea" name="voicePersonality" rows="3" placeholder="Optional: personality instructions for voice rewrite (e.g. tone, catchphrases, language mixing rules)">${escapeHtml(
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
                        aria-label="${telegramSecretVisible ? 'Hide Telegram bot token' : 'Show Telegram bot token'}"
                        title="${telegramSecretVisible ? 'Hide Telegram bot token' : 'Show Telegram bot token'}"
                      >
                        ${telegramSecretVisible ? icon.eyeOff : icon.eye}
                      </button>
                    </div>
                  </label>
                  <label class="label">
                    Default chat ID (optional)
                    <input class="config-input" type="text" name="telegramChatId" value="${escapeHtml(
                      telegramChannel.chatId || '',
                    )}" placeholder="Optional: Telegram chat id for default routing" />
                  </label>
                  ${
                    telegramChannel.lastError
                      ? `<div class="list-row-meta danger-copy">${escapeHtml(telegramChannel.lastError)}</div>`
                      : ''
                  }
                  ${renderChannelRuntimeCard(telegramChannel, { showRoute: true })}
                  <div class="inline-actions">
                    <button class="small-button" type="button" data-action="test-agent-channel" data-channel-id="telegram">
                      Test Telegram
                    </button>
                  </div>
                </section>
              `
              : ''
          }
          ${
            activeChannelTab === 'discord'
              ? `
                <section class="selected-file-card agent-channel-card">
                  <div class="agent-editor-header">
                    <div class="agent-editor-heading">
                      <div class="meta-block-label">Discord</div>
                      <div class="list-row-meta">Attach a Discord bot workspace to this agent.</div>
                    </div>
                    <span class="chip ${discordChannel.lastStatus === 'connected' ? 'is-accent' : ''}">
                      ${escapeHtml(discordChannel.statusLabel || discordChannel.lastStatus || 'idle')}
                    </span>
                  </div>
                  <label class="checkbox-row">
                    <input type="checkbox" name="discordEnabled" ${discordChannel.enabled ? 'checked' : ''} />
                    <span>Enable Discord for this agent</span>
                  </label>
                  <label class="checkbox-row">
                    <input type="checkbox" name="discordVoiceReply" ${discordChannel.voiceReply ? 'checked' : ''} />
                    <span>Send voice reply (TTS audio after each text reply)</span>
                  </label>
                  <div class="list-row-meta" style="margin:0 0 8px 0;">
                    Voice reply mode, Edge TTS voice and voice personality are agent-level and
                    apply to both Telegram and Discord — configure them on the Telegram tab.
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
                        aria-label="${discordSecretVisible ? 'Hide Discord bot token' : 'Show Discord bot token'}"
                        title="${discordSecretVisible ? 'Hide Discord bot token' : 'Show Discord bot token'}"
                      >
                        ${discordSecretVisible ? icon.eyeOff : icon.eye}
                      </button>
                    </div>
                  </label>
                  <label class="label">
                    Guild ID
                    <input class="config-input" type="text" name="discordGuildId" value="${escapeHtml(
                      discordChannel.guildId || '',
                    )}" placeholder="Discord guild id" />
                  </label>
                  <label class="label">
                    Channel ID
                    <input class="config-input" type="text" name="discordChannelId" value="${escapeHtml(
                      discordChannel.channelId || '',
                    )}" placeholder="Discord channel id" />
                  </label>
                  ${
                    discordChannel.lastError
                      ? `<div class="list-row-meta danger-copy">${escapeHtml(discordChannel.lastError)}</div>`
                      : ''
                  }
                  ${renderChannelRuntimeCard(discordChannel)}
                  <div class="inline-actions">
                    <button class="small-button" type="button" data-action="test-agent-channel" data-channel-id="discord">
                      Test Discord
                    </button>
                  </div>
                </section>
              `
              : ''
          }
          ${
            activeChannelTab === 'lark'
              ? `
                <section class="selected-file-card agent-channel-card">
                  <div class="agent-editor-header">
                    <div class="agent-editor-heading">
                      <div class="meta-block-label">Lark</div>
                      <div class="list-row-meta">Attach a Lark (Feishu) bot workspace to this agent.</div>
                    </div>
                    <span class="chip">coming soon</span>
                  </div>
                  <div class="list-row-meta">
                    Lark channel support is coming soon. The backend adapter is being wired up — you'll
                    be able to paste a Lark bot App ID / App Secret here once the channel is live.
                  </div>
                </section>
              `
              : ''
          }
        </div>

        <div class="inline-actions">
          <button
            class="small-button"
            type="button"
            data-action="reset-agent-draft"
            data-agent-id="${selected.id}"
          >
            Reset
          </button>
          ${
            scope === 'project' && selected.hasProjectOverride
              ? `
                <button
                  class="small-button"
                  type="button"
                  data-action="reset-project-agent-override"
                  data-agent-id="${selected.id}"
                >
                  Reset project override
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

  return `
    <section class="page agent-page">
      <div class="page-grid agent-page-grid">
        <div class="header-row">
          <div>
            <h1 class="page-title compact">Agent</h1>
          </div>

          <label class="label agent-select-label">
            Agent
            <select class="config-select" data-action="select-agent-profile">
              ${(uiState.bootstrap?.customize?.agents || [])
                .map(
                  agent => `
                    <option value="${agent.id}" ${selected?.id === agent.id ? 'selected' : ''}>
                      ${escapeHtml(agent.name)}
                    </option>
                  `,
                )
                .join('')}
            </select>
          </label>
        </div>

        <div class="customize-layout agent-layout">
          <div class="customize-pane agent-list-pane">
            <div class="customize-pane-header">
              <h2 class="pane-title">Lanes</h2>
            </div>
            ${renderAgentList(selected?.id || 'main')}
          </div>

          <div class="agent-detail-column">
            ${renderAgentWorkbench(selected)}
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderModelPage() {
  const config = uiState.bootstrap.settings.config;
  const draft = effectiveModelSetupDraft();
  const authMode = draft.authMode || 'codex';
  const defaults = modelDefaultsForAuthMode(authMode);
  const authModeLabel =
    authMode === 'local' ? 'Local model' : authMode === 'api-key' ? 'API key' : 'OAuth';
  const modelOptions = modelOptionsForAuthMode(authMode);
  const modelOptionsMarkup = modelOptions
    .map(
      option => `
        <option value="${escapeHtml(option)}" ${
          (draft.model || defaults.model) === option ? 'selected' : ''
        }>
          ${escapeHtml(option)}
        </option>
      `,
    )
    .join('');

  let modeSpecific = '';
  if (authMode === 'local') {
    modeSpecific = `
      <div class="agent-compact-note">
        Local model mode expects a local OpenAI-compatible endpoint. Melo will call the configured endpoint directly and will only send an authorization header if you fill in an optional key.
      </div>
      <label class="label">
        Local endpoint
        <input
          class="config-input"
          type="text"
          name="baseUrl"
          value="${escapeHtml(draft.baseUrl || defaults.baseUrl)}"
          placeholder="${defaults.baseUrl}"
        />
      </label>
      <label class="label">
        Local model
        <div class="select-like model-field-select">
          <select class="config-select" name="model">
            ${modelOptionsMarkup}
          </select>
        </div>
      </label>
      <label class="label">
        Optional local access key
        <input
          class="input"
          name="apiKey"
          type="password"
          value=""
          placeholder="Optional"
        />
      </label>
      <div class="inline-actions">
        <button class="small-button" type="button" data-action="load-model-options">
          ${uiState.modelCatalogLoading ? 'Reading models…' : 'Read local models'}
        </button>
      </div>
    `;
  } else if (authMode === 'api-key') {
    modeSpecific = `
      <div class="agent-compact-note">
        API mode uses the official provider endpoint and a manually supplied API key.
      </div>
      <label class="label">
        Base URL
        <input
          class="config-input"
          type="text"
          name="baseUrl"
          value="${escapeHtml(draft.baseUrl || defaults.baseUrl)}"
          placeholder="${defaults.baseUrl}"
        />
      </label>
      <label class="label">
        Model
        <div class="select-like model-field-select">
          <select class="config-select" name="model">
            ${modelOptionsMarkup}
          </select>
        </div>
      </label>
      <label class="label">
        API key
        <input
          class="input"
          name="apiKey"
          type="password"
          value=""
          placeholder="${escapeHtml(config.maskedApiKey || 'sk-...')}"
        />
      </label>
      <div class="list-row-meta">Leave this blank if you want to keep the current saved key.</div>
      <div class="inline-actions">
        <button class="small-button" type="button" data-action="load-model-options">
          ${uiState.modelCatalogLoading ? 'Reading models…' : 'Read available models'}
        </button>
      </div>
    `;
  } else {
    modeSpecific = `
      <div class="agent-compact-note">
        OAuth mode reuses your local Codex device login. Clicking Start OAuth opens a Terminal-based Codex login flow, then you can come back here and refresh the status. This is a Codex login bridge, not a direct API-key flow.
      </div>
      <div class="detail-meta">
        <div class="meta-block-label">OAuth status</div>
        <div>
          ${
            config.codexAuth?.loggedIn
              ? `Signed in through Codex as ${escapeHtml(config.codexAuth.email || 'your OpenAI account')}${config.codexAuth.plan ? ` · ${escapeHtml(config.codexAuth.plan)}` : ''}.`
              : 'No active Codex OAuth session is available yet.'
          }
        </div>
      </div>
      <div class="inline-actions">
        <button class="small-button is-primary" type="button" data-action="start-model-oauth">
          Start OAuth
        </button>
        <button class="small-button" type="button" data-action="refresh-model-status">
          Refresh status
        </button>
      </div>
      <label class="label">
        OAuth endpoint
        <input
          class="config-input"
          type="text"
          name="baseUrl"
          value="${escapeHtml(draft.baseUrl || defaults.baseUrl)}"
          placeholder="${defaults.baseUrl}"
        />
      </label>
      <label class="label">
        Model
        <div class="select-like model-field-select">
          <select class="config-select" name="model">
            ${modelOptionsMarkup}
          </select>
        </div>
      </label>
      <div class="inline-actions">
        <button class="small-button" type="button" data-action="load-model-options">
          ${uiState.modelCatalogLoading ? 'Reading models…' : 'Refresh model list'}
        </button>
      </div>
    `;
  }

  return `
    <section class="page page-model">
      <div class="model-page-titlebar">
        <h1 class="page-title compact">Model</h1>
      </div>
      <div class="project-workbench model-page-grid">
        <section class="surface-card model-setup-card">
          <div class="header-row model-setup-header">
            <span class="chip is-accent">${escapeHtml(authModeLabel)}</span>
          </div>

          <form id="model-config-form" class="config-form" data-form="model-config">
            <input type="hidden" name="authMode" value="${escapeHtml(authMode)}" />
            <div class="label model-setup-select">
              <span>Set up model type</span>
              <div class="model-type-switch" role="tablist" aria-label="Set up model type">
                <button
                  class="small-button ${authMode === 'local' ? 'is-primary' : ''}"
                  type="button"
                  data-action="set-model-auth-mode"
                  data-auth-mode="local"
                >
                  Local model
                </button>
                <button
                  class="small-button ${authMode === 'api-key' ? 'is-primary' : ''}"
                  type="button"
                  data-action="set-model-auth-mode"
                  data-auth-mode="api-key"
                >
                  API key
                </button>
                <button
                  class="small-button ${authMode === 'codex' ? 'is-primary' : ''}"
                  type="button"
                  data-action="set-model-auth-mode"
                  data-auth-mode="codex"
                >
                  OAuth
                </button>
              </div>
            </div>

            ${modeSpecific}

            <label class="label">
              System prompt
              <textarea class="config-textarea" name="systemPrompt">${escapeHtml(
                draft.systemPrompt || '',
              )}</textarea>
            </label>

            <div class="inline-actions">
              <button class="small-button is-primary" type="submit">
                Save model setup
              </button>
            </div>
          </form>
        </section>
      </div>
    </section>
  `;
}

function renderAgentDetails(selected) {
  const moodOptions = uiState.bootstrap?.customize?.moods || [];
  const presets = uiState.bootstrap?.customize?.agentPresets || [];
  const project = activeProject();
  const scope = selectedAgentScope();
  const draft = agentDraftFor(selected);
  const activeEditorFile = uiState.agentEditorTab === 'soul' ? 'SOUL.md' : 'IDENTITY.md';
  const activeEditorValue =
    uiState.agentEditorTab === 'soul'
      ? draft?.['soul.md'] || ''
      : draft?.identity || draft?.identify || '';
  const activeEditorPath =
    uiState.agentEditorTab === 'soul' ? selected.soulPath : selected.identityPath;

  return `
    <div class="detail-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">${escapeHtml(selected.name)}</h2>
          <p class="page-kicker">${escapeHtml(selected.description)}</p>
        </div>
        <span class="chip is-accent">${escapeHtml(selected.moodLabel)}</span>
      </div>

      <div class="toggle-row">
        <div>
          <div class="list-row-title">Persona scope</div>
          <div class="list-row-meta">
            ${
              project
                ? `Switch between global defaults and a project override for ${escapeHtml(
                    project.name,
                  )}.`
                : 'Global defaults apply because no project override target is active.'
            }
          </div>
        </div>
        <div class="chip-row">
          <button
            class="chip chip-button ${scope === 'global' ? 'is-accent' : ''}"
            type="button"
            data-action="switch-agent-scope"
            data-scope="global"
          >
            Global
          </button>
          <button
            class="chip chip-button ${scope === 'project' ? 'is-accent' : ''}"
            type="button"
            data-action="switch-agent-scope"
            data-scope="project"
            ${project ? '' : 'disabled'}
          >
            ${project ? escapeHtml(project.name) : 'Project override'}
          </button>
        </div>
      </div>

      <div class="meta-grid">
        <div>
          <div class="meta-block-label">Lane</div>
          <div>${escapeHtml(selected.laneLabel)}</div>
        </div>
        <div>
          <div class="meta-block-label">Source</div>
          <div>
            ${
              selected.scopeSource === 'project'
                ? `Project override${project ? ` · ${escapeHtml(project.name)}` : ''}`
                : 'Global default'
            }
          </div>
        </div>
      </div>

      <div class="detail-meta">
        <div class="meta-block-label">Role prompt</div>
        <div>${escapeHtml(selected.rolePrompt)}</div>
      </div>

      <div class="subsection">
        <div class="header-row">
          <h3 class="subsection-title">Preset import</h3>
          <span class="meta-label">Import a mood/persona baseline into the current scope</span>
        </div>
        <div class="card-grid compact-grid preset-grid">
          ${presets
            .map(
              preset => `
                <article class="artifact-card preset-card">
                  <div class="thread-meta">
                    <span class="chip is-accent">${escapeHtml(preset.mood)}</span>
                  </div>
                  <h3 class="card-title">${escapeHtml(preset.name)}</h3>
                  <p class="card-summary">${escapeHtml(preset.description)}</p>
                  <button
                    class="small-button is-primary"
                    type="button"
                    data-action="import-agent-preset"
                    data-agent-id="${selected.id}"
                    data-preset-id="${preset.id}"
                  >
                    Import preset
                  </button>
                </article>
              `,
            )
            .join('')}
        </div>
      </div>

      <form id="agent-profile-editor-form-${selected.id}" class="config-form" data-form="agent-profile-update" data-agent-id="${selected.id}">
        <div class="editor-tab-row">
          <button
            class="chip chip-button ${uiState.agentEditorTab === 'identity' ? 'is-accent' : ''}"
            type="button"
            data-action="select-agent-editor-tab"
            data-tab="identity"
          >
            IDENTITY.md
          </button>
          <button
            class="chip chip-button ${uiState.agentEditorTab === 'soul' ? 'is-accent' : ''}"
            type="button"
            data-action="select-agent-editor-tab"
            data-tab="soul"
          >
            SOUL.md
          </button>
        </div>

        <div class="selected-file-card agent-file-editor">
          <div class="thread-meta selected-file-meta">
            <span class="chip is-accent">${escapeHtml(activeEditorFile)}</span>
            <span class="chip">${escapeHtml(selected.name)}</span>
            <span class="chip">${scope === 'project' && project ? escapeHtml(project.name) : 'Global'}</span>
          </div>
          <div class="workspace-root">${escapeHtml(activeEditorPath || activeEditorFile)}</div>
          <textarea
            class="textarea code-editor"
            name="${uiState.agentEditorTab === 'soul' ? 'soul.md' : 'identity'}"
          >${escapeHtml(activeEditorValue)}</textarea>
        </div>

        ${
          uiState.agentEditorTab === 'soul'
            ? `<input type="hidden" name="identity" value="${escapeHtml(
                draft?.identity || draft?.identify || '',
              )}" />`
            : `<input type="hidden" name="soul.md" value="${escapeHtml(
                draft?.['soul.md'] || '',
              )}" />`
        }

        <div class="detail-meta">
          <div class="meta-block-label">Current mood</div>
          <div>${escapeHtml(selected.moodDescription)}</div>
        </div>

        <div class="chip-row">
          ${moodOptions
            .map(
              option => `
                <button
                  class="chip chip-button ${draft?.mood === option.id ? 'is-accent' : ''}"
                  type="button"
                  data-action="set-agent-mood"
                  data-mood="${option.id}"
                  data-agent-id="${selected.id}"
                >
                  ${escapeHtml(option.label)}
                </button>
              `,
            )
            .join('')}
        </div>

        <label class="label">
          Mood
          <select class="config-select" name="mood">
            ${moodOptions
              .map(
                option => `
                  <option value="${option.id}" ${draft?.mood === option.id ? 'selected' : ''}>
                    ${escapeHtml(option.label)} · ${escapeHtml(option.description)}
                  </option>
                `,
              )
              .join('')}
          </select>
        </label>

        <div class="detail-meta">
          <div class="meta-block-label">Mood instruction</div>
          <div>${escapeHtml(
            moodOptions.find(option => option.id === draft?.mood)?.prompt || selected.moodPrompt,
          )}</div>
        </div>

        <div class="detail-meta">
          <div class="meta-block-label">MiniMax voice (optional)</div>
          <div>
            Bind this agent to a MiniMax cloned voice — the TTS panel's "自定义语音"
            list shows every agent that has a voice id set, so this is what
            controls which agents appear there. Configure your MiniMax key
            in Settings → Connector → API key.
          </div>
        </div>
        <label class="label">
          MiniMax voice ID
          <input
            class="input"
            name="minimaxVoiceId"
            value="${escapeHtml(draft?.minimaxVoiceId ?? selected.minimaxVoiceId ?? '')}"
            placeholder="moss_audio_… or any cloned voice id (leave blank to unbind)"
          />
        </label>

        <div class="inline-actions">
          <button class="small-button is-primary" type="submit">Save agent profile</button>
          ${
            scope === 'project' && selected.hasProjectOverride
              ? `
                <button
                  class="small-button"
                  type="button"
                  data-action="reset-project-agent-override"
                  data-agent-id="${selected.id}"
                >
                  Reset project override
                </button>
              `
              : ''
          }
        </div>
      </form>
    </div>
  `;
}

function renderConnectorDetails(selected) {
  if (!selected) {
    return '<div class="empty-state">Select a skill, agent, or connector to inspect it.</div>';
  }

  if (uiState.bootstrap.settings.selectedCustomizeSection === 'agents') {
    return renderAgentDetails(selected);
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
    return `
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
              .map(folder => `<span class="chip">${escapeHtml(folder)}</span>`)
              .join('')}
          </div>
          ${
            !isGlobalSkill
              ? `<div class="chip-row">
                   <span class="meta-label">Only visible to:</span>
                   ${allowedAgentIds
                     .map(aid => `<span class="chip">${escapeHtml(aid)}</span>`)
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

        ${isCustomSkill ? `
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
    return `
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
    const draftAuthMode = draft.authMode || 'codex';
    extra = `
      <form id="connector-config-form" class="config-form" data-form="connector-config">
        <label class="label">
          Auth mode
          <select class="input" name="authMode">
            <option value="local" ${draftAuthMode === 'local' ? 'selected' : ''}>
              Local model
            </option>
            <option value="codex" ${draftAuthMode === 'codex' ? 'selected' : ''}>
              Codex / ChatGPT OAuth
            </option>
            <option value="api-key" ${draftAuthMode === 'api-key' ? 'selected' : ''}>
              OpenAI API key
            </option>
          </select>
        </label>
        ${
          draftAuthMode === 'codex'
            ? `
              <div class="detail-meta">
                ${
                  selected.config.codexAuth?.loggedIn
                    ? `Using local Codex login as ${escapeHtml(
                        selected.config.codexAuth.email || 'signed-in account',
                      )}${selected.config.codexAuth.plan ? ` · plan ${escapeHtml(selected.config.codexAuth.plan)}` : ''}.`
                    : 'No local Codex login found yet. Open the Model page to start the OAuth sign-in flow.'
                }
              </div>
            `
            : `
        <label class="label">
          OpenAI API key
          <input
            class="input"
            name="apiKey"
            type="password"
            value=""
            placeholder="${escapeHtml(selected.config.maskedApiKey || 'sk-...')}"
          />
        </label>
        <div class="list-row-meta">Leave this blank if you want to keep the current saved key.</div>
            `
        }
        <label class="label">
          Base URL
          <input
            class="input"
            name="baseUrl"
            value="${escapeHtml(draft.baseUrl || '')}"
            placeholder="https://api.openai.com/v1"
          />
        </label>
        <label class="label">
          Model
          <input
            class="input"
            name="model"
            value="${escapeHtml(draft.model || '')}"
            placeholder="gpt-5.5"
          />
        </label>
        <label class="label">
          System prompt
          <textarea class="config-textarea" name="systemPrompt">${escapeHtml(
            draft.systemPrompt || '',
          )}</textarea>
        </label>
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
          Whisper API key (optional override)
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
          MiniMax API key
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
    extra = `
      <div class="detail-meta">
        <div class="meta-block-label">Workspace root</div>
        <div class="mono">${escapeHtml(selected.config.workspaceRoot || '(none)')}</div>
      </div>
      <div class="chip-row">
        <span class="chip is-accent">${selected.config.fileCount || 0} files</span>
        <span class="chip">${selected.config.exists ? 'Available' : 'Unavailable'}</span>
        ${
          selected.config.selectedFilePath
            ? `<span class="chip">${escapeHtml(selected.config.selectedFilePath)}</span>`
            : ''
        }
      </div>
      ${workspace.selectedFile ? renderSelectedFilePreview() : ''}
    `;
  } else if (selected.id === 'local-command') {
    extra = `
      <div class="chip-row">
        ${(workspace.commandTemplates || [])
          .map(
            template => `
              <span class="chip">${escapeHtml(template.label)}</span>
            `,
          )
          .join('')}
      </div>
      ${(workspace.commandRuns || []).length ? renderCommandRunner() : '<div class="empty-state compact">No command runs yet.</div>'}
    `;
  } else if (selected.id === 'artifacts') {
    extra = `
      <div class="chip-row">
        <span class="chip is-accent">${selected.config.totalArtifacts} total</span>
        <span class="chip">${selected.config.projectArtifacts} in active project</span>
      </div>
      ${renderProjectArtifactShelf()}
    `;
  } else if (selected.id === 'projects') {
    extra = `
      <div class="chip-row">
        <span class="chip is-accent">${escapeHtml(
          selected.config.activeProject || '(none)',
        )}</span>
        <span class="chip mono">${escapeHtml(selected.config.workspacePath || '')}</span>
      </div>
    `;
  }

  return `
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

  return `
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
        ? `
          <div class="skill-filter-tags">
            <button
              type="button"
              class="chip chip-button ${!tag ? 'is-accent' : ''}"
              data-action="set-skill-filter-tag"
              data-tag=""
            >All tags</button>
            ${tags
              .map(
                t => `
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
          ? `Showing ${filteredCount} of ${totalCount} skills · <button type="button" class="link-button" data-action="reset-skill-filter">reset</button>`
          : `${totalCount} skills`}
      </div>
    </div>
  `;
}

function renderCustomSkillCreateCard() {
  return `
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
  render();
  try {
    const response = await api('/api/skills/runs/stats');
    uiState.skillRunStats.skills = Array.isArray(response?.skills) ? response.skills : [];
    uiState.skillRunStats.loaded = true;
  } catch (err) {
    uiState.skillRunStats.error = err?.message || 'Failed to load skill runs';
  } finally {
    uiState.skillRunStats.loading = false;
    render();
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
  render();
  try {
    // Fan out — three independent endpoints, none of which block the
    // others, so a slow one doesn't gate the rest.
    const [serversResp, pluginsResp, tasksResp] = await Promise.all([
      api('/api/mcp/servers').catch(err => ({ _error: err?.message || 'mcp/servers failed' })),
      api('/api/plugins').catch(err => ({ _error: err?.message || 'plugins failed' })),
      api('/api/background-tasks/list').catch(err => ({ _error: err?.message || 'background-tasks/list failed' })),
    ]);
    const errors = [serversResp, pluginsResp, tasksResp]
      .filter(r => r && r._error)
      .map(r => r._error);
    if (errors.length === 3) {
      uiState.advanced.error = errors.join(' · ');
    } else {
      uiState.advanced.cliServers = Array.isArray(serversResp?.servers) ? serversResp.servers : [];
      uiState.advanced.plugins = Array.isArray(pluginsResp?.plugins) ? pluginsResp.plugins : [];
      uiState.advanced.tasks = Array.isArray(tasksResp?.runs) ? tasksResp.runs : [];
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

async function refreshMemoryStatus() {
  if (uiState.memoryStatus.loading) return;
  uiState.memoryStatus.loading = true;
  uiState.memoryStatus.error = null;
  render();
  try {
    const response = await api('/api/memory/status');
    uiState.memoryStatus.snapshot = response;
    uiState.memoryStatus.loaded = true;
  } catch (err) {
    uiState.memoryStatus.error = err?.message || 'Failed to load memory status';
  } finally {
    uiState.memoryStatus.loading = false;
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
      body: JSON.stringify({ confirm: 'YES, WIPE EMBEDDINGS' }),
      headers: { 'Content-Type': 'application/json' },
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

function renderMemoryPane() {
  const { loading, loaded, snapshot, error, wipeConfirmOpen, wipeInFlight, wipeResult } = uiState.memoryStatus;
  if (!loaded && !loading && !error) {
    // Kick off the first fetch; re-render happens inside refreshMemoryStatus.
    Promise.resolve().then(refreshMemoryStatus);
  }
  const content = (() => {
    if (loading && !snapshot) {
      return `<div class="empty-state compact">Loading memory status…</div>`;
    }
    if (error) {
      return `<div class="alert compact-alert">${escapeHtml(error)}</div>`;
    }
    if (!snapshot) {
      return `<div class="empty-state compact">No data yet. Click refresh.</div>`;
    }
    const s = snapshot;
    const drift = s.embedding?.drift || {};
    const metaRows = s.meta
      ? Object.entries(s.meta)
          .map(([k, v]) => `<div class="meta-label">${escapeHtml(k)}</div><div class="mono">${escapeHtml(String(v))}</div>`)
          .join('')
      : '<div class="list-row-meta">(not yet populated)</div>';
    return `
      <div class="detail-card memory-card">
        <div class="header-row">
          <div>
            <h2 class="pane-title">Memory</h2>
            <p class="page-kicker">Read-only snapshot of the local memory store, embedding provider, and dreaming pipeline.</p>
          </div>
          <div class="inline-actions">
            <button class="small-button" data-action="refresh-memory-status">Refresh</button>
          </div>
        </div>

        ${drift.hasDrift ? `
          <div class="alert compact-alert">
            <strong>Embedding model drift detected.</strong>
            Stored vectors were written by <span class="mono">${escapeHtml(drift.stored || '?')}</span>
            but the active provider reports <span class="mono">${escapeHtml(drift.inferredProvider || '?')}</span>.
            Recall quality may degrade until old vectors are rebuilt.
          </div>
        ` : ''}

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
          <div><div class="meta-label">Model (live)</div><div class="mono">${escapeHtml(drift.inferredProvider || '(provider not initialised)')}</div></div>
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
          ${wipeConfirmOpen ? `
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
          ${wipeResult ? `<div class="list-row-meta" style="margin-top: 8px;">${escapeHtml(wipeResult)}</div>` : ''}
        </div>

        <div class="subsection">
          <div class="meta-block-label">_meta table</div>
          <div class="meta-grid">${metaRows}</div>
        </div>
      </div>
    `;
  })();
  return `<div class="customize-pane">${content}</div>`;
}

// ───────────────────────────────────────────────────────────────────────
// Phase 3 — Skill Overview | Markdown tab switcher
// ───────────────────────────────────────────────────────────────────────

function renderSkillDetailTabs(selected, activeTab) {
  return `
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
  render();
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
    render();
  }
}

function renderSkillMarkdownTab(selected) {
  const activeTab = 'markdown';
  const cached = uiState.skillMarkdown[selected.id] || {};
  const body = (() => {
    if (cached.loading) return `<div class="empty-state compact">Loading SKILL.md…</div>`;
    if (cached.error) return `<div class="alert compact-alert">${escapeHtml(cached.error)}</div>`;
    if (!cached.markdown) {
      // Kick off initial load when rendered for the first time.
      Promise.resolve().then(() => refreshSkillMarkdown(selected.id));
      return `<div class="empty-state compact">Loading SKILL.md…</div>`;
    }
    return `<pre class="skill-markdown-block">${escapeHtml(cached.markdown)}</pre>`;
  })();
  return `
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
  return `
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
      ${error ? `<div class="banner is-warning">${escapeHtml(error)}</div>` : ''}
      ${
        !loaded && !loading
          ? `<div class="empty-state compact">Click "Load" to see run statistics.</div>`
          : skills.length === 0 && loaded
            ? `<div class="empty-state compact">No skill runs recorded yet.</div>`
            : `
              <div class="list-stack">
                ${skills
                  .map(row => {
                    const rate = formatSuccessRate(row);
                    const durLabel = formatDurationMs(row.p50DurationMs ?? row.avgDurationMs);
                    const lastAt = formatLastRunAt(row.lastRunAt);
                    const metaLabel = `${row.runs} runs • ${rate} ok • p50 ${durLabel} • last ${lastAt}`;
                    const errHtml = (row.recentErrors || [])
                      .slice(0, 3)
                      .map(e => `
                        <div class="skill-health-error">
                          <span class="meta-label">${escapeHtml(e.errorType || 'error')}</span>
                          <span>${escapeHtml((e.errorMessage || '').slice(0, 160))}</span>
                        </div>
                      `)
                      .join('');
                    const isDegraded = typeof row.successRate === 'number' && row.successRate < 0.7 && row.runs >= 3;
                    return `
                      <div class="list-row skill-health-row ${isDegraded ? 'is-degraded' : ''}">
                        <div>
                          <div class="list-row-title">${escapeHtml(nameFor(row.skillId))}</div>
                          <div class="list-row-meta">${escapeHtml(metaLabel)}</div>
                          ${errHtml ? `<div class="skill-health-errors">${errHtml}</div>` : ''}
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
  return `
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
          .map(p => `
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

  return `
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
              <div class="list-row-meta">IDENTITY.md, SOUL.md, and mood for the main chat agent and worker lanes.</div>
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
                Advanced
                <span class="chip is-accent">Experimental</span>
              </div>
              <div class="list-row-meta">MCP servers, plugins, background tasks. Status, reload, disconnect, kill — config edits deferred.</div>
            </button>
            <button
              class="section-button ${section === 'memory' ? 'is-active' : ''}"
              data-action="open-customize-section"
              data-section="memory"
            >
              <div class="list-row-title">Memory</div>
              <div class="list-row-meta">Inspect the memory store, embedding model, and dreaming activity.</div>
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
                mcpPresets: uiState.bootstrap?.customize?.mcpPresets || [],
              })
            : section === 'memory'
              ? renderMemoryPane()
              : `
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
                return `
                  <button
                    class="list-row ${isActive ? 'is-active' : ''}"
                    data-action="select-customize-item"
                    data-section="${section}"
                    data-id="${item.id}"
                  >
                    <div class="list-row-title">
                      ${escapeHtml(item.name)}
                      ${
                        section === 'agents'
                          ? `<span class="meta-label">${escapeHtml(item.moodLabel)}</span>`
                          : ''
                      }
                    </div>
                    <div class="list-row-meta">${escapeHtml(
                      section === 'agents' ? item.laneLabel : item.description,
                    )}</div>
                  </button>
                `;
              })
              .join('')}
            ${section === 'skills' && filteredSkills().length === 0
              ? `<div class="empty-state compact">No skills match the current filter.</div>`
              : ''}
          </div>
        </div>

        <div class="customize-pane">
          ${renderConnectorDetails(selected)}
          ${
            section === 'skills'
              ? `
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
  const artifacts = uiState.bootstrap.artifacts;
  const active = selectedArtifact();
  const project = activeProject();

  return `
    <section class="page">
      <div class="page-grid">
        <div class="header-row">
          <div>
            <h1 class="page-title compact">Artifacts</h1>
          </div>

          <div class="inline-actions">
            <button class="ghost-button is-primary" data-action="toggle-artifact-form">
              <span class="toolbar-icon">${icon.plus}</span>
              New artifact
            </button>
          </div>
        </div>

        ${
          uiState.showArtifactForm
            ? `
              <form class="project-form-card surface-card" data-form="artifact-create">
                <div class="project-form-grid">
                  <label class="label">
                    Title
                    <input class="input" name="title" value="${escapeHtml(
                      uiState.draftArtifact.title,
                    )}" placeholder="Build notes" />
                  </label>
                  <label class="label">
                    Language
                    <input class="input" name="language" value="${escapeHtml(
                      uiState.draftArtifact.language,
                    )}" placeholder="markdown" />
                  </label>
                </div>
                <label class="label">
                  Kind
                  <input class="input" name="kind" value="${escapeHtml(
                    uiState.draftArtifact.kind,
                  )}" placeholder="note" />
                </label>
                <label class="label">
                  Content
                  <textarea class="textarea" name="content" placeholder="Paste a plan, code block, or durable output">${escapeHtml(
                    uiState.draftArtifact.content,
                  )}</textarea>
                </label>
                <div class="inline-actions">
                  <button class="small-button is-primary" type="submit">Save artifact</button>
                  <button class="small-button is-outline" type="button" data-action="toggle-artifact-form">
                    Cancel
                  </button>
                  ${
                    project ? `<span class="meta-label">Attached to ${escapeHtml(project.name)}</span>` : ''
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
                        artifact => `
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
                                  ? `<span class="chip">${escapeHtml(
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
                  : '<div class="empty-state compact">No artifacts yet. Code fences from replies will land here automatically.</div>'
              }
            </div>
          </section>

          <section class="surface-card artifact-detail-panel">
            ${
              active
                ? uiState.editingArtifactId === active.id
                  ? `
                    <form class="project-form-card surface-card" data-form="artifact-update">
                      <div class="project-form-grid">
                        <label class="label">
                          Title
                          <input class="input" name="title" value="${escapeHtml(
                            uiState.editingArtifactDraft.title,
                          )}" />
                        </label>
                        <label class="label">
                          Language
                          <input class="input" name="language" value="${escapeHtml(
                            uiState.editingArtifactDraft.language,
                          )}" />
                        </label>
                      </div>
                      <label class="label">
                        Kind
                        <input class="input" name="kind" value="${escapeHtml(
                          uiState.editingArtifactDraft.kind,
                        )}" />
                      </label>
                      <label class="label">
                        Content
                        <textarea class="textarea tall" name="content">${escapeHtml(
                          uiState.editingArtifactDraft.content,
                        )}</textarea>
                      </label>
                      <div class="inline-actions">
                        <button class="small-button is-primary" type="submit">Save changes</button>
                        <button class="small-button is-outline" type="button" data-action="cancel-edit-artifact">
                          Cancel
                        </button>
                      </div>
                    </form>
                  `
                  : `
                    <div class="header-row">
                      <div>
                        <h2 class="pane-title">${escapeHtml(active.title)}</h2>
                        <div class="thread-meta">
                          <span class="chip is-accent">${escapeHtml(active.language)}</span>
                          <span class="chip">${escapeHtml(active.kind)}</span>
                          ${
                            active.projectId
                              ? `<span class="chip">${escapeHtml(
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
                            ? `
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

                    <pre class="code-preview tall" data-copyable-surface><code>${escapeHtml(active.content)}</code></pre>
                  `
                : '<div class="empty-state">Select an artifact to preview it.</div>'
            }
          </section>
        </div>
      </div>
    </section>
  `;
}

function renderSearchBucket(title, itemsHtml, count) {
  return `
    <section class="surface-card search-bucket">
      <div class="search-bucket-header">
        <h2 class="pane-title">${title}</h2>
        <span class="chip">${count}</span>
      </div>
      <div class="search-list">${itemsHtml}</div>
    </section>
  `;
}

function renderSearchResultButton(item) {
  // Workspace file-group rows carry a `hits: [...]` array of per-line hits
  // from `streamWorkspaceContentByFile`.  When we have at least one extra
  // hit beyond the top-scoring line that the group already advertises, we
  // render an expandable sub-list so the user can drill into a specific
  // line without having to open the file first.
  const hasSubHits =
    Array.isArray(item.hits) && item.hits.length > 0 && item.filePath;

  if (!hasSubHits) {
    return `
    <button
      class="search-action-button"
      data-action="open-search-result"
      data-result-id="${escapeHtml(item.id)}"
    >
      <span class="search-action-icon">${searchResultIcon(item)}</span>
      <span class="search-action-copy">
        <span class="search-action-title-row">
          <span class="search-action-title">${escapeHtml(item.title)}</span>
          ${
            item.badge
              ? `<span class="search-action-badge">${escapeHtml(item.badge)}</span>`
              : ''
          }
        </span>
        ${
          item.subtitle
            ? `<span class="search-action-subtitle">${escapeHtml(item.subtitle)}</span>`
            : ''
        }
      </span>
      ${
        item.meta
          ? `<span class="search-action-meta">${escapeHtml(item.meta)}</span>`
          : ''
      }
    </button>
  `;
  }

  const isExpanded = Boolean(uiState.expandedSearchGroups?.[item.filePath]);
  const subHitCount = item.hits.length;
  const expandLabel = isExpanded
    ? `Hide ${subHitCount} match${subHitCount === 1 ? '' : 'es'}`
    : `Show ${subHitCount} match${subHitCount === 1 ? '' : 'es'}`;

  return `
    <div class="search-action-row search-action-row--file-group${
      isExpanded ? ' is-expanded' : ''
    }">
      <div class="search-action-row-head">
        <button
          class="search-action-button search-action-button--grow"
          data-action="open-search-result"
          data-result-id="${escapeHtml(item.id)}"
        >
          <span class="search-action-icon">${searchResultIcon(item)}</span>
          <span class="search-action-copy">
            <span class="search-action-title-row">
              <span class="search-action-title">${escapeHtml(item.title)}</span>
              ${
                item.badge
                  ? `<span class="search-action-badge">${escapeHtml(item.badge)}</span>`
                  : ''
              }
            </span>
            ${
              item.subtitle
                ? `<span class="search-action-subtitle">${escapeHtml(item.subtitle)}</span>`
                : ''
            }
          </span>
          ${
            item.meta
              ? `<span class="search-action-meta">${escapeHtml(item.meta)}</span>`
              : ''
          }
        </button>
        <button
          type="button"
          class="search-action-expand"
          data-action="toggle-search-group-hits"
          data-file-path="${escapeHtml(item.filePath)}"
          aria-expanded="${isExpanded ? 'true' : 'false'}"
          title="${escapeHtml(expandLabel)}"
        >
          <span class="search-action-expand-chip">${subHitCount}</span>
          <span class="search-action-expand-caret">${isExpanded ? '▾' : '▸'}</span>
        </button>
      </div>
      ${
        isExpanded
          ? `<div class="search-action-sublist" role="list">${item.hits
              .map(hit => renderSearchResultSubHit(item, hit))
              .join('')}</div>`
          : ''
      }
    </div>
  `;
}

// Render a single per-line hit underneath an expanded file-group row.
// Clicking a sub-hit directly opens the file at that specific line (it
// ignores the group's own top-scoring line in favour of the line the user
// actually clicked).  We avoid injecting these into `currentSearchItems`
// because they are drill-downs, not independently rankable results — the
// click boost is credited to the parent group.
function renderSearchResultSubHit(parent, hit) {
  const rawLine = Number(hit?.lineNumber) || 0;
  const previewText = hit?.lineText || hit?.subtitle || '';
  const preview = truncate(String(previewText).trim(), 160);
  return `
    <button
      type="button"
      class="search-action-subhit"
      role="listitem"
      data-action="open-file-match-line"
      data-file-path="${escapeHtml(parent.filePath)}"
      data-line-number="${rawLine}"
      data-parent-result-id="${escapeHtml(parent.id)}"
    >
      <span class="search-action-subhit-line">L${rawLine || '?'}</span>
      <span class="search-action-subhit-text">${escapeHtml(preview)}</span>
    </button>
  `;
}

function renderSearchPage() {
  const query = uiState.searchQuery.trim();
  const buckets = searchBucketsForRender();
  const activeResults = currentSearchItems();
  const total = activeResults.length;
  const functionCount = activeResults.filter(item =>
    ['feature', 'skill', 'connector'].includes(item.kind),
  ).length;
  const chatCount = activeResults.filter(
    item => item.kind === 'chat-thread' || item.kind === 'chat-hit',
  ).length;

  return `
    <section class="page search-page">
      <div class="search-stage">
        <div class="search-panel">
          <div class="search-panel-header">
            <span class="search-panel-icon">${icon.search}</span>
            <input
              class="search-input search-panel-input"
              id="global-search"
              type="search"
              value="${escapeHtml(uiState.searchQuery)}"
              placeholder="Search chats, features, projects, artifacts, and files"
            />
            <button
              class="search-clear-button"
              type="button"
              data-action="clear-search-query"
              title="Clear search"
            >
              ×
            </button>
          </div>

          <div class="search-panel-body">
            <div class="search-panel-meta">
              ${
                query
                  ? `
                    <span class="chip">${total} result${total === 1 ? '' : 's'}</span>
                    <span class="chip">${functionCount} functions</span>
                    <span class="chip">${chatCount} chat matches</span>
                  `
                  : '<span class="meta-label">Search everything in Melo with fuzzy matching.</span>'
              }
              ${
                uiState.searchLoading
                  ? '<span class="meta-label">Refreshing…</span>'
                  : ''
              }
              ${
                uiState.searchFileLoading
                  ? '<span class="meta-label">Searching files…</span>'
                  : ''
              }
            </div>

            ${
              total
                ? `
                  <div class="search-buckets">
                    ${buckets
                      .map(bucket =>
                        renderSearchBucket(
                          bucket.title,
                          bucket.items.map(renderSearchResultButton).join(''),
                          bucket.items.length,
                        ),
                      )
                      .join('')}
                  </div>
                `
                : query
                  ? `<div class="empty-state">
                      <div class="empty-state-title">No matches for "${escapeHtml(query)}".</div>
                      <div class="empty-state-meta">
                        Search covers <strong>chats &amp; messages</strong>,
                        <strong>prompt history</strong>,
                        <strong>memory</strong>,
                        <strong>artifacts</strong>,
                        <strong>projects</strong>,
                        <strong>skills / connectors</strong>, and
                        <strong>workspace files</strong>. Try simpler keywords, an exact phrase, or check spelling.
                      </div>
                    </div>`
                  : `<div class="empty-state">
                      <div class="empty-state-title">Start typing to search.</div>
                      <div class="empty-state-meta">
                        Looks across chats, messages, memory, artifacts, projects, and workspace files.
                        A file path, a project name, or a phrase you remember from a past chat all work.
                      </div>
                    </div>`
            }
          </div>
        </div>
      </div>
    </section>
  `;
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

  return `
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
                    (command, index) => `
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
  const { requestId, toolId, args } = pending[0];

  const argsText = args && Object.keys(args).length
    ? JSON.stringify(args, null, 2)
    : '(no arguments)';

  return `
    <div class="tool-permission-backdrop" role="dialog" aria-modal="true" aria-label="Tool permission request">
      <div class="tool-permission-shell">
        <div class="tool-permission-header">
          <span class="tool-permission-icon">${icon.chip}</span>
          <div>
            <div class="tool-permission-title">Tool Permission Request</div>
            <div class="tool-permission-subtitle">Melo wants to run a tool</div>
          </div>
        </div>
        <div class="tool-permission-body">
          <div class="tool-permission-tool-name">${escapeHtml(toolId)}</div>
          <pre class="tool-permission-args">${escapeHtml(argsText)}</pre>
        </div>
        <div class="tool-permission-footer">
          <div class="inline-actions">
            <button class="small-button is-primary"
              data-action="tool-permission-allow-once"
              data-request-id="${escapeHtml(requestId)}"
              data-tool-id="${escapeHtml(toolId)}">
              Allow once
            </button>
            <button class="small-button"
              data-action="tool-permission-allow-session"
              data-request-id="${escapeHtml(requestId)}"
              data-tool-id="${escapeHtml(toolId)}">
              Always allow
            </button>
            <button class="small-button"
              data-action="tool-permission-deny"
              data-request-id="${escapeHtml(requestId)}"
              data-tool-id="${escapeHtml(toolId)}">
              Deny
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ─── Tool call status strip (shown while tool is executing) ───────────────────

function renderActiveToolCallsStrip() {
  const calls = uiState.activeToolCalls;
  if (!calls.length) return '';

  return `
    <div class="tool-calls-strip">
      ${calls.map(call => `
        <div class="tool-call-pill ${call.status === 'running' ? 'is-running' : call.status === 'ok' ? 'is-ok' : 'is-error'}">
          <span class="tool-call-pill-icon">${icon.terminal}</span>
          <span class="tool-call-pill-name">${escapeHtml(call.name)}</span>
          ${call.status === 'running' ? '<span class="tool-call-spinner"></span>' : ''}
          ${call.status === 'ok' ? '<span class="tool-call-check">✓</span>' : ''}
          ${call.status === 'error' ? '<span class="tool-call-x">✗</span>' : ''}
        </div>
      `).join('')}
    </div>
  `;
}

// ─── Tool permission handlers ─────────────────────────────────────────────────

async function handleToolPermissionResponse(requestId, toolId, granted, scope) {
  // Optimistically remove from queue
  uiState.pendingToolPermissions = uiState.pendingToolPermissions.filter(
    p => p.requestId !== requestId,
  );
  render();

  try {
    await api('/api/tools/permission-response', {
      method: 'POST',
      body: { requestId, granted, scope, toolId },
    });
  } catch (err) {
    // Non-fatal — server already resolved or timed out
    if (process?.env?.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn('permission-response failed:', err.message);
    }
  }
}

function _positionAgentDropdown() {
  const chip = document.querySelector('[data-action="toggle-agent-selector"]');
  const dropdown = document.querySelector('.agent-selector-dropdown');
  if (!chip || !dropdown) return;
  const chipRect = chip.getBoundingClientRect();
  const dropH = dropdown.offsetHeight;
  // Center of dropdown aligns with center of chip
  const top = chipRect.top + chipRect.height / 2 - dropH / 2;
  const left = chipRect.right + 10;
  dropdown.style.top = top + 'px';
  dropdown.style.left = left + 'px';
}

// Generic scroll preservation: any nested scrollable pane that isn't already
// covered by a dedicated capture/restore path would reset to 0 whenever
// render() rewrites the DOM — including the 4-second agent runtime refresh.
// This walks known scrollable selectors and saves scrollTop keyed by position
// within the DOM, so the same instance can be found again after re-render.
const _PRESERVED_SCROLL_SELECTORS = [
  '.customize-pane',
  '.search-panel-body',
  '.search-results-stream',
  '.agent-list-pane',
  '.agent-detail-column',
];

function captureScrollPositions() {
  const map = new Map();
  _PRESERVED_SCROLL_SELECTORS.forEach(selector => {
    document.querySelectorAll(selector).forEach((el, index) => {
      if (!(el instanceof HTMLElement)) return;
      if (el.scrollTop > 0) {
        map.set(`${selector}::${index}`, el.scrollTop);
      }
    });
  });
  return map;
}

function restoreScrollPositions(map) {
  if (!map || map.size === 0) return;
  map.forEach((scrollTop, key) => {
    const [selector, indexStr] = key.split('::');
    const elements = document.querySelectorAll(selector);
    const target = elements[Number(indexStr)];
    if (target instanceof HTMLElement) {
      target.scrollTop = scrollTop;
    }
  });
}

// ── Named textarea scroll preservation ───────────────────────────────────────
// captureFocusedInputState only saves scrollTop for the ACTIVELY focused
// element. But users also scroll around textareas they haven't clicked into —
// e.g. reading the Voice personality text, the system prompt, the connector
// description — and a background render that fires while their cursor is
// outside the textarea (3s autosave resolving, 4s runtime poll, toast timer,
// etc.) used to yank the textarea's scrollTop back to 0, because
// app.innerHTML swap creates a brand-new DOM node with no scroll history.
//
// This pair covers ALL <textarea name="..."> elements inside <form id="...">,
// keyed by (formId, name) — the same stable identity pair we use for focus
// restore. Inputs (type=text etc.) don't have a visible scrollTop so they're
// skipped. The agent-content-editor textarea (IDENTITY.md) also has its own
// dedicated capture via captureAgentEditorState; this generic path is a
// cheap safety net that catches every OTHER named textarea in the app.
function captureFormTextareaScrolls() {
  const map = new Map();
  document.querySelectorAll('form[id] textarea[name]').forEach(el => {
    if (!(el instanceof HTMLTextAreaElement)) return;
    if (el.scrollTop <= 0) return;
    const form = el.form;
    if (!form || !form.id || !el.name) return;
    map.set(`${form.id}::${el.name}`, el.scrollTop);
  });
  return map;
}

function restoreFormTextareaScrolls(map) {
  if (!map || map.size === 0) return;
  map.forEach((scrollTop, key) => {
    const sep = key.indexOf('::');
    if (sep < 0) return;
    const formId = key.slice(0, sep);
    const name = key.slice(sep + 2);
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;
    const el = form.elements.namedItem(name);
    if (el instanceof HTMLTextAreaElement) {
      el.scrollTop = scrollTop;
    }
  });
}

// ── Thread anchor: scroll preservation that survives async viz hydration ──
// Why this exists: render() saves scrollTop before the innerHTML swap and
// restores it afterward. That's fine for simple text content, but Demon viz
// cards hydrate asynchronously — scene3d canvases mount on the microtask
// queue (or later, for the lazy globe-flight), and when they take a layout
// slot the content ABOVE the user's viewport grows by hundreds of pixels.
// The restored scrollTop is then pointing at the wrong content. The user
// sees their scroll "jump" to a different viz card.
//
// Capturing an anchor by DOM element (message-id) instead of scrollTop
// lets us correct for layout shift after the async hydration completes.

// Snapshot the anchor: whatever .message article is closest to (but not
// past) the top of the viewport, its messageId, and its y-offset within
// the viewport. We also record the autoFollow flag — if the user was
// pinned to the bottom we should stay pinned, not anchor.
function captureThreadAnchor(scroller) {
  if (!(scroller instanceof HTMLElement)) return null;
  const scrollerRect = scroller.getBoundingClientRect();
  // Auto-follow threshold — if the user is within 24px of the bottom, skip
  // anchoring entirely. syncThreadViewport already handles that case.
  const distanceFromBottom =
    scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
  if (distanceFromBottom < 24) return null;
  const messages = scroller.querySelectorAll('.message[data-message-id]');
  let bestId = null;
  let bestOffsetFromScrollerTop = Infinity;
  for (const el of messages) {
    if (!(el instanceof HTMLElement)) continue;
    const r = el.getBoundingClientRect();
    // Distance from scroller-top to message-top (negative if above viewport).
    const delta = r.top - scrollerRect.top;
    // Prefer the first message whose TOP is at or below the scroller top
    // (i.e. the first one partially visible). If none exist (user is above
    // the first message), fall back to the message with the smallest
    // positive delta that we've seen.
    if (delta >= 0 && delta < bestOffsetFromScrollerTop) {
      bestId = el.dataset.messageId;
      bestOffsetFromScrollerTop = delta;
      break;
    }
  }
  if (!bestId) return null;
  return { messageId: bestId, viewportOffset: bestOffsetFromScrollerTop };
}

// Restore by anchor: find the element with the same messageId, measure its
// new y-offset, and shift scrollTop so the element is back at the original
// viewport offset. Idempotent — can be called multiple times as async viz
// cards hydrate and re-grow the layout.
function restoreThreadAnchor(anchor) {
  if (!anchor || !anchor.messageId) return false;
  const scroller = document.querySelector('.thread-scroll-region');
  if (!(scroller instanceof HTMLElement)) return false;
  const el = scroller.querySelector(
    `.message[data-message-id="${String(anchor.messageId).replace(/"/g, '')}"]`,
  );
  if (!(el instanceof HTMLElement)) return false;
  const scrollerRect = scroller.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const currentOffset = elRect.top - scrollerRect.top;
  const correction = currentOffset - anchor.viewportOffset;
  // Small delta — don't bother; also avoids thrashing when we're already stable.
  if (Math.abs(correction) < 1) return true;
  scroller.scrollTop += correction;
  return true;
}

function render({ background = false } = {}) {
  if (uiState.loading && !uiState.bootstrap) {
    app.innerHTML = '<div class="loading-state">Launching Melo Desktop...</div>';
    return;
  }

  if (!uiState.bootstrap) {
    app.innerHTML = '<div class="loading-state">Unable to load Melo Desktop.</div>';
    return;
  }

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
  const _vizAnchor = _threadScroller instanceof HTMLElement
    ? captureThreadAnchor(_threadScroller)
    : null;
  uiState.pendingVizAnchor = _vizAnchor;

  // Compute whether thread content will change this render — if the signature matches the
  // last rendered signature it's a UI-only render (voice panel, checkbox, etc.) and we must
  // restore the thread scroll manually (syncThreadViewport returns early for same-signature).
  // If the signature differs, syncThreadViewport will scroll the thread; don't interfere.
  const _chat = activeChat();
  const _threadSig = _chat
    ? `${_chat.id}:${_chat.messages.length}:${_chat.updatedAt || ''}:${
        uiState.highlightedMessageId || ''
      }:${uiState.streamingChatId === _chat.id ? uiState.streamingAssistantText.length : 0}:${
        uiState.sending && uiState.streamingChatId === _chat.id ? 1 : 0
      }`
    : '';
  const _threadContentUnchanged = _threadSig === uiState.lastThreadScrollSignature;

  app.innerHTML = `
    <div class="shell">
      ${renderSidebar()}
      <div class="workspace">
        ${renderTopbar()}
        <div class="content-shell">
          <main class="content-scroll">${renderPage()}</main>
          <div class="content-scrollbar" aria-hidden="true">
            <div class="content-scrollbar-thumb"></div>
          </div>
        </div>
      </div>
    </div>
    <input id="composer-attachment-input" class="hidden-file-input" type="file" multiple />
    ${renderCommandPalette()}
    ${renderEditContextMenu()}
    ${renderCopyContextMenu()}
    ${renderRecentContextMenu()}
    ${renderAudioContextMenu()}
    ${renderToolPermissionDialog()}
    ${uiState.error ? `<div class="toast">${escapeHtml(uiState.error)}</div>` : ''}
  `;

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
  // innerHTML rebuild. Runs AFTER restoreAgentEditorState so the agent-specific
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
  if (autoFollowChanged) {
    render();
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
      updateThreadAutoFollow(scroller);
      syncContentScrollbar({ forceVisible: true });
    },
    { passive: true },
  );

  scroller.addEventListener(
    'wheel',
    () => {
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

document.addEventListener('click', async event => {
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

  const trigger = event.target.closest('[data-action]');
  if (!trigger || !uiState.bootstrap) {
    if (closedAttachmentMenu) {
      render();
    }
    return;
  }

  const action = trigger.dataset.action;

  try {
    switch (action) {
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
            chat?.projectId || uiState.bootstrap.settings.selectedProjectId,
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
      case 'toggle-project-form':
        uiState.showProjectForm = !uiState.showProjectForm;
        render();
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
      case 'refresh-memory-status':
        // Reset cache so re-opening the panel forces a fresh collect.
        uiState.memoryStatus.loaded = false;
        await refreshMemoryStatus();
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
                render();
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
      case 'set-agent-mood': {
        const agentId = trigger.dataset.agentId;
        const draftKey = agentDraftKey(agentId);
        uiState.agentDrafts[draftKey] = {
          ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
          mood: trigger.dataset.mood,
        };
        render();
        break;
      }
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
        const draftKey = agentDraftKey(agentId);
        const currentDraft = {
          ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
        };
        const currentIds = Array.isArray(currentDraft.enabledMcpServerIds)
          ? new Set(currentDraft.enabledMcpServerIds)
          : new Set();
        if (currentIds.has(mcpServerId)) {
          currentIds.delete(mcpServerId);
        } else if (!presetEnabled) {
          showFlashToast(`"${mcpServerId}" is disabled globally — enable in Advanced first.`);
          break;
        } else {
          currentIds.add(mcpServerId);
        }
        currentDraft.enabledMcpServerIds = [...currentIds];
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
      case 'open-artifact':
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
      case 'tool-permission-allow-session':
        await handleToolPermissionResponse(
          trigger.dataset.requestId,
          trigger.dataset.toolId,
          true,
          'session',
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
      case 'set-task-status':
        await handleUpdateTaskStatus(trigger.dataset.taskId, trigger.dataset.status);
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
      case 'toggle-demon-mode':
        uiState.demonMode = !uiState.demonMode;
        localStorage.setItem('melo-demon-mode', uiState.demonMode ? '1' : '0');
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
        // Switching to explicit API voice clears any custom provider (Edge TTS etc.)
        if (uiState.ttsEngine === 'api') {
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
          body: { ttsProvider: 'minimax', minimaxVoiceId: voiceId },
        }).then(payload => applyBootstrapPreservingDrafts(payload)).catch(() => {});
        render();
        break;
      }
      case 'toggle-agent-selector': {
        uiState.agentSelectorOpen = !uiState.agentSelectorOpen;
        render();
        break;
      }
      case 'select-chat-agent': {
        const agentId = trigger.dataset.agentId;
        if (agentId) {
          uiState.activeChatAgentId = agentId;
          localStorage.setItem('melo-active-chat-agent', agentId);
        }
        uiState.agentSelectorOpen = false;
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
      scheduleAgentChannelAutosave(agentId);
      return;
    }

    // voiceReplyMode / edgeTtsVoice / voicePersonality are agent-level fields
    // edited on the Telegram panel. Persist them through the same channel
    // autosave pipeline so they don't get lost when applyBootstrap() clears
    // agent drafts.
    if (['voiceReplyMode', 'edgeTtsVoice', 'voicePersonality'].includes(target.name)) {
      mergeAgentDraft(agentId, {
        [target.name]: target.value,
      });
      scheduleAgentChannelAutosave(agentId);
      return;
    }

    const nextDraft = mergeAgentDraft(agentId, {
      [target.name]: target.value,
    });
    if (target.name === 'identity') {
      nextDraft.identify = target.value;
      captureAgentEditorState();
      scheduleAgentMarkdownAutosave(agentId);
    } else if (target.name === 'soul.md') {
      captureAgentEditorState();
      scheduleAgentMarkdownAutosave(agentId);
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
  if (
    !(
      target instanceof HTMLSelectElement ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    )
  ) {
    return;
  }

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
        body: { minimaxVoiceId: target.value },
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
      fallbackDraft: effectiveModelSetupDraft(),
      modelDefaultsForAuthMode,
    });
    if (draftDispatch) {
      uiState.modelSetupDraft = draftDispatch.nextDraft;
      if (draftDispatch.shouldRender) render();
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
        scheduleAgentChannelAutosave(agentId);
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
        scheduleAgentChannelAutosave(agentId);
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
        scheduleAgentChannelAutosave(agentId);
        return;
      }

      // voiceReplyMode / edgeTtsVoice / voicePersonality are agent-level (not
      // channel-level) but the user edits them on the Telegram panel next to
      // the channel toggles. Route them through the channel autosave so they
      // persist on change without requiring the user to hit a separate save
      // button.
      if (['voiceReplyMode', 'edgeTtsVoice', 'voicePersonality'].includes(target.name)) {
        mergeAgentDraft(agentId, {
          [target.name]: target.value,
        });
        scheduleAgentChannelAutosave(agentId);
        render();
        return;
      }

      const nextDraft = mergeAgentDraft(agentId, {
        [target.name]: target.value,
      });
      if (target.name === 'identity') {
        nextDraft.identify = target.value;
      }
      render();
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
      case 'agent-profile-update':
        await handleUpdateAgentProfile(form);
        break;
      case 'connector-config':
        await handleSaveConnectorConfig(form);
        break;
      case 'model-config':
        await handleSaveConnectorConfig(form);
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
    showError(error.message);
  }
});

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
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing &&
    !uiState.commandPalette.open
  ) {
    event.preventDefault();
    await handleSendMessage();
    return;
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
