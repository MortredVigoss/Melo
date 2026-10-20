import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionScene, applyExecutionEvent, finishExecutionScene, visibleSceneSources, moduleActivity, sourceReadingLabel, moduleForOperation, requestedImageCount } from '../../shared/executionScene.js';
import {executeToolCalls} from '../../testSupport/directAgentFixture.js';
import { calculatorTool } from '../../tools/builtins/calculatorTool.js';
import { observeTool, observeNativeItem } from '../../tools/executionObservation.js';
import { createExecutionRecorder, readExecutionScene, selectSceneImage, saveExecutionScene, recoverSceneObservations, readExecutionContext } from './executionScenes.js';
import { sessionEvents } from '../../shared/sessionEvents.js';
import { renderSessionEvents } from '../../../desktop-ui/executionDetails.js';
import { appendToolInvocationRecord, buildToolInvocationRecord } from '../../tools/toolInvocationRecord.js';
import { readCodexSseResponse } from '../../providers/streams.js';
import { signWorkspaceFileUrl, verifySignedFileUrl } from '../../web/urlSigning.js';

test('old false research blockage is corrected on read without rewriting the saved scene or message', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-answer-recovery-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const query = '这是更新后的连通性检查。请只回复：更新验证通过。不要调用工具。';
  const completion = { version: 1, kind: 'research', outcome: 'blocked', goalState: 'unverified',
    reason: 'RELEVANT_READ_SOURCE_MISSING', completedSteps: 0, evidenceIds: [], summary: '受阻 · 尚无目标完成证据' };
  const message = { id: 'answer', role: 'assistant', content: '更新验证通过。', metadata: { completion } };
  const scene = createExecutionScene({ runId: 'old-answer', chatId: 'chat', query });
  finishExecutionScene(scene, { message });
  await mkdir(join(home, 'desktop', 'execution-scenes'), { recursive: true });
  await saveExecutionScene(home, scene);
  const before = JSON.stringify({ scene, message });
  const recovered = await readExecutionScene(home, scene.runId, { message });
  assert.equal(recovered.completion.outcome, 'completed');
  assert.equal(recovered.completion.kind, 'answer');
  assert.equal(recovered.completion.summary, '回答已交付');
  assert.equal(recovered.taskOutcome, 'completed');
  assert.deepEqual(recovered.events, scene.events);
  assert.equal(JSON.stringify({ scene, message }), before);
  assert.equal((await readExecutionScene(home, scene.runId)).completion.reason, completion.reason, 'disk remains unchanged');
  for (const changed of [
    { query: '搜索今天的新闻' }, { status: 'cancelled' }, { status: 'failed' },
    { query: '' }, { query: query.padEnd(4000, ' ') },
    { completion: { ...completion, reason: 'NO_FINAL_ANSWER' } },
    { completion: { ...completion, kind: 'action' } },
    { completion: { ...completion, completedSteps: 1 } },
    { completion: { ...completion, evidenceIds: ['source'] } },
    { operations: [{ id: 'call', name: 'file_write', status: 'completed' }] },
    { toolCalls: [{ callId: 'call', toolId: 'file_write' }] },
    { artifacts: [{ id: 'image', kind: 'image', url: 'https://example.com/image.png' }] },
    { previews: [{ id: 'image', url: 'https://example.com/image.png' }] },
    { sources: [{ id: 'read', url: 'https://example.com', reading: 'unknown' }] },
  ]) {
    const original = { ...scene, ...changed };
    assert.deepEqual(recoverSceneObservations(original, { message }).completion, original.completion, JSON.stringify(changed));
  }
  for (const invalid of [{ ...message, content: '' }, { ...message, id: 'another' }, { ...message, role: 'user' }]) {
    assert.deepEqual(recoverSceneObservations(scene, { message: invalid }).completion, completion);
  }
});

test('persisted tool records drive matching UI and model event IDs after interruption without repeating effects', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-events-')); t.after(() => rm(home, { recursive: true, force: true }));
  const recorder = createExecutionRecorder({ home, runId: 'r', chatId: 'c' }, 'perform one action');
  let effects = 0;
  await executeToolCalls([{ id: '0:a', args: {}, tool: { id: 'effect-fixture', requiresPermission: false,
    run: async () => { effects++; return { ok: true, output: 'Bearer secret-token-value' }; } } }], {
    sseEmitter: (kind, event) => { if (kind === 'execution_event') recorder.event(event); },
  });
  const record = buildToolInvocationRecord({ runId: 'r', iteration: 0, call: { id: 'a', name: 'effect-fixture' },
    result: { ok: true, output: 'private result' }, modelFacingOutput: 'Bearer secret-token-value' });
  appendToolInvocationRecord(record, { home }); recorder.recordTool(record);
  recorder.event({ kind: 'operation', id: '1:b', name: 'send_message', status: 'running' });
  // The process died after recording start but before receiving this result.
  await recorder.finish('interrupted');
  const chat = { id: 'c', messages: [{ role: 'user', metadata: { runId: 'r' } }] };
  const restored = await readExecutionScene(home, 'r');
  const events = sessionEvents(restored), html = renderSessionEvents(events);
  const context = await readExecutionContext(home, chat);
  for (const event of events) {
    assert.ok(html.includes(event.eventId));
    assert.ok(context.includes(event.eventId));
  }
  assert.equal(events.filter(event => event.operationId === '0:a' && event.phase === 'result').length, 1);
  assert.equal(events.find(event => event.operationId === '1:b' && event.phase === 'result').resultState, 'unknown');
  for (let i = 0; i < 3; i++) assert.equal(await readExecutionContext(home, chat), context);
  assert.equal(effects, 1, 'reopening records and projecting model history cannot invoke the executor');
  assert.doesNotMatch(context + html, /secret-token-value|private result/);
  assert.equal(await readExecutionContext(home, chat, { enabled: false }), '');
  assert.doesNotMatch(await readExecutionContext(home, { ...chat, id: 'other-chat' }), /effect-fixture/);
});

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

