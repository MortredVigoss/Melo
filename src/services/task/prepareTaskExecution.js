import { validateTeamPlan } from '../../agents/team.js';
import { randomUUID } from 'node:crypto';
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { createChatRecord } from '../../state/conversation.js';
import { assertCanCreateChat } from '../../state/chatPruning.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';

export async function prepareTaskExecution(taskId, { skipBootstrap = false, teamPlan = null } = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => prepareTaskExecution(taskId, { skipBootstrap, teamPlan }));
  teamPlan = validateTeamPlan(teamPlan);
  let execution;
  await updateStateAtomically(state => {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) throw new Error('找不到任务。');
    if (task.projectId && state.projects?.find(project => project.id === task.projectId)?.deletedAt) throw new Error('所属项目已删除，请重新分配任务后再执行。');
    if (task.status === 'running') throw new Error('任务正在执行，请先停止当前执行。');
    let chat = state.chats.find(c => c.id === task.execution?.chatId);
    // Reassignment creates a fresh execution chat; the previous run keeps its
    // original conversation and workspace snapshot.
    if (!chat || (chat.projectId || null) !== (task.projectId || null)) {
      assertCanCreateChat(state);
      chat = createChatRecord({ mode: 'chat', projectId: task.projectId, agentId: task.owner });
      chat.title = task.title;
      state.chats.unshift(chat);
    }
    if (task.execution?.status !== 'prepared' || task.execution.chatId !== chat.id || JSON.stringify(task.execution.teamPlan || null) !== JSON.stringify(teamPlan)) {
      const content = `请执行任务：${task.title}\n${task.summary || ''}\n\n使用可用工具完成工作，并验证结果。说明实际改动、验证结果和未完成的事项。遇到权限请求请等待用户决定。${task.runCount ? '\n这是一次恢复或修复：先查看本对话中的执行记录和当前文件状态，避免重复已完成的外部操作，再处理剩余问题。' : ''}`;
      task.execution = { requestId: randomUUID(), chatId: chat.id, content, status: 'prepared', teamPlan, createdAt: new Date().toISOString() };
    }
    task.status = 'todo';
    task.syncRevision = (task.syncRevision || 1) + 1;
    task.updatedAt = new Date().toISOString();
    execution = { ...task.execution, taskId };
    state.settings.selectedChatId = chat.id;
    state.settings.activeMode = chat.mode;
    state.settings.activeView = 'chat';
  });
  return { execution, bootstrap: skipBootstrap ? null : await getDesktopBootstrap() };
}
