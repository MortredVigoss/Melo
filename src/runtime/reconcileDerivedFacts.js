import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withMemoryHome, withTransaction } from '../memory/store.js';
import { reconcileLegacyFacts, quarantineDeletedChatFacts } from '../memory/factRecords.js';

// The indexing snapshot may predate a newly committed project/chat. Hold the
// memory write lock while reading current source identities, so new facts
// cannot appear between that read and destructive source reconciliation.
export function reconcileDerivedFacts({ home, snapshot, initialize, previousChatIds = new Set() }) {
  return withMemoryHome(home, () => withTransaction(() => {
    const current = JSON.parse(readFileSync(join(home, 'desktop/state.json'), 'utf8'));
    if (!Array.isArray(current.projects) || !Array.isArray(current.chats)) throw new Error('Source manifest is incomplete.');
    const hydrated = new Map(snapshot.chats.map(chat => [chat.id, chat]));
    const chats = current.chats.map(chat => hydrated.get(chat.id) || { ...chat, sessionMemory: [] });
    if (initialize) reconcileLegacyFacts({ ...snapshot, projects: current.projects, chats });
    const chatIds = new Set(current.chats.map(chat => chat.id));
    quarantineDeletedChatFacts([...previousChatIds].filter(id => !chatIds.has(id)));
    return chatIds;
  }));
}