// Bug audit 2026-10-18 T15: execution-scenes/<runId>.* (scene JSON + D1 tools.jsonl)
// are pruned by age (14 days) and count (newest 300 runs); live runs survive.
test('T15: pruneExecutionScenes drops runs older than 14 days or beyond the newest 300, whole run at a time, never a live run', async () => {
  const { pruneExecutionScenes, SCENE_RETENTION_DAYS, SCENE_RETENTION_RUNS } = await import('./executionScenes.js');
  const { utimes, mkdir, readdir } = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'melo-scene-prune-'));
  const dir = join(home, 'desktop', 'execution-scenes');
  await mkdir(dir, { recursive: true });
  const now = Date.now(), day = 86_400_000;
  const touch = async (name, ageMs) => { const file = join(dir, name); await writeFile(file, '{}'); await utimes(file, new Date(now - ageMs), new Date(now - ageMs)); };
  await touch('old.json', 20 * day); await touch('old.tools.jsonl', 20 * day);
  await touch('edge.json', (SCENE_RETENTION_DAYS + 0.5) * day);
  await touch('fresh.json', 1 * day); await touch('fresh.tools.jsonl', 1 * day);
  await touch('unrelated.txt', 30 * day);
  const first = await pruneExecutionScenes(home, { now });
  assert.deepEqual(first, { removedRuns: 2, removedFiles: 3 });
  assert.deepEqual((await readdir(dir)).sort(), ['fresh.json', 'fresh.tools.jsonl', 'unrelated.txt']);
  // Count cap: 305 fresh runs → only the newest 300 survive (two files per run go together).
  for (let i = 0; i < 305; i++) { await touch(`run${String(i).padStart(3, '0')}.json`, i * 1000); await touch(`run${String(i).padStart(3, '0')}.tools.jsonl`, i * 1000); }
  const second = await pruneExecutionScenes(home, { now });
  assert.equal(second.removedRuns, 306 - SCENE_RETENTION_RUNS, 'fresh + 305 runs minus the newest 300');
  const left = (await readdir(dir)).filter(n => n.endsWith('.json'));
  assert.equal(left.length, SCENE_RETENTION_RUNS);
  assert.ok(left.includes('run000.json') && left.includes('run299.json'), 'newest 300 kept');
  assert.ok(!left.includes('run300.json') && !left.includes('fresh.json'), 'the 1-day-old run is now the oldest and goes with run300..304');
  assert.ok(!(await readdir(dir)).includes('run300.tools.jsonl'), 'the run\'s tools.jsonl goes with it');
  // A run that is still being recorded is never pruned, even when old or beyond the cap.
  const recorder = createExecutionRecorder({ home, runId: 'live-run', requestId: 'r', chatId: 'c' }, 'q', () => {});
  await new Promise(resolve => setTimeout(resolve, 150));
  await utimes(join(dir, 'live-run.json'), new Date(now - 40 * day), new Date(now - 40 * day));
  const third = await pruneExecutionScenes(home, { now, maxRuns: 1 });
  assert.ok((await readdir(dir)).includes('live-run.json'), 'live run kept');
  assert.ok(third.removedRuns > 0);
  await recorder.finish('completed', { content: '' });
  // Missing directory: nothing to do, no throw.
  assert.deepEqual(await pruneExecutionScenes(join(home, 'nope')), { removedRuns: 0, removedFiles: 0 });
  await rm(home, { recursive: true, force: true });
});

test('completion receipt survives scene persistence separately from delivery status', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-completion-scene-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const completion = { version: 1, kind: 'action', outcome: 'partial', goalState: 'unverified', reason: 'GOAL_TERMINAL_EVIDENCE_MISSING', evidenceIds: [], completedSteps: 1, summary: 'Partially completed' };
  const recorder = createExecutionRecorder({ home, runId: 'completion-run', chatId: 'completion-chat' }, 'Create a file');
  await recorder.finish('completed', { id: 'assistant', content: 'Done', metadata: { completion } });
  const restored = await readExecutionScene(home, 'completion-run');
  assert.equal(restored.status, 'completed');
  assert.equal(restored.taskOutcome, 'partial');
  assert.deepEqual(restored.completion, completion);
});
