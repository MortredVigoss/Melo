import { currentLanguage } from '../../i18n.js';
import { requestText } from '../../feedback.js';
// Chat feature controller (architecture plan P2c, 2026-10-19): the composer
// (draft, prompt history, slash palette, attachments and drag-and-drop, voice
// input), the send pipeline (optimistic user message, /api/chat/send/stream
// with its SSE events, supplements while a reply runs, stop / abort, retry
// identity, reply delivery to TTS), chat creation, the chat-side Agent
// picker, thread navigation and viewport (auto-follow, scroll signature,
// "加载更早", jump-to-latest), message actions and the chat files panel.
// Moved out of desktop-ui/app.js byte-for-byte first (P2c 1/6, 2/6); since
// then the bodies keep their state in ./state.js, read page data through
// getBootstrap() and the other context accessors, and send requests through
// ./api.js (./context.js). app.js's render() keeps its full re-render and its
// generic protections and calls the hooks below at the positions the chat
// code used to have. See features/README.md.
import { t } from '../../i18n.js';
import { expandThreadWindow } from './threadWindow.js';
import { videoExtraction, videoKnowledgeNote } from '../../videoKnowledge.js';
import { attachmentLimit, makeTransferCopy, uploadVideoFile, MB } from './transferCopy.js';
import { consumeImageTask, restoreImageTask } from '../../imageControls.js';
import { createReplyDelivery, receiveReplyDelivery } from '../../replyDelivery.js';
import { createTurnPresentation, receiveTurnPresentation } from './turnPresentation.js';
import { createVoiceInput, voiceInputActive } from '../../voiceInput.js';
import { modelPanelPosition } from '../../modelPresentation.js';
import { isRenderableViz } from '../../viz/vizRenderer.js';
import { collectTeamPlan } from '../../teamPanel.js';
import { streamApi } from './api.js';
import { renderStreamingFast, patchLiveRunSteps } from './viewThread.js';
import { bindChatContext, chatApi, getBootstrap, setBootstrap, app, render, bgRender, notify, applyBootstrap, applyBootstrapPreservingDrafts, refreshBootstrap, activeChat, isOverview, leaveOverview, newChatSelection, selectNewChatAgent, allChatAgentProfiles, closeModelPicker, toolPermissions, setToolPermissions, commandPaletteOpen, voiceLanguage, handleComposerCommand, handleSpeakMessage, handleDeleteChat, stopCurrentTts, _isTtsActive, _streamTtsStart, _streamTtsPushChunk, setStreamTtsBuffer, _streamTtsOnToolCall, _streamTtsReset, _streamTtsFlush, notifyLocalCompletion, shouldSendOnEnter, promoteTextUrlsToAttachments, receiveExecutionScene, cancelLiveScene, captureThreadAnchor, restoreThreadAnchor, truncate, icon } from './context.js';
import { chatState, resetChatState } from './state.js';

// Binds the narrow context and starts from fresh feature state. app.js calls
// this once at startup (through ./index.js); tests call it per case.
export function installChatController(context) {
  bindChatContext(context);
  resetChatState();
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
  chatState.streamingChatId = null;
  chatState.streamingAssistantText = '';
}

function prepareThreadNavigation({ highlightedMessageId = null, autoFollow = true } = {}) {
  chatState.highlightedMessageId = highlightedMessageId;
  chatState.lastThreadScrollSignature = '';
  chatState.lastThreadChatId = null;
  chatState.threadAutoFollow = autoFollow;
}

function applyOptimisticUserMessage({ chatId, content, attachments }) {
  const bootstrap = getBootstrap();
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

  setBootstrap({
    ...bootstrap,
    activeChat: nextChat,
    chats: nextChats,
    recents: nextRecents,
    settings: {
      ...bootstrap.settings,
      selectedChatId: chatId,
      activeView: 'chat',
    },
  });

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
  const all = getBootstrap()?.customize?.skills || [];
  const query = (chatState.slashPalette.query || '').toLowerCase();
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

  const current = chatState.composer.trim();
  chatState.composer = current ? `${current}\n${normalized}` : normalized;
}

function promptHistoryEntries() {
  return (getBootstrap()?.settings?.promptHistory || [])
    .map(entry => String(entry?.content || '').trim())
    .filter(Boolean);
}

function resetComposerHistoryNavigation() {
  chatState.composerHistoryIndex = -1;
  chatState.composerHistoryDraft = '';
}

