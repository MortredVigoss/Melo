import { updateStateAtomically } from '../../state/stateStore.js';
import { nextActivatedGroups } from '../../tools/toolGroups.js';

export async function persistSessionMemorySnapshot(snapshot, { home } = {}) {
  let applied = false;
  await updateStateAtomically(state => {
    const chat = state.chats.find(chat => chat.id === snapshot.id);
    if (!chat || (Number(chat.memoryLastExtractedAtCount) || 0) > (Number(snapshot.memoryLastExtractedAtCount) || 0)) return;
    if (chat.messages?.[snapshot.messages.length - 1]?.id !== snapshot.messages.at(-1)?.id) return;
    for (const key of ['sessionMemory', 'memoryLastExtractedAt', 'memoryLastExtractedAtCount']) chat[key] = snapshot[key];
    applied = true;
  }, { home });
  return applied;
}

// Persist a small set of per-chat runtime fields (e.g. activated tool groups)
// without touching messages. Used for only-grow flags that must survive a
// restart.
export async function persistChatRuntimeFields(chat, keys = [], { home } = {}) {
  await updateStateAtomically(latest => {
    const current = latest.chats.find(entry => entry.id === chat.id);
    if (!current) return;
    for (const key of keys) current[key] = chat[key];
  }, { home });
}

// Persist a compaction failure so the MAX_COMPACT_FAILURES breaker survives
// the turn (audit L5). Merged with max(): a background pass working on a
// stale snapshot can never lower the stored count.
export async function persistCompactFailure(chat, { home } = {}) {
  await updateStateAtomically(latest => {
    const current = latest.chats.find(entry => entry.id === chat.id);
    if (!current) return;
    current.compactFailures = Math.max(Number(current.compactFailures) || 0, Number(chat.compactFailures) || 0);
    chat.compactFailures = current.compactFailures;
  }, { home });
}

// Compact fields only (audit T4/L2). The background pre-compaction finishes
// with a `chat` snapshot that may be a turn or more behind the store, so
// only-grow runtime flags are merged, never copied: activated tool groups
// as a union, the attachment migration mark never lowered, and the upgrade
// counter taken from the store unless this write comes from the upgrade
// path itself.
const COMPACT_FIELDS = ['compactSummary', 'compactCards', 'compactBoundaryMessageId', 'compactedMessageCount', 'compactedAt', 'compactFailures', 'compactSummarySource'];

export async function persistCompactSnapshot(chat, compactPlan, { home, upgrade = false } = {}) {
  await updateStateAtomically(latest => {
    const current = latest.chats.find(entry => entry.id === chat.id);
    if (!current || !current.messages.some(message => message.id === compactPlan.boundaryId)) return;
    if ((current.compactedMessageCount || 0) > compactPlan.compactedCount) return;
    for (const key of COMPACT_FIELDS) current[key] = chat[key];
    if (upgrade) current.compactUpgradeAttempts = chat.compactUpgradeAttempts;
    else chat.compactUpgradeAttempts = current.compactUpgradeAttempts;
    const groups = nextActivatedGroups(current.toolGroupsActivated, Array.isArray(chat.toolGroupsActivated) ? chat.toolGroupsActivated : []);
    if (groups.length || Array.isArray(current.toolGroupsActivated)) current.toolGroupsActivated = groups;
    chat.toolGroupsActivated = current.toolGroupsActivated;
    if (chat.attachmentsExternalized === true) current.attachmentsExternalized = true;
    chat.attachmentsExternalized = current.attachmentsExternalized;
  }, { home });
}
