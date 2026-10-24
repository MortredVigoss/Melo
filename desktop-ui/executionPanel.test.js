import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { updateNeuralWorkspace } from './neuralDom.js';
import { createExecutionScene, applyExecutionEvent, finishExecutionScene } from '../src/shared/executionScene.js';

test('panel reuses its live DOM, caps sources at ten and projects selected images without new execution', async t => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost' });
  const originals = new Map();
  const install = (key, value) => { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  const calls = [];
  install('document', dom.window.document); install('localStorage', dom.window.localStorage);
  install('matchMedia', () => ({ matches: true })); install('setInterval', () => 0);
  install('fetch', async url => { calls.push(url); return { ok: true, json: async () => ({ scenes: [] }) }; });
  t.after(() => { dom.window.close(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const source = (await readFile(new URL('./executionPanel.js', import.meta.url), 'utf8'))
    .replace("'./html.js'",JSON.stringify(new URL('./html.js',import.meta.url).href))
    .replace("'./i18n.js'",JSON.stringify(new URL('./i18n.js',import.meta.url).href))
    .replace("'/shared/executionScene.js'", JSON.stringify(new URL('../src/shared/executionScene.js', import.meta.url).href))
    .replace("'./executionDetails.js'", JSON.stringify(new URL('./executionDetails.js', import.meta.url).href))
    .replace("'./executionViewport.js'", JSON.stringify(new URL('./executionViewport.js', import.meta.url).href));
  const panel = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const app = document.querySelector('#app');
  const markup = `<div>${panel.renderExecutionPanel()}</div>`;
  updateNeuralWorkspace(app, markup);
  panel.syncExecutionPanel({ chat: { id: 'chat', messages: [] } });
  await new Promise(resolve => setImmediate(resolve));
  const scene = createExecutionScene({ runId: 'sources', chatId: 'chat', query: 'source test final' });
  applyExecutionEvent(scene, { sources: Array.from({ length: 14 }, (_, i) => ({ url: `https://example.test/source-${i}`, title: `Source ${i}`, appeared: true })) });
  panel.receiveExecutionScene(structuredClone(scene));
  document.querySelector('[data-module="search"]').click();
  assert.equal(document.querySelectorAll('a.execution-source').length, 5);
  assert.equal(document.querySelectorAll('a[data-priority="primary"]').length, 5);
  document.querySelector('[data-execution-action="more"]').click();
  assert.equal(document.querySelectorAll('a.execution-source').length, 10);
  assert.equal(document.querySelectorAll('a[data-priority="primary"]').length, 5);
  assert.equal(document.querySelectorAll('a[data-priority="secondary"]').length, 5);
  assert.equal(scene.sources.length, 14);
  const stage = document.querySelector('.execution-panel-stage');
  assert.equal(document.querySelectorAll('.execution-module').length, 5);
  assert.equal(stage.dataset.wide, 'false');
  stage.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }));
  assert.equal(stage.dataset.wide, 'true', 'zooming out exposes all five modules without changing the selected results');
  assert.equal(stage.style.getPropertyValue('--detail-height'), '0px', 'the overall view fits its viewport rather than retaining a tall source-list plane');
  assert.equal(document.querySelectorAll('a.execution-source').length, 10);
  document.querySelector('[data-execution-action=zoom-in]').click();
  assert.equal(stage.dataset.wide, 'false');
  assert.notEqual(stage.style.getPropertyValue('--detail-height'), '0px', 'zooming back restores readable source rows');
  document.querySelector('[data-execution-action=overview]').click();
  assert.equal(stage.dataset.zoom, '1.000');
  assert.equal(document.querySelectorAll('.execution-module').length, 5);
  assert.equal(document.querySelector('[data-module=compute] small').textContent, '无调用记录');
  const labels = document.querySelector('.execution-labels');
  updateNeuralWorkspace(app, markup);
  assert.equal(document.querySelector('.execution-labels'), labels);
  assert.ok([...document.querySelectorAll('a.execution-source')].every(a => a.dataset.externalUrl === a.href));

  applyExecutionEvent(scene, { sources: [{ url: 'https://example.test/source-13?utm_source=openai', title: 'source test final', citationUrl: 'https://example.test/source-13?utm_source=openai', citationLabel: 'Final reference' }] });
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'model:1', name: '模型请求', status: 'completed', output: '模型返回完成', api: { reportedModel: 'fixture-model', usage: { input: 1200, output: 80, reasoning: 30 }, durationMs: 2345 } });
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'model:1:summary', module: 'compute', channel: 'reasoning-summary', name: '公开摘要', status: 'completed', output: '核对输入条件\n\n整理证据' });
  finishExecutionScene(scene, { message: { id: 'answer' }, citedUrls: ['https://example.test/source-12', 'https://example.test/source-13?utm_source=openai'] });
  panel.receiveExecutionScene(structuredClone(scene));
  document.querySelector('[data-module="search"]').click();
  document.querySelector('[data-execution-action="more"]').click();
  assert.equal(document.querySelectorAll('a.execution-source').length, 5);
  assert.equal(document.querySelectorAll('a[data-cited="true"]').length, 1, 'a relevant cited page is highlighted; a low-ranking citation does not reserve a slot');
  const finalLink = document.querySelector('a[href="https://example.test/source-13?utm_source=openai"]');
  assert.ok(finalLink); assert.equal(finalLink.dataset.externalUrl, finalLink.href);
  assert.match(finalLink.textContent, /回答引用/);
  assert.match(finalLink.title, /未记录页面读取/);

  const bubble = document.createElement('article'); bubble.className = 'message'; bubble.dataset.messageId = 'answer'; document.body.append(bubble);
  panel.syncExecutionPanel({ chat: { id: 'chat', messages: [{ id: 'answer', role: 'assistant', metadata: { runId: 'sources' } }] } });
  document.querySelector('[data-module="create"]').click();
  assert.match(document.querySelector('.execution-pipeline').textContent, /模型请求/);
  assert.match(document.querySelector('.execution-pipeline').textContent, /本机聊天渲染/);
  assert.ok(localStorage.getItem('melo-scene-presented:sources'));
  assert.match(document.querySelector('.execution-pipeline').textContent, /1,200/);
  document.querySelector('[data-module=compute]').click();
  assert.match(document.querySelector('.execution-reasoning-records').textContent, /整理证据/);
  const beforeReading = stage.dataset.zoom;
  const readScroll = new dom.window.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
  document.querySelector('.execution-reasoning-records p').dispatchEvent(readScroll);
  assert.equal(readScroll.defaultPrevented, false); assert.equal(stage.dataset.zoom, beforeReading);
  document.querySelector('.execution-reasoning-records button').click();
  assert.equal(document.querySelector('.execution-inspector').hidden, false);
  assert.match(document.querySelector('.execution-inspector').textContent, /核对输入条件/);
  document.querySelector('[data-execution-action=close-inspector]').click();
  document.querySelector('[data-execution-action=overview]').click();
  assert.match(document.querySelector('.execution-signal').textContent, /历史回看/);
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
  assert.ok(calls.every(url => String(url).startsWith('/api/chat/scenes?')));
  document.querySelector('[data-execution-action="toggle"]').click();
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
  const source = (await readFile(new URL('./executionPanel.js', import.meta.url), 'utf8'))
    .replace("'./html.js'",JSON.stringify(new URL('./html.js',import.meta.url).href))
    .replace("'./i18n.js'",JSON.stringify(new URL('./i18n.js',import.meta.url).href))
    .replace("'/shared/executionScene.js'", JSON.stringify(new URL('../src/shared/executionScene.js', import.meta.url).href))
    .replace("'./executionDetails.js'", JSON.stringify(new URL('./executionDetails.js', import.meta.url).href))
    .replace("'./executionViewport.js'", JSON.stringify(new URL('./executionViewport.js', import.meta.url).href));
  const panel = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
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
