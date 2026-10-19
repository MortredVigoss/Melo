// Chat feature controller (architecture plan P2c, 2026-10-19): the composer
// (draft, prompt history, slash palette, attachments and drag-and-drop, voice
// input), the send pipeline (optimistic user message, /api/chat/send/stream
// with its SSE events, supplements while a reply runs, stop / abort, retry
// identity, reply delivery to TTS), chat creation, the chat-side Agent
// picker, thread navigation and viewport (auto-follow, scroll signature,
// "加载更早", jump-to-latest), message actions and the chat files panel.
// Moved out of desktop-ui/app.js byte-for-byte. See features/README.md.
import { t } from '../../i18n.js';
import { expandThreadWindow } from '../../threadWindow.js';
import { videoExtraction, videoKnowledgeNote } from '../../videoKnowledge.js';
import { attachmentLimit, makeTransferCopy, uploadVideoFile, MB } from '../../transferCopy.js';
import { consumeImageTask, restoreImageTask } from '../../imageControls.js';
import { createReplyDelivery, receiveReplyDelivery } from '../../replyDelivery.js';
import { createTurnPresentation, receiveTurnPresentation } from '../../turnPresentation.js';
import { createVoiceInput, voiceInputActive } from '../../voiceInput.js';
import { modelPanelPosition } from '../../modelPresentation.js';
import { collectTeamPlan } from '../../teamPanel.js';
import { streamApi } from './api.js';
import { renderStreamingFast, patchLiveRunSteps } from './viewThread.js';
import { bindChatContext, uiState, app, api, render, bgRender, showError, applyBootstrap, applyBootstrapPreservingDrafts, loadBootstrap, activeChat, allChatAgentProfiles, truncate, icon, handleComposerCommand, handleSpeakMessage, handleDeleteChat, captureThreadAnchor, restoreThreadAnchor, stopCurrentTts, _isTtsActive, _streamTts, _streamTtsStart, _streamTtsPushChunk, _streamTtsOnToolCall, _streamTtsReset, _streamTtsFlush, notifyLocalCompletion, shouldSendOnEnter, receiveExecutionScene, cancelLiveScene, promoteTextUrlsToAttachments } from './context.js';

// Binds the context. app.js calls this once at startup (through ./index.js).
export function installChatController(context) {
  bindChatContext(context);
}

function isAbortError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error.name === 'AbortError' || error.code === 'ABORT_ERR'),
  );
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