function navigateComposerHistory(direction = 'older') {
  const entries = promptHistoryEntries();
  if (!entries.length) {
    return false;
  }

  if (chatState.composerHistoryIndex < 0) {
    chatState.composerHistoryDraft = chatState.composer;
  }

  if (direction === 'older') {
    chatState.composerHistoryIndex = Math.min(
      entries.length - 1,
      chatState.composerHistoryIndex + 1,
    );
  } else if (chatState.composerHistoryIndex <= 0) {
    chatState.composerHistoryIndex = -1;
    chatState.composer = chatState.composerHistoryDraft;
    chatState.composerHistoryDraft = '';
    render();
    focusComposerSoon();
    return true;
  } else {
    chatState.composerHistoryIndex -= 1;
  }

  if (chatState.composerHistoryIndex >= 0) {
    chatState.composer = entries[chatState.composerHistoryIndex] || '';
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
  chatState.voice = {
    ...chatState.voice,
    ...patch,
    supported: patch.supported ?? (voiceBridgeSupported() || chatState.voice.supported),
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
      notify({level:'error',text:`${file.name} is not supported yet. Add images, video, audio, or PDF files here.`});
      continue;
    }
    // Photos up to 100 MB are sent as a bounded copy; videos up to 500 MB are uploaded as a file; other files keep 20 MB.
    const limit = kind === 'image' || kind === 'video' ? attachmentLimit(kind) : 20 * MB;
    if (file.size > limit) {
      notify({level:'error',text:t('{name} 超过 {limit} MB，未添加。', { name: file.name, limit: limit / MB })});
      continue;
    }
    const copy = kind === 'image' ? await makeTransferCopy(file).catch(() => null) : null;
    let url = copy?.url;
    if (kind === 'video') {
      chatState.attachmentUploading = file.name; render();
      try { url = (await uploadVideoFile(file)).url; }
      catch (error) { notify({level:'error',text:t('{name} 上传失败：{reason}', { name: file.name, reason: error.message })}); continue; }
      finally { chatState.attachmentUploading = null; }
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
    chatState.composerAttachments = [...chatState.composerAttachments, ...nextAttachments].slice(0, 8);
    chatState.composerAttachmentMenuOpen = false;
    render();
  }
}

function openComposerAttachmentPicker(accept) {
  const input = document.querySelector('#composer-attachment-input');
  if (!(input instanceof HTMLInputElement)) {
    notify({level:'error',text:'Attachment picker is unavailable right now.'});
    return;
  }
  chatState.composerAttachmentMenuOpen = false;
  input.accept = accept;
  input.value = '';
  input.click();
  render();
}

async function promptComposerLinkAttachment() {
  const chatID = activeChat()?.id;
  const value = await requestText({ title:t('添加链接'), value:'https://',
    validate: value => { try { const url = new URL(value.trim()); if (['http:','https:'].includes(url.protocol) && url.hostname && !url.username && !url.password) return ''; } catch {} return t('请输入完整的 http 或 https 链接'); }
  });
  if (activeChat()?.id !== chatID) return;
  const url = String(value || '').trim();
  if (!url) {
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    notify({level:'error',text:'Please paste a full http or https link.'});
    return;
  }
  // Reuse the same classifier as text-paste promotion so YouTube / audio /
  // video / PDF / plain web pages produce identical kind / mimeType / title
  // regardless of how the user attached them.
  const promoted = promoteTextUrlsToAttachments(url, chatState.composerAttachments);
  if (!promoted.length) {
    // URL was already in composerAttachments — silently no-op.
    chatState.composerAttachmentMenuOpen = false;
    render();
    return;
  }
  const enriched = promoted.map(a => ({
    ...a,
    id: crypto.randomUUID(),
    sizeLabel: '',
  }));
  chatState.composerAttachments = [...chatState.composerAttachments, ...enriched].slice(0, 8);
  chatState.composerAttachmentMenuOpen = false;
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
  if (chatState.composerDragActive === nextValue) {
    return;
  }
  chatState.composerDragActive = nextValue;
  render();
}

function voiceContext() {
  const settings = getBootstrap()?.settings || {};
  return [settings.activeView, settings.selectedProjectId, settings.selectedChatId, newChatSelection().agentId].join('|');
}

const voiceInput = createVoiceInput({
  getContext: voiceContext,
  onChange: state => {
    const samePhase = state.status === chatState.voice.status && state.sessionID === chatState.voice.sessionID;
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
  if (voiceInputActive(chatState.voice)) voiceInput.cancel();
}

function handleVoiceBridgeEvent(detail = {}) { voiceInput.receive(detail); }

function toggleVoiceInput() {
  if (voiceInputActive(chatState.voice)) { voiceInput.stop(); return; }
  stopCurrentTts();
  voiceInput.start(voiceLanguage() || currentLanguage());
}

async function handleCreateChat({
  mode = getBootstrap().settings.activeMode,
  projectId = newChatSelection().projectId ?? null,
  agentId = newChatSelection().agentId || 'main',
} = {}) {
  const payload = await chatApi.createChat({ mode, projectId, agentId, modelSelection:newChatSelection().model, contextArtifactIds:newChatSelection().artifactIds });
  chatState.composer = '';
  chatState.composerAttachments = [];
  resetComposerHistoryNavigation();
  // 2026-06-04 audit闭环: clear pending voice transcript + its linking id when
  // switching chats. Without this a recorded-but-unsent voice message leaves
  // composerVoiceTranscript/Id set; the next plain-text send would carry a
  // stale extractedMedia transcript referencing an orphan attachmentId.
  // Parallels the send-path reset (handleSendMessage).
  chatState.composerVoiceTranscript = null;
  chatState.composerVoiceAttachmentId = null;
  applyBootstrap(payload);
}

// A supplement for the reply running in this chat. The server adds it before the
// next model step; if the turn has no further step it comes back and is sent next.
async function sendSupplement(chatId, text) {
  chatState.composer = '';
  try {
    const response = await chatApi.postSupplement(chatId, text);
    if (response.ok) (chatState.supplementsSent ||= []).push(text);
    else (chatState.supplementsAfterTurn ||= []).push(text);
  } catch { (chatState.supplementsAfterTurn ||= []).push(text); }
  // The turn may have ended while the request was in flight: send it as the next message now.
  if (!chatState.sending && chatState.supplementsAfterTurn?.length) {
    const queued = chatState.supplementsAfterTurn.splice(0);
    chatState.supplementsSent = [];
    await handleSendMessage({ chatId, content: queued.join('\n') });
    return;
  }
  render();
}

async function handleSendMessage(prepared = null) {
  if (!prepared && chatState.sending && !voiceInputActive(chatState.voice) && chatState.composer.trim() && chatState.streamingChatId && chatState.streamingChatId === activeChat()?.id) {
    await sendSupplement(chatState.streamingChatId, chatState.composer.trim());
    return;
  }
  if (chatState.sending || chatState.agentSelectionSaving || (!prepared && voiceInputActive(chatState.voice))) return;
  const content = prepared?.content || chatState.composer.trim();
  const attachments = prepared ? [] : [...chatState.composerAttachments];
  if (!content && !attachments.length) return;

  const fromOverview = prepared ? false : isOverview();
  leaveOverview();
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
  const voiceTranscript = (prepared ? null : chatState.composerVoiceTranscript) || null;
  if (!prepared) chatState.composerVoiceTranscript = null;
  // Same for the linking id (2026-05-23 Codex C 闭环) — capture before reset
  // so the prefilled transcript entry can reference the audio attachment.
  const voiceAttachmentId = (prepared ? null : chatState.composerVoiceAttachmentId) || null;
  if (!prepared) chatState.composerVoiceAttachmentId = null;

  let chatId = prepared?.chatId || (fromOverview ? null : getBootstrap()?.settings?.selectedChatId || null);
  const submissionKey = targetChatId => JSON.stringify({ chatId: targetChatId, content, attachments, imageTask, teamPlan,
    voiceTranscript, voiceAttachmentId, mode: getBootstrap()?.settings?.activeMode,
    agentId: activeChat()?.agentId || getBootstrap()?.settings?.selectedAgentId,
    modelSelection: activeChat()?.modelSelection || null });
  const retry = !prepared && chatState.composerRetry?.key === submissionKey(chatId) ? chatState.composerRetry : null;
  chatState.sending = true;
  chatState.activeTurn = createTurnPresentation(prepared?.requestId || retry?.requestId || crypto.randomUUID());
  closeModelPicker();
  chatState.thinkingSince = Date.now();
  chatState.sendAbortController = new AbortController();
  let previousBootstrap = cloneBootstrapState(getBootstrap());
  const turnRequestId = chatState.activeTurn.requestId;
  resetStreamingAssistant();
  chatState.composer = '';
  resetComposerHistoryNavigation();
  chatState.composerAttachments = [];
  chatState.composerAttachmentMenuOpen = false;
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
      chatId = getBootstrap().settings.selectedChatId;
      previousBootstrap = cloneBootstrapState(getBootstrap());
      applyOptimisticUserMessage({
        chatId,
        content,
        attachments,
      });
      render();
    }

    chatState.streamingChatId = chatId;
    chatState.streamingAssistantText = '';
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
        mode: getBootstrap().settings.activeMode,

      },
      signal: chatState.sendAbortController.signal,
      onEvent: message => {
        if (message.event === 'execution_scene') { receiveExecutionScene(message.payload?.scene); patchLiveRunSteps(message.payload?.scene?.chatId); }
        const previousPhase = chatState.activeTurn?.phase;
        receiveTurnPresentation(chatState.activeTurn, message.event, message.payload);
        if (previousPhase !== chatState.activeTurn?.phase) render();
        const delivery = receiveReplyDelivery(replyDelivery, message.event, message.payload);
        if (delivery.speechDelta) _streamTtsPushChunk(delivery.speechDelta);
        if (typeof delivery.finalSpeechText === 'string' && _isTtsActive()) {
          setStreamTtsBuffer(delivery.finalSpeechText);
        }
        if (message.event === 'delta') {
          chatState.streamingChatId = chatId;
          // payload.delta is always the incremental text; payload.text is the accumulated total.
          // Use payload.delta directly for TTS — the derived `delta` below can be null when
          // both fields are present (which all streaming paths do), causing TTS to never fire.
          const payloadDelta = String(message.payload?.delta || '');
          const delta = typeof message.payload?.text === 'string'
            ? null // full-text replace for display accumulation
            : payloadDelta;
          chatState.streamingAssistantText =
            typeof message.payload?.text === 'string'
              ? message.payload.text
              : `${chatState.streamingAssistantText}${delta}`;
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
            setToolPermissions(toolPermissions().filter(
              p => p.requestId !== requestId,
            ));
            toolPermissions().push({
              kind: 'file_safety',
              requestId,
              operation,
              payload: rest,
            });
            render();
          } else if (payload.toolId) {
            const { toolId, args } = payload;
            // Retransmissions replace only themselves; parallel calls need distinct decisions.
            setToolPermissions(toolPermissions().filter(
              p => p.requestId !== requestId,
            ));
            toolPermissions().push({
              kind: 'tool',
              requestId,
              toolId,
              args: args || {},
            });
            render();
          }
        } else if (message.event === 'capability_request') {
          // Capability elevation (2026-10-20): the same queue as tool permissions;
          // the approvals feature renders and answers entries of kind 'capability'.
          const payload = message.payload || {};
          if (payload.requestId) {
            setToolPermissions(toolPermissions().filter(p => p.requestId !== payload.requestId));
            toolPermissions().push({ ...payload, kind: 'capability' });
            render();
          }
        } else if (message.event === 'capability_request_closed') {
          // Timed out, cancelled, budget ended or answered: the card goes away.
          const requestId = message.payload?.requestId;
          if (requestId && toolPermissions().some(p => p.requestId === requestId)) {
            setToolPermissions(toolPermissions().filter(p => p.requestId !== requestId));
            render();
          }
        } else if (message.event === 'reply_text') {
          // Speech is handled by replyDelivery only after the finalized event.
        } else if (message.event === 'tool_calls_start') {
          // Tools about to execute — strip <tool_call> XML from the streaming display
          chatState.streamingAssistantText = chatState.streamingAssistantText
            .replace(/<tool_call>[\s\S]*$/, '')
            .trim();
          // Discard intermediate TTS text ("我正在搜索...")
          _streamTtsOnToolCall();
          // Mark as running
          const calls = message.payload?.calls || [];
          for (const c of calls) {
            const existing = chatState.activeToolCalls.find(t => t.id === c.id);
            if (existing) {
              existing.status = 'running';
            } else {
              chatState.activeToolCalls.push({ id: c.id, name: c.name, arguments: c.arguments, status: 'running' });
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
            const existing = chatState.activeToolCalls.find(t => t.id === r.id);
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
            chatState.activeToolCalls = chatState.activeToolCalls.filter(t => t.status === 'running');
            bgRender();
          }, 1800);
          bgRender();
        }
      },
    });

    sendSucceeded = true;
    if (result?.unusedSupplements?.length) (chatState.supplementsAfterTurn ||= []).push(...result.unusedSupplements);
    if (!prepared) chatState.composerRetry = null;
    notifyLocalCompletion();
    if (result?.bootstrap) {
      applyBootstrap(result.bootstrap);
    } else {
      await refreshBootstrap();
    }
  } catch (error) {
    if (isAbortError(error)) {
      sendWasAborted = true;
      // Bug audit U4: no more scene events arrive after Stop — finish the
      // run's scene locally and re-read scenes + chat once the server has
      // persisted its cancelled scene and the [工具轨迹] message.
      cancelLiveScene(chatState.activeTurn?.runId || null, { chatId });
      for (const delay of [800, 2500]) setTimeout(() => { if (!chatState.sending) refreshBootstrap().catch(() => {}); }, delay);
      try {
        await refreshBootstrap();
      } catch {}
      return;
    }
    try {
      await refreshBootstrap();
    } catch {
      if (previousBootstrap) {
        setBootstrap(previousBootstrap);
      }
    }
    chatState.composer = content;
    chatState.composerAttachments = attachments;
    chatState.composerVoiceTranscript = voiceTranscript;
    chatState.composerVoiceAttachmentId = voiceAttachmentId;
    if (!prepared) chatState.composerRetry = { requestId: turnRequestId, chatId, key: submissionKey(chatId),
      interrupted: error.code === 'REQUEST_INTERRUPTED' };
    restoreImageTask(imageTask);
    chatState.composerAttachmentMenuOpen = false;
    notify({level:'error',text:error.message});
  } finally {
    chatState.sending = false;
    // Supplements the turn could not use are sent as the next message of the same chat.
    // A stopped or failed turn returns every supplement to the composer instead of dropping it.
    const followUp = sendSucceeded ? (chatState.supplementsAfterTurn || []) : [];
    const returned = sendSucceeded ? [] : [...(chatState.supplementsSent || []), ...(chatState.supplementsAfterTurn || [])];
    chatState.supplementsSent = [];
    chatState.supplementsAfterTurn = [];
    if (returned.length) chatState.composer = [chatState.composer.trim(), ...returned.map(text => t('补充：{text}', { text }))].filter(Boolean).join('\n');
    if (followUp.length && chatId) setTimeout(() => handleSendMessage({ chatId, content: followUp.join('\n') }), 0);
    chatState.activeTurn = null;
    chatState.sendAbortController = null;
    chatState.thinkingSince = 0;
    chatState.activeToolCalls = [];
    setToolPermissions([]);

    // Stop button behaviour: when the user aborted the stream, the buffered
    // partial sentence in _streamTts.buffer is half a thought — flushing it
    // would have the assistant speak garbled fragments seconds after the
    // click. Discard the buffer AND tell the server to abort any synthesis
    // already on its way (covers the queue path + speak-text fast paths).
    if (sendWasAborted || !sendSucceeded) {
      try { await chatApi.clearSpeechQueue(); } catch {}
      try { await chatApi.stopSpeech(); } catch {}
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
  if (!chatState.sending || !chatState.sendAbortController) {
    return;
  }

  chatState.sendAbortController.abort();
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

  if (getBootstrap()?.settings?.activeView !== 'chat' || !activeChat()) {
    return;
  }

  const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
  const distanceFromBottom = Math.max(0, maxScroll - scroller.scrollTop);
  const nextAutoFollow = distanceFromBottom <= 56;
  const autoFollowChanged = nextAutoFollow !== chatState.threadAutoFollow;
  chatState.threadAutoFollow = nextAutoFollow;
  // Always track the last known scroll position so we can restore it after re-renders
  chatState.lastKnownScrollTop = scroller.scrollTop;

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
    getBootstrap()?.settings?.activeView !== 'chat' ||
    !chat?.messages?.length
  ) {
    chatState.lastThreadScrollSignature = '';
    chatState.lastThreadChatId = null;
    chatState.threadAutoFollow = true;
    return;
  }

  const isNewThread = chatState.lastThreadChatId !== chat.id;
  if (isNewThread) {
    chatState.lastThreadChatId = chat.id;
    chatState.threadAutoFollow = true;
  }

  const signature = `${chat.id}:${chat.messages.length}:${chat.updatedAt || ''}:${
    chatState.highlightedMessageId || ''
  }:${chatState.streamingChatId === chat.id ? chatState.streamingAssistantText.length : 0}:${
    chatState.sending && chatState.streamingChatId === chat.id ? 1 : 0
  }`;
  if (signature === chatState.lastThreadScrollSignature) {
    return;
  }

  chatState.lastThreadScrollSignature = signature;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const scroller = document.querySelector('.thread-scroll-region');
      const highlightedMessage = chatState.highlightedMessageId
        ? document.querySelector(`[data-message-id="${chatState.highlightedMessageId}"]`)
        : null;
      if (highlightedMessage instanceof HTMLElement) {
        chatState.threadAutoFollow = false;
        highlightedMessage.scrollIntoView({ block: 'center', behavior: 'auto' });
        return;
      }

      if (!chatState.threadAutoFollow) {
        // Restore the user's saved scroll position — new DOM starts at 0
        if (scroller instanceof HTMLElement && chatState.lastKnownScrollTop > 0) {
          scroller.scrollTop = chatState.lastKnownScrollTop;
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
  if (chatState.sending || chatId !== getBootstrap()?.settings?.selectedChatId || !task?.retryOf) return;
  handleSendMessage({ chatId, content: query || '继续图片任务', imageTask: task });
}

// Click actions (formerly `case` branches of app.js's click dispatch),
// registered once by app.js through the feature registry.
export const chatActions = {
  'delete-active-chat': async () => {
    if(activeChat()) await handleDeleteChat(activeChat().id);
  },
  'restart-interrupted-send': async () => {
    chatState.composerRetry = null;
    await handleSendMessage();
  },
  'stop-send': () => {
    handleStopSending();
  },
  'save-video-knowledge': async ({ trigger }) => {
    const message = activeChat()?.messages?.find(m => m.id === trigger.dataset.messageId);
    const attachment = message?.attachments?.find(a => a.id === trigger.dataset.attachmentId);
    const entry = message && attachment ? videoExtraction(message, attachment) : null;
    if (!entry) { notify({level:'error',text:t('这段视频还没有处理结果。')}); return; }
    try { applyBootstrap(await chatApi.saveArtifact({ ...videoKnowledgeNote(attachment, entry), projectId: activeChat()?.projectId || null })); (chatState.savedVideoKnowledge ||= {})[attachment.id] = true; render(); }
    catch (error) { notify({level:'error',text:error.message}); }
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
    chatState.threadWindow ||= {};
    expandThreadWindow(chatState.threadWindow, chat.id, 60);
    render();
    const nextScroller = document.querySelector('.thread-scroll-region');
    if (nextScroller instanceof HTMLElement) {
      if (!(anchor && restoreThreadAnchor(anchor))) {
        nextScroller.scrollTop = previousTop + (nextScroller.scrollHeight - previousHeight);
      }
      chatState.lastKnownScrollTop = nextScroller.scrollTop;
      // Viz cards (if any) hydrate async and grow above the viewport —
      // re-pin once the frame after the swap settles.
      if (anchor) requestAnimationFrame(() => restoreThreadAnchor(anchor));
    }
  },
  'jump-to-topic': ({ trigger }) => {
    // A "回到话题" marker: bring the topic's first message into the window and scroll to it.
    prepareThreadNavigation({ highlightedMessageId: trigger.dataset.messageId, autoFollow: false });
    render();
  },
  'scroll-thread-to-bottom': () => {
    // User clicked the floating "jump to latest" arrow. Re-enable
    // auto-follow so subsequent streaming chunks keep the view pinned to
    // the bottom, and snap to bottom immediately (instant, not smooth —
    // a smooth animation fires scroll events mid-animation that would
    // briefly flip auto-follow back off and make the button flicker).
    chatState.threadAutoFollow = true;
    chatState.lastKnownScrollTop = 0;
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
      chatState.composer = `/${skillId} `;
      chatState.slashPalette.open = false;
      chatState.slashPalette.query = '';
      chatState.slashPalette.selectedIndex = 0;
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
    const chat=activeChat(), content=chatState.composer.trim();
    if(!content) {notify({level:'error',text:t('请先在输入框写下团队任务。')});return;}
    const team=collectTeamPlan(trigger.closest('[data-team-scope]'));
    if(team.error) {notify({level:'error',text:t(team.error)});return;}
    await handleSendMessage({chatId:chat?.id,content,teamPlan:team.plan});
  },
  'toggle-composer-attachment-menu': () => {
    chatState.composerAttachmentMenuOpen = !chatState.composerAttachmentMenuOpen;
    render();
  },
  'pick-composer-attachment': ({ trigger }) => {
    openComposerAttachmentPicker(trigger.dataset.accept || 'image/*,video/*,audio/*');
  },
  'add-link-attachment': async () => {
    await promptComposerLinkAttachment();
  },
  'remove-composer-attachment': ({ trigger }) => {
    chatState.composerAttachments = chatState.composerAttachments.filter(
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
    chatState.agentSelectorOpen = !chatState.agentSelectorOpen;
    render();
    if (chatState.agentSelectorOpen) document.querySelector('.agent-selector-row.is-selected')?.focus({ preventScroll: true });
  },
  'select-chat-agent': async ({ trigger }) => {
    const agentId = trigger.dataset.agentId;
    // Allowed during a reply: the running turn keeps the Agent it started with; this applies next.
    if (chatState.agentSelectionSaving || !allChatAgentProfiles().some(a=>a.id===agentId)) return;
    const chat = !isOverview() ? activeChat() : null;
    chatState.agentSelectionSaving=true; render();
    try {
      if(chat) applyBootstrapPreservingDrafts(await chatApi.updateChat(chat.id, {agentId}));
      else selectNewChatAgent(agentId);
      chatState.agentSelectorOpen=false;
    } finally {chatState.agentSelectionSaving=false;render();}
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
  if(action==='toggle-chat-files') {event.preventDefault();chatState.chatFilesOpen=!chatState.chatFilesOpen;trigger.parentElement.open=chatState.chatFilesOpen;return true;}
  return false;
}

// 'input' listener branch for the composer textarea, called at its old
// position. Returns true when it handled the event.
export function handleComposerInput(target) {
  if (target.id === 'composer') {
    chatState.composer = target.value;
    resetComposerHistoryNavigation();
    syncComposerTextareaHeight();
    // Phase 3.3.3 — open/close slash palette based on current composer value.
    const slashQuery = parseSlashQuery(target.value);
    if (slashQuery !== null) {
      if (!chatState.slashPalette.open
          || chatState.slashPalette.query !== slashQuery) {
        chatState.slashPalette.open = true;
        chatState.slashPalette.query = slashQuery;
        chatState.slashPalette.selectedIndex = 0;
        render();
      }
    } else if (chatState.slashPalette.open) {
      chatState.slashPalette.open = false;
      chatState.slashPalette.query = '';
      chatState.slashPalette.selectedIndex = 0;
      render();
    }
    return true;
  }
  return false;
}

// 'change' listener branch for the composer's hidden file input, at its old
// position inside the listener's try (errors still reach notify). Returns
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
    notify({level:'error',text:error.message});
  }
}

export function handleComposerDragEnd() {
  setComposerDragActive(false);
}

// 'keydown' listener branches for the chat Agent picker (Escape, arrow
// keys), at their old position between the model picker's Escape and arrow
// branches. Returns true when handled.
export function handleAgentSelectorKeydown(event, target) {
  if (chatState.agentSelectorOpen && event.key === 'Escape') {
    event.preventDefault();
    chatState.agentSelectorOpen = false;
    render();
    document.querySelector('[data-action="toggle-agent-selector"]')?.focus({ preventScroll: true });
    return true;
  }
  if (chatState.agentSelectorOpen && target?.closest('#agent-selector-panel') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
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
  if (target?.id === 'composer' && chatState.slashPalette.open) {
    const matches = slashPaletteMatches();
    if (event.key === 'Escape') {
      event.preventDefault();
      chatState.slashPalette.open = false;
      chatState.slashPalette.query = '';
      chatState.slashPalette.selectedIndex = 0;
      render();
      return true;
    }
    if (event.key === 'ArrowDown' && matches.length) {
      event.preventDefault();
      chatState.slashPalette.selectedIndex =
        (chatState.slashPalette.selectedIndex + 1) % matches.length;
      render();
      return true;
    }
    if (event.key === 'ArrowUp' && matches.length) {
      event.preventDefault();
      chatState.slashPalette.selectedIndex =
        (chatState.slashPalette.selectedIndex - 1 + matches.length) % matches.length;
      render();
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && matches.length && !event.shiftKey) {
      event.preventDefault();
      const pick = matches[
        Math.min(
          Math.max(0, chatState.slashPalette.selectedIndex | 0),
          matches.length - 1,
        )
      ];
      if (pick) {
        chatState.composer = `/${pick.id} `;
        chatState.slashPalette.open = false;
        chatState.slashPalette.query = '';
        chatState.slashPalette.selectedIndex = 0;
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
    shouldSendOnEnter(event, getBootstrap()?.settings?.localPreferences) &&
    !commandPaletteOpen()
  ) {
    event.preventDefault();
    return handleSendMessage();
  }
  return false;
}

// ── Hooks app.js calls (architecture plan P2c) ──────────────────────────────
// render() keeps its full re-render and its generic protections (typing /
// scroll guards, focused-input caret, nested and textarea scroll, content
// scroll, neural regions); the chat steps run where the inline code was:
//   captureComposerBeforeRender()        with the other captures (composer value / scrollTop)
//   captureThreadBeforeRender()          after the content scroll capture (thread scrollTop, viz anchor, signature)
//   restoreThreadScrollAfterRender(t)    after the content scroll restore
//   syncThreadViewport()                 after syncContentScrollbar(), before the Agent scroll restore
//   restoreComposerAfterRender(c)        after syncFileEditorGoToLine(), before the Agent editor restore
//   positionAgentDropdown(), syncVizBlocks()   after the focused-input restore
//   restoreVizAnchorAfterRender(t)       last
// Stream deltas do not go through render(): renderStreamingFast() patches the
// streaming bubble in place (handleSendMessage) and falls back to render().
// render(), with the other captures before the page update: the composer's
// value and scrollTop.
export function captureComposerBeforeRender() {
  const _savedComposer = document.querySelector('#composer');
  return _savedComposer ? { value: _savedComposer.value, top: _savedComposer.scrollTop } : null;
}

// render(), before the page update: the thread scroller's scrollTop, the viz
// anchor (also kept for the async viz hydration listener) and whether the
// thread content changes in this render.
export function captureThreadBeforeRender() {
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
  // Also stash the anchor on the chat state so the async viz hydration path can
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
  chatState.pendingVizAnchor = _vizAnchor;

  // Compute whether thread content will change this render — if the signature matches the
  // last rendered signature it's a UI-only render (voice panel, checkbox, etc.) and we must
  // restore the thread scroll manually (syncThreadViewport returns early for same-signature).
  // If the signature differs, syncThreadViewport will scroll the thread; don't interfere.
  const _threadSig = _chat
    ? `${_chat.id}:${_chat.messages.length}:${_chat.updatedAt || ''}:${
        chatState.highlightedMessageId || ''
      }:${chatState.streamingChatId === _chat.id ? chatState.streamingAssistantText.length : 0}:${
        chatState.sending && chatState.streamingChatId === _chat.id ? 1 : 0
      }`
    : '';
  const _threadContentUnchanged = _threadSig === chatState.lastThreadScrollSignature;
  return { savedThreadScroll: _savedThreadScroll, vizAnchor: _vizAnchor, threadContentUnchanged: _threadContentUnchanged };
}

// render(), right after the content scroll restore and before
// syncThreadViewport().
export function restoreThreadScrollAfterRender({ savedThreadScroll: _savedThreadScroll, threadContentUnchanged: _threadContentUnchanged }) {
  // Restore thread scroll only on UI-only renders (same thread signature).
  // When thread content changed, syncThreadViewport handles scrolling — don't interfere.
  if (_savedThreadScroll >= 0 && _threadContentUnchanged) {
    const _newThread = document.querySelector('.thread-scroll-region');
    if (_newThread instanceof HTMLElement) {
      _newThread.scrollTop = _savedThreadScroll;
    }
  }
}

// render(), after syncFileEditorGoToLine() and before the Agent editor and
// focused-input restores: composer height, then its scrollTop when the
// draft is unchanged.
export function restoreComposerAfterRender(_savedComposerScroll) {
  syncComposerTextareaHeight();
  const _newComposer = document.querySelector('#composer');
  if (_newComposer && _savedComposerScroll?.value === _newComposer.value) {
    _newComposer.scrollTop = _savedComposerScroll.top;
  }
}

// render(), last: re-pin the viz anchor captured before the update.
export function restoreVizAnchorAfterRender({ vizAnchor: _vizAnchor }) {
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
      // Clear the stashed anchor on the chat state so stale references don't
      // leak — the async globe-flight path reads this to re-pin after it
      // finishes hydrating.
      if (chatState.pendingVizAnchor === _vizAnchor) chatState.pendingVizAnchor = null;
    }, 600);
  } else {
    chatState.pendingVizAnchor = null;
  }
}

// The 'melo:viz:hydrated' listener: a viz card finished hydrating and grew.
export function restorePendingVizAnchor() {
  if (chatState.pendingVizAnchor) {
    restoreThreadAnchor(chatState.pendingVizAnchor);
  }
}

// render(): the command palette and a permission prompt close the picker.
export function closeAgentSelector() {
  chatState.agentSelectorOpen = false;
}

// The click listener, before the action dispatch: a click outside the
// composer's attachment menu closes it (the listener renders later, only if
// no action handles the click). Returns true when it closed the menu.
export function closeAttachmentMenuOnOutsideClick(event) {
  if (
    chatState.composerAttachmentMenuOpen &&
    !event.target.closest('.composer-bottom-left')
  ) {
    chatState.composerAttachmentMenuOpen = false;
    return true;
  }
  return false;
}

// The click listener, after the model picker's outside-click close: a click
// outside the Agent chip and panel closes the picker.
export function closeAgentSelectorOnOutsideClick(event) {
  if (chatState.agentSelectorOpen && !event.target.closest('.agent-chip-anchor, #agent-selector-panel')) {
    chatState.agentSelectorOpen = false;
    render();
  }
}

// toggle-model-picker (app.js): opening the model picker closes the
// attachment menu.
export function closeAttachmentMenu() {
  chatState.composerAttachmentMenuOpen = false;
}

// Navigation away from a search hit (open-view, search, switch-mode, file
// matches) drops the highlighted message.
export function clearHighlightedMessage() {
  chatState.highlightedMessageId = null;
}

// handleOpenNewChatHome (app.js, the new-chat navigation), at the position
// of the inline reset: stop a running capture and clear the composer.
export function resetComposerForNewChatHome() {
  stopVoiceCaptureIfNeeded();
  setVoiceState({
    recording: false,
    preview: '',
    error: '',
    status: chatState.voice.supported ? 'ready' : 'idle',
  });
  chatState.composer = '';
  resetComposerHistoryNavigation();
  chatState.composerAttachments = [];
  // 2026-06-04 audit闭环: also clear pending voice transcript + linking id
  // (same stale-transcript leak as handleCreateChat) — composerAttachments
  // reset above drops the audio attachment but the voice fields would
  // otherwise survive into the next send.
  chatState.composerVoiceTranscript = null;
  chatState.composerVoiceAttachmentId = null;
  chatState.composerAttachmentMenuOpen = false;
  chatState.composerDragActive = false;
}

// applyBootstrap (app.js): page data that changes the view, chat or project
// stops a running voice capture.
export function voiceCaptureActive() {
  return voiceInputActive(chatState.voice);
}

// handleRunTask (app.js): a task run is sent through the chat pipeline; the
// user's unsent draft (taken before the task is prepared) comes back unless
// they typed something new meanwhile.
export function takeComposerDraft() {
  return { composer: chatState.composer, attachments: chatState.composerAttachments };
}
export function restoreComposerDraft(draft, sentContent) {
  if (!chatState.composer || chatState.composer === sentContent) {
    chatState.composer = draft.composer;
    chatState.composerAttachments = draft.attachments;
  }
}

// The composer draft for app.js's slash commands (handleComposerCommand), the
// command catalog filter and the (unrendered) command deck presets.
export function composerText() {
  return chatState.composer;
}
export function setComposerText(text) {
  chatState.composer = text;
}
// The image task controls read the composer's attachments.
export function composerAttachments() {
  return chatState.composerAttachments;
}
// render(), the task panel and the 1 s thinking timer.
export function isSending() {
  return chatState.sending;
}

// Tests and diagnostics.
export const getState = () => chatState;

export { isAbortError, cloneBootstrapState, optimisticMessagePreview, optimisticChatTitle, resetStreamingAssistant, prepareThreadNavigation, applyOptimisticUserMessage, parseSlashQuery, slashPaletteMatches, voiceBridgeSupported, appendComposerText, promptHistoryEntries, resetComposerHistoryNavigation, navigateComposerHistory, focusComposerSoon, syncComposerTextareaHeight, setVoiceState, isPdfAttachment, isPdfFile, attachmentIcon, attachmentLabel, formatFileSize, detectAttachmentKindFromFile, readFileAsDataUrl, queueComposerFiles, openComposerAttachmentPicker, promptComposerLinkAttachment, hasFileTransfer, composerDropTargetFromEvent, setComposerDragActive, voiceContext, voiceInput, stopVoiceCaptureIfNeeded, handleVoiceBridgeEvent, toggleVoiceInput, handleCreateChat, sendSupplement, handleSendMessage, handleStopSending, _positionAgentDropdown, updateThreadAutoFollow, syncThreadViewport, retryMissingImages };
