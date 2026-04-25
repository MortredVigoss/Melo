// Chat-persistence helpers — Phase 7d-5α-A1.
//
// Two functions:
//
//   serializeChatForPersistence — shape a chat record for the on-disk
//     state.json snapshot. Strips runtime-only fields like `messages`,
//     `compactSummary`, etc. so they don't appear in the serialized
//     state (those live in per-thread checkpoints written by
//     persistChatThreads). Pure object reshape, no deps.
//
//   persistChatThreads — for each chat with messages, derive a thread
//     context (ensureChatThreadContext) and persist a checkpoint to
//     ~/.melo/desktop/threads/<chat.id>.json via saveThreadCheckpoint.
//     Then prune any older checkpoint files whose chat is no longer
//     active.
//
// History:
//   • commit 2/9 (4d81ef4): introduced this module with
//     serializeChatForPersistence.
//   • commit 4/9 (this commit): added persistChatThreads, made
//     possible by commit 3 (2cc94a8) lifting ensureChatThreadContext
//     and buildThreadCheckpointPayload to src/state/chatThreadContext.js.
//
// Per CLAUDE.md §5 (byte-for-byte rule), bodies are verbatim from
// desktopStore.js — only the `export` keyword was added.

import { saveThreadCheckpoint, pruneThreadCheckpoints } from '../memory/checkpointer.js';
import {
  ensureChatThreadContext,
  buildThreadCheckpointPayload,
} from './chatThreadContext.js';

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

/**
 * @param {Array} chats
 * @param {{ threadsDir?: string }} [options] — explicit threadsDir to
 *   route every saveThreadCheckpoint + pruneThreadCheckpoints call
 *   through. CLAUDE.md §6: required when called from inside a captured
 *   load chain (e.g. readStateSnapshot's repair-save) so the disk
 *   target stays pinned to the home that started the chain. Omitted =
 *   legacy lazy resolution.
 */
export async function persistChatThreads(chats = [], { threadsDir } = {}) {
  const keepThreadIds = [];

  for (const chat of chats) {
    if (!chat?.id) {
      continue;
    }

    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    if (!messages.length) {
      continue;
    }

    const threadContext = ensureChatThreadContext(chat);
    await saveThreadCheckpoint(
      chat.id,
      buildThreadCheckpointPayload(chat, threadContext),
      { threadsDir },
    );
    keepThreadIds.push(chat.id);
  }

  await pruneThreadCheckpoints(keepThreadIds, { threadsDir });
}
