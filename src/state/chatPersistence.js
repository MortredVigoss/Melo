import { createHash } from 'node:crypto';
import { normalizeChat } from './stateHydration.js';
import { saveThreadCheckpoint } from '../memory/checkpointer.js';
import {
  ensureChatThreadContext,
  buildThreadCheckpointPayload,
} from '../memory/chatThreadContext.js';

export { serializeChatForPersistence } from './chatManifest.js';

/**
 * @param {Array} chats
 * @param {{ threadsDir?: string }} [options] — explicit threadsDir to
 *   route every saveThreadCheckpoint + pruneThreadCheckpoints call
 *   through. CLAUDE.md §6: required when called from inside a captured
 *   load chain (e.g. readStateSnapshot's repair-save) so the disk
 *   target stays pinned to the home that started the chain. Omitted =
 *   legacy lazy resolution.
 */
export async function persistChatThreads(chats = [], { threadsDir, unchanged = new Set() } = {}) {
  const keepThreadIds = [];
  let written = 0;
  for (const chat of chats) {
    if (!chat?.id) continue;
    if (unchanged.has(chat.id)) {
      if (chat.checkpointId) keepThreadIds.push(chat.checkpointId);
      continue;
    }
    Object.assign(chat, normalizeChat(chat));
    if (!chat.messages.length) {
      chat.checkpointId = null;
      continue;
    }
    const payload = buildThreadCheckpointPayload(chat, ensureChatThreadContext(chat));
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const checkpointId = `${chat.id}--${digest}`;
    if (chat.checkpointId !== checkpointId) {
      await saveThreadCheckpoint(checkpointId, payload, { threadsDir });
      written += 1;
    }
    chat.checkpointId = checkpointId;
    keepThreadIds.push(checkpointId);
  }
  // Cleanup is the caller's responsibility AFTER committing the manifest.
  return { keepThreadIds, written };
}
