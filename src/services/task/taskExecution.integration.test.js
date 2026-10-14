import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateStateAtomically, loadState } from '../../state/stateStore.js';
import { prepareTaskExecution } from './prepareTaskExecution.js';
import { finishTaskRun, recoverTaskRuns } from './taskRunLifecycle.js';
import { scheduleChatTurn } from '../chat/turnScheduler.js';
import { sendChatMessage } from '../chat/sendChatMessage.js';
import { registerPlugin, unregisterPlugin } from '../../plugins/hooks.js';
import { recordTaskApproval } from './taskApprovalCheckpoint.js';
import { exportMobileSnapshot } from '../../http/mobileSyncRoutes.js';
const home = await mkdtemp(join(tmpdir(), 'melo-task-quality-'));
process.env.MELO_HOME = home;
process.env.MELO_TEST_MODE = '1';
process.env.MELO_MOCK_RESPONSE = 'The work is ready for your review.';
test.after(async () => { unregisterPlugin('task-quality'); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('prepare is idempotent; real chat completion needs review and duplicate delivery never reruns', async () => {
  await updateStateAtomically(s => { s.tasks = [{ id: 'quality', title: 'Test task', summary: 'Summarize the work', owner: 'main', status: 'todo', runCount: 0 }]; });
  const [{ execution: a }, { execution: b }] = await Promise.all([prepareTaskExecution('quality', { skipBootstrap: true }), prepareTaskExecution('quality', { skipBootstrap: true })]);
  assert.equal(a.requestId, b.requestId);
  assert.equal(a.chatId, b.chatId);
  const result = await sendChatMessage({ ...a, skipBootstrap: true });
  const replay = await sendChatMessage({ ...a, skipBootstrap: true });
  assert.equal(replay.replayed, true);
  assert.equal(result.assistantMessage.id, replay.assistantMessage.id);
  const task = (await loadState()).tasks.find(t => t.id === 'quality');
  assert.equal(task.status, 'review');
  assert.equal(task.runCount, 1);
  assert.equal(task.runHistory.length, 1);
  assert.equal(task.execution.assistantMessageId, result.assistantMessage.id);
  const { execution: retry } = await prepareTaskExecution('quality', { skipBootstrap: true });
  assert.equal(retry.chatId, a.chatId);
  assert.notEqual(retry.requestId, a.requestId);
  assert.match(retry.content, /避免重复/);
});

test('cancellation is recorded, preserves history and offers a fresh explicit recovery', async () => {
  const { execution } = await prepareTaskExecution('quality', { skipBootstrap: true });
  let enter; const entered = new Promise(r => { enter = r; });
  let release; const gate = new Promise(r => { release = r; });
  registerPlugin('task-quality', { 'chat:message:before': async () => { enter(); await gate; } });
  const controller = new AbortController();
  const pending = sendChatMessage({ ...execution, signal: controller.signal, skipBootstrap: true });
  await entered;
  await assert.rejects(prepareTaskExecution('quality', { skipBootstrap: true }), /正在执行/);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  release();
  await rejected;
  await scheduleChatTurn({ home, chatId: execution.chatId }, async () => {});
  unregisterPlugin('task-quality');
  const task = (await loadState()).tasks.find(t => t.id === 'quality');
  assert.equal(task.status, 'blocked');
  assert.equal(task.execution.status, 'cancelled');
  assert.equal(task.runHistory.length, 2);
});

test('provider error, stale completion and restart cannot falsely mark tasks done', () => {
  const state = { tasks: [{ id: 'x', status: 'running', execution: { status: 'running', runId: 'new' } }], chatRuns: [{ status: 'running' }] };
  finishTaskRun(state, { runId: 'old' }, { message: { id: 'late', content: 'done' } });
  assert.equal(state.tasks[0].status, 'running');
  finishTaskRun(state, { runId: 'new' }, { message: { content: 'Provider failed', metadata: { executionError: 'HTTP_500' } } });
  assert.equal(state.tasks[0].status, 'blocked');
  state.tasks[0].status = 'running';
  state.tasks[0].execution = { status: 'running', runId: 'restart' };
  recoverTaskRuns(state);
  assert.equal(state.tasks[0].status, 'blocked');
  assert.equal(state.chatRuns[0].status, 'interrupted');
  assert.match(state.tasks[0].latestNote, /不会自动重复/);
});

test('mobile checkpoint reports pending local approval without exporting grants and ignores stale runs', async () => {
  const now = new Date().toISOString();
  await updateStateAtomically(state => {
    state.tasks = [{ id: 'approval-task', title: 'Local approval', summary: 'Check the change', owner: 'main', status: 'running', updatedAt: now,
      syncRevision: 1, execution: { status: 'running', runId: 'approval-run', chatId: 'local-chat' } }];
  });
  const context = { home, env: { ...process.env, MELO_HOME: home }, runId: 'approval-run' };
  await recordTaskApproval(context, 'approval-task', 'private-operation-id', 'file_write', true);
  let state = await loadState();
  let checkpoint = exportMobileSnapshot(state).tasks[0];
  assert.equal(checkpoint.needsApproval, true);
  assert.match(checkpoint.checkpoint, /file_write/);
  assert.equal(checkpoint.revision, 2);
  assert.equal(JSON.stringify(checkpoint).includes('private-operation-id'), false);
  await recordTaskApproval({ ...context, runId: 'obsolete' }, 'approval-task', 'private-operation-id', 'file_write', false);
  assert.equal(exportMobileSnapshot(await loadState()).tasks[0].needsApproval, true);
  await recordTaskApproval(context, 'approval-task', 'private-operation-id', 'file_write', false);
  checkpoint = exportMobileSnapshot(await loadState()).tasks[0];
  assert.equal(checkpoint.needsApproval, false);
  assert.equal(checkpoint.revision, 3);
  await recordTaskApproval(context, 'approval-task', 'private-operation-id', 'file_write', true);
  await updateStateAtomically(state => finishTaskRun(state, context, { cancelled: true }));
  state = await loadState();
  assert.deepEqual(state.tasks[0].execution.pendingApprovals, {});
  assert.equal(state.tasks[0].status, 'blocked');
});
