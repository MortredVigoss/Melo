import test from 'node:test';
import assert from 'node:assert/strict';
import { observeModelReplies } from './executionPipeline.js';
import { createExecutionScene, applyExecutionEvent, moduleActivity, finishExecutionScene } from '../../shared/executionScene.js';

test('model stream boundaries remain separate from tools and never store draft text or reasoning', async () => {
  const scene = createExecutionScene({ runId: 'pipeline' }), states = [], deltas = [];
  const call = observeModelReplies(async options => {
    await options.onDelta({ delta: 'private draft' });
    await options.onDelta({ delta: ' more' });
    options.onProviderResponse({ reportedModel: 'actual-model' });
    return 'final result';
  }, (type, event) => { assert.equal(type, 'execution_event'); applyExecutionEvent(scene, event); states.push(structuredClone(event)); });
  const reply = await call({ model: 'requested-model', onDelta: chunk => deltas.push(chunk) });
  assert.equal(reply, 'final result'); assert.equal(deltas.length, 2);
  assert.equal(states.length, 3); assert.equal(states[1].outputMessageId, 'output.receiving'); assert.equal(states[1].output, undefined);
  assert.equal(scene.operations.length, 0); assert.equal(scene.pipeline.length, 1);
  assert.equal(scene.pipeline[0].returnedModel, 'actual-model');
  assert.doesNotMatch(JSON.stringify(scene), /private draft|final result/);
  assert.equal(moduleActivity(scene, 'tools').status, 'idle');
  assert.equal(moduleActivity(scene, 'create').status, 'completed');
});

test('non-stream calls are not switched to streaming; cancelled calls cannot finish successfully', async () => {
  const events = [], controller = new AbortController();
  const call = observeModelReplies(async options => {
    assert.equal(options.onDelta, undefined);
    controller.abort(); throw Object.assign(new Error('stop'), { name: 'AbortError' });
  }, (_, event) => events.push(event));
  await assert.rejects(call({ model: 'm', signal: controller.signal }), /stop/);
  assert.deepEqual(events.map(e => e.status), ['running', 'cancelled']);
});

test('tool overview reuses the same search operation, while only its search body crawls', () => {
  const scene = createExecutionScene({ runId: 'aggregate' });
  applyExecutionEvent(scene, { kind: 'operation', id: 'search', module: 'search', name: 'native_web_search', status: 'running' });
  const tools = moduleActivity(scene, 'tools'), search = moduleActivity(scene, 'search');
  assert.equal(scene.operations.length, 1); assert.equal(tools.running.length, 1);
  assert.equal(search.operations[0], tools.operations[0]);
  assert.equal(tools.primaryRunning.length, 0); assert.equal(search.primaryRunning.length, 1);
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'reply:format', name: '整理回答与引用', status: 'running' });
  finishExecutionScene(scene, { status: 'cancelled' });
  assert.equal(scene.pipeline[0].status, 'cancelled');
  assert.equal(moduleActivity(scene, 'create').running.length, 0);
  assert.equal(applyExecutionEvent(scene, { kind: 'pipeline', id: 'reply:format', status: 'completed' }), false);
});
