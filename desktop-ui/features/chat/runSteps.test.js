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

// Agent audit 2026-11-10: the scene keeps an English fallback of a stage's name
// and output next to its message id, a stop stage's output is a reason code,
// and a refused call only says `failed`. With the names of executionText.js the
// live steps read in the interface language; the test goes through the real
// reducer and the names the chat view passes.
test('live steps name stages, stop reasons, tools and refused calls in the interface language', async () => {
  const { setLanguage } = await import('../../i18n.js');
  const { stageName, stageOutput, toolName, callOutcome } = await import('../../executionText.js');
  const { createExecutionScene, applyExecutionEvent } = await import('../../../src/shared/executionScene.js');
  const text = { stageName, stageOutput, toolName, callOutcome };
  const scene = createExecutionScene({ runId: 'r', requestId: 'q', chatId: 'c' });
  const at = second => `2026-11-10T00:00:0${second}Z`;
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'goal-check:1', module: 'compute', messageId: 'stage.delivery', status: 'running', at: at(1) });
  applyExecutionEvent(scene, { kind: 'operation', id: '0:a', name: 'file_write', module: 'files', status: 'failed', errorCode: 'PERMISSION_DENIED', input: 'path: notes.md', at: at(2) });
  applyExecutionEvent(scene, { kind: 'operation', id: '0:b', name: 'load_tools', module: 'tools', status: 'completed', input: 'names: pdf', at: at(3) });
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'core:stop', module: 'compute', messageId: 'stage.stopped', status: 'failed', output: 'REPEATED_TOOL_FAILURE', at: at(4) });
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'limit:delivery', module: 'compute', messageId: 'stage.delivery', status: 'completed', output: 'LIMIT_DELIVERED', at: at(5) });
  try {
    setLanguage('zh-CN');
    const rows = sceneSteps(scene, 6, text).map(step => [step.title, step.detail]);
    assert.deepEqual(rows, [
      ['核对任务交付', ''],
      ['写入文件', '未获许可，没有执行 · path: notes.md'],
      ['加载工具说明', 'names: pdf'],
      ['执行已停止', '工具连续几轮失败'],
      ['整理已确认的内容', '已按上限整理并交付'],
    ]);
    // Without those names the steps print what the scene recorded: the English fallbacks and the codes.
    assert.deepEqual(sceneSteps(scene).map(step => [step.title, step.detail]), [
      ['Checking task delivery', ''],
      ['写入文件', 'path: notes.md'],
      ['加载工具说明', 'names: pdf'],
      ['Execution stopped', 'REPEATED_TOOL_FAILURE'],
      ['Checking task delivery', 'LIMIT_DELIVERED'],
    ]);
    setLanguage('en');
    assert.deepEqual(sceneSteps(scene, 6, text).map(step => step.title), ['Checking task delivery', 'Write file', 'Load tool definitions', 'Execution stopped', 'Wrapping up what is confirmed']);
  } finally { setLanguage('en'); }
});

test('the chat view passes those names to the live steps and the pills', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./viewThread.js', import.meta.url), 'utf8');
  assert.equal(source.match(/sceneSteps\(liveSceneFor\([^)]*\), 6, RUN_TEXT\)/g)?.length, 2, 'first paint and in-place update');
  assert.match(source, /const RUN_TEXT = \{ stageName, stageOutput, toolName, callOutcome \}/);
  assert.match(source, /terminalIcon: icon\.terminal,\s+toolName,\s+callOutcome,/);
});
