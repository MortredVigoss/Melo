import {effectiveAgentProfile} from '../../state/agentProfiles.js';
import {hasCapability} from '../../domain/agent/capabilities.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
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
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import {
  normalizeApproval,
  normalizeApprovals,
} from '../../domain/approval/approvalService.js';
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
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => createApproval(...arguments));
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
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => rejectApproval(...arguments));
  await updateStateAtomically(state => {
    const approval = findApprovalById(state, approvalId);
    if (!approval) {
      throw new Error('Approval request not found.');
    }

    if (!['pending', 'uncertain'].includes(approval.status)) throw Object.assign(new Error('Approval is no longer pending.'), { code: 'APPROVAL_NOT_PENDING', statusCode: 409 });
    const uncertain = approval.status === 'uncertain';
    approval.status = 'rejected';
    approval.updatedAt = nowIso();
    approval.resultSummary = uncertain ? '用户核对后关闭记录；此前操作结果未确认，不代表已撤销。' : 'Request rejected.';
    state.approvals = normalizeApprovals(state.approvals);
    return state;
  });
  return getDesktopBootstrap();
}

export async function executeApproval(approvalId) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => executeApproval(...arguments));
  let approval;
  let replayed = false;
  await updateStateAtomically(latestState => {
    approval = findApprovalById(latestState, approvalId);
    if (!approval) throw new Error('Approval request not found.');
    if (approval.status === 'approved') { replayed = true; return; }
    if (approval.status !== 'pending') {
      throw Object.assign(new Error('Approval is no longer pending.'), { code: 'APPROVAL_NOT_PENDING', statusCode: 409 });
    }
    const chat=latestState.chats.find(c=>c.id===approval.chatId);
    if (chat) {
      const profile=effectiveAgentProfile(latestState,chat.agentId || 'main',chat.projectId), caps=profile.capabilities;
      const required=approval.kind==='command'?'runCommands':['file-save','artifact-apply'].includes(approval.kind)?'writeFiles':null;
      if ((required&&!hasCapability(caps,required)) || (approval.kind==='external-tool'&&caps&&!caps.connectors.includes(approval.payload.connectorId))) throw Object.assign(new Error('Agent capability no longer permits this action.'),{code:'CAPABILITY_DENIED',statusCode:403});
    }
    approval.status = 'running';
    approval.updatedAt = nowIso();
    approval.resultSummary = 'Running approved action...';
    latestState.approvals = normalizeApprovals(latestState.approvals);
  });
  if (replayed) return { bootstrap: await getDesktopBootstrap(), replayed: true };

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
