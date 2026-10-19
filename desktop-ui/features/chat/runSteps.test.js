import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneSteps, renderRunSteps, stepState } from './runSteps.js';

test('live steps come from the scene, keep running ones and the most recent finished ones', () => {
  const scene = {
    pipeline: [{ id: 'think', name: '思考摘要', channel: 'reasoning-summary', status: 'running', output: '先读文件\n再修改 app.js 的发送逻辑', startedAt: '2026-10-17T00:00:01Z' }],
    operations: [
      { id: 'a', name: 'file_read', status: 'completed', input: 'src/a.js', startedAt: '2026-10-17T00:00:02Z' },
      { id: 'b', name: 'file_edit', status: 'completed', change: { path: 'desktop-ui/app.js' }, startedAt: '2026-10-17T00:00:03Z' },
      { id: 'c', name: 'bash', status: 'failed', command: 'npm test', startedAt: '2026-10-17T00:00:04Z' },
      { id: 'd', name: 'bash', status: 'running', command: 'npm run lint', startedAt: '2026-10-17T00:00:05Z' },
    ],
  };
  const all = sceneSteps(scene);
  assert.deepEqual(all.map(s => [s.title, s.detail, s.state]), [
    ['思考摘要', '再修改 app.js 的发送逻辑', 'running'],
    ['读取文件', 'src/a.js', 'done'],
    ['修改文件', 'desktop-ui/app.js', 'done'],
    ['运行命令', 'npm test', 'failed'],
    ['运行命令', 'npm run lint', 'running'],
  ]);
  assert.deepEqual(sceneSteps(scene, 3).map(s => s.detail), ['再修改 app.js 的发送逻辑', 'npm test', 'npm run lint']);
  assert.equal(stepState('queued'), 'running');
  const html = renderRunSteps(sceneSteps({ operations: [{ id: 'x', name: 'bash', status: 'running', command: '<rm>' }] }), s => String(s).replaceAll('<', '&lt;'));
  assert.match(html, /运行命令/); assert.match(html, /&lt;rm>/); assert.doesNotMatch(html, /<rm>/);
  assert.equal(renderRunSteps([], s => s), '');
});

// Bug audit 2026-10-18 U5: a stage that only reported `completed` (the model
// request stage, the compact stage) used to have no time at all, so the whole
// list gave up sorting and every tool operation sank below the stages.
test('U5: completed-only stages keep their chronological place among tool operations', () => {
  const scene = {
    pipeline: [
      { id: 'model:1', name: '模型请求', status: 'completed', output: '模型返回完成', finishedAt: '2026-10-18T00:00:05Z' },
      { id: 'think', name: '思考摘要', channel: 'reasoning-summary', status: 'completed', output: '先读文件', at: '2026-10-18T00:00:01Z' },
    ],
    operations: [
      { id: 'a', name: 'file_read', status: 'completed', input: 'src/a.js', startedAt: '2026-10-18T00:00:02Z' },
      { id: 'b', name: 'bash', status: 'running', command: 'npm test', startedAt: '2026-10-18T00:00:06Z' },
    ],
  };
  assert.deepEqual(sceneSteps(scene).map(s => s.id), ['stage:think', 'op:a', 'stage:model:1', 'op:b']);
  assert.ok(sceneSteps(scene).every(s => s.at), 'every step carries a time');
});

test('U5: applyExecutionEvent stamps startedAt on the first sighting of a stage, whatever its status', async () => {
  const { createExecutionScene, applyExecutionEvent } = await import('../../../src/shared/executionScene.js');
  const scene = createExecutionScene({ runId: 'r', requestId: 'q', chatId: 'c' });
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'model:1', name: '模型请求', status: 'completed', at: '2026-10-18T00:00:05Z' });
  assert.equal(scene.pipeline[0].startedAt, '2026-10-18T00:00:05Z');
  assert.equal(scene.pipeline[0].finishedAt, '2026-10-18T00:00:05Z');
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'model:2', name: '模型请求', status: 'running', at: '2026-10-18T00:00:06Z' });
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'model:2', status: 'completed', at: '2026-10-18T00:00:08Z' });
  assert.equal(scene.pipeline[1].startedAt, '2026-10-18T00:00:06Z', 'a later event never moves the start');
  assert.deepEqual(sceneSteps(scene).map(s => s.id), ['stage:model:1', 'stage:model:2']);
});
