import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createActionRegistry } from '../registry.js';

// Architecture plan P2c: the chat feature owns its state (composer draft,
// attachments, voice ids, retry identity, supplements, the running reply and
// the thread viewport), reads page data only through its narrow context,
// sends through ./api.js and is driven through the action registry, the
// listener entry points and the render() hooks exactly as app.js drives it.
// Behaviour versions of the former app.js source tests sendRecovery,
// newChatComposer and the voice half of mediaAttachment.source.
const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { pretendToBeVisual: true, url: 'http://127.0.0.1/' });
for (const name of ['document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'Element', 'FileReader']) globalThis[name] = dom.window[name];
globalThis.window = dom.window;
globalThis.requestAnimationFrame = callback => dom.window.requestAnimationFrame(callback);
globalThis.CSS = { escape: value => String(value).replace(/["\\]/g, '\\$&') };
// The desktop shell's speech bridge (WKWebView): dictation runs through it.
const bridgeMessages = [];
globalThis.webkit = { messageHandlers: { meloVoice: { postMessage: message => bridgeMessages.push(message) } } };
const { installChatFeature } = await import('./index.js');

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const agent = id => ({ id, name: id === 'main' ? 'Melo' : id });
const message = (id, role, content, extra = {}) => ({ id, role, content, createdAt: '2026-10-19T00:00:00.000Z', ...extra });
const chat = (id, messages = [], extra = {}) => ({ id, title: `Chat ${id}`, agentId: 'main', mode: 'chat', projectId: null, messages, updatedAt: '2026-10-19T00:00:00.000Z', ...extra });
function page({ chats = [chat('chat-a', [message('q', 'user', 'hi'), message('r', 'assistant', 'hello')]), chat('chat-b', [message('q2', 'user', 'other')])], selected = 'chat-a', marker = '' } = {}) {
  return {
    marker,
    settings: { activeView: 'chat', activeMode: 'chat', selectedChatId: selected, selectedAgentId: 'main', config: { authMode: 'codex', hasCredentials: true, model: 'gpt-5' }, localPreferences: {} },
    profile: { name: 'Me' },
    customize: { agents: [agent('main'), agent('research')], skills: [{ id: 'pdf-maker', name: 'PDF', enabled: true }] },
    projects: [], artifacts: [],
    workspace: { exists: false, entries: [], selectedFile: null, commandTemplates: [] },
    chats, activeChat: chats.find(item => item.id === selected) || null, recents: [],
  };
}
const flush = async (turns = 6) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)); };

// A fake server for the two requests the feature sends with fetch: the SSE
// reply stream (held open until the test writes events or closes it) and the
// supplement post.
function server({ supplementOk = true } = {}) {
  const encoder = new TextEncoder();
  const streams = [];
  const supplements = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url === '/api/chat/supplement') { supplements.push(body); return new Response('{}', { status: supplementOk ? 200 : 409 }); }
    assert.equal(url, '/api/chat/send/stream');
    const stream = { body, controller: null };
    streams.push(stream);
    const readable = new ReadableStream({ start(controller) { stream.controller = controller; } });
    init.signal?.addEventListener('abort', () => stream.controller.error(new DOMException('The operation was aborted.', 'AbortError')));
    return new Response(readable, { headers: { 'content-type': 'text/event-stream' } });
  };
  const current = () => streams.at(-1);
  return {
    streams, supplements,
    send(event, payload = {}) { current().controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)); },
    close() { current().controller.close(); },
  };
}

