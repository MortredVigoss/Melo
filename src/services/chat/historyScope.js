import { isLocalChat } from '../../memory/factPolicy.js';

// Which conversations a history search from `chatId` may read. A project chat
// sees its own project; a chat outside projects sees other chats outside
// projects; channel chats (Telegram etc.) only see themselves. Nothing crosses
// a project boundary, so one project's discussion never surfaces in another.
export function historySearchChatIds(state, chatId) {
  const chats = Array.isArray(state?.chats) ? state.chats : [];
  const current = chats.find(chat => chat.id === chatId);
  if (!current) return chatId ? [chatId] : [];
  if (!isLocalChat(current)) return [current.id];
  const deleted = new Set([...(state?.pendingChatDeletions || []), ...(state?.mobileDeletedChats || []).map(row => row.id)]);
  const projectId = current.projectId || null;
  return chats.filter(chat => !deleted.has(chat.id) && isLocalChat(chat) && (chat.projectId || null) === projectId).map(chat => chat.id);
}
