// Task mutation handlers — sub-phase 7d-5ε commit 3 of the desktopStore
// decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Six task-domain CRUD entries plus two private helpers:
//   • markTaskOutcome        (private — sets status + lastRunAt + runCount)
//   • runTaskWorkerModel     (private — invokes the task execution graph)
//   • createTask / updateTask
//   • runTask                — single-task run with state transitions
//   • runTaskLane            — owner-lane batch run
//
// All upstream deps live in dedicated leaf modules.

import { randomUUID } from 'node:crypto';
import { nowIso } from '../../shared/helpers.js';
import { getResolvedConfig } from '../../config.js';
import { loadState, saveState } from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { findTaskById } from '../../state/stateLookups.js';
import { getDesktopBootstrap } from '../../state/desktopBootstrap.js';
import {
  TASK_OWNERS,
  normalizeTask,
  normalizeTasks,
} from './taskService.js';
import { runTaskAgentExecutionGraph } from '../chat/taskExecutionRunner.js';

function markTaskOutcome(task, { success, note }) {
  task.updatedAt = nowIso();
  task.lastRunAt = nowIso();
  task.runCount = (task.runCount || 0) + 1;
  task.latestNote = note;
  task.status = success ? 'done' : 'blocked';
}

async function runTaskWorkerModel(state, config, task) {
  const graphResult = await runTaskAgentExecutionGraph({
    state,
    config,
    task,
  });

  return graphResult.reply;
}

export async function createTask({ title, summary, owner, projectId, chatId, kind = 'task' }) {
  const state = ensureSelectedEntities(await loadState());
  const task = normalizeTask({
    id: randomUUID(),
    kind,
    title: String(title || '').trim() || 'Untitled task',
    summary: String(summary || '').trim(),
    owner,
    projectId: projectId || state.settings.selectedProjectId,
    chatId: chatId || state.settings.selectedChatId,
    status: 'todo',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  state.tasks.unshift(task);
  state.tasks = normalizeTasks(state.tasks);
  await saveState(state);
  return getDesktopBootstrap();
}

export async function updateTask(taskId, patch = {}) {
  const state = ensureSelectedEntities(await loadState());
  const task = findTaskById(state, taskId);
  if (!task) {
    throw new Error('Task not found.');
  }

  Object.assign(task, normalizeTask({
    ...task,
    ...patch,
    id: task.id,
    createdAt: task.createdAt,
    updatedAt: nowIso(),
  }));

  state.tasks = normalizeTasks(state.tasks);
  await saveState(state);
  return getDesktopBootstrap();
}

export async function runTask(taskId) {
  const [config, rawState] = await Promise.all([getResolvedConfig(), loadState()]);
  const state = ensureSelectedEntities(rawState);
  const task = findTaskById(state, taskId);
  if (!task) {
    throw new Error('Task not found.');
  }

  const runningState = ensureSelectedEntities(await loadState());
  const runningTask = findTaskById(runningState, taskId);
  if (!runningTask) {
    throw new Error('Task not found.');
  }

  runningTask.status = 'running';
  runningTask.updatedAt = nowIso();
  await saveState(runningState);

  let outcome;
  try {
    const note = await runTaskWorkerModel(state, config, task);
    outcome = { success: true, note };
  } catch (error) {
    outcome = {
      success: false,
      note: error.message || 'Task run failed.',
    };
  }

  const latestState = ensureSelectedEntities(await loadState());
  const latestTask = findTaskById(latestState, taskId);
  if (!latestTask) {
    throw new Error('Task not found after worker execution.');
  }

  markTaskOutcome(latestTask, outcome);
  latestState.tasks = normalizeTasks(latestState.tasks);
  await saveState(latestState);
  return getDesktopBootstrap();
}

export async function runTaskLane(owner) {
  const normalizedOwner = TASK_OWNERS.includes(owner) ? owner : 'main';
  const [config, rawState] = await Promise.all([getResolvedConfig(), loadState()]);
  const state = ensureSelectedEntities(rawState);
  const queuedTasks = state.tasks.filter(
    task =>
      task.kind === 'agent' &&
      task.owner === normalizedOwner &&
      ['todo', 'blocked'].includes(task.status),
  );

  if (!queuedTasks.length) {
    throw new Error(`No queued agent tasks for ${normalizedOwner}.`);
  }

  const queuedTaskIds = queuedTasks.map(task => task.id);
  const runningState = ensureSelectedEntities(await loadState());
  const runningTasks = runningState.tasks.filter(task => queuedTaskIds.includes(task.id));
  if (!runningTasks.length) {
    throw new Error(`No queued agent tasks for ${normalizedOwner}.`);
  }

  for (const task of runningTasks) {
    task.status = 'running';
    task.updatedAt = nowIso();
  }
  await saveState(runningState);

  const results = await Promise.allSettled(
    queuedTasks.map(task => runTaskWorkerModel(state, config, task)),
  );

  const latestState = ensureSelectedEntities(await loadState());
  for (let index = 0; index < queuedTasks.length; index += 1) {
    const task = findTaskById(latestState, queuedTasks[index]?.id);
    const result = results[index];
    if (!task || !result) continue;

    if (result.status === 'fulfilled') {
      markTaskOutcome(task, { success: true, note: result.value });
    } else {
      markTaskOutcome(task, {
        success: false,
        note: result.reason?.message || 'Task run failed.',
      });
    }
  }

  latestState.tasks = normalizeTasks(latestState.tasks);
  await saveState(latestState);
  return getDesktopBootstrap();
}
