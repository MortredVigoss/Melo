import {stageChatFiles,finishChatFileDeletions} from '../workspace/chatWorkspaceFiles.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
import { loadState, updateStateAtomically } from '../../state/stateStore.js';
import { getReminderScheduler } from '../../reminders/scheduler.js';
import { deleteArchivedChatRuns } from '../../persistence/turnArchive.js';
import { quarantineDeletedChatFacts } from '../../memory/factRecords.js';

export function assertChatDeletable(state, chat) {
  if (chat.locked) throw Object.assign(new Error('对话已锁定，请先在桌面解锁，再重试删除或同步。'), {statusCode:409});
  if (state.chatRuns?.some(run => run.chatId === chat.id && run.status === 'running') || state.approvals?.some(a=>a.chatId===chat.id && a.status==='running')) throw Object.assign(new Error('对话仍在执行，请等待结束后再删除或同步。'), {statusCode:409});
}
export function stageChatDeletion(state, ids, options={}) {
  stageChatFiles(state,ids,options);
  state.pendingChatDeletions = [...new Set([...(state.pendingChatDeletions || []), ...ids])];
}
// Call only AFTER the state commit and outside its queue: reminder delivery
// itself takes that queue. The durable pending list makes crash/failure retry safe.
export async function finishChatDeletions(home) {
  if (currentRequestContext()?.home !== home) return runWithRequestContext(createRequestContext({...currentRequestContext(),home}), () => finishChatDeletions(home));
  const state = await loadState({home});
  const ids = (state.pendingChatDeletions || []).filter(id => !state.chats.some(c => c.id === id));
  await finishChatFileDeletions(home);
  if (!ids.length) return;
  quarantineDeletedChatFacts(ids);
  const completed = new Set();
  for (const id of ids) {
    try {
      await getReminderScheduler(home).cancelChat(id);
      deleteArchivedChatRuns(home, id);
      completed.add(id);
    } catch (error) { console.warn(`Deleted-chat cleanup deferred: ${error.message}`); }
  }
  if (completed.size) await updateStateAtomically(s => {
    s.pendingChatDeletions = (s.pendingChatDeletions || []).filter(id => !completed.has(id));
    return s;
  }, {home});
}