function harness({ bootstrap = page(), responses = {}, overview = false } = {}) {
  const calls = [], applied = [], preserved = [], errors = [], cancelled = [], scenes = [], spoken = [], deleted = [];
  let renders = 0, refreshes = 0, refreshError = null;
  const state = { bootstrap, overview, permissions: [], newChat: { agentId: 'main', projectId: null, artifactIds: [], model: null }, modelPickerOpen: true };
  const app = document.querySelector('#app');
  let feature;
  const paint = () => { app.innerHTML = state.overview ? feature.renderComposer() : feature.renderPage(); };
  const context = {
    getBootstrap: () => state.bootstrap,
    setBootstrap: payload => { state.bootstrap = payload; },
    app,
    api: async (path, options = {}) => {
      calls.push([path, options.method || 'GET', options.body]);
      const value = responses[path];
      if (value instanceof Error) throw value;
      if (typeof value === 'function') return value(options);
      return structuredClone(value ?? state.bootstrap);
    },
    render: () => { renders++; paint(); },
    bgRender: () => { renders++; paint(); },
    showError: text => errors.push(text),
    applyBootstrap: payload => { applied.push(payload); state.bootstrap = payload; },
    applyBootstrapPreservingDrafts: payload => { preserved.push(payload); state.bootstrap = payload; },
    refreshBootstrap: async () => { refreshes++; if (refreshError) throw refreshError; },
    activeChat: () => state.bootstrap?.activeChat || null,
    isOverview: () => state.overview,
    leaveOverview: () => { state.overview = false; },
    newChatSelection: () => state.newChat,
    selectNewChatAgent: agentId => { state.newChat = { ...state.newChat, agentId }; },
    activeChatAgentProfile: () => agent('main'),
    allChatAgentProfiles: () => state.bootstrap.customize.agents,
    composerTeamPlan: () => null,
    modelPicker: () => ({ open: state.modelPickerOpen, saving: false }),
    closeModelPicker: () => { state.modelPickerOpen = false; },
    toolPermissions: () => state.permissions,
    setToolPermissions: list => { state.permissions = list; },
    commandPaletteOpen: () => false,
    voiceLanguage: () => 'zh-CN',
    handleComposerCommand: async () => false,
    handleSpeakMessage: async trigger => { spoken.push(trigger.dataset.messageId); },
    handleDeleteChat: async chatId => { deleted.push(chatId); },
    speakingState: () => ({ messageId: null, loadingId: null }),
    stopCurrentTts: () => { spoken.push('stop'); },
    _isTtsActive: () => false, _streamTtsStart: async () => {}, _streamTtsPushChunk: () => {}, setStreamTtsBuffer: () => {},
    _streamTtsOnToolCall: () => {}, _streamTtsReset: () => {}, _streamTtsFlush: async () => {},
    notifyLocalCompletion: () => {},
    shouldSendOnEnter: event => event.key === 'Enter' && !event.shiftKey && !event.isComposing,
    extractTextUrls: text => [text],
    promoteTextUrlsToAttachments: () => [],
    renderExecutionPanel: () => '',
    receiveExecutionScene: scene => scenes.push(scene),
    liveSceneFor: () => null,
    cancelLiveScene: (runId, options) => cancelled.push([runId, options]),
    renderSceneReplay: () => '',
    selectedMessagePresentation: item => item,
    renderMessageRefs: () => '',
    renderTextBlock: value => `<p>${escapeHtml(value)}</p>`,
    renderWorkspaceExplorer: () => '',
    renderTtsVoicePanel: () => '',
    modelOptionsForAuthMode: () => [],
    captureThreadAnchor: () => null,
    restoreThreadAnchor: () => false,
    escapeHtml,
    truncate: (value = '', max = 180) => (value.length > max ? `${value.slice(0, max - 1)}…` : value),
    icon: new Proxy({}, { get: () => '' }),
  };
  feature = installChatFeature(context);
  const actions = createActionRegistry('action');
  actions.register(feature.actions, 'chat');
  const forms = createActionRegistry('form');
  forms.register(feature.forms, 'chat');
  paint();
  return {
    feature, actions, forms, context, state, calls, applied, preserved, errors, cancelled, scenes, spoken, deleted,
    chat: () => feature.getState(),
    renders: () => renders, refreshes: () => refreshes,
    failRefresh: error => { refreshError = error; },
    view: chatId => { state.bootstrap = { ...state.bootstrap, activeChat: state.bootstrap.chats.find(item => item.id === chatId), settings: { ...state.bootstrap.settings, selectedChatId: chatId } }; paint(); },
    send: () => forms.dispatch('composer', { form: app.querySelector('form[data-form=composer]'), event: null }),
    click: (action, html) => {
      const host = document.createElement('div');
      host.innerHTML = html || `<button data-action="${action}"></button>`;
      return actions.dispatch(action, { action, trigger: host.firstElementChild, event: null });
    },
  };
}

