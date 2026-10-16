import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionScene, applyExecutionEvent, finishExecutionScene, visibleSceneSources, moduleActivity, sourceReadingLabel, moduleForOperation, requestedImageCount } from '../../shared/executionScene.js';
import {executeToolCalls} from '../../testSupport/directAgentFixture.js';
import { calculatorTool } from '../../tools/builtins/calculatorTool.js';
import { observeTool, observeNativeItem } from '../../tools/executionObservation.js';
import { createExecutionRecorder, readExecutionScene, selectSceneImage, saveExecutionScene, recoverSceneObservations } from './executionScenes.js';
import { readCodexSseResponse } from '../../providers/streams.js';
import { signWorkspaceFileUrl, verifySignedFileUrl } from '../../web/urlSigning.js';

test('source identity, unknown reading and five/ten limit survive citation selection', () => {
  const scene = createExecutionScene({ runId: 'r', query: 'orbital mission' });
  applyExecutionEvent(scene, { sources: Array.from({ length: 14 }, (_, i) => ({ url: `https://example.test/${i}`, title: i === 13 ? 'Orbital mission report' : `Result ${i}`, rank: i, appeared: true, reading: 'snippet' })) });
  applyExecutionEvent(scene, { sources: [{ url: 'https://example.test/13', accessed: true, reading: 'partial' }] });
  const ids = scene.sources.map(s => s.id);
  finishExecutionScene(scene, { citedUrls: ['https://example.test/11'] });
  assert.equal(scene.sources.length, 14);
  assert.equal(visibleSceneSources(scene).length, 5);
  assert.equal(visibleSceneSources(scene, true).length, 10);
  assert.equal(visibleSceneSources(scene)[0].url, 'https://example.test/13');
  assert.deepEqual(scene.sources.map(s => s.id), ids);
  assert.equal(scene.sources[11].cited, true);
  assert.match(sourceReadingLabel(scene.sources[13]), /部分正文/);
  assert.match(sourceReadingLabel(scene.sources[0]), /未记录页面读取/);
  assert.equal(applyExecutionEvent(scene, { sources: [{ url: 'https://invented.test' }] }), false);
});

test('executor observations preserve real parallel overlap and serial barriers', async () => {
  const scene = createExecutionScene({ runId: 'parallel' }), observed = [];
  let release, began = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const tool = { id: 'parallel-test', requiresPermission: false, isConcurrencySafe: true, run: async () => { began++; if (began === 2) release(); await gate; return { ok: true, output: 'done' }; } };
  const serial = { id: 'serial-test', requiresPermission: false, isConcurrencySafe: false, run: async () => ({ ok: true, output: 'saved' }) };
  await executeToolCalls([{ id: 'a', tool, args: {} }, { id: 'b', tool, args: {} }, { id: 'c', tool: serial, args: {} }], {
    sseEmitter: (type, event) => { if (type !== 'execution_event') return; applyExecutionEvent(scene, event); observed.push({ event, running: moduleActivity(scene, 'tools').running.length }); },
  });
  assert.ok(observed.some(s => s.running === 2));
  const serialStart = observed.findIndex(s => s.event.id === 'c' && s.event.status === 'running');
  assert.ok(['a', 'b'].every(id => observed.findIndex(s => s.event.id === id && s.event.status === 'completed') < serialStart));
});

test('real calculator produces expression/result; a text reply alone does not create a calculation', async () => {
  const scene = createExecutionScene({ runId: 'calculation' });
  assert.equal(moduleActivity(scene, 'compute').status, 'idle');
  await executeToolCalls([{ id: 'math', tool: calculatorTool, args: { action: 'math', expression: '15 * 15' } }], {
    sseEmitter: (type, event) => { if (type === 'execution_event') applyExecutionEvent(scene, event); },
  });
  assert.equal(scene.operations[0].expression, '15 * 15');
  assert.equal(scene.operations[0].result, '225');
  assert.equal(scene.operations[0].status, 'completed');
  assert.equal(moduleActivity(scene, 'search').status, 'idle');
});

