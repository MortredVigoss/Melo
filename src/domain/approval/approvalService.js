// ─── Approval service ────────────────────────────────────────────────────────
// Canonicalization + presentation helpers for the "approvals" slice of
// state — requests the agent needs the user to OK before executing
// (commands, external tool calls, etc.). Pure record shape helpers; the
// create/resolve state mutations stay in desktopStore until the Phase 10
// state split.
//
// This module owns:
//   - APPROVAL_STATUSES — valid `status` values (pending / running /
//     approved / rejected)
//   - MAX_APPROVALS — completed-history cap; unresolved approvals are retained
//   - normalizeApproval(raw) — shape-coerce one record; legacy/partial
//     blobs round-trip safely (unknown status falls back to "pending")
//   - normalizeApprovals(list) — newest-first, bounded completed history
//   - summarizeApproval(approval) — decorate with human createdLabel +
//     updatedLabel for the UI; never mutates the stored approval
//
// Extracted from desktopStore.js in the Phase 8 refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — only imports shared
// date helpers.

import { randomUUID } from 'node:crypto';
import { coerceIso, formatUpdatedAt } from '../../shared/helpers.js';

export const APPROVAL_STATUSES = ['pending', 'running', 'uncertain', 'approved', 'rejected'];
export const MAX_APPROVALS = 24;

export function normalizeApproval(approval) {
  return {
    id: approval?.id || randomUUID(),
    kind: typeof approval?.kind === 'string' ? approval.kind : 'command',
    title: approval?.title || 'Pending approval',
    description: typeof approval?.description === 'string' ? approval.description : '',
    status: APPROVAL_STATUSES.includes(approval?.status) ? approval.status : 'pending',
    projectId: approval?.projectId || null,
    chatId: approval?.chatId || null,
    payload:
      approval?.payload && typeof approval.payload === 'object' ? approval.payload : {},
    resultSummary:
      typeof approval?.resultSummary === 'string' ? approval.resultSummary : '',
    createdAt: coerceIso(approval?.createdAt),
    updatedAt: coerceIso(approval?.updatedAt),
    executedAt: approval?.executedAt ? coerceIso(approval.executedAt) : null,
  };
}

export function normalizeApprovals(approvals) {
  if (!Array.isArray(approvals)) {
    return [];
  }

  let completedCount = 0;
  return approvals
    .map(normalizeApproval)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .filter(approval => ['pending', 'running', 'uncertain'].includes(approval.status) || completedCount++ < MAX_APPROVALS);
}

export function summarizeApproval(approval) {
  return {
    ...approval,
    createdLabel: formatUpdatedAt(approval.createdAt),
    updatedLabel: formatUpdatedAt(approval.updatedAt),
  };
}

// Boot recovery only: never replay an action whose external outcome is unknown.
export function recoverApprovalRuns(state) {
  for (const approval of state.approvals || []) {
    if (approval.status !== 'running') continue;
    approval.status = 'uncertain';
    approval.updatedAt = new Date().toISOString();
    approval.resultSummary = '执行时应用中断，操作结果尚未确认。请核对文件、命令或外部服务记录；不会自动重复执行。';
  }
  return state;
}
