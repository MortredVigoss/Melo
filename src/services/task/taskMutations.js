import {creationProjectId} from '../../domain/project/projectMembership.js';
import { assertTaskAcceptable } from './taskAcceptance.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
// Task CRUD and compatibility entrypoints; execution uses the chat tool pipeline.

import { randomUUID } from 'node:crypto';
import { nowIso } from '../../shared/helpers.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { findTaskById } from '../../state/stateLookups.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import {
  normalizeTask,
  normalizeTasks,
} from '../../domain/task/taskService.js';
import { prepareTaskExecution } from './prepareTaskExecution.js';
import { loadState } from '../../state/stateStore.js';

export async function createTask({ title, summary, owner, projectId, chatId, kind = 'task' }) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => createTask(...arguments));
  await updateStateAtomically(state => {
    const task = normalizeTask({
      id: randomUUID(),
      kind,
      title: String(title || '').trim() || 'Untitled task',
      summary: String(summary || '').trim(),
      owner,
      projectId: creationProjectId(state,{projectId,chatId,operation:'task'}),
      chatId: chatId || null,
      status: 'todo',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    state.tasks.unshift(task);
    state.tasks = normalizeTasks(state.tasks);
    return state;
  });
  return getDesktopBootstrap();
}

export async function updateTask(taskId, patch = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => updateTask(...arguments));
  await updateStateAtomically(state => {
    const task = findTaskById(state, taskId);
    if (!task) {
      throw new Error('Task not found.');
    }

    if (task.status === 'running' || patch.status === 'running') throw new Error('执行中的任务不能手动改状态，请先在对话中停止。');
    if (patch.acceptanceChecks && task.status === 'review') {
      for (const criterion of task.acceptance?.criteria || []) criterion.checked = patch.acceptanceChecks[criterion.id] === true;
    }
    if (patch.status === 'done') { assertTaskAcceptable(task); task.acceptance.reviewedAt = nowIso();
      const score = Number(patch.qualityScore);
      if (Number.isInteger(score) && score >= 1 && score <= 5 && task.runHistory?.length) task.runHistory[task.runHistory.length-1].qualityScore = score; }
    if (task.execution?.status === 'prepared') task.execution.status = 'cancelled';
    task.syncRevision = (task.syncRevision || 1) + 1;
    const editable = Object.fromEntries(Object.entries(patch).filter(([key]) => ['title', 'summary', 'owner', 'status', 'projectId'].includes(key)));
    Object.assign(task, normalizeTask({
      ...task,
      ...editable,
      id: task.id,
      createdAt: task.createdAt,
      updatedAt: nowIso(),
    }));

    state.tasks = normalizeTasks(state.tasks);
    return state;
  });
  return getDesktopBootstrap();
}

// Legacy non-stream entry uses the same tool-capable runner as chat.
export async function runTask(taskId, options = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => runTask(taskId, options));
  const { execution } = await prepareTaskExecution(taskId, { skipBootstrap: true });
  const { sendChatMessage } = await import('../chat/sendChatMessage.js');
  await sendChatMessage({ ...execution, signal: options.signal, sseEmitter: options.sseEmitter, skipBootstrap: true });
  return getDesktopBootstrap();
}
export async function runTaskLane(owner) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => runTaskLane(owner));
  const state = await loadState();
  const tasks = state.tasks.filter(t => t.kind === 'agent' && t.owner === owner && ['todo', 'blocked'].includes(t.status));
  if (!tasks.length) throw new Error('没有待执行的任务。');
  for (const task of tasks) await runTask(task.id);
  return getDesktopBootstrap();
}
