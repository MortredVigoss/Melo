// Chat-persistence helpers — Phase 7d-5α-A1 (commit 2/9).
//
// `serializeChatForPersistence` shapes a chat record for the on-disk
// state.json snapshot — it strips runtime-only fields like `messages`,
// `compactSummary`, etc. so they don't appear in the serialized state
// (those live in per-thread checkpoints written by persistChatThreads).
//
// The function is a pure object reshape (no other dep), which makes it
// the smallest safe pure-leaf to extract next. `persistChatThreads`
// (the function that uses this and was originally in the same code
// region of desktopStore) deliberately stays put for now — it depends
// on `ensureChatThreadContext` which is broadly called across the
// store and needs its own commit to lift out before persistChatThreads
// can join this module.
//
// Per CLAUDE.md §5 (byte-for-byte rule), the body is verbatim from
// desktopStore.js — only the `export` keyword was added.

export function serializeChatForPersistence(chat) {
  return {
    id: chat.id,
    title: chat.title,
    mode: chat.mode,
    projectId: chat.projectId || null,
    agentId: chat.agentId || 'main',
    source: chat.source || 'desktop',
    chatType: chat.chatType || 'private',
    chatTitle: chat.chatTitle || '',
    messageThreadId: chat.messageThreadId || null,
    externalThreadKey: chat.externalThreadKey || '',
    locked: Boolean(chat.locked),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}
