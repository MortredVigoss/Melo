// ─── Task service ────────────────────────────────────────────────────────────
// Canonicalization + presentation helpers for the "tasks" slice of state —
// the small todo/agent-run queue surfaced in the Melo sidebar. This module
// does not read or write state; callers hand in a raw record and get back a
// shape the rest of the app can depend on.
//
// This module owns:
//   - TASK_OWNERS — valid `owner` values (main / research / builder / reviewer)
//   - TASK_STATUSES — valid `status` values (todo / running / blocked / done)
//   - MAX_TASKS — cap enforced by normalizeTasks()
//   - normalizeTask(raw) — shape-coerce a single record; invalid owner/status
//     fall back to defaults so legacy blobs still load cleanly
//   - normalizeTasks(list) — array version, sorted newest-first and clamped
//     to MAX_TASKS so the sidebar doesn't grow unbounded
//   - summarizeTask(task) — decorate with human labels for the UI; pure
//     view-model, no mutation of the underlying task
//
// Extracted from desktopStore.js in the Phase 8 refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — only imports shared
// date helpers.

import { randomUUID } from 'node:crypto';
import { coerceIso, formatUpdatedAt } from '../../shared/helpers.js';

export const TASK_OWNERS = ['main', 'research', 'builder', 'reviewer'];
export const TASK_STATUSES = ['todo', 'running', 'blocked', 'done'];
export const MAX_TASKS = 24;

function titleCase(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, match => match.toUpperCase());
}

export function normalizeTask(task) {
  return {
    id: task?.id || randomUUID(),
    kind: task?.kind === 'agent' ? 'agent' : 'task',
    title: task?.title || 'Untitled task',
    summary: typeof task?.summary === 'string' ? task.summary : '',
    owner: TASK_OWNERS.includes(task?.owner) ? task.owner : 'main',
    status: TASK_STATUSES.includes(task?.status) ? task.status : 'todo',
    projectId: task?.projectId || null,
    chatId: task?.chatId || null,
    createdAt: coerceIso(task?.createdAt),
    updatedAt: coerceIso(task?.updatedAt),
    latestNote: typeof task?.latestNote === 'string' ? task.latestNote : '',
    runCount: Number.isFinite(Number(task?.runCount)) ? Number(task.runCount) : 0,
    lastRunAt: task?.lastRunAt ? coerceIso(task.lastRunAt) : null,
  };
}

export function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) {
    return [];
  }

  return tasks
    .map(normalizeTask)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, MAX_TASKS);
}

export function summarizeTask(task) {
  return {
    ...task,
    updatedLabel: formatUpdatedAt(task.updatedAt),
    ownerLabel: titleCase(task.owner),
    statusLabel: titleCase(task.status),
    lastRunLabel: task.lastRunAt ? formatUpdatedAt(task.lastRunAt) : 'Never run',
    latestNotePreview: task.latestNote ? task.latestNote.slice(0, 220) : '',
  };
}
