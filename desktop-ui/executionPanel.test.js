// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from './i18n.js';
setFixtureLanguage('zh-CN');
import { completionResult } from '../shared/agent/completion.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { updateNeuralWorkspace } from './neuralDom.js';
import { createExecutionScene, applyExecutionEvent, finishExecutionScene } from '../src/shared/executionScene.js';
// The panel and the war room import browser paths; point them at the source files.
const fileUrl = path => JSON.stringify(new URL(path, import.meta.url).href);
async function warRoomModule() {
  const code = (await readFile(new URL('./warRoom.js', import.meta.url), 'utf8'))
    .replace("'./i18n.js'", fileUrl('./i18n.js'))
    .replace("'/shared/executionScene.js'", fileUrl('../src/shared/executionScene.js'))
    .replace("'/shared/executionBoard.js'", fileUrl('../src/shared/executionBoard.js'))
    .replace("'/shared/warRoom.js'", fileUrl('../src/shared/warRoom.js'));
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}
async function loadPanel() {
  const source = (await readFile(new URL('./executionPanel.js', import.meta.url), 'utf8'))
    .replace("'./buttonStyles.js'", fileUrl('./buttonStyles.js'))
    .replace("'./html.js'", fileUrl('./html.js'))
    .replaceAll("'./i18n.js'", fileUrl('./i18n.js'))
    .replace("'/shared/executionScene.js'", fileUrl('../src/shared/executionScene.js'))
    .replace("'./executionDetails.js'", fileUrl('./executionDetails.js'))
    .replace("'/shared/executionBoard.js'", fileUrl('../src/shared/executionBoard.js'))
    .replace("'/shared/warRoom.js'", fileUrl('../src/shared/warRoom.js'))
    .replace("'./warRoom.js'", JSON.stringify(await warRoomModule()));
  // A fresh module per test: the panel keeps module state (its war room) per document.
  return import(`data:text/javascript;base64,${Buffer.from(`${source}\n// load ${++loads}`).toString('base64')}`);
}
let loads = 0;

test('war room keeps the chat markup apart, caps sources at ten, traces its numbers and projects selected images without new execution', async t => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost' });
  const originals = new Map();
  const install = (key, value) => { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  const calls = [];
  install('document', dom.window.document); install('localStorage', dom.window.localStorage);
  install('matchMedia', () => ({ matches: true })); install('setInterval', () => 0);
  install('fetch', async url => { calls.push(url); return { ok: true, json: async () => ({ scenes: [] }) }; });
  t.after(() => { dom.window.close(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const panel = await loadPanel();
  const app = document.querySelector('#app');
  const markup = `<div>${panel.renderExecutionPanel()}</div>`;
  updateNeuralWorkspace(app, markup);
  panel.syncExecutionPanel({ chat: { id: 'chat', messages: [] } });
  await new Promise(resolve => setImmediate(resolve));
  const scene = createExecutionScene({ runId: 'sources', chatId: 'chat', query: 'source test final' });
  applyExecutionEvent(scene, { sources: Array.from({ length: 14 }, (_, i) => ({ url: `https://example.test/source-${i}`, title: `Source ${i}`, appeared: true })) });
  panel.receiveExecutionScene(structuredClone(scene));
  // Layout A: the expanded task space is the war room, mounted once outside the chat markup.
  const room = document.querySelector('#execution-war-room');
  assert.ok(room);
  assert.equal(room.hidden, true, 'a run that only lists sources (no call, assignment or evaluation) does not open the war room by itself');
  document.querySelector('#execution-panel [data-execution-action="toggle"]').click();
  assert.equal(room.hidden, false);
  assert.match(room.querySelector('.war-status [data-war-trace="tokens"]').textContent, /输入 — token/, 'no response has reported usage: unknown, never shown as 0');
  const region = id => { room.querySelector('[data-war-back]')?.click(); room.querySelector(`[data-war-region="${id}"]`).click(); return room.querySelector('[data-cell="detail"]'); };
  const regionRow = id => [...room.querySelectorAll('.war-regions li')].find(li => li.querySelector(`[data-war-region="${id}"]`));
  region('search');
  assert.equal(room.querySelectorAll('a.execution-source').length, 5);
  assert.equal(room.querySelectorAll('a[data-priority="primary"]').length, 5);
  room.querySelector('[data-execution-action="more"]').click();
  assert.equal(room.querySelectorAll('a.execution-source').length, 10);
  assert.equal(room.querySelectorAll('a[data-priority="primary"]').length, 5);
  assert.equal(room.querySelectorAll('a[data-priority="secondary"]').length, 5);
  assert.equal(scene.sources.length, 14);
  room.querySelector('[data-war-back]').click();
  assert.equal(room.querySelectorAll('.war-regions li').length, 5, 'every region is listed, with its own count');
  assert.match(regionRow('compute').textContent, /无调用记录/);
  assert.match(room.querySelector('.war-sources').textContent, /14 条来源/);
  room.querySelector('[data-war-trace="sources"]').click();
  assert.equal(room.querySelectorAll('[data-cell="detail"] .war-trace li').length, 14, 'the number opens exactly the records it counts');
  updateNeuralWorkspace(app, markup);
  assert.equal(document.querySelector('#execution-war-room'), room, 're-rendering the chat leaves the war room and its WebGL alone');
  assert.ok([...room.querySelectorAll('a[href]')].every(a => a.dataset.externalUrl === a.href));

  applyExecutionEvent(scene, { sources: [{ url: 'https://example.test/source-13?utm_source=openai', title: 'source test final', citationUrl: 'https://example.test/source-13?utm_source=openai', citationLabel: 'Final reference' }] });
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'model:1', name: '模型请求', status: 'completed', output: '模型返回完成', api: { reportedModel: 'fixture-model', usage: { input: 1200, output: 80, reasoning: 30 }, durationMs: 1500 } });
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'model:1:summary', module: 'compute', channel: 'reasoning-summary', name: '公开摘要', status: 'completed', output: '核对输入条件\n\n整理证据' });
  finishExecutionScene(scene, { message: { id: 'answer' }, citedUrls: ['https://example.test/source-12', 'https://example.test/source-13?utm_source=openai'] });
  panel.receiveExecutionScene(structuredClone(scene));
  region('search');
  room.querySelector('[data-execution-action="more"]').click();
  assert.equal(room.querySelectorAll('a.execution-source').length, 5);
  assert.equal(room.querySelectorAll('a.execution-source[data-cited="true"]').length, 1, 'a relevant cited page is highlighted; a low-ranking citation does not reserve a slot');
  const finalLink = room.querySelector('a.execution-source[href="https://example.test/source-13?utm_source=openai"]');
  assert.ok(finalLink); assert.equal(finalLink.dataset.externalUrl, finalLink.href);
  assert.match(finalLink.textContent, /回答引用/);
  assert.match(finalLink.title, /未记录页面读取/);

  const bubble = document.createElement('article'); bubble.className = 'message'; bubble.dataset.messageId = 'answer'; document.body.append(bubble);
  panel.syncExecutionPanel({ chat: { id: 'chat', messages: [{ id: 'answer', role: 'assistant', metadata: { runId: 'sources' } }] } });
  region('create');
  assert.match(room.querySelector('.execution-pipeline').textContent, /模型请求/);
  assert.match(room.querySelector('.execution-pipeline').textContent, /本机对话渲染/);
  assert.ok(localStorage.getItem('melo-scene-presented:sources'));
  assert.match(room.querySelector('.execution-pipeline').textContent, /1,200/);
  region('compute');
  assert.match(room.querySelector('.execution-reasoning-records').textContent, /整理证据/);
  const readScroll = new dom.window.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
  room.querySelector('.execution-reasoning-records p').dispatchEvent(readScroll);
  assert.equal(readScroll.defaultPrevented, false, 'scrolling a reading list never zooms the space');
  room.querySelector('.execution-reasoning-records button').click();
  assert.match(room.querySelector('[data-cell="detail"]').textContent, /核对输入条件/);
  room.querySelector('[data-execution-action=close-inspector]').click();
  assert.match(room.querySelector('.war-status [data-war-trace="tokens"]').textContent, /输入 1,200 token/);
  room.querySelector('.war-status [data-war-trace="tokens"]').click();
  assert.match(room.querySelector('[data-cell="detail"] .war-count').textContent, /1 次模型请求 · 共 1,200 token/);
  assert.match(room.querySelector('[data-cell="detail"]').textContent, /历史回看/);
  assert.equal(scene.operations.length, 0, 'rendering and model events do not become fake tool calls');
  const imageScene = createExecutionScene({ runId: 'images', chatId: 'chat', query: '生成三张图片' });
  const artifacts = Array.from({ length: 5 }, (_, i) => ({ id: `img-${i}`, kind: 'image', url: `https://example.test/candidate-${i}.png`, title: `Candidate ${i}` }));
  applyExecutionEvent(imageScene, { artifacts }); finishExecutionScene(imageScene);
  imageScene.selectedImageIds = ['img-0', 'img-4', 'img-2']; panel.receiveExecutionScene(imageScene);
  const message = { role:'assistant', metadata: { runId: 'images' }, content: artifacts.map(a => `![candidate](${a.url})`).join('\n'), attachments: artifacts };
  const userMessage = {role:'user',metadata:{runId:'images'},content:'生成三张图片',attachments:[]};
  assert.equal(panel.selectedMessagePresentation(userMessage),userMessage,'Generated results must never be projected onto the user message');
  const projected = panel.selectedMessagePresentation(message);
  assert.deepEqual(projected.attachments.map(a => a.id), imageScene.selectedImageIds);
  assert.ok(!projected.content.includes('![')); assert.equal(message.attachments.length, 5);
  const limited = createExecutionScene({ runId: 'limit-delivery', chatId: 'chat', query: '当天活动' });
  panel.receiveExecutionScene(structuredClone(limited));
  const completion = completionResult({ goal: '当天活动', reply: '已确认活动，票量尚未核实', terminalReason: 'LIMIT_DELIVERED', locale: 'zh',
    task: { version: 1, limitDelivery: true, limitReason: 'ROUND_LIMIT', deliveryCheck: 'checked', decision: 'partial', requirements: [{ text: '票量', status: 'missing', evidenceIds: [] }] } });
  finishExecutionScene(limited, { message: { id: 'limited-answer', metadata: { completion } } });
  panel.receiveExecutionScene(structuredClone(limited));
  assert.match(document.querySelector('.execution-panel').textContent, /部分完成 · 已达轮数上限/);
  assert.doesNotMatch(document.querySelector('.execution-panel').textContent, /受阻 · 尚无目标完成证据/);
  // The old iPhone sent terminal tool receipts as model stages, even across sync.
  const phone = createExecutionScene({ runId: 'phone-history', chatId: 'chat', query: 'BIGBANG' });
  phone.pipeline = [
    { id: 'web:a', module: 'create', name: '网页 · 打开', status: 'completed', output: '已读取网页' },
    { id: 'web:b', module: 'create', name: '网页 · 截图', status: 'failed', output: '网页加载超时' },
    { id: 'history:excerpts', module: 'compute', name: '早期对话', status: 'completed' },
    { id: 'model:response', module: 'create', name: '模型请求', status: 'completed' }
  ];
  panel.receiveExecutionScene(phone);
  assert.doesNotMatch(region('create').textContent, /网页 ·/);
  region('search');
  assert.equal(room.querySelectorAll('.execution-search-trail button').length, 2);
  room.querySelector('[data-war-back]').click();
  assert.match(room.querySelector('.war-status').textContent, /工具调用 2/);
  assert.match(regionRow('search').textContent, /2 次调用/);
  assert.match(regionRow('tools').textContent, /无调用记录/, 'a page read is counted under 网页检索 only');
  assert.equal(phone.pipeline.length, 4, 'replaying an old receipt leaves the stored record intact');
  finishExecutionScene(phone);
  panel.receiveExecutionScene(phone);
  assert.ok(calls.every(url => String(url).startsWith('/api/chat/scenes?')));
  document.querySelector('#execution-panel [data-execution-action="toggle"]').click();
  assert.equal(room.hidden, true);
  await new Promise(resolve => setImmediate(resolve));
});