function voiceBridgeSupported() {
  return Boolean(globalThis.webkit?.messageHandlers?.meloVoice);
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

let composerResizeObserver;
let observedComposer;
let observedComposerWidth = 0;

function syncComposerTextareaHeight() {
  const composer = document.querySelector('#composer');
  if (composer !== observedComposer) {
    composerResizeObserver?.disconnect();
    observedComposer = composer;
    observedComposerWidth = composer?.clientWidth || 0;
    if (composer && typeof ResizeObserver !== 'undefined') {
      composerResizeObserver ||= new ResizeObserver(entries => {
        if (entries[0]?.target !== observedComposer) return;
        const width = observedComposer.clientWidth;
        if (width === observedComposerWidth) return;
        observedComposerWidth = width;
        syncComposerTextareaHeight();
      });
      composerResizeObserver.observe(composer);
    }
  }
  if (!(composer instanceof HTMLTextAreaElement)) {
    return;
  }

  const computedStyle = window.getComputedStyle(composer);
  const minHeight = Number.parseFloat(computedStyle.minHeight) || 48;
  const maxHeight = Number.parseFloat(computedStyle.maxHeight) || 88;
  const scrollTop = composer.scrollTop;

  composer.style.height = 'auto';
  const contentHeight = composer.scrollHeight;
  const nextHeight = Math.min(maxHeight, Math.max(minHeight, contentHeight));
  composer.style.height = `${nextHeight}px`;
  composer.style.overflowY = contentHeight > maxHeight + 1 ? 'auto' : 'hidden';
  composer.scrollTop = scrollTop;
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
    const kind = detectAttachmentKindFromFile(file);
    if (!kind) {
      showError(`${file.name} is not supported yet. Add images, video, audio, or PDF files here.`);
      continue;
    }
    // Photos up to 100 MB are sent as a bounded copy; videos up to 500 MB are uploaded as a file; other files keep 20 MB.
    const limit = kind === 'image' || kind === 'video' ? attachmentLimit(kind) : 20 * MB;
    if (file.size > limit) {
      showError(t('{name} 超过 {limit} MB，未添加。', { name: file.name, limit: limit / MB }));
      continue;
    }
    const copy = kind === 'image' ? await makeTransferCopy(file).catch(() => null) : null;
    let url = copy?.url;
    if (kind === 'video') {
      uiState.attachmentUploading = file.name; render();
      try { url = (await uploadVideoFile(file)).url; }
      catch (error) { showError(t('{name} 上传失败：{reason}', { name: file.name, reason: error.message })); continue; }
      finally { uiState.attachmentUploading = null; }
    }
    url ||= await readFileAsDataUrl(file);
    nextAttachments.push({
      id: crypto.randomUUID(),
      kind,
      url,
      title: file.name,
      fileName: file.name,
      mimeType: copy?.mimeType || file.type || (isPdfFile(file) ? 'application/pdf' : ''),
      sizeLabel: copy ? t('{size} · 发送 {width}×{height} 副本', { size: formatFileSize(file.size), width: copy.width, height: copy.height }) : formatFileSize(file.size),
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
  stopCurrentTts();
  voiceInput.start(uiState.voiceLanguage || 'zh-CN');
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

// A supplement for the reply running in this chat. The server adds it before the
// next model step; if the turn has no further step it comes back and is sent next.
async function sendSupplement(chatId, text) {
  uiState.composer = '';
  try {
    const response = await fetch('/api/chat/supplement', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId, content: text }) });
    if (response.ok) (uiState.supplementsSent ||= []).push(text);
    else (uiState.supplementsAfterTurn ||= []).push(text);
  } catch { (uiState.supplementsAfterTurn ||= []).push(text); }
  // The turn may have ended while the request was in flight: send it as the next message now.
  if (!uiState.sending && uiState.supplementsAfterTurn?.length) {
    const queued = uiState.supplementsAfterTurn.splice(0);
    uiState.supplementsSent = [];
    await handleSendMessage({ chatId, content: queued.join('\n') });
    return;
  }
  render();
}

async function handleSendMessage(prepared = null) {
  if (!prepared && uiState.sending && !voiceInputActive(uiState.voice) && uiState.composer.trim() && uiState.streamingChatId && uiState.streamingChatId === activeChat()?.id) {
    await sendSupplement(uiState.streamingChatId, uiState.composer.trim());
    return;
  }
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
        if (message.event === 'execution_scene') { receiveExecutionScene(message.payload?.scene); patchLiveRunSteps(message.payload?.scene?.chatId); }
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
              if (Number.isFinite(r.durationMs)) existing.durationMs = r.durationMs;
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
    if (result?.unusedSupplements?.length) (uiState.supplementsAfterTurn ||= []).push(...result.unusedSupplements);
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
      // Bug audit U4: no more scene events arrive after Stop — finish the
      // run's scene locally and re-read scenes + chat once the server has
      // persisted its cancelled scene and the [工具轨迹] message.
      cancelLiveScene(uiState.activeTurn?.runId || null, { chatId });
      for (const delay of [800, 2500]) setTimeout(() => { if (!uiState.sending) loadBootstrap(uiState.searchQuery, { quiet: true }).catch(() => {}); }, delay);
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
    // Supplements the turn could not use are sent as the next message of the same chat.
    // A stopped or failed turn returns every supplement to the composer instead of dropping it.
    const followUp = sendSucceeded ? (uiState.supplementsAfterTurn || []) : [];
    const returned = sendSucceeded ? [] : [...(uiState.supplementsSent || []), ...(uiState.supplementsAfterTurn || [])];
    uiState.supplementsSent = [];
    uiState.supplementsAfterTurn = [];
    if (returned.length) uiState.composer = [uiState.composer.trim(), ...returned.map(text => t('补充：{text}', { text }))].filter(Boolean).join('\n');
    if (followUp.length && chatId) setTimeout(() => handleSendMessage({ chatId, content: followUp.join('\n') }), 0);
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

function retryMissingImages({ chatId, query, task }) {
  if (uiState.sending || chatId !== uiState.bootstrap?.settings?.selectedChatId || !task?.retryOf) return;
  handleSendMessage({ chatId, content: query || '继续图片任务', imageTask: task });
}

// Click actions (formerly `case` branches of app.js's click dispatch),
// registered once by app.js through the feature registry.
export const chatActions = {
  'delete-active-chat': async () => {
    if(activeChat()) await handleDeleteChat(activeChat().id);
  },
  'restart-interrupted-send': async () => {
    uiState.composerRetry = null;
    await handleSendMessage();
  },
  'stop-send': () => {
    handleStopSending();
  },
  'save-video-knowledge': async ({ trigger }) => {
    const message = activeChat()?.messages?.find(m => m.id === trigger.dataset.messageId);
    const attachment = message?.attachments?.find(a => a.id === trigger.dataset.attachmentId);
    const entry = message && attachment ? videoExtraction(message, attachment) : null;
    if (!entry) { showError(t('这段视频还没有处理结果。')); return; }
    try { applyBootstrap(await api('/api/artifacts', { method: 'POST', body: { ...videoKnowledgeNote(attachment, entry), projectId: activeChat()?.projectId || null } })); (uiState.savedVideoKnowledge ||= {})[attachment.id] = true; render(); }
    catch (error) { showError(error.message); }
  },
  'thread-load-earlier': () => {
    // Long-thread render window: reveal the next 60 older messages. The
    // thread signature (chat id / length / updatedAt) does not change, so
    // render() restores the raw scrollTop — which would now point INTO
    // the freshly inserted older content. Anchor on the first visible
    // message instead (same helpers as the viz-hydration path) and shift
    // scrollTop by the height the new content added above it; fall back
    // to a plain scrollHeight delta when no anchor is available (e.g.
    // the scroller was within the auto-follow threshold of the bottom).
    const chat = activeChat();
    if (!chat) return;
    const scroller = document.querySelector('.thread-scroll-region');
    const anchor = scroller instanceof HTMLElement ? captureThreadAnchor(scroller) : null;
    const previousHeight = scroller instanceof HTMLElement ? scroller.scrollHeight : 0;
    const previousTop = scroller instanceof HTMLElement ? scroller.scrollTop : 0;
    uiState.threadWindow ||= {};
    expandThreadWindow(uiState.threadWindow, chat.id, 60);
    render();
    const nextScroller = document.querySelector('.thread-scroll-region');
    if (nextScroller instanceof HTMLElement) {
      if (!(anchor && restoreThreadAnchor(anchor))) {
        nextScroller.scrollTop = previousTop + (nextScroller.scrollHeight - previousHeight);
      }
      uiState.lastKnownScrollTop = nextScroller.scrollTop;
      // Viz cards (if any) hydrate async and grow above the viewport —
      // re-pin once the frame after the swap settles.
      if (anchor) requestAnimationFrame(() => restoreThreadAnchor(anchor));
    }
  },
  'scroll-thread-to-bottom': () => {
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
  },
  'pick-slash-skill': ({ trigger }) => {
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
  },
  'run-chat-team': async ({ trigger }) => {
    const chat=activeChat(), content=uiState.composer.trim();
    if(!content) {showError(t('请先在输入框写下团队任务。'));return;}
    const team=collectTeamPlan(trigger.closest('[data-team-scope]'));
    if(team.error) {showError(t(team.error));return;}
    await handleSendMessage({chatId:chat?.id,content,teamPlan:team.plan});
  },
  'toggle-composer-attachment-menu': () => {
    uiState.composerAttachmentMenuOpen = !uiState.composerAttachmentMenuOpen;
    render();
  },
  'pick-composer-attachment': ({ trigger }) => {
    openComposerAttachmentPicker(trigger.dataset.accept || 'image/*,video/*,audio/*');
  },
  'add-link-attachment': () => {
    promptComposerLinkAttachment();
  },
  'remove-composer-attachment': ({ trigger }) => {
    uiState.composerAttachments = uiState.composerAttachments.filter(
      attachment => attachment.id !== trigger.dataset.attachmentId,
    );
    render();
  },
  'cancel-voice-input': () => {
    voiceInput.cancel();
  },
  'toggle-voice-input': () => {
    toggleVoiceInput();
  },
  'speak-message': async ({ trigger }) => {
    await handleSpeakMessage(trigger);
  },
  'toggle-agent-selector': () => {
    uiState.agentSelectorOpen = !uiState.agentSelectorOpen;
    render();
    if (uiState.agentSelectorOpen) document.querySelector('.agent-selector-row.is-selected')?.focus({ preventScroll: true });
  },
  'select-chat-agent': async ({ trigger }) => {
    const agentId = trigger.dataset.agentId;
    // Allowed during a reply: the running turn keeps the Agent it started with; this applies next.
    if (uiState.agentSelectionSaving || !allChatAgentProfiles().some(a=>a.id===agentId)) return;
    const chat = !uiState.neuralOverview ? activeChat() : null;
    uiState.agentSelectionSaving=true; render();
    try {
      if(chat) applyBootstrapPreservingDrafts(await api('/api/chats/update',{method:'POST',body:{chatId:chat.id,patch:{agentId}}}));
      else {uiState.activeChatAgentId=agentId;localStorage.setItem('melo-active-chat-agent',agentId);}
      uiState.agentSelectorOpen=false;
    } finally {uiState.agentSelectionSaving=false;render();}
  },
};

// Form submits (formerly `case` branches of app.js's submit listener).
export const chatForms = {
  'composer': async () => {
    await handleSendMessage();
  },
};

// app.js's click listener, before the action dispatch (its old position): the
// chat files <summary> must preventDefault synchronously or the <details>
// toggles natively as well, so this stays an early branch, not a registry
// action. Returns true when it handled the click.
export function handleChatFilesToggle(action, trigger, event) {
  if(action==='toggle-chat-files') {event.preventDefault();uiState.chatFilesOpen=!uiState.chatFilesOpen;trigger.parentElement.open=uiState.chatFilesOpen;return true;}
  return false;
}

// 'input' listener branch for the composer textarea, called at its old
// position. Returns true when it handled the event.
export function handleComposerInput(target) {
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
    return true;
  }
  return false;
}

// 'change' listener branch for the composer's hidden file input, at its old
// position inside the listener's try (errors still reach showError). Returns
// false or the pending upload, which the listener awaits.
export function handleComposerFileChange(target) {
  if (target.id === 'composer-attachment-input') {
    return queueComposerFiles(target.files);
  }
  return false;
}

// The document drag-and-drop listeners' bodies (the composer drop target);
// app.js keeps the registrations in their order.
export function handleComposerDragOver(event) {
  if (!hasFileTransfer(event)) {
    return;
  }

  event.preventDefault();
  const isComposerTarget = Boolean(composerDropTargetFromEvent(event));
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = isComposerTarget ? 'copy' : 'none';
  }
  setComposerDragActive(isComposerTarget);
}

