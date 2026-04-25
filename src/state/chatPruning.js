// Chat-pruning helpers — extracted from desktopStore in Phase 7d-5α-A1.
//
// This module is the smallest leaf-first step toward extracting the
// state machine: pruning operates on `state.chats` only, has no
// transitive dependencies on other desktopStore-local helpers, and gets
// called from both the state-loader path (auto-prune legacy excess on
// startup) and the chat-creation path (make room before adding a new
// chat). Moving it here lets future leaves — chatPersistence,
// stateHydration — reach the prune logic without going through
// desktopStore (which would re-create the cycle Codex flagged in
// review of cec12c3).
//
// Per CLAUDE.md §5 (byte-for-byte rule), every body below is verbatim
// from desktopStore.js — only the `export` keyword was added.

// MAX_RECENT_CHATS used to live as a private const in desktopStore.js.
// Any caller outside this module that wants to reference the cap should
// import it from here.
export const MAX_RECENT_CHATS = 10;

export function oldestUnlockedChat(chats = []) {
  return [...chats]
    .filter(chat => !chat.locked)
    .sort(
      (left, right) =>
        new Date(left.updatedAt || left.createdAt || 0).getTime() -
        new Date(right.updatedAt || right.createdAt || 0).getTime(),
    )[0] || null;
}

export function pruneExcessChats(state) {
  // Auto-delete the oldest unlocked chats until we are below MAX_RECENT_CHATS.
  // Locked chats are always preserved. Used both on load (to clear legacy records)
  // and before creating a new chat (so the user is never blocked by an error).
  while ((state.chats || []).length >= MAX_RECENT_CHATS) {
    const oldest = oldestUnlockedChat(state.chats);
    if (!oldest) {
      break; // all remaining chats are locked — can't prune further
    }
    state.chats = (state.chats || []).filter(c => c.id !== oldest.id);
  }
}

export function assertCanCreateChat(state) {
  // First try to make room by pruning excess unlocked chats automatically.
  pruneExcessChats(state);

  if ((state.chats || []).length < MAX_RECENT_CHATS) {
    return;
  }

  // Only reaches here when every existing chat is locked.
  throw new Error(
    `Recents is full (${MAX_RECENT_CHATS}) and all chats are locked. Unlock or delete one before starting a new chat.`,
  );
}