// Bug audit 2026-10-18 U4: after a client-side Stop no more scene events
// arrive, so the run stayed `running` and fed the next turn's live steps.
test('U4: cancelLiveScene finishes the run locally and re-reads the chat scenes later', async t => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost' });
  const originals = new Map();
  const install = (key, value) => { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  const calls = [], timers = [];
  install('document', dom.window.document); install('localStorage', dom.window.localStorage);
  install('matchMedia', () => ({ matches: true })); install('setInterval', () => 0);
  install('setTimeout', (fn, delay) => { timers.push({ fn, delay }); return timers.length; });
  install('fetch', async url => { calls.push(String(url)); return { ok: true, json: async () => ({ scenes: [] }) }; });
  t.after(() => { dom.window.close(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const panel = await loadPanel();
  updateNeuralWorkspace(document.querySelector('#app'), `<div>${panel.renderExecutionPanel()}</div>`);
  panel.syncExecutionPanel({ chat: { id: 'chat', messages: [] } });
  await new Promise(resolve => setImmediate(resolve));
  const scene = createExecutionScene({ runId: 'run-stop', chatId: 'chat', query: 'stop me' });
  applyExecutionEvent(scene, { kind: 'operation', id: 'op1', name: 'bash', module: 'tools', status: 'running', command: 'sleep 100' });
  panel.receiveExecutionScene(structuredClone(scene));
  assert.equal(panel.liveSceneFor('chat')?.runId, 'run-stop', 'the running scene is the chat\'s live scene');
  calls.length = 0; timers.length = 0;

  panel.cancelLiveScene('run-stop', { chatId: 'chat' });
  assert.equal(panel.liveSceneFor('chat'), null, 'a cancelled scene is never the live steps of the next turn');
  assert.deepEqual(timers.filter(x => x.delay === 800 || x.delay === 2500).map(x => x.delay), [800, 2500], 'scenes are re-read after 800 ms and once more at 2.5 s');
  for (const timer of timers.filter(x => x.delay === 800 || x.delay === 2500)) timer.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(url => url.startsWith('/api/chat/scenes?chatId=chat')).length, 2, 'both re-reads hit /api/chat/scenes for the chat');

  // The server's own cancelled scene (same or later sequence) replaces the local one.
  const serverScene = finishExecutionScene(structuredClone(scene), { status: 'cancelled', message: { id: 'trace-1' } });
  panel.receiveExecutionScene(serverScene);
  assert.equal(panel.liveSceneFor('chat'), null);
  // Unknown run ids and finished runs are no-ops apart from the re-read.
  timers.length = 0;
  panel.cancelLiveScene('nope', { chatId: 'chat' });
  assert.equal(timers.length, 2);
  panel.cancelLiveScene(null, { chatId: null });
  assert.equal(timers.length, 2, 'nothing to re-read without a chat');
});

// Layout A (2026-11-06): the user asked that the war room pop up while a reply
// is being worked on. It opens once per run, at the first observable step; a
// plain reply never opens it; a run the user closed stays closed; at the end
// it hands back to the chat unless the user has touched it.
test('the war room opens by itself at a live run\'s first observable step and hands back at the end', async t => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost' });
  const originals = new Map();
  const install = (key, value) => { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  const timers = [];
  install('document', dom.window.document); install('localStorage', dom.window.localStorage);
  install('matchMedia', () => ({ matches: true })); install('setInterval', () => 0);
  install('setTimeout', (fn, delay) => { timers.push({ fn, delay }); return timers.length; }); install('clearTimeout', id => { if (timers[id - 1]) timers[id - 1].cleared = true; });
  install('fetch', async () => ({ ok: true, json: async () => ({ scenes: [] }) }));
  t.after(() => { dom.window.close(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const panel = await loadPanel();
  updateNeuralWorkspace(document.querySelector('#app'), `<div>${panel.renderExecutionPanel()}</div>`);
  panel.syncExecutionPanel({ chat: { id: 'chat', messages: [] } });
  await new Promise(resolve => setImmediate(resolve));
  const room = document.querySelector('#execution-war-room');
  const collapse = () => { for (const timer of timers.filter(x => x.delay === 2600 && !x.cleared)) { timer.cleared = true; timer.fn(); } };

  const plain = createExecutionScene({ runId: 'plain', chatId: 'chat', query: '你好' });
  applyExecutionEvent(plain, { kind: 'pipeline', id: 'reply:render', name: '回答', status: 'running' });
  panel.receiveExecutionScene(structuredClone(plain));
  assert.equal(room.hidden, true, 'a plain reply never opens the war room');

  const run = createExecutionScene({ runId: 'work', chatId: 'chat', query: '查一下' });
  panel.receiveExecutionScene(structuredClone(run));
  assert.equal(room.hidden, true, 'nothing observable yet');
  applyExecutionEvent(run, { kind: 'operation', id: 'search', module: 'search', name: 'web_search', status: 'running', query: 'q' });
  panel.receiveExecutionScene(structuredClone(run));
  assert.equal(room.hidden, false, 'the first tool call opens it');
  assert.equal(document.documentElement.dataset.warRoom, 'true');
  finishExecutionScene(run, { message: { id: 'answer-1' } });
  panel.receiveExecutionScene(structuredClone(run));
  collapse();
  assert.equal(room.hidden, true, 'an untouched war room hands back to the chat when the run ends');

  const closed = createExecutionScene({ runId: 'closed', chatId: 'chat', query: '再查' });
  applyExecutionEvent(closed, { kind: 'pipeline', id: 'internal:1', name: '检索成员', role: 'research', status: 'running' });
  panel.receiveExecutionScene(structuredClone(closed));
  assert.equal(room.hidden, false, 'an assignment opens it too');
  room.querySelector('[data-war-close]').click();
  assert.equal(room.hidden, true);
  applyExecutionEvent(closed, { kind: 'operation', id: 'job-1:search', module: 'search', name: 'web_search', status: 'running' });
  panel.receiveExecutionScene(structuredClone(closed));
  assert.equal(room.hidden, true, 'a run the user closed is not opened again by itself');
  finishExecutionScene(closed, { message: { id: 'answer-2' } });
  panel.receiveExecutionScene(structuredClone(closed));

  const touched = createExecutionScene({ runId: 'touched', chatId: 'chat', query: '第三次' });
  applyExecutionEvent(touched, { kind: 'pipeline', id: 'task-evaluation:1', name: '评估', status: 'completed', output: '发现 0' });
  panel.receiveExecutionScene(structuredClone(touched));
  assert.equal(room.hidden, false, 'an evaluation opens it, and a new run opens it again');
  const now = room.querySelector('.war-now').textContent;
  assert.match(now, /评估 · 主 Agent · 发现 0$/, `the phase names the step once; the line adds who and what: ${now}`);
  room.querySelector('[data-war-trace="calls"]').click();
  finishExecutionScene(touched, { message: { id: 'answer-3' } });
  panel.receiveExecutionScene(structuredClone(touched));
  collapse();
  assert.equal(room.hidden, false, 'once the user has used the war room it stays until they leave');
  room.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(room.hidden, false, 'Escape first leaves the detail');
  // A prompt that needs the user (a call held for permission) is never covered:
  // the war room steps aside, keeps the user's place in the composer, and comes
  // back once the prompt is answered. Stepping aside is not a dismissal.
  room.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(room.hidden, true, 'then closes the war room');
  const composer = document.createElement('textarea'); document.body.append(composer); composer.focus();
  const held = createExecutionScene({ runId: 'held', chatId: 'chat', query: '改文件' });
  applyExecutionEvent(held, { kind: 'operation', id: 'read', module: 'files', name: 'file_read', status: 'running' });
  panel.receiveExecutionScene(structuredClone(held));
  assert.equal(room.hidden, false);
  await new Promise(resolve => setImmediate(resolve));
  for (const timer of timers.filter(x => x.delay === 0)) timer.fn();
  assert.equal(document.activeElement, composer, 'an automatic open never takes the keyboard');
  applyExecutionEvent(held, { kind: 'operation', id: 'write', module: 'files', name: 'file_write', status: 'waiting' });
  panel.receiveExecutionScene(structuredClone(held));
  assert.equal(room.hidden, true, 'the war room steps aside for the permission prompt');
  applyExecutionEvent(held, { kind: 'operation', id: 'write', module: 'files', name: 'file_write', status: 'running' });
  panel.receiveExecutionScene(structuredClone(held));
  assert.equal(room.hidden, false, 'and comes back once the prompt is answered');
  // The same for a prompt the chat shows on its own (file safety, capability, task scope): it carries data-request-id.
  const prompt = document.createElement('button'); prompt.dataset.requestId = 'req-1'; document.body.append(prompt);
  applyExecutionEvent(held, { kind: 'operation', id: 'write', module: 'files', name: 'file_write', status: 'running', input: 'b.txt' });
  panel.receiveExecutionScene(structuredClone(held));
  assert.equal(room.hidden, true, 'a chat prompt waiting for an answer is never covered');
  document.querySelector('#execution-panel [data-execution-action="toggle"]').click();
  assert.equal(room.hidden, true); assert.equal(document.activeElement, prompt, 'opening by hand first takes the user to the prompt');
  prompt.remove();
  applyExecutionEvent(held, { kind: 'operation', id: 'write', module: 'files', name: 'file_write', status: 'completed' });
  panel.receiveExecutionScene(structuredClone(held));
  assert.equal(room.hidden, false, 'answered: the war room is back');
});