export function handleComposerDragLeave(event) {
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
}

export async function handleComposerDrop(event) {
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
}

export function handleComposerDragEnd() {
  setComposerDragActive(false);
}

// 'keydown' listener branches for the chat Agent picker (Escape, arrow
// keys), at their old position between the model picker's Escape and arrow
// branches. Returns true when handled.
export function handleAgentSelectorKeydown(event, target) {
  if (uiState.agentSelectorOpen && event.key === 'Escape') {
    event.preventDefault();
    uiState.agentSelectorOpen = false;
    render();
    document.querySelector('[data-action="toggle-agent-selector"]')?.focus({ preventScroll: true });
    return true;
  }
  if (uiState.agentSelectorOpen && target?.closest('#agent-selector-panel') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const options = [...document.querySelectorAll('.agent-selector-row:not(:disabled)')];
    const index = options.indexOf(target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
    return true;
  }
  return false;
}

// 'keydown' listener branches for the composer — slash palette navigation,
// prompt history (ArrowUp / ArrowDown at the edges), Enter to send — at their
// old position. Returns false, true, or the pending send, which the listener
// awaits.
export function handleComposerKeydown(event, target) {
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
      return true;
    }
    if (event.key === 'ArrowDown' && matches.length) {
      event.preventDefault();
      uiState.slashPalette.selectedIndex =
        (uiState.slashPalette.selectedIndex + 1) % matches.length;
      render();
      return true;
    }
    if (event.key === 'ArrowUp' && matches.length) {
      event.preventDefault();
      uiState.slashPalette.selectedIndex =
        (uiState.slashPalette.selectedIndex - 1 + matches.length) % matches.length;
      render();
      return true;
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
      return true;
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
    return true;
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
    return true;
  }

  if (
    target?.id === 'composer' &&
    shouldSendOnEnter(event, uiState.bootstrap?.settings?.localPreferences) &&
    !uiState.commandPalette.open
  ) {
    event.preventDefault();
    return handleSendMessage();
  }
  return false;
}

export { isAbortError, cloneBootstrapState, optimisticMessagePreview, optimisticChatTitle, resetStreamingAssistant, prepareThreadNavigation, applyOptimisticUserMessage, parseSlashQuery, slashPaletteMatches, voiceBridgeSupported, appendComposerText, promptHistoryEntries, resetComposerHistoryNavigation, navigateComposerHistory, focusComposerSoon, syncComposerTextareaHeight, setVoiceState, isPdfAttachment, isPdfFile, attachmentIcon, attachmentLabel, formatFileSize, detectAttachmentKindFromFile, readFileAsDataUrl, queueComposerFiles, openComposerAttachmentPicker, promptComposerLinkAttachment, hasFileTransfer, composerDropTargetFromEvent, setComposerDragActive, voiceContext, voiceInput, stopVoiceCaptureIfNeeded, handleVoiceBridgeEvent, toggleVoiceInput, handleCreateChat, sendSupplement, handleSendMessage, handleStopSending, _positionAgentDropdown, updateThreadAutoFollow, syncThreadViewport, retryMissingImages };
