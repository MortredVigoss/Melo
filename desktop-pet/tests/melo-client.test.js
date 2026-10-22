'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MeloClient, parseEventStreamBlock } = require('../melo-client.cjs');

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const frame = (event, payload) => `event: ${event}\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
const finalFrame = (text = 'Melo 原文', extra = {}) => frame('done', { assistantMessage: { id: 'reply-1', content: text, metadata: { modelResponses: [{ simulated: false }] } }, ...extra });

function fixture({ state: initialState = { chatId: 'main-chat' }, chats = [{ id: 'main-chat', agentId: 'main' }], activeChat, selectedChat, stream = finalFrame(), onRequest } = {}) {
  let state = { ...initialState };
  const requests = [], events = [];
  const client = new MeloClient({
    readState: () => state,
    writeState: patch => { state = { ...state, ...patch }; },
    emit: event => { events.push(event); },
    fetchImpl: async (url, options = {}) => {
      const route = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : undefined;
      const request = { route, body, signal: options.signal };
      requests.push(request);
      const custom = await onRequest?.(request);
      if (custom) return custom;
      if (route === '/api/bootstrap') return json({ chats, activeChat });
      if (route === '/api/settings') return json({ activeChat: selectedChat });
      if (route === '/api/chats') return json({ activeChat: { id: 'created-main-chat', agentId: 'main' } });
      if (route === '/api/chat/send/stream') return typeof stream === 'string' ? new Response(stream) : stream(request);
      if (route.endsWith('/permission-response') || route.endsWith('/respond')) return json({ ok: true });
      throw new Error(`Unexpected route: ${route}`);
    },
  });
  return { client, requests, events, get state() { return state; } };
}

function liveStream(request) {
  let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }));
  request.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
  return {
    response,
    send(event, payload) { controller.enqueue(new TextEncoder().encode(frame(event, payload))); },
    finish(text = '完成') { controller.enqueue(new TextEncoder().encode(finalFrame(text))); controller.close(); },
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('uses the ordinary main chat endpoint with exactly the user input, and preserves the final reply', async () => {
  const question = '  今天的天气？\n请查看实际信息。  ';
  const answer = '  **原样回答**\n\n有中文、emoji 🐳 和末尾空格。  ';
  const f = fixture({ state: { chatId: 'main-chat', city: 'Do not inject this' }, stream: frame('delta', { delta: 'intermediate' }) + finalFrame(answer) });
  const result = await f.client.send(question);
  const sent = f.requests.find(request => request.route === '/api/chat/send/stream').body;
  assert.deepEqual(Object.keys(sent).sort(), ['attachments', 'chatId', 'content', 'mode', 'requestId']);
  assert.equal(sent.content, question);
  assert.equal(sent.chatId, 'main-chat');
  assert.equal(sent.mode, 'chat');
  assert.deepEqual(sent.attachments, []);
  assert.equal(result.text, answer);
  assert.deepEqual(f.state.lastReply, result);
  assert.equal(result.source, 'melo');
  assert.equal(result.modelResponses[0].simulated, false);
  assert.equal(f.events.find(event => event.event === 'delta').payload.delta, 'intermediate');
  assert.equal(f.client.busy, false);
});

test('a stale or persona chat creates a separate unscoped main-agent chat and persists its identity', async () => {
  const f = fixture({ state: { chatId: 'winter-chat', skin: 'winter' }, chats: [{ id: 'winter-chat', agentId: 'custom-1' }] });
  const first = await f.client.send('one');
  assert.equal(first.chatId, 'created-main-chat');
  assert.deepEqual(f.requests.find(request => request.route === '/api/chats').body, { mode: 'chat', agentId: 'main', projectId: null });
  assert.equal(f.state.chatId, 'created-main-chat');
  assert.equal(f.state.skin, 'winter');
});

test('actual Melo sidebar shape omits agentId: the active main conversation is reused', async () => {
  const f = fixture({ chats: [{ id: 'main-chat', title: 'Existing chat', mode: 'chat', messageCount: 2 }], activeChat: { id: 'main-chat', agentId: 'main', messages: [] } });
  assert.equal((await f.client.send('first follow-up')).chatId, 'main-chat');
  assert.equal((await f.client.send('second follow-up')).chatId, 'main-chat');
  assert.equal(f.requests.filter(request => request.route === '/api/chats').length, 0);
  assert.equal(f.requests.filter(request => request.route === '/api/settings').length, 0);
});

test('a nonactive summary is selected and checked against full details before reuse', async () => {
  const f = fixture({ chats: [{ id: 'main-chat', title: 'Existing main chat' }], activeChat: { id: 'other-chat', agentId: 'custom-1' }, selectedChat: { id: 'main-chat', agentId: 'main' } });
  assert.equal((await f.client.send('follow-up')).chatId, 'main-chat');
  assert.deepEqual(f.requests.find(request => request.route === '/api/settings').body, { selectedChatId: 'main-chat', activeView: 'chat' });
  assert.equal(f.requests.filter(request => request.route === '/api/chats').length, 0);
});

test('missing agentId in a summary cannot silently reuse a custom persona or unknown detail', async () => {
  for (const selectedChat of [{ id: 'main-chat', agentId: 'custom-1' }, { id: 'main-chat' }, { id: 'wrong-chat', agentId: 'main' }]) {
    const f = fixture({ chats: [{ id: 'main-chat' }], activeChat: { id: 'other-chat', agentId: 'main' }, selectedChat });
    assert.equal((await f.client.send('hello')).chatId, 'created-main-chat');
    assert.deepEqual(f.requests.find(request => request.route === '/api/chats').body, { mode: 'chat', agentId: 'main', projectId: null });
  }
});

test('active full details outrank a stale summary reporting the main agent', async () => {
  const f = fixture({ chats: [{ id: 'main-chat', agentId: 'main' }], activeChat: { id: 'main-chat', agentId: 'custom-1' } });
  assert.equal((await f.client.send('hello')).chatId, 'created-main-chat');
});

test('parses split UTF-8 and CRLF frames without truncating or duplicating model content', async () => {
  const answer = '金冬天 🐳\n下一行';
  const bytes = new TextEncoder().encode(': keepalive\r\n\r\n' + frame('tool_calls_start', { calls: [{ id: 't1', name: 'web_search', arguments: {} }] }) + finalFrame(answer));
  const f = fixture({ stream: () => new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.subarray(index, index + 1));
    controller.close();
  } })) });
  assert.equal((await f.client.send('hello')).text, answer);
  assert.equal(f.events.filter(event => event.event === 'tool_calls_start').length, 1);
});

test('accepts a final event at EOF without a trailing separator; ignores SSE comments', async () => {
  assert.equal(parseEventStreamBlock(': heartbeat'), null);
  assert.deepEqual(parseEventStreamBlock('event: delta\ndata: {\ndata: "delta": "x"\ndata: }'), { event: 'delta', payload: { delta: 'x' } });
  const f = fixture({ stream: finalFrame('tail').trimEnd() });
  assert.equal((await f.client.send('hello')).text, 'tail');
});

test('an interrupted, invalid or error stream never becomes a successful fabricated answer', async () => {
  for (const stream of [frame('delta', { delta: 'partial' }), frame('done', { assistantMessage: { content: '' } }), 'event: delta\ndata: not-json\n\n']) {
    const f = fixture({ stream });
    await assert.rejects(f.client.send('hello'));
    assert.equal(f.state.lastReply, undefined);
    assert.equal(f.client.busy, false);
  }
  const f = fixture({ stream: frame('error', { code: 'TOOLS_UNAVAILABLE', error: 'Actual upstream error' }) });
  await assert.rejects(f.client.send('hello'), { message: 'Actual upstream error', code: 'TOOLS_UNAVAILABLE' });
});

test('tool execution and approvals are forwarded but never automatically granted', async () => {
  let live;
  const f = fixture({ stream: request => { live = liveStream(request); return live.response; } });
  const sending = f.client.send('do this');
  await tick();
  const payload = { requestId: 'permission-1', toolId: 'web_search', args: { query: 'user query' } };
  live.send('tool_permission', payload);
  live.send('execution_scene', { scene: { steps: [{ name: 'Search', status: 'waiting' }] } });
  await tick();
  assert.deepEqual(f.events.find(event => event.event === 'tool_permission').payload, payload);
  assert.equal(f.requests.length, 2);
  await assert.rejects(f.client.respondPermission('unknown', 'allow'), { code: 'PERMISSION_NOT_PENDING' });
  await assert.rejects(f.client.respondPermission('permission-1', 'always'), { code: 'INVALID_PERMISSION_DECISION' });
  await f.client.respondPermission('permission-1', 'allow');
  assert.deepEqual(f.requests.at(-1).body, { requestId: 'permission-1', granted: true, scope: 'once', toolId: 'web_search' });
  live.finish();
  await sending;
  await assert.rejects(f.client.respondPermission('permission-1', 'allow'), { code: 'PERMISSION_NOT_PENDING' });
});

test('file confirmation failure remains pending, and only user-entered confirmation is transmitted', async () => {
  let live, decisions = 0;
  const f = fixture({ stream: request => { live = liveStream(request); return live.response; }, onRequest: request => {
    if (request.route === '/api/tools/permission-response' && ++decisions === 1) return json({ ok: false, reason: 'CONFIRMATION_MISMATCH' });
  } });
  const sending = f.client.send('user-authorized task');
  await tick();
  live.send('tool_permission', { requestId: 'file-1', kind: 'file_safety', operation: 'delete', expectedConfirmation: 'delete exact thing' });
  await tick();
  await assert.rejects(f.client.respondPermission('file-1', 'allow'), { code: 'CONFIRMATION_MISMATCH' });
  assert.equal(f.requests.at(-1).body.confirmInput, '');
  await f.client.respondPermission('file-1', 'allow', { confirmInput: 'user typed this' });
  assert.deepEqual(f.requests.at(-1).body, { requestId: 'file-1', granted: true, scope: 'once', kind: 'file_safety', confirmInput: 'user typed this', persistent: false });
  live.finish();
  await sending;
});

test('capability requests use run-scoped decisions, honor closures and cannot grant another turn', async () => {
  let live;
  const f = fixture({ stream: request => { live = liveStream(request); return live.response; } });
  const sending = f.client.send('hello');
  await tick();
  live.send('capability_request', { requestId: 'cap-1' });
  live.send('capability_request', { requestId: 'cap-stale', turnRequestId: 'another-turn' });
  live.send('capability_request', { requestId: 'cap-closed' });
  live.send('capability_request_closed', { requestId: 'cap-closed', reason: 'expired' });
  await tick();
  await assert.rejects(f.client.respondPermission('cap-stale', 'allow'), { code: 'PERMISSION_NOT_PENDING' });
  await assert.rejects(f.client.respondPermission('cap-closed', 'allow'), { code: 'PERMISSION_NOT_PENDING' });
  await f.client.respondPermission('cap-1', 'allow');
  assert.equal(f.requests.at(-1).route, '/api/capability-requests/respond');
  assert.deepEqual(f.requests.at(-1).body, { requestId: 'cap-1', decision: 'run' });
  live.send('tool_permission', { requestId: 'deny-1', toolId: 'shell' });
  await tick();
  await f.client.respondPermission('deny-1', 'deny');
  assert.equal(f.requests.at(-1).body.granted, false);
  live.finish();
  await sending;
});

test('stop aborts the active request, clears pending approvals, and rejects a concurrent send', async () => {
  let live;
  const f = fixture({ stream: request => { live = liveStream(request); return live.response; } });
  const sending = f.client.send('hello');
  await tick();
  await assert.rejects(f.client.send('second'), { code: 'SEND_IN_PROGRESS' });
  live.send('tool_permission', { requestId: 'pending', toolId: 'shell' });
  await tick();
  f.client.stop();
  await assert.rejects(sending, { name: 'AbortError' });
  await assert.rejects(f.client.respondPermission('pending', 'allow'), { code: 'PERMISSION_NOT_PENDING' });
  assert.equal(f.state.lastReply, undefined);
  assert.equal(f.client.busy, false);
});

test('stop during bootstrap aborts preparation and never creates or sends a message', async () => {
  const f = fixture({ onRequest: request => request.route === '/api/bootstrap' ? new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }) : undefined });
  const sending = f.client.send('hello');
  await tick();
  f.client.stop();
  await assert.rejects(sending, { name: 'AbortError' });
  assert.deepEqual(f.requests.map(request => request.route), ['/api/bootstrap']);
});

test('connection errors retain upstream details and do not silently choose another backend', async () => {
  const f = fixture({ onRequest: request => request.route === '/api/bootstrap' ? json({ error: 'Melo unavailable' }, 503) : undefined });
  await assert.rejects(f.client.send('hello'), { message: 'Melo unavailable', status: 503 });
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.lastReply, undefined);
  assert.throws(() => new MeloClient({ baseUrl: 'https://remote.example' }), { code: 'INVALID_MELO_URL' });
  assert.throws(() => new MeloClient({ baseUrl: 'http://user:pass@localhost:43127' }), { code: 'INVALID_MELO_URL' });
});
