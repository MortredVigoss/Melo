// Recents is a display limit, never a retention policy. Kept for legacy callers.
export const MAX_RECENT_CHATS = 10;
export function oldestUnlockedChat(chats = []) {
  return [...chats].filter(chat => !chat.locked).sort((a, b) =>
    new Date(a.updatedAt || a.createdAt || 0) - new Date(b.updatedAt || b.createdAt || 0))[0] || null;
}
export function pruneExcessChats() {}
export function assertCanCreateChat() {}
