// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from './i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { executionTiming, renderExecutionTiming } from './executionTiming.js';
import { setLanguage } from './i18n.js';

const at = seconds => new Date(Date.UTC(2026, 9, 16, 0, 0, seconds)).toISOString();
const now = seconds => Date.parse(at(seconds));
const scene = () => ({ status: 'running', startedAt: at(0), pipeline: [], operations: [], artifacts: [] });
test('live time advances without events, completion and cancellation freeze across reloads', () => {
  const run = scene();
  assert.equal(executionTiming(run, now(12)).elapsedMs, 12000);
  assert.equal(executionTiming(run, now(16)).elapsedMs, 16000);
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
    const saved = JSON.parse(JSON.stringify({ ...run, status, finishedAt: at(19) }));
    assert.equal(executionTiming(saved, now(999)).elapsedMs, 19000);
    assert.equal(executionTiming(saved, now(2000)).elapsedMs, 19000);
  }
});
test('missing and invalid historical clocks stay unknown and never keep counting', () => {
  for (const startedAt of [undefined, null, '', 'invalid', at(30)]) assert.equal(executionTiming({ ...scene(), startedAt }, now(20)).elapsedMs, null);
  assert.equal(executionTiming({ ...scene(), status: 'completed' }, now(20)).elapsedMs, null);
  const legacy = executionTiming({ ...scene(), runId: 'legacy-reply', status: 'completed', finishedAt: at(0) }, now(20));
  assert.equal(legacy.elapsedMs, null); assert.equal(legacy.finishedAt, null);
  assert.match(renderExecutionTiming({ ...scene(), status: 'failed' }), /用时未记录/);
});
test('model intervals exclude summary duplicates, merge parallel calls and exclude tool gaps', () => {
  const run = { ...scene(), pipeline: [
    { id: 'model:1', status: 'completed', startedAt: at(1), finishedAt: at(9) },
    { id: 'model:1:summary', channel: 'reasoning-summary', status: 'running', startedAt: at(1) },
    { id: 'model:2', status: 'completed', startedAt: at(5), finishedAt: at(12) },
    { id: 'model:3', status: 'running', startedAt: at(16) },
    { id: 'reply:render', status: 'running', startedAt: at(0) },
  ] };
  assert.equal(executionTiming(run, now(20)).modelMs, 15000);
  run.status = 'cancelled'; run.finishedAt = at(21);
  assert.equal(executionTiming(run, now(999)).modelMs, 16000);
});
test('image percentages count saved artifacts, never previews, failures or elapsed guesses', () => {
  const run = { ...scene(), imageTask: { count: 2 }, operations: [{ name: 'image', module: 'create', status: 'running', startedAt: at(2) }], previews: [{ url: 'preview' }] };
  assert.equal(executionTiming(run, now(100)).image.percent, 0);
  run.artifacts.push({ kind: 'image', createdAt: at(18) });
  assert.equal(executionTiming(run, now(20)).image.percent, 50);
  run.status = 'failed'; run.finishedAt = at(23);
  assert.equal(executionTiming(run, now(999)).image.percent, 50);
  assert.equal(executionTiming(run, now(999)).image.elapsedMs, 21000);
  run.artifacts.push({ kind: 'image', createdAt: at(22) });
  assert.equal(executionTiming(run, now(999)).image.percent, 100);
  assert.equal(executionTiming(run, now(999)).image.elapsedMs, 20000);
  assert.equal(executionTiming(run, now(999)).image.savedAt, now(22));
});
test('image analysis is not generation; phone saved-image observations use the same progress', () => {
  assert.equal(executionTiming({ ...scene(), operations: [{ name: 'image', module: 'files' }] }, now(10)).image, null);
  const run = { ...scene(), imageProgress: { requested: 1, saved: 1, startedAt: at(3), finishedAt: at(17) } };
  assert.equal(executionTiming(run, now(200)).image.elapsedMs, 14000);
  assert.equal(executionTiming(run, now(200)).image.percent, 100);
});
test('display labels distinguish whole-run and model time and localize authored text', () => {
  const run = { ...scene(), status: 'completed', finishedAt: at(18), imageTask: { count: 1 }, artifacts: [{ kind: 'image', createdAt: at(17) }] };
  assert.match(renderExecutionTiming(run, now(100)), /本轮用时 18 秒/);
  assert.match(renderExecutionTiming(run, now(100)), /完成于/);
  assert.match(renderExecutionTiming(run, now(100)), /图片成果 100%/);
  setLanguage('en');
  try { assert.match(renderExecutionTiming(run), /Total time 18 s/); }
  finally { setLanguage('zh-CN'); }
});