test('native search events preserve actual action and optional sources without inventing read coverage', async () => {
  const scene = createExecutionScene({ runId: 'native' });
  const search = { id: 'search', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'test', sources: [{ url: 'https://example.test/a', title: 'A' }] } };
  const open = { id: 'open', type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://example.test/a' } };
  const blocks = [{ type: 'response.output_item.added', item: { ...search, status: 'in_progress' } },
    { type: 'response.output_item.done', item: search }, { type: 'response.output_item.done', item: open },
    { type: 'response.completed', response: { output: [search, open, { type: 'message', content: [{ type: 'output_text', text: 'Answer', annotations: [{ type: 'url_citation', url: 'https://example.test/a', title: 'A' }] }] }] } }];
  const response = new Response(blocks.map(b => `data: ${JSON.stringify(b)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const text = await readCodexSseResponse(response, { onExecutionEvent: event => applyExecutionEvent(scene, event) });
  assert.equal(scene.operations.length, 2);
  assert.equal(scene.sources.length, 1);
  assert.equal(scene.sources[0].accessed, true);
  assert.equal(scene.sources[0].reading, 'range-unknown');
  assert.match(text, /\[source: https:\/\/example.test\/a\]/);
  assert.equal(observeNativeItem({ type: 'reasoning' }), null);
});

test('durable cancelled scenes reopen without running tools; image selections persist and renew only signed paths', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-scene-')); t.after(() => rm(home, { recursive: true, force: true }));
  const recorder = createExecutionRecorder({ home, runId: 'run', requestId: 'request', chatId: 'chat' }, '生成三张图片');
  recorder.event({ kind: 'operation', id: 'work', name: 'calculator', module: 'compute', status: 'running' });
  await recorder.finish('cancelled');
  const restored = await readExecutionScene(home, 'run');
  assert.equal(restored.status, 'cancelled');
  assert.equal(restored.operations[0].status, 'cancelled');
  assert.deepEqual((await readExecutionScene(home, 'run')).events, restored.events);

  const imagePath = join(home, 'generated.png'); await writeFile(imagePath, 'test file bytes');
  const url = signWorkspaceFileUrl(imagePath);
  const event = observeTool({ id: 'image', name: 'image', args: { action: 'generate' }, result: { ok: true, meta: { path: imagePath, url } } });
  const images = createExecutionRecorder({ home, runId: 'images', chatId: 'chat' }, '生成三张图片');
  const candidates = [];
  for (let i = 0; i < 5; i++) {
    const path = join(home, `candidate-${i}.png`); await writeFile(path, `test candidate ${i}`);
    candidates.push({ ...event.artifacts[0], id: `image-${i}`, path, url: signWorkspaceFileUrl(path) });
  }
  images.event({ ...event, artifacts: candidates });
  images.event({ artifacts: [{ ...candidates[0], id: 'duplicate', url: candidates[0].url + '&cache=2' }] });
  await images.finish('completed');
  const imageScene = await readExecutionScene(home, 'images');
  assert.equal(imageScene.artifacts.length, 5);
  assert.equal(imageScene.selectedImageIds.length, 3);
  assert.equal(verifySignedFileUrl(new URL(imageScene.artifacts[0].url).searchParams), candidates[0].path);
  selectSceneImage(imageScene, 'image-4', 1); await saveExecutionScene(home, imageScene);
  assert.equal((await readExecutionScene(home, 'images')).selectedImageIds[1], 'image-4');
  assert.throws(() => selectSceneImage(imageScene, 'not-real', 0));
  const untrusted = observeTool({ id: 'mcp', name: 'mcp:remote:file', args: {}, result: { ok: true, meta: { url: 'https://example.test/file', path: '/etc/passwd' } } });
  assert.equal(untrusted.artifacts[0].path, undefined);
  await assert.rejects(readExecutionScene(home, '../secret'), { statusCode: 400 });
});


test('actual registry IDs map to their modules and opening a browser does not imply reading', () => {
  assert.equal(moduleForOperation('file_read'), 'files');
  assert.equal(moduleForOperation('xlsx'), 'create');
  assert.equal(moduleForOperation('pdf', { action: 'read' }), 'files');
  assert.equal(moduleForOperation('pdf', { action: 'write' }), 'create');
  assert.equal(moduleForOperation('browser_snapshot'), 'search');
  const scene = createExecutionScene({ runId: 'browser' });
  applyExecutionEvent(scene, observeTool({ id: 'open', name: 'browser_open', result: { ok: true, meta: { currentUrl: 'https://example.test/page' } } }));
  assert.equal(scene.sources[0].accessed, false);
  assert.match(sourceReadingLabel(scene.sources[0]), /已打开/);
  applyExecutionEvent(scene, observeTool({ id: 'read', name: 'browser_snapshot', result: { ok: true, meta: { currentUrl: 'https://example.test/page', title: 'Actual title', textLength: 234 } } }));
  assert.equal(scene.sources[0].accessed, true);
  assert.equal(scene.sources[0].titleProvided, true);
  assert.match(sourceReadingLabel(scene.sources[0]), /部分正文/);
});

test('explicit image counts are independent of website display limits', () => {
  assert.equal(requestedImageCount('生成十二张图'), 12);
  assert.equal(requestedImageCount('生成三张图片'), 3);
  assert.equal(requestedImageCount('create 21 images'), 21);
  assert.equal(requestedImageCount('画一张图'), 1);
  assert.equal(requestedImageCount('画只猫'), 1);
});

test('source display is the relevance top five/ten regardless of citation flags', () => {
  const scene = createExecutionScene({ runId: 'citation-coverage', query: 'orbital mission report' });
  applyExecutionEvent(scene, { sources: Array.from({ length: 18 }, (_, i) => ({
    url: `https://example.test/${i}`, title: i < 12 ? 'Orbital mission report' : `Reference ${i}`, rank: i, appeared: true, reading: 'snippet',
  })) });
  finishExecutionScene(scene, { citedUrls: [15, 16, 17].map(i => `https://example.test/${i}`) });
  const initial = visibleSceneSources(scene), expanded = visibleSceneSources(scene, true);
  assert.equal(initial.length, 5); assert.equal(expanded.length, 10);
  assert.equal(initial.filter(s => s.cited).length, 0, 'citation flags do not reserve a place over more relevant candidates');
  assert.deepEqual(initial.map(s => s.url), [0, 1, 2, 3, 4].map(i => `https://example.test/${i}`));
  assert.ok(scene.sources.slice(15).every(s => s.cited), 'references are retained in the full record even outside the display limit');
  assert.equal(initial[0].url, 'https://example.test/0', 'relevance still orders the visible sources');
  assert.deepEqual(expanded.slice(0, 5), initial);
  assert.equal(scene.sources.length, 18);
  const many = structuredClone(scene);
  many.sources.forEach(s => { s.cited = true; });
  assert.deepEqual(visibleSceneSources(many).map(s => s.id), initial.map(s => s.id));
  assert.equal(visibleSceneSources(many).length, 5);
  assert.equal(visibleSceneSources(many, true).length, 10, 'many citations must not bypass the panel limit');
});

