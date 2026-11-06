import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionScene, applyExecutionEvent, finishExecutionScene, moduleForOperation, EXECUTION_MODULES } from './executionScene.js';
import { regionSummary, regionCalls, sceneActors, operationChip, deliveryGate, traceList, sceneHasExecution, sceneNeedsUser, shouldAutoOpen, finishedOperations } from './warRoom.js';
import { sceneResources } from './executionBoard.js';

const op = (scene, id, module, name, status, extra = {}) => applyExecutionEvent(scene, { kind: 'operation', id, module, name, status, ...extra });
const stage = (scene, id, status, extra = {}) => applyExecutionEvent(scene, { kind: 'pipeline', id, status, ...extra });

function memberRun() {
  const scene = createExecutionScene({ runId: 'war', chatId: 'c', query: 'q' });
  stage(scene, 'internal:1', 'running', { name: '检索成员', role: 'research', input: '找活动' });
  op(scene, 'job-1:search', 'search', 'web_search', 'running', { query: 'melbourne outdoor music' });
  op(scene, 'job-1:search', 'search', 'web_search', 'completed', { resultSummary: '8 条来源' });
  op(scene, 'job-1:read', 'search', 'fetch_url', 'running', { input: 'https://www.whatson.melbourne.vic.gov.au/twilight' });
  op(scene, 'lead-calc', 'compute', 'calculator', 'completed', { expression: '15 * 15', result: '225' });
  op(scene, 'lead-notify', 'tools', 'notify', 'completed', { input: '{"title":"ok"}' });
  return scene;
}

test('regions add up to the total and a web search never counts under 工具调用', () => {
  const scene = memberRun(), regions = regionSummary(scene);
  assert.equal(regions.reduce((sum, region) => sum + region.calls, 0), scene.operations.length);
  assert.equal(regions.find(r => r.id === 'search').calls, 2);
  assert.equal(regions.find(r => r.id === 'tools').calls, 1);
  assert.deepEqual(regionCalls(scene, 'tools').map(o => o.id), ['lead-notify']);
  assert.equal(traceList(scene, 'calls').count, scene.operations.length);
  for (const region of regions) {
    const trace = traceList(scene, `region:${region.id}`);
    assert.equal(trace.calls, region.calls); assert.equal(trace.count, trace.rows.length);
  }
});

test('undeclared external retrieval tools belong to 网页检索; declared modules and file tools keep theirs', () => {
  for (const name of ['mcp__brave__brave_web_search', 'tavily-search', 'firecrawl_scrape', 'exa.search', 'mcp__web__fetch_url', 'browse_page']) assert.equal(moduleForOperation(name), 'search', name);
  for (const name of ['file_search', 'search_files', 'search_history']) assert.equal(moduleForOperation(name), 'files', name);
  for (const name of ['notify', 'mcp__github__create_issue', 'bash']) assert.equal(moduleForOperation(name), 'tools', name);
  assert.equal(moduleForOperation('mcp__brave__brave_web_search', {}, 'tools'), 'tools');
  assert.ok(EXECUTION_MODULES.every(m => moduleForOperation('x', {}, m.id) === m.id));
});

test('a spider stands where its call actually is, not where its role suggests', () => {
  const scene = createExecutionScene({ runId: 'roles', chatId: 'c' });
  stage(scene, 'internal:2', 'running', { name: '资料读取成员', role: 'lookup' });
  let member = sceneActors(scene).find(a => a.id === 'member:2');
  assert.equal(member.out, true); assert.equal(member.module, null, 'no call yet: on the core');
  op(scene, 'job-2:web', 'search', 'web_search', 'running');
  member = sceneActors(scene).find(a => a.id === 'member:2');
  assert.equal(member.module, 'search'); assert.equal(member.operation, 'job-2:web');
  op(scene, 'job-2:web', 'search', 'web_search', 'completed');
  member = sceneActors(scene).find(a => a.id === 'member:2');
  assert.equal(member.module, 'search', 'stays where it last worked'); assert.equal(member.operation, null);
  stage(scene, 'internal:2', 'completed', { output: '完成' });
  assert.equal(sceneActors(scene).find(a => a.id === 'member:2').out, false);
  const lead = sceneActors(scene).find(a => a.id === 'lead');
  assert.equal(lead.out, false); assert.deepEqual(lead.operations, []);
  op(scene, 'own-file', 'files', 'file_read', 'running', { input: '/Users/me/notes/plan.md' });
  const busy = sceneActors(scene).find(a => a.id === 'lead');
  assert.equal(busy.out, true); assert.equal(busy.module, 'files'); assert.deepEqual(busy.operations, ['own-file']);
});

