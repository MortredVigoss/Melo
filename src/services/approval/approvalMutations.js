// Approval mutation handlers — sub-phase 7d-5ε commit 3 of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Three exported approval-domain entries server.js calls. `executeApproval`
// is the most interesting: it dispatches on `approval.kind` to the
// matching workspace / connector mutation. After 7d-5ε commit 1 (external
// connector) and the workspace-mutations extraction in this same commit,
// none of those targets reach back into desktopStore.

import { randomUUID } from 'node:crypto';
import { nowIso } from '../../shared/helpers.js';
import {
  loadState,
  updateStateAtomically,
} from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { findApprovalById } from '../../state/stateLookups.js';
import { getDesktopBootstrap } from '../../state/desktopBootstrap.js';
import {
  normalizeApproval,
  normalizeApprovals,
} from './approvalService.js';
import {
  runLocalCommand,
  saveWorkspaceFile,
  applyArtifactToWorkspaceFile,
} from '../workspace/workspaceMutations.js';
import { invokeExternalConnectorTool } from '../connector/externalConnectorMutations.js';

export async function createApproval({
  kind,
  title,
  description,
  payload,
  projectId,
  chatId,
}) {
  await updateStateAtomically(state => {
    const approval = normalizeApproval({
      id: randomUUID(),
      kind,
      title: String(title || '').trim() || 'Pending approval',
      description: String(description || '').trim(),
      payload,
      projectId: projectId || state.settings.selectedProjectId,
      chatId: chatId || state.settings.selectedChatId,
      status: 'pending',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    state.approvals.unshift(approval);
    state.approvals = normalizeApprovals(state.approvals);
    return state;
  });
  return getDesktopBootstrap();
}

export async function rejectApproval(approvalId) {
  await updateStateAtomically(state => {
    const approval = findApprovalById(state, approvalId);
    if (!approval) {
      throw new Error('Approval request not found.');
    }

    approval.status = 'rejected';
    approval.updatedAt = nowIso();
    approval.resultSummary = 'Request rejected.';
    state.approvals = normalizeApprovals(state.approvals);
    return state;
  });
  return getDesktopBootstrap();
}

export async function executeApproval(approvalId) {
  const state = ensureSelectedEntities(await loadState());
  const approval = findApprovalById(state, approvalId);
  if (!approval) {
    throw new Error('Approval request not found.');
  }

  await updateStateAtomically(latestState => {
    const runningApproval = findApprovalById(latestState, approvalId);
    if (!runningApproval) {
      throw new Error('Approval request not found.');
    }

    runningApproval.status = 'running';
    runningApproval.updatedAt = nowIso();
    runningApproval.resultSummary = 'Running approved action...';
    latestState.approvals = normalizeApprovals(latestState.approvals);
    return latestState;
  });

  try {
    let result;
    switch (approval.kind) {
      case 'command':
        result = await runLocalCommand(approval.payload);
        break;
      case 'file-save':
        result = await saveWorkspaceFile(approval.payload);
        break;
      case 'artifact-apply':
        result = await applyArtifactToWorkspaceFile(approval.payload);
        break;
      case 'external-tool':
        result = await invokeExternalConnectorTool(approval.payload);
        break;
      default:
        throw new Error(`Unsupported approval kind: ${approval.kind}`);
    }

    await updateStateAtomically(latestState => {
      const completedApproval = findApprovalById(latestState, approvalId);
      if (!completedApproval) {
        return latestState;
      }

      completedApproval.status = 'approved';
      completedApproval.updatedAt = nowIso();
      completedApproval.executedAt = nowIso();
      completedApproval.resultSummary =
        result?.commandRun?.label ||
        result?.toolRun?.toolName ||
        result?.workspace?.selectedFilePath ||
        'Action completed.';
      latestState.approvals = normalizeApprovals(latestState.approvals);
      return latestState;
    });

    return {
      ...(result || {}),
      bootstrap: await getDesktopBootstrap(),
    };
  } catch (error) {
    await updateStateAtomically(latestState => {
      const failedApproval = findApprovalById(latestState, approvalId);
      if (!failedApproval) {
        return latestState;
      }

      failedApproval.status = 'rejected';
      failedApproval.updatedAt = nowIso();
      failedApproval.resultSummary = error.message;
      latestState.approvals = normalizeApprovals(latestState.approvals);
      return latestState;
    });
    throw error;
  }
}
