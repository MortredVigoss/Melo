import { updateStateAtomically } from '../../state/stateStore.js';

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

export async function persistCompactSnapshot(chat, compactPlan, { home } = {}) {
  await updateStateAtomically(latest => {
    const current = latest.chats.find(entry => entry.id === chat.id);
    if (!current || !current.messages.some(message => message.id === compactPlan.boundaryId)) return;
    if ((current.compactedMessageCount || 0) > compactPlan.compactedCount) return;
    for (const key of ['compactSummary', 'compactCards', 'compactBoundaryMessageId', 'compactedMessageCount', 'compactedAt', 'compactFailures', 'compactSummarySource', 'compactUpgradeAttempts', 'toolGroupsActivated', 'attachmentsExternalized']) {
      current[key] = chat[key];
    }
  }, { home });
}
