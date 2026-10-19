// Chat feature state (architecture plan P2c, 2026-10-19). Owned by this
// feature: app.js neither reads nor writes it (it asks the handle, e.g.
// isSending(), composerText()). Field names and initial values are the ones
// the moved code used on uiState, so `git log -L` / blame stay readable.
// Fields app.js used to create on first use start from an equivalent empty
// value. The bootstrap, the new-chat selection, the model picker, the tool
// permission queue and the TTS state stay in app.js (features/README.md).
import { voiceInputSupported } from '../../voiceInput.js';

export function createChatState() {
  return {
    // The running reply: one at a time across all chats.
    sending: false,
    sendAbortController: null,
    activeTurn: null,
    thinkingSince: 0,
    // Streaming bubble of the running reply (renderStreamingFast patches it in place).
    streamingChatId: null,
    streamingAssistantText: '',
    // activeToolCalls: array of { id, name, arguments, status:'running'|'ok'|'error', output? }
    activeToolCalls: [],
    // Supplements typed while a reply runs: delivered to the server
    // (supplementsSent) or kept for the next message (supplementsAfterTurn).
    supplementsSent: [],
    supplementsAfterTurn: [],
    // { requestId, chatId, key, interrupted } of a failed send: an unchanged
    // resend in the same chat reuses the request id (sendRecovery).
    composerRetry: null,
    // The composer draft (one draft; the chat it is sent to is decided at send time).
    composer: '',
    composerHistoryIndex: -1,
    composerHistoryDraft: '',
    // Phase 3.3.3 — slash-command palette for the composer. Shown when the
    // composer value starts with "/<query>". Lists enabled skills whose id
    // or name matches the query; clicking an entry inserts "/<skill-id> "
    // into the composer so the user can keep typing arguments.
    slashPalette: {
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
    composerDragActive: false,
    // File name of a video being uploaded before it can be sent.
    attachmentUploading: null,
    // Pending voice transcript to be pre-attached when auto-submitting a voice message.
    // Set to null when not in a voice-submit flow.
    composerVoiceTranscript: null,
    // Stable id linking the voice audio attachment to its prefilled transcript
    // entry. describeAudioExtractionStatus matches transcript→attachment by id,
    // so without this the just-transcribed voice message would mis-render as
    // "transcript unavailable" (2026-05-23 Codex C 闭环).
    composerVoiceAttachmentId: null,
    // Chat-side Agent picker.
    agentSelectorOpen: false,
    agentSelectionSaving: false,
    // Thread: highlighted search hit, per-chat "load earlier" expansion of the
    // message render window (chatId → extra messages beyond
    // THREAD_RENDER_WINDOW; see threadWindow.js), the viewport signature and
    // auto-follow, and the position restored after re-renders.
    highlightedMessageId: null,
    threadWindow: {},
    lastThreadScrollSignature: '',
    lastThreadChatId: null,
    threadAutoFollow: true,
    lastKnownScrollTop: 0,
    // Anchor captured before the page update so viz cards' async hydration
    // doesn't pull the user's viewport away from the message they were
    // reading. { messageId, viewportOffset } — see captureThreadBeforeRender().
    pendingVizAnchor: null,
    // Chat files panel and saved video notes (attachment id → true).
    chatFilesOpen: false,
    savedVideoKnowledge: {},
  };
}

// Live binding: importers always see the current object.
export let chatState = createChatState();

export function resetChatState() {
  chatState = createChatState();
  return chatState;
}