test('the chat feature takes a narrow context (no uiState) and starts from its own state', async () => {
  const h = harness();
  assert.throws(() => installChatFeature({ ...h.context, uiState: {} }), /not uiState/);
  const { setBootstrap, toolPermissions, ...rest } = h.context;
  assert.throws(() => installChatFeature(rest), /missing context setBootstrap, toolPermissions/);
  const first = harness();
  first.chat().composer = 'draft';
  await first.click('toggle-composer-attachment-menu');
  const firstState = first.chat();
  assert.equal(firstState.composerAttachmentMenuOpen, true);
  const second = harness();
  assert.notEqual(second.chat(), firstState, 'every install starts from its own state object');
  assert.equal(second.chat().composer, '');
  assert.equal(second.chat().composerAttachmentMenuOpen, false);
});

test('registry: chat actions and the composer form are registered once; cross-page navigation stays in app.js', async () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.feature.actions).sort(), [
    'add-link-attachment', 'cancel-voice-input', 'delete-active-chat', 'pick-composer-attachment', 'pick-slash-skill',
    'remove-composer-attachment', 'restart-interrupted-send', 'run-chat-team', 'save-video-knowledge', 'scroll-thread-to-bottom',
    'select-chat-agent', 'speak-message', 'stop-send', 'thread-load-earlier', 'toggle-agent-selector', 'toggle-composer-attachment-menu',
    'toggle-voice-input',
  ]);
  assert.deepEqual(Object.keys(h.feature.forms), ['composer']);
  for (const name of ['open-chat', 'new-chat', 'select-agent-profile', 'select-project', 'toggle-model-picker', 'toggle-chat-files']) {
    assert.equal(h.actions.has(name), false, `${name} stays in app.js`);
  }
  // Agent picker: toggle, choose for this chat, Escape closes.
  await h.click('toggle-agent-selector');
  assert.equal(h.chat().agentSelectorOpen, true);
  assert.ok(document.querySelector('#agent-selector-panel') === null, 'the dropdown is rendered by app.js next to the shell');
  assert.match(h.feature.renderAgentSelectorDropdown(), /data-action="select-chat-agent"/);
  await h.click('select-chat-agent', '<button data-action="select-chat-agent" data-agent-id="research"></button>');
  assert.deepEqual(h.calls.at(-1), ['/api/chats/update', 'POST', { chatId: 'chat-a', patch: { agentId: 'research' } }]);
  assert.equal(h.preserved.length, 1, 'the running drafts survive the Agent switch');
  assert.equal(h.chat().agentSelectorOpen, false);
  assert.equal(h.chat().agentSelectionSaving, false);
  await h.click('toggle-agent-selector');
  const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape' });
  assert.equal(h.feature.handleAgentSelectorKeydown(escape, document.body), true);
  assert.equal(h.chat().agentSelectorOpen, false);
  assert.equal(h.feature.handleAgentSelectorKeydown(escape, document.body), false, 'closed: not handled');
  // Attachment menu: toggle, outside click closes without a render of its own.
  await h.click('toggle-composer-attachment-menu');
  assert.ok(document.querySelector('.composer-attachment-menu'));
  assert.equal(h.feature.closeAttachmentMenuOnOutsideClick({ target: document.querySelector('.composer-bottom-left') }), false);
  assert.equal(h.feature.closeAttachmentMenuOnOutsideClick({ target: document.body }), true);
  assert.equal(h.chat().composerAttachmentMenuOpen, false);
  // Message actions reach the TTS and chat lifecycle helpers that stay in app.js.
  await h.click('speak-message', '<button data-action="speak-message" data-message-id="r"></button>');
  await h.click('delete-active-chat');
  assert.deepEqual(h.spoken, ['r']);
  assert.deepEqual(h.deleted, ['chat-a']);
  // On the overview the choice is the next new chat's Agent (a fresh install:
  // the context is bound once per install).
  const home = harness({ overview: true });
  await home.click('select-chat-agent', '<button data-action="select-chat-agent" data-agent-id="research"></button>');
  assert.equal(home.state.newChat.agentId, 'research');
  assert.deepEqual(home.calls, []);
});