test('a finished call turns into a chip naming what it touched', () => {
  assert.deepEqual(operationChip({ name: 'fetch_url', input: 'https://www.rbg.vic.gov.au/heritage-walk', status: 'completed' }), { verb: 'read', text: 'rbg.vic.gov.au', failed: false, status: 'completed' });
  assert.equal(operationChip({ name: 'web_search', query: 'Melbourne free outdoor music', status: 'completed' }).text, 'Melbourne free outdoor music');
  assert.equal(operationChip({ name: 'file_write', change: { path: '/tmp/a/report.md' }, status: 'completed' }).text, 'report.md');
  assert.equal(operationChip({ name: 'calculator', expression: '15 * 15', status: 'completed' }).text, '15 * 15');
  assert.equal(operationChip({ name: 'notify', status: 'failed' }).failed, true);
  assert.ok(operationChip({ name: 'web_search', query: 'x'.repeat(80) }).text.length <= 40);
});

const snapshot = {
  contract: { revision: 1, target: { minimum: 3, maximum: 5 }, explicit: null, coverage: [{ tag: '户外', covered: true }, { tag: '音乐', covered: false }], requiredFields: ['name', 'startsAt'] },
  summary: { discovered: 4, verified: 2, recommended: 1, stop: 'continue', nextBatch: 5, gaps: ['数量 2 / 3'] },
  policy: { checkpoint: { milliseconds: 180000, calls: 20 }, memberCalls: 6 },
  candidates: [
    { key: 'a', name: 'A', tier: 'primary', total: 92, fields: { name: 'verified', startsAt: 'verified' } },
    { key: 'b', name: 'B', tier: 'eligible', total: 70, fields: { name: 'verified', startsAt: 'missing' } },
    { key: 'c', name: 'C', tier: 'excluded', total: 40, fields: { name: 'verified', startsAt: 'failed' }, excludeReason: '不在本周末' },
  ],
};

test('the delivery gate reads its four rows from the snapshot and its state from the evaluator', () => {
  const gate = deliveryGate(snapshot);
  assert.deepEqual(gate.rows.map(r => [r.key, r.value, r.met]), [['count', '2 / 3', false], ['primary', '1', true], ['coverage', '1 / 2', false], ['gaps', '1', false]]);
  assert.equal(gate.open, false); assert.equal(gate.met, 1); assert.equal(gate.nextBatch, 5);
  assert.equal(deliveryGate({ ...snapshot, summary: { ...snapshot.summary, stop: 'ready_for_review' } }).open, true);
  assert.equal(deliveryGate({ ...snapshot, contract: { ...snapshot.contract, explicit: { value: 2, quote: '两个' } } }).rows[0].value, '2 / 2');
  assert.equal(deliveryGate({ summary: {} }), null);
});

