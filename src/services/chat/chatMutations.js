import {ownedChatDirectory} from '../workspace/chatWorkspaceFiles.js';
import { moveChatProject } from '../../domain/project/projectLifecycle.js';
import {creationProjectId} from '../../domain/project/projectMembership.js';
import { mergeDeletedChats } from '../../../mobile-sync/protocol.js';
import { assertChatDeletable, stageChatDeletion, finishChatDeletions } from './chatDeletion.js';
import { getResolvedConfig } from '../../config.js';
import { validateConversationSelection } from './conversationSelection.js';
// Architecture migration: byte-for-byte command port.
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import { createChatRecord } from '../../state/conversation.js';

export async function createChat({ mode, projectId, agentId, modelSelection, contextArtifactIds }) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => createChat(...arguments));
  const selectionConfig = await getResolvedConfig();
  // Recents is a presentation limit. Only explicit deletion removes history.
  await updateStateAtomically(async latestState => {
    const state = ensureSelectedEntities(latestState);
    const chat = createChatRecord({
      mode: mode || state.settings.activeMode,
      projectId: creationProjectId(state,{projectId,operation:'chat'}),
      agentId: agentId || null,
    });
    if (state.projects.find(p=>p.id===chat.projectId)?.archived) throw new Error('请先恢复此项目，再创建新的项目对话。');

    Object.assign(chat, validateConversationSelection({...(agentId ? {agentId} : {}), ...(modelSelection ? {modelSelection} : {}), ...(contextArtifactIds ? {contextArtifactIds} : {})}, state, selectionConfig));
    state.chats.unshift(chat);
    state.settings.selectedChatId = chat.id;
    state.settings.selectedProjectId = chat.projectId;
    state.settings.activeView = 'chat';
    state.settings.activeMode = chat.mode;
    return state;
  });

  return getDesktopBootstrap();
}

export async function updateChat(chatId, patch = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => updateChat(...arguments));
  const selectionConfig = await getResolvedConfig();
  // 2026-05-23 架构 audit #3: read-find-merge moves inside the mutator so the
  // locked-flag write merges against the freshest chat record (a concurrent
  // updateChat / deleteChat can't be silently overwritten). Not-found throw
  // inside the mutator aborts before persist.
  await updateStateAtomically(async latestState => {
    const state = ensureSelectedEntities(latestState);
    const chatIndex = state.chats.findIndex(chat => chat.id === chatId);
    if (chatIndex < 0) {
      throw new Error('Chat not found.');
    }

    const currentChat = state.chats[chatIndex];
    if ((Object.hasOwn(patch, 'agentId') || Object.hasOwn(patch, 'modelSelection') || Object.hasOwn(patch, 'projectId') || Object.hasOwn(patch, 'contextArtifactIds')) && state.chatRuns?.some(run=>run.chatId===chatId && run.status==='running')) throw new Error('请等待当前回复结束后再切换角色或模型。');
    const selection = validateConversationSelection(patch, state, selectionConfig);
    if (Object.hasOwn(selection, 'projectId') && selection.projectId !== currentChat.projectId) {
      moveChatProject(state, currentChat, selection.projectId, new Date().toISOString());
    }
    if (Object.hasOwn(selection, 'projectId') && state.settings.selectedChatId === chatId && state.settings.activeView === 'chat') state.settings.selectedProjectId = selection.projectId;
    state.chats[chatIndex] = {
      ...currentChat,
      ...selection,
      locked:
        typeof patch.locked === 'boolean'
          ? patch.locked
          : Boolean(currentChat.locked),
    };
    return state;
  });
  return getDesktopBootstrap();
}

export async function deleteChat(chatId, options={}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => deleteChat(...arguments));
  const home = currentRequestContext().home;
  // 2026-05-23 架构 audit #3: filter-and-clear-selection inside the mutator so
  // a concurrent createChat / updateChat against the same list can't be lost.
  await updateStateAtomically(async latestState => {
    const state = ensureSelectedEntities(latestState);
    const existingChat = state.chats.find(chat => chat.id === chatId);
    if (!existingChat) {
      throw new Error('Chat not found.');
    }

    assertChatDeletable(state, existingChat);
    const directory=await ownedChatDirectory(home,chatId);
    if (!['keep','delete'].includes(options.fileDecision) && directory.exists) throw Object.assign(new Error('请选择是否同时删除对话文件。'),{statusCode:409,code:'FILE_DECISION_REQUIRED'});
    if(options.fileDecision==='delete' && options.workspaceToken!==directory.token) throw Object.assign(new Error('文件目录已变化，请重新确认。'),{statusCode:409,code:'WORKSPACE_CHANGED'});
    stageChatDeletion(state, [chatId],options);
    if (!existingChat.externalThreadKey) {
      state.mobileDeletedChats = mergeDeletedChats(state.mobileDeletedChats, [{id:chatId,deletedAt:new Date().toISOString()}]);
    }
    state.chats = state.chats.filter(chat => chat.id !== chatId);
    if (state.settings.selectedChatId === chatId) {
      state.settings.selectedChatId = null;
    }
    return state;
  });
  await finishChatDeletions(home);
  return getDesktopBootstrap();
}