test('send pipeline: optimistic message, streamed deltas patch the bubble in place, done applies the returned page', async () => {
  const sse = server();
  const h = harness();
  h.chat().composer = 'hello there';
  const sending = h.send();
  await flush();
  assert.equal(sse.streams.length, 1);
  const body = sse.streams[0].body;
  assert.equal(body.chatId, 'chat-a');
  assert.equal(body.content, 'hello there');
  assert.equal(body.mode, 'chat');
  assert.ok(body.requestId);
  assert.equal(h.chat().composer, '', 'the draft leaves the composer when it is sent');
  assert.equal(h.chat().sending, true);
  assert.equal(h.state.modelPickerOpen, false, 'sending closes the model picker');
  assert.equal(h.state.bootstrap.activeChat.messages.at(-1).content, 'hello there', 'optimistic user message');
  assert.equal(h.feature.isSending(), true);
  assert.match(h.feature.thinkingLabel(), /^正在提交/);
  sse.send('started', { requestId: body.requestId, runId: 'run-1' });
  sse.send('delta', { delta: 'Hel' });
  await flush();
  const bubble = () => document.querySelector('.message-list .message.assistant.is-streaming .message-bubble');
  assert.equal(bubble().textContent.trim(), 'Hel');
  const rendersAfterFirstDelta = h.renders();
  const article = document.querySelector('.message.assistant.is-streaming');
  sse.send('delta', { delta: 'lo' });
  sse.send('delta', { delta: ' world' });
  await flush();
  assert.equal(bubble().textContent.trim(), 'Hello world');
  assert.equal(h.renders(), rendersAfterFirstDelta, 'later deltas patch the bubble without a full render');
  assert.equal(document.querySelector('.message.assistant.is-streaming'), article, 'same DOM node');
  const finished = page({ marker: 'after', chats: [chat('chat-a', [message('q', 'user', 'hi'), message('r', 'assistant', 'hello'), message('u', 'user', 'hello there'), message('a', 'assistant', 'Hello world')]), chat('chat-b')] });
  sse.send('done', { requestId: body.requestId, bootstrap: finished });
  sse.close();
  await sending;
  assert.equal(h.applied.at(-1).marker, 'after');
  assert.equal(h.chat().sending, false);
  assert.equal(h.chat().streamingChatId, null);
  assert.equal(h.chat().composerRetry, null);
  assert.equal(document.querySelector('.is-streaming'), null);
  assert.equal(document.querySelectorAll('.message-list article.message').length, 4);
});

test('done with unusedSupplements sends them as the next message of the same chat', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sse = server();
  const h = harness();
  h.chat().composer = 'write a summary';
  const sending = h.send();
  await flush();
  // Typed while the reply runs, in the same chat: a supplement, not a new message.
  h.chat().composer = 'also mention costs';
  await h.send();
  assert.deepEqual(sse.supplements, [{ chatId: 'chat-a', content: 'also mention costs' }]);
  assert.equal(h.chat().composer, '');
  assert.deepEqual(h.chat().supplementsSent, ['also mention costs']);
  assert.match(document.querySelector('.run-steps-note').textContent, /补充已送达.*also mention costs/);
  sse.send('done', { unusedSupplements: ['also mention costs'] });
  sse.close();
  await sending;
  assert.equal(h.refreshes(), 1, 'no page data in done: reload quietly');
  assert.deepEqual(h.chat().supplementsSent, []);
  assert.equal(sse.streams.length, 1);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(sse.streams.length, 2, 'the unused supplement goes out as the next message');
  assert.equal(sse.streams[1].body.chatId, 'chat-a');
  assert.equal(sse.streams[1].body.content, 'also mention costs');
  assert.notEqual(sse.streams[1].body.requestId, sse.streams[0].body.requestId);
  sse.send('done', {});
  sse.close();
  await flush();
  assert.equal(h.chat().sending, false);
});

test('stop aborts the stream, finishes the live scene locally, reloads and silences TTS', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sse = server();
  const h = harness();
  h.chat().composer = 'long task';
  const sending = h.send();
  await flush();
  sse.send('started', { requestId: sse.streams[0].body.requestId, runId: 'run-9' });
  sse.send('delta', { delta: 'Work' });
  await flush();
  await h.click('stop-send');
  await sending;
  assert.deepEqual(h.cancelled, [['run-9', { chatId: 'chat-a' }]]);
  assert.equal(h.refreshes(), 1);
  assert.deepEqual(h.calls.map(([path]) => path), ['/api/tts/queue-clear', '/api/tts/speak-stop']);
  assert.deepEqual(h.errors, [], 'a stop is not an error');
  assert.equal(h.chat().composer, '', 'a stopped send keeps the draft cleared');
  assert.equal(h.chat().sending, false);
  assert.equal(h.chat().sendAbortController, null);
  t.mock.timers.tick(800);
  t.mock.timers.tick(1700);
  await flush();
  assert.equal(h.refreshes(), 3, 'scenes and the tool-trace message are re-read twice after the stop');
  await h.click('stop-send');
  assert.equal(h.cancelled.length, 1, 'nothing running: stop is a no-op');
});

