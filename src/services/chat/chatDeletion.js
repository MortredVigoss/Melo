import {stageChatFiles,finishChatFileDeletions} from '../workspace/chatWorkspaceFiles.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
import { loadState, updateStateAtomically } from '../../state/stateStore.js';
import { getReminderScheduler } from '../../reminders/scheduler.js';
import { deleteArchivedChatRuns } from '../../persistence/turnArchive.js';
import { quarantineDeletedChatFacts } from '../../memory/factRecords.js';
import { unindexChats } from '../../memory/conversationIndex.js';

export function assertChatDeletable(state, chat) {
  if (chat.locked) throw Object.assign(new Error('对话已锁定，请先在桌面解锁，再重试删除或同步。'), {statusCode:409});
  if (state.chatRuns?.some(run => run.chatId === chat.id && run.status === 'running') || state.approvals?.some(a=>a.chatId===chat.id && a.status==='running')) throw Object.assign(new Error('对话仍在执行，请等待结束后再删除或同步。'), {statusCode:409});
}
export function stageChatDeletion(state, ids, options={}) {
  stageChatFiles(state,ids,options);
  state.pendingChatDeletions = [...new Set([...(state.pendingChatDeletions || []), ...ids])];
}
// One-time catch-up for chats deleted before a cleanup step existed. Run inside
// a state mutation at start; finishChatDeletions then does the work.
//   1: reminders, archived runs, file decisions.
//   2 (2026-11-14): the history search index. Their file decisions were made
//      long ago, so the ids go straight onto the pending list, not through
//      stageChatFiles (which would ask about the files again).
export function stageDeletionCatchUp(state) {
  const deleted = (state.mobileDeletedChats || []).map(row => row.id);
  const version = Number(state.chatDeletionCleanupVersion) || 0;
  if (version < 1) stageChatDeletion(state, deleted);
  else if (version < 2) state.pendingChatDeletions = [...new Set([...(state.pendingChatDeletions || []), ...deleted])];
  if (version < 2) state.chatDeletionCleanupVersion = 2;
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
  // A deleted chat must stop being findable through search_history. A failure
  // here leaves every id pending, so the next start tries again.
  let unindexed = true;
  try { unindexChats(ids); } catch (error) { unindexed = false; console.warn(`Deleted-chat search cleanup deferred: ${error.message}`); }
  const completed = new Set();
  for (const id of ids) {
    try {
      await getReminderScheduler(home).cancelChat(id);
      deleteArchivedChatRuns(home, id);
      if (unindexed) completed.add(id);
    } catch (error) { console.warn(`Deleted-chat cleanup deferred: ${error.message}`); }
  }
  if (completed.size) await updateStateAtomically(s => {
    s.pendingChatDeletions = (s.pendingChatDeletions || []).filter(id => !completed.has(id));
    return s;
  }, {home});
}