test('every evaluation number lists exactly the records it counts', () => {
  const scene = memberRun();
  assert.equal(traceList(scene, 'gate:count', { snapshot }).count, 2);
  assert.deepEqual(traceList(scene, 'gate:primary', { snapshot }).rows.map(r => r.id), ['a']);
  assert.equal(traceList(scene, 'gate:coverage', { snapshot }).count, 2);
  assert.deepEqual(traceList(scene, 'gate:gaps', { snapshot }).rows.map(r => r.text), ['数量 2 / 3']);
  assert.equal(traceList(scene, 'candidates:all', { snapshot }).count, 3);
  assert.deepEqual(traceList(scene, 'candidates:excluded', { snapshot }).rows.map(r => [r.id, r.reason]), [['c', '不在本周末']]);
  assert.deepEqual(traceList(scene, 'candidates:top', { snapshot }).rows.map(r => r.total), [92]);
  assert.equal(traceList(scene, 'field:startsAt', { snapshot }).count, 3);
  assert.deepEqual(traceList(scene, 'checkpoint', { snapshot }).rows.map(r => [r.id, r.value]), [['milliseconds', 180000], ['calls', 20], ['memberCalls', 6]]);
  assert.deepEqual(traceList(scene, 'member:1').rows.map(r => r.id), ['job-1:search', 'job-1:read']);
  assert.equal(traceList(scene, 'nonsense:x').count, 0);
});

test('tokens trace sums exactly the model calls it lists', () => {
  const scene = memberRun();
  stage(scene, 'model:1', 'completed', { name: '模型请求', api: { usage: { input: 1200, output: 80 } } });
  stage(scene, 'model:2', 'completed', { name: '模型请求', api: { usage: { input: 800, output: 40 } } });
  // A public summary carries its request's own API record; one response, counted once.
  stage(scene, 'model:2:summary', 'completed', { module: 'compute', channel: 'reasoning-summary', name: '公开摘要', api: { responseId: 'resp-2', usage: { input: 800, output: 40 } } });
  stage(scene, 'model:3', 'completed', { name: '模型请求', api: { responseId: 'resp-3', usage: { input: 500 } } });
  stage(scene, 'model:3:retry-echo', 'completed', { name: '模型请求', api: { responseId: 'resp-3', usage: { input: 500 } } });
  const trace = traceList(scene, 'tokens');
  assert.deepEqual(trace.rows.map(r => [r.id, r.tokens]), [['model:1', 1200], ['model:2', 800], ['model:3', 500]]);
  assert.equal(trace.total, 2500); assert.equal(trace.count, 3);
  assert.equal(sceneResources(scene).inputTokens, trace.total, 'the status number and its list agree');
  assert.equal(sceneResources(scene).usageRecords, 3);
  assert.equal(sceneResources(memberRun()).usageRecords, 0, 'no response reported usage: the count is unknown, not 0');
});

test('the war room opens by itself only for a live run that did something observable', () => {
  const chat = createExecutionScene({ runId: 'plain', chatId: 'c' });
  stage(chat, 'reply:render', 'running', { name: '回答' });
  assert.equal(sceneHasExecution(chat), false); assert.equal(shouldAutoOpen(chat), false);
  const run = memberRun();
  assert.equal(shouldAutoOpen(run), true);
  assert.equal(shouldAutoOpen(run, { dismissed: true }), false);
  assert.equal(shouldAutoOpen(run, { autoOpened: true }), false);
  assert.equal(shouldAutoOpen(run, { opened: true }), false);
  const evaluated = createExecutionScene({ runId: 'eval', chatId: 'c' }); stage(evaluated, 'task-evaluation:1', 'completed', { output: '发现 1' });
  assert.equal(shouldAutoOpen(evaluated), true);
  // A call held for the user's permission: the war room never covers the prompt.
  const held = createExecutionScene({ runId: 'held', chatId: 'c' });
  op(held, 'write', 'files', 'file_write', 'waiting');
  assert.equal(sceneNeedsUser(held), true); assert.equal(shouldAutoOpen(held), false);
  op(held, 'write', 'files', 'file_write', 'running');
  assert.equal(sceneNeedsUser(held), false); assert.equal(shouldAutoOpen(held), true, 'once answered, the run opens it');
  finishExecutionScene(run, { status: 'completed' });
  assert.equal(shouldAutoOpen(run), false);
  assert.deepEqual(finishedOperations(run).sort(), ['job-1:read', 'job-1:search', 'lead-calc', 'lead-notify'].sort());
});