test('a stopped or failed turn returns its supplements to the composer instead of dropping them', async () => {
  const sse = server();
  const h = harness();
  h.chat().composer = 'first';
  const sending = h.send();
  await flush();
  h.chat().composer = 'and second';
  await h.send();
  h.chat().composer = 'still typing';
  sse.send('error', { code: 'MODEL_ERROR', message: 'upstream failed' });
  await sending;
  assert.equal(h.chat().composer, 'first\n补充：and second', 'restored draft plus the returned supplement');
  assert.equal(h.errors.length, 1);
});

test('a failed send restores the draft, attachments and voice ids, keeps the retry identity for that chat only', async () => {
  const sse = server();
  const h = harness();
  const attachment = { id: 'img', kind: 'image', url: 'data:image/png;base64,AAAA', title: 'a.png' };
  Object.assign(h.chat(), { composer: 'deploy it', composerAttachments: [attachment], composerVoiceTranscript: 'spoken', composerVoiceAttachmentId: 'img' });
  const sending = h.send();
  await flush();
  assert.equal(h.chat().composerVoiceTranscript, null, 'voice ids are captured, then cleared, for the send');
  assert.equal(h.chat().composerVoiceAttachmentId, null);
  sse.send('error', { code: 'REQUEST_INTERRUPTED', runId: 'run-1' });
  await sending;
  assert.equal(h.chat().composer, 'deploy it');
  assert.deepEqual(h.chat().composerAttachments, [attachment]);
  assert.equal(h.chat().composerVoiceTranscript, 'spoken');
  assert.equal(h.chat().composerVoiceAttachmentId, 'img');
  assert.equal(h.chat().composerRetry.chatId, 'chat-a');
  assert.equal(h.chat().composerRetry.interrupted, true);
  assert.equal(h.errors.length, 1);
  assert.ok(document.querySelector('[data-action="restart-interrupted-send"]'), 'the interrupted banner shows in the chat that failed');
  // Draft isolation per chat: the banner and the retry identity belong to chat A.
  h.view('chat-b');
  assert.equal(document.querySelector('[data-action="restart-interrupted-send"]'), null);
  const resend = h.send();
  await flush();
  assert.equal(sse.streams[1].body.chatId, 'chat-b');
  assert.notEqual(sse.streams[1].body.requestId, sse.streams[0].body.requestId, 'the same text in another chat is a new request');
  sse.send('done', {});
  sse.close();
  await resend;
});

test('restart-interrupted-send drops the retry identity and sends the draft as a new request', async () => {
  const sse = server();
  const h = harness();
  h.chat().composer = 'retry me';
  const first = h.send();
  await flush();
  sse.send('error', { code: 'REQUEST_INTERRUPTED' });
  await first;
  const again = h.click('restart-interrupted-send');
  await flush();
  assert.equal(sse.streams.length, 2);
  assert.equal(sse.streams[1].body.content, 'retry me');
  assert.notEqual(sse.streams[1].body.requestId, sse.streams[0].body.requestId);
  sse.send('done', {});
  sse.close();
  await again;
});

test('parallel tool permissions stay independently answerable', async () => {
  const sse = server();
  const h = harness();
  h.chat().composer = 'make a pdf';
  const sending = h.send();
  await flush();
  for (const requestId of ['one', 'two', 'two']) sse.send('tool_permission', { requestId, toolId: 'pdf', args: {} });
  sse.send('tool_permission', { requestId: 'file-1', kind: 'file_safety', operation: 'delete', path: '/tmp/x' });
  await flush();
  assert.deepEqual(h.state.permissions.map(p => [p.kind, p.requestId]), [['tool', 'one'], ['tool', 'two'], ['file_safety', 'file-1']]);
  assert.deepEqual(h.state.permissions[2].payload, { requestId: 'file-1', kind: 'file_safety', path: '/tmp/x' });
  assert.equal(h.feature.thinkingLabel().startsWith('等待你的确认'), true);
  sse.send('done', {});
  sse.close();
  await sending;
  assert.deepEqual(h.state.permissions, [], 'the queue empties when the turn ends');
});

