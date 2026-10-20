import { putWorkspace } from '../../../mobile-sync/workspaceProtocol.js';
import { projectDeletionId, projectDeletionValue } from '../../../mobile-sync/projectLifecycle.js';

function conflict(message) { throw Object.assign(new Error(message), { statusCode: 409, code: 'PROJECT_LIFECYCLE_CONFLICT' }); }
export function moveChatProject(state, chat, projectId, timestamp) {
  if ((chat.projectId || null) === (projectId || null)) return;
  if (['chatRuns', 'commandRuns', 'approvals'].some(key => (state[key] || []).some(row => row.chatId === chat.id && row.status === 'running'))) conflict('对话仍有进行中的操作，请结束后再移动。');
  invalidateProjectApprovals(state, chat.id, timestamp);
  chat.projectId = projectId || null;
}
export function invalidateProjectApprovals(state, chatId, timestamp) {
  for (const approval of state.approvals || []) if (approval.chatId === chatId && approval.status === 'pending') {
    approval.status = 'rejected'; approval.updatedAt = timestamp;
    approval.resultSummary = '项目归属已变化，此审批失效；请按新的工作目录重新请求。';
  }
}
export function assertProjectIdle(state, projectId) {
  const chats = new Set((state.chats || []).filter(chat => chat.projectId === projectId).map(chat => chat.id));
  if ((state.chatRuns || []).some(run => run.status === 'running' && (run.projectId === projectId || chats.has(run.chatId))) ||
      (state.commandRuns || []).some(run => run.status === 'running' && (run.projectId === projectId || chats.has(run.chatId))) ||
      (state.approvals || []).some(row => row.status === 'running' && (row.projectId === projectId || chats.has(row.chatId))) ||
      (state.tasks || []).some(row => row.projectId === projectId && ['doing', 'running'].includes(row.status))) conflict('项目仍有进行中的回复、命令、审批或任务，请先停止或完成。');
}

// A single state transaction is the durable operation journal. No directory
// traversal, file deletion, tool dispatch or external effect occurs here.
export function deleteProjectState(state, { projectId, operationId, timestamp, device }) {
  const project = state.projects.find(row => row.id === projectId);
  if (!project) conflict('项目不存在。');
  if (project.deletedAt) return project.lifecycle;
  assertProjectIdle(state, projectId);
  const marker = projectDeletionValue({ projectId, operationId, deletedAt: timestamp });
  const chats = (state.chats || []).filter(chat => chat.projectId === projectId);
  const artifacts = (state.artifacts || []).filter(row => row.projectId === projectId || project.knowledgeIds?.includes(row.id));
  const pending = (state.approvals || []).filter(row => row.status === 'pending' && (row.projectId === projectId || chats.some(chat => chat.id === row.chatId)));
  const report = {
    chatIds: chats.map(row => row.id), artifactIds: artifacts.map(row => row.id),
    invalidatedApprovalIds: pending.map(row => row.id),
    workspacePolicy: 'retained', memoryNamespace: `project:${projectId}`, memoryPolicy: 'retained_in_original_scope',
  };
  for (const chat of chats) { chat.projectId = null; invalidateProjectApprovals(state, chat.id, timestamp); }
  for (const row of artifacts) if (row.projectId === projectId) row.projectId = null;
  for (const row of pending) { row.status = 'rejected'; row.updatedAt = timestamp; row.resultSummary = '项目已删除，此审批失效；未执行操作。'; }
  for (const task of state.tasks || []) if (task.projectId === projectId && !['done', 'cancelled'].includes(task.status)) {
    task.status = 'blocked'; task.latestNote = '所属项目已删除，原目标记录保留；请重新分配后继续。'; task.updatedAt = timestamp;
  }
  project.deleted = true; project.deletedAt = timestamp; project.archived = true; project.updatedAt = timestamp;
  project.lifecycle = { deleteOperationId: operationId, deletedAt: timestamp, report };
  if (state.settings?.selectedProjectId === projectId) {
    state.settings.selectedProjectId = null; state.settings.selectedAgentScope = 'global'; state.settings.selectedFilePath = null;
  }
  state.mobileWorkspaceSync ||= { version: 1, records: [] };
  state.mobileWorkspaceDevice ||= device;
  putWorkspace(state.mobileWorkspaceSync, 'knowledge', projectDeletionId(projectId),
    marker, state.mobileWorkspaceDevice);
  return project.lifecycle;
}

export function restoreProjectState(state, { projectId, operationId, replacementId, timestamp }) {
  const original = state.projects.find(row => row.id === projectId);
  if (!original?.deletedAt) conflict('项目没有删除记录。');
  if (original.lifecycle?.restoredProjectId) {
    const existing = state.projects.find(row => row.id === original.lifecycle.restoredProjectId);
    if (!existing || existing.deletedAt) conflict('已恢复的项目后来再次删除，请从它自己的删除记录恢复。');
    return existing;
  }
  if (state.projects.some(row => row.id === replacementId)) conflict('恢复项目 ID 已存在。');
  const restored = { ...original, id: replacementId, archived: false, createdAt: timestamp, updatedAt: timestamp };
  delete restored.deleted; delete restored.deletedAt; delete restored.lifecycle;
  // Project-level capability overrides and old approvals do not move to a new ID.
  original.lifecycle ||= {};
  Object.assign(original.lifecycle, { restoreOperationId: operationId, restoredProjectId: replacementId });
  state.projects.unshift(restored);
  return restored;
}