test('recording merges displayed text-block citations and tracking variants without pretending they were read', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-citation-')); t.after(() => rm(home, { recursive: true, force: true }));
  const recorder = createExecutionRecorder({ home, runId: 'citations', chatId: 'chat' }, 'mission');
  recorder.event({ sources: [{ url: 'https://example.test/report?id=42', title: 'Mission', appeared: true, reading: 'snippet', rank: 0 }] });
  const scene = await recorder.finish('completed', {
    id: 'answer', content: 'Short stored summary',
    blocks: [{ type: 'text', text: '[Mission report](https://example.test/report?id=42&utm_source=openai) [source: https://example.test/extra]' }],
    citations: [{ src: 'https://example.test/paper', quote: 'Actual cited passage' }],
  });
  assert.equal(scene.sources.length, 3);
  assert.equal(scene.sources.filter(s => s.cited).length, 3);
  const report = scene.sources.find(s => s.url.includes('id=42'));
  assert.equal(report.reading, 'snippet'); assert.equal(report.accessed, false);
  assert.equal(report.citationLabel, 'Mission report');
  assert.equal(report.citationUrl, 'https://example.test/report?id=42&utm_source=openai');
  assert.equal(scene.sources.find(s => s.url.endsWith('/extra')).reading, 'unknown');
  const separate = createExecutionScene({ runId: 'meaningful-query' });
  applyExecutionEvent(separate, { sources: [{ url: 'https://example.test/report?id=42' }, { url: 'https://example.test/report?id=43' }] });
  assert.equal(separate.sources.length, 2, 'meaningful query parameters must not collapse different pages');
});

test('version-two saved scenes reconcile final references on replay without changing execution history', () => {
  const scene = createExecutionScene({ runId: 'v2-history' });
  scene.observationVersion = 2;
  applyExecutionEvent(scene, { sources: [{ url: 'https://example.test/read', accessed: true, reading: 'partial', provider: 'Reader' }] });
  // Simulate the duplicate shape persisted by the old exact-URL matcher.
  scene.sources.push({ ...structuredClone(scene.sources[0]), id: 'legacy-tracked', url: 'https://example.test/read?utm_source=openai', order: 1, accessed: false, reading: 'unknown', appeared: true, providers: ['Search'] });
  finishExecutionScene(scene, { message: { id: 'answer' } });
  const before = structuredClone(scene);
  const history = { message: { id: 'answer', blocks: [{ type: 'text', text: '[Read page](https://example.test/read?utm_source=openai) [Final reference](https://example.test/final)' }] } };
  const restored = recoverSceneObservations(scene, history);
  assert.deepEqual(scene, before);
  assert.equal(restored.sources.length, 2);
  assert.ok(restored.sources.every(s => s.cited));
  assert.equal(restored.sources[0].accessed, true); assert.equal(restored.sources[0].reading, 'partial');
  assert.deepEqual(restored.sources[0].providers, ['Reader', 'Search']);
  assert.equal(restored.sources[0].id, scene.sources[0].id);
  assert.equal(restored.sources[1].accessed, false); assert.equal(restored.sources[1].reading, 'unknown');
  assert.equal(restored.messageId, scene.messageId); assert.equal(restored.finishedAt, scene.finishedAt);
  assert.deepEqual(restored.operations, scene.operations); assert.deepEqual(restored.events, scene.events);
  assert.equal(restored.restSeed, scene.restSeed);
  assert.deepEqual(recoverSceneObservations(restored, history), restored);
});