test('disconnect preserves the voice transcript; an unchanged resend reuses the request identity and transcript linkage', async () => {
  const sse = server();
  const h = harness();
  Object.assign(h.chat(), { composer: 'hello', composerAttachments: [{ id: 'audio', kind: 'audio' }], composerVoiceTranscript: 'spoken text', composerVoiceAttachmentId: 'audio' });
  let sending = h.send();
  await flush();
  sse.close();
  await sending;
  assert.match(h.errors[0], /./);
  assert.equal(h.chat().composerVoiceTranscript, 'spoken text');
  assert.equal(h.chat().composerVoiceAttachmentId, 'audio');
  sending = h.send();
  await flush();
  sse.close();
  await sending;
  const [first, second] = sse.streams.map(stream => stream.body);
  assert.equal(first.requestId, second.requestId);
  assert.deepEqual(first.extractedMedia, second.extractedMedia);
  assert.deepEqual(first.extractedMedia, [{ attachmentId: 'audio', kind: 'transcript', text: 'spoken text', metadata: { source: 'speech-recognition', fileName: 'voice-message.wav' } }]);
  h.chat().composer = 'changed';
  sending = h.send();
  await flush();
  sse.close();
  await sending;
  assert.notEqual(sse.streams[2].body.requestId, second.requestId);
});

test('a new chat created before a disconnect remains the retry target even when refresh also fails', async () => {
  const sse = server();
  const created = page({ chats: [chat('created-chat')], selected: 'created-chat' });
  const h = harness({ overview: true, bootstrap: page({ chats: [], selected: null }), responses: { '/api/chats': created } });
  h.state.newChat = { agentId: 'research', projectId: 'p1', artifactIds: ['k1'], model: { model: 'gpt-5' } };
  h.chat().composer = 'new topic';
  h.failRefresh(new Error('still offline'));
  let sending = h.send();
  await flush();
  assert.deepEqual(h.calls[0], ['/api/chats', 'POST', { mode: 'chat', projectId: 'p1', agentId: 'research', modelSelection: { model: 'gpt-5' }, contextArtifactIds: ['k1'] }]);
  sse.close();
  await sending;
  assert.equal(h.state.bootstrap.settings.selectedChatId, 'created-chat', 'the failed refresh keeps the created chat');
  sending = h.send();
  await flush();
  sse.close();
  await sending;
  assert.equal(sse.streams[0].body.chatId, 'created-chat');
  assert.equal(sse.streams[1].body.chatId, 'created-chat');
  assert.equal(sse.streams[0].body.requestId, sse.streams[1].body.requestId);
});

test('completed delivery clears the retry identity; a deliberate new message gets a new id', async () => {
  const sse = server();
  const h = harness();
  h.chat().composer = 'hello';
  let sending = h.send();
  await flush();
  sse.close();
  await sending;
  sending = h.send();
  await flush();
  sse.send('done', {});
  sse.close();
  await sending;
  assert.equal(h.chat().composerRetry, null);
  h.chat().composer = 'hello';
  sending = h.send();
  await flush();
  assert.notEqual(sse.streams[1].body.requestId, sse.streams[2].body.requestId);
  sse.send('done', {});
  sse.close();
  await sending;
});

test('draft isolation per chat: a supplement only goes to the chat whose reply is running', async () => {
  const sse = server();
  const h = harness();
  h.chat().composer = 'question for a';
  const sending = h.send();
  await flush();
  h.view('chat-b');
  h.chat().composer = 'meant for b';
  await h.send();
  assert.deepEqual(sse.supplements, [], 'not delivered to the running reply of chat A');
  assert.equal(sse.streams.length, 1, 'and not sent while a reply runs');
  assert.equal(h.chat().composer, 'meant for b', 'the draft stays in the composer');
  h.view('chat-a');
  await h.send();
  assert.deepEqual(sse.supplements, [{ chatId: 'chat-a', content: 'meant for b' }]);
  sse.send('done', {});
  sse.close();
  await sending;
});

test('createChat clears the draft, attachments and both voice fields only after the chat exists', async () => {
  const h = harness({ responses: { '/api/chats': new Error('offline') } });
  Object.assign(h.chat(), { composer: 'draft', composerAttachments: [{ id: 'private-file' }], composerVoiceTranscript: 'spoken', composerVoiceAttachmentId: 'private-file' });
  await assert.rejects(h.feature.createChat(), /offline/);
  assert.equal(h.chat().composerAttachments.length, 1);
  assert.equal(h.chat().composerVoiceTranscript, 'spoken');
  h.context.api = null;
  const ok = harness({ responses: { '/api/chats': page({ marker: 'created' }) } });
  Object.assign(ok.chat(), { composer: 'draft', composerAttachments: [{ id: 'private-file' }], composerVoiceTranscript: 'spoken', composerVoiceAttachmentId: 'private-file', composerHistoryIndex: 2 });
  await ok.feature.createChat({ projectId: 'p2', mode: 'code', agentId: 'research' });
  assert.deepEqual(ok.calls[0][2], { mode: 'code', projectId: 'p2', agentId: 'research', modelSelection: null, contextArtifactIds: [] });
  assert.equal(ok.applied[0].marker, 'created');
  assert.equal(ok.chat().composer, '');
  assert.deepEqual(ok.chat().composerAttachments, []);
  assert.equal(ok.chat().composerVoiceTranscript, null);
  assert.equal(ok.chat().composerVoiceAttachmentId, null);
  assert.equal(ok.chat().composerHistoryIndex, -1);
});

test('the new-chat home reset clears the draft, attachments, menus and both voice fields', () => {
  const h = harness();
  Object.assign(h.chat(), { composer: 'draft', composerAttachments: [{ id: 'audio' }], composerVoiceTranscript: 'spoken', composerVoiceAttachmentId: 'audio', composerAttachmentMenuOpen: true, composerDragActive: true });
  h.feature.resetComposerForNewChatHome();
  assert.equal(h.chat().composer, '');
  assert.deepEqual(h.chat().composerAttachments, []);
  assert.equal(h.chat().composerVoiceTranscript, null);
  assert.equal(h.chat().composerVoiceAttachmentId, null);
  assert.equal(h.chat().composerAttachmentMenuOpen, false);
  assert.equal(h.chat().composerDragActive, false);
  assert.equal(h.chat().voice.status, 'ready', 'the bridge supports dictation, so the mic is ready again');
});

test('dictation inserts into the existing draft and never sends by itself', async () => {
  const sse = server();
  const h = harness();
  h.chat().composer = 'draft';
  bridgeMessages.length = 0;
  await h.click('toggle-voice-input');
  const [{ action, sessionID, language }] = bridgeMessages;
  assert.deepEqual([action, language], ['toggle', 'zh-CN']);
  assert.equal(h.feature.voiceCaptureActive(), true);
  h.feature.handleVoiceBridgeEvent({ sessionID, status: 'listening', recording: true, partial: '你' });
  h.feature.handleVoiceBridgeEvent({ sessionID, status: 'ready', finalText: '你好' });
  assert.equal(h.chat().composer, 'draft\n你好');
  assert.equal(h.feature.voiceCaptureActive(), false);
  assert.equal(sse.streams.length, 0);
  assert.deepEqual(h.spoken, ['stop'], 'starting dictation stops TTS');
});

test('composer listeners: typing opens the slash palette, Enter picks a skill, history and Enter-to-send', async () => {
  const sse = server();
  const h = harness({ bootstrap: { ...page(), settings: { ...page().settings, promptHistory: [{ content: 'older prompt' }] } } });
  const composer = () => document.querySelector('#composer');
  composer().value = '/pd';
  assert.equal(h.feature.handleComposerInput(composer()), true);
  assert.equal(h.chat().composer, '/pd');
  assert.equal(h.chat().slashPalette.open, true);
  assert.equal(h.feature.handleComposerInput(document.createElement('input')), false, 'other inputs fall through');
  const key = (k, extra = {}) => new dom.window.KeyboardEvent('keydown', { key: k, ...extra });
  assert.equal(h.feature.handleComposerKeydown(key('Enter'), composer()), true);
  assert.equal(h.chat().composer, '/pdf-maker ');
  assert.equal(h.chat().slashPalette.open, false);
  h.chat().composer = '';
  const empty = composer();
  empty.value = '';
  assert.equal(h.feature.handleComposerKeydown(key('ArrowUp'), empty), true);
  assert.equal(h.chat().composer, 'older prompt');
  assert.equal(h.feature.handleComposerKeydown(key('a'), composer()), false);
  const pending = h.feature.handleComposerKeydown(key('Enter'), composer());
  assert.equal(typeof pending.then, 'function', 'Enter returns the pending send for the listener to await');
  await flush();
  assert.equal(sse.streams[0].body.content, 'older prompt');
  sse.send('done', {});
  sse.close();
  await pending;
  assert.equal(h.feature.handleComposerKeydown(key('Enter', { shiftKey: true }), composer()), false, 'Shift+Enter is a newline');
});

test('thread: load earlier widens the window of the active chat; jump to latest re-enables auto-follow; tool traces render as records', async () => {
  const many = Array.from({ length: 70 }, (_, i) => message(`m${i}`, i % 2 ? 'assistant' : 'user', `message ${i}`));
  many.push(message('trace', 'assistant', '[工具轨迹] web_search', { kind: 'tool-trace', metadata: { toolTrace: { status: 'cancelled' } } }));
  const h = harness({ bootstrap: page({ chats: [chat('chat-a', many), chat('chat-b')] }) });
  assert.ok(document.querySelector('[data-action="thread-load-earlier"]'));
  const before = document.querySelectorAll('.message-list article.message').length;
  await h.click('thread-load-earlier');
  assert.equal(h.chat().threadWindow['chat-a'], 60);
  assert.equal(document.querySelectorAll('.message-list article.message').length, 71);
  assert.ok(before < 71);
  assert.equal(document.querySelector('[data-action="thread-load-earlier"]'), null);
  h.chat().threadAutoFollow = false;
  await h.click('scroll-thread-to-bottom');
  assert.equal(h.chat().threadAutoFollow, true);
  assert.equal(h.chat().lastKnownScrollTop, 0);
  const trace = document.querySelector('[data-message-id="trace"]');
  assert.ok(trace.classList.contains('is-tool-trace'));
  assert.ok(trace.querySelector('.tool-trace-body'));
  assert.equal(trace.querySelector('[data-action="speak-message"]'), null, 'a tool trace has nothing to read aloud');
  assert.ok(document.querySelector('[data-message-id="m69"] [data-action="speak-message"]'), 'a reply can be read aloud');
});

test('render hooks: thread scroll is restored only when the thread did not change; the composer keeps its scroll for an unchanged draft', () => {
  const sse = server();
  const h = harness();
  h.feature.syncThreadViewport();
  const unchanged = h.feature.captureThreadBeforeRender();
  assert.equal(unchanged.threadContentUnchanged, true);
  assert.equal(unchanged.vizAnchor, null, 'no viz card in this chat: no anchor loop');
  const scroller = document.querySelector('.thread-scroll-region');
  let written = null;
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => 0, set: value => { written = value; } });
  h.feature.restoreThreadScrollAfterRender({ ...unchanged, savedThreadScroll: 240 });
  assert.equal(written, 240);
  h.chat().streamingChatId = 'chat-a';
  h.chat().sending = true;
  h.chat().streamingAssistantText = 'growing';
  const changed = h.feature.captureThreadBeforeRender();
  assert.equal(changed.threadContentUnchanged, false, 'a growing reply lets syncThreadViewport scroll');
  written = null;
  h.feature.restoreThreadScrollAfterRender({ ...changed, savedThreadScroll: 240 });
  assert.equal(written, null);
  const composer = document.querySelector('#composer');
  composer.value = 'line';
  let composerTop = null;
  const saved = { value: 'line', top: 37 };
  Object.defineProperty(composer, 'scrollTop', { configurable: true, get: () => 0, set: value => { composerTop = value; } });
  h.feature.restoreComposerAfterRender(saved);
  assert.equal(composerTop, 37);
  composerTop = null;
  h.feature.restoreComposerAfterRender({ value: 'different', top: 37 });
  assert.notEqual(composerTop, 37, 'a changed draft keeps its own scroll');
  assert.equal(sse.streams.length, 0);
});

test('chat files toggle is handled before the dispatch, synchronously', () => {
  const h = harness();
  document.querySelector('#app').innerHTML = '<details class="chat-files-panel"><summary data-action="toggle-chat-files">对话文件</summary></details>';
  const summary = document.querySelector('summary');
  let prevented = false;
  const event = { preventDefault: () => { prevented = true; } };
  assert.equal(h.feature.handleChatFilesToggle('toggle-chat-files', summary, event), true);
  assert.equal(prevented, true);
  assert.equal(summary.parentElement.open, true);
  assert.equal(h.chat().chatFilesOpen, true);
  assert.equal(h.feature.handleChatFilesToggle('open-chat', summary, event), false);
});
