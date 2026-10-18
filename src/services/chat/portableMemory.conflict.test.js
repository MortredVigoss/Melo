// Cross-device memory conflict (design 2026-10-17 §3.4 跨设备同步): a phone-edited
// fact that collides with a desktop edit keeps the desktop row active, parks
// the phone version under metadata.conflict, projects as status 'conflict' and
// is settled with 采用桌面版 / 采用手机版 (editMemoryFact resolveConflict).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertMemory, getMemoriesByIds, _resetStoreForTests, isEntryInvalidated } from '../../memory/store.js';
import { canRecallMemory } from '../../memory/factPolicy.js';
import { editMemoryFact } from '../../memory/factRecords.js';
import { refreshPortableWorkspace } from './portableWorkspace.js';
import { refreshPortableMemory, applyPortableMemory, portableMemoryID, hasMemoryConflict, memoryConflict } from './portableMemory.js';
import { putWorkspace, mergeWorkspaces, resolveWorkspace } from '../../../mobile-sync/workspaceProtocol.js';

const T = n => `2026-10-17T0${n}:00:00.000Z`;
async function withStore(fn) {
  const home = mkdtempSync(join(tmpdir(), 'melo-memory-conflict-'));
  const old = process.env.MELO_HOME; process.env.MELO_HOME = home; _resetStoreForTests();
  try { return await fn(); }
  finally { if (old === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = old; _resetStoreForTests(); rmSync(home, { recursive: true, force: true }); }
}
function seed() {
  const state = { chats: [{ id: 'chat-a', source: 'desktop', title: 'A', messages: [] }], projects: [], artifacts: [], agentProfiles: {} };
  const row = { id: 'promoted:conflict', kind: 'session-fact', namespace: 'chat:chat-a', sourceId: 'chat-a', text: 'User prefers tea', searchText: 'user prefers tea',
    createdAt: T(0), updatedAt: T(0), metadata: { chatId: 'chat-a', agentId: 'main', scope: 'chat', audience: 'local', sourceText: 'I like tea', category: 'user_preference', originalFact: 'User prefers tea' } };
  upsertMemory(row);
  refreshPortableWorkspace(state);
  return { state, row, id: portableMemoryID(row.id) };
}

test('hasMemoryConflict: only when both sides edited and the desktop edit is newer than the phone edit', () => {
  const prior = { text: 'desk', metadata: { scope: 'chat', userEdited: true, editedAt: T(3) } };
  const v = { text: 'phone', scope: 'chat', status: 'active', userEdited: true, updatedAt: T(2) };
  assert.equal(hasMemoryConflict(prior, v), true);
  assert.equal(hasMemoryConflict(prior, { ...v, updatedAt: T(4) }), false, 'a phone edit after the desktop edit is sequential, phone wins');
  assert.equal(hasMemoryConflict(prior, { ...v, userEdited: false }), false);
  assert.equal(hasMemoryConflict({ ...prior, metadata: { ...prior.metadata, userEdited: false } }, v), false);
  assert.equal(hasMemoryConflict({ ...prior, metadata: { ...prior.metadata, editedAt: undefined } }, v), false, 'a raw desktop upsert is not a user edit');
  assert.equal(hasMemoryConflict(prior, { ...v, text: 'desk' }), false, 'same text and scope is no conflict');
  assert.equal(hasMemoryConflict(prior, { ...v, text: 'desk', scope: 'personal' }), true, 'a scope-only difference counts');
  assert.equal(hasMemoryConflict(prior, { ...v, status: 'forgotten' }), false);
  assert.deepEqual(memoryConflict(v), { text: 'phone', scope: 'chat', editedAt: T(2), source: 'mobile' });
});

test('single-version phone edit colliding with a newer desktop edit → status conflict, desktop row stays active, both resolutions work', () => withStore(async () => {
  const { state, row, id } = seed();
  let expected = refreshPortableMemory(state);
  // Desktop edit via the real editor (sets userEdited + editedAt).
  const edited = editMemoryFact(row.id, { text: 'User prefers oolong tea' });
  assert.equal(edited.metadata.userEdited, true);
  // Phone edit stamped earlier than the desktop edit, arriving as a single dominating version.
  expected = refreshPortableMemory(state);
  const phoneValue = { ...state.mobileWorkspaceSync.records.find(r => r.kind === 'memory').versions[0].value, text: 'User prefers green tea', scope: 'personal', userEdited: true, updatedAt: T(0) };
  const mobile = structuredClone(state.mobileWorkspaceSync);
  putWorkspace(mobile, 'memory', id, phoneValue, 'phone');
  state.mobileWorkspaceSync = mergeWorkspaces(state.mobileWorkspaceSync, mobile);
  applyPortableMemory(state, expected);
  let stored = getMemoriesByIds([row.id])[0];
  assert.equal(stored.text, 'User prefers oolong tea', 'desktop text is kept');
  assert.equal(stored.metadata.scope, 'chat');
  assert.deepEqual(stored.metadata.conflict, { text: 'User prefers green tea', scope: 'personal', editedAt: T(0), source: 'mobile' });
  assert.equal(stored.metadata.mobileSyncConflict, undefined);
  assert.equal(isEntryInvalidated(stored.metadata), false, 'row stays active');
  assert.ok(canRecallMemory(stored, { chat: state.chats[0], agentId: 'main' }));
  // The projection exposes status 'conflict' with both texts.
  const { memoryFacts } = await import('../memory/memoryManagement.js');
  const projected = (await memoryFacts({ query: 'tea' })).records.find(r => r.id === row.id);
  assert.equal(projected.status, 'conflict');
  assert.equal(projected.text, 'User prefers oolong tea');
  assert.deepEqual(projected.conflict, { text: 'User prefers green tea', scope: 'personal', editedAt: T(0), source: 'mobile' });
  // Re-syncing the desktop's own value does not drop the pending conflict.
  expected = refreshPortableMemory(state);
  applyPortableMemory(state, expected);
  assert.deepEqual(getMemoriesByIds([row.id])[0].metadata.conflict?.text, 'User prefers green tea');
  // 采用手机版: text + scope come from the phone version; conflict cleared.
  const mobileWins = editMemoryFact(row.id, { resolveConflict: 'mobile' });
  assert.equal(mobileWins.text, 'User prefers green tea');
  assert.equal(mobileWins.metadata.scope, 'personal');
  assert.equal(mobileWins.metadata.conflict, undefined);
  assert.equal(mobileWins.metadata.mobileSyncConflict, false);
  assert.equal((await memoryFacts({ query: 'tea' })).records.find(r => r.id === row.id).status, 'active');
  assert.throws(() => editMemoryFact(row.id, { resolveConflict: 'desktop' }), /没有待处理的冲突/);
  assert.throws(() => editMemoryFact(row.id, { resolveConflict: 'phone' }), /冲突处理方式无效/);
  // 采用桌面版 on a fresh conflict keeps the desktop text.
  upsertMemory({ ...getMemoriesByIds([row.id])[0], metadata: { ...getMemoriesByIds([row.id])[0].metadata, conflict: { text: 'phone again', scope: 'chat', editedAt: T(1), source: 'mobile' } } });
  const desktopWins = editMemoryFact(row.id, { resolveConflict: 'desktop' });
  assert.equal(desktopWins.text, 'User prefers green tea');
  assert.equal(desktopWins.metadata.conflict, undefined);
}));

test('concurrent desktop/phone versions expose the phone version as conflict and settle the workspace register on resolution', () => withStore(async () => {
  const { state, row, id } = seed();
  let expected = refreshPortableMemory(state);
  const fork = structuredClone(state.mobileWorkspaceSync);
  const value = fork.records.find(r => r.kind === 'memory').versions[0].value;
  putWorkspace(fork, 'memory', id, { ...value, text: 'phone concurrent', userEdited: true, updatedAt: T(1) }, 'phone');
  putWorkspace(state.mobileWorkspaceSync, 'memory', id, { ...value, text: 'desktop concurrent', userEdited: true, updatedAt: T(2) }, state.mobileWorkspaceDevice);
  upsertMemory({ ...row, text: 'desktop concurrent', updatedAt: T(2), metadata: { ...row.metadata, userEdited: true, editedAt: T(2) } });
  expected = refreshPortableMemory(state);
  state.mobileWorkspaceSync = mergeWorkspaces(state.mobileWorkspaceSync, fork);
  assert.equal(state.mobileWorkspaceSync.records.find(r => r.id === id).versions.length, 2);
  applyPortableMemory(state, expected);
  let stored = getMemoriesByIds([row.id])[0];
  assert.equal(stored.text, 'desktop concurrent');
  assert.equal(stored.metadata.mobileSyncConflict, true, 'workspace-level conflict flag is kept for the sync conflict UI');
  assert.deepEqual(stored.metadata.conflict, { text: 'phone concurrent', scope: 'chat', editedAt: T(1), source: 'mobile' });
  const { memoryFacts, updateMemoryFact } = await import('../memory/memoryManagement.js');
  assert.equal((await memoryFacts({ query: 'concurrent' })).records.find(r => r.id === row.id).status, 'conflict');
  // Resolving through the management service clears the row and the register.
  const { saveState } = await import('../../state/stateStore.js');
  await saveState({ projects: [], chats: state.chats, tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [], agentProfiles: {}, projectAgentOverrides: {},
    settings: { selectedProjectId: null, selectedChatId: null, selectedAgentId: 'main', selectedConnectorId: null, selectedFilePath: null, activeMode: 'chat', promptHistory: [] },
    mobileWorkspaceSync: state.mobileWorkspaceSync, mobileWorkspaceDevice: state.mobileWorkspaceDevice });
  const resolved = await updateMemoryFact({ id: row.id, patch: { resolveConflict: 'mobile' } });
  assert.equal(resolved.text, 'phone concurrent');
  assert.equal(resolved.metadata.mobileSyncConflict, false);
  assert.equal(resolved.metadata.conflict, undefined);
  const { loadState } = await import('../../state/stateStore.js');
  const after = await loadState();
  const register = after.mobileWorkspaceSync.records.find(r => r.id === id);
  assert.equal(register.versions.length, 1, 'register is settled so the next sync does not re-flag');
  assert.equal(register.versions[0].value.text, 'phone concurrent');
  // Settling via the sync conflict UI on the desktop version lifts the flags too.
  const { state: s2, row: r2, id: id2 } = seed();
  expected = refreshPortableMemory(s2);
  const fork2 = structuredClone(s2.mobileWorkspaceSync);
  const v2 = fork2.records.find(r => r.kind === 'memory').versions[0].value;
  putWorkspace(fork2, 'memory', id2, { ...v2, text: 'phone two' }, 'phone');
  putWorkspace(s2.mobileWorkspaceSync, 'memory', id2, { ...v2, text: 'desktop two' }, s2.mobileWorkspaceDevice);
  upsertMemory({ ...r2, text: 'desktop two' });
  expected = refreshPortableMemory(s2);
  s2.mobileWorkspaceSync = mergeWorkspaces(s2.mobileWorkspaceSync, fork2);
  applyPortableMemory(s2, expected);
  assert.equal(getMemoriesByIds([r2.id])[0].metadata.conflict.text, 'phone two');
  const desktopIndex = s2.mobileWorkspaceSync.records.find(r => r.id === id2).versions.findIndex(v => v.value.text === 'desktop two');
  s2.mobileWorkspaceSync = resolveWorkspace(s2.mobileWorkspaceSync, 'memory', id2, desktopIndex, 'phone');
  applyPortableMemory(s2);
  stored = getMemoriesByIds([r2.id])[0];
  assert.equal(stored.text, 'desktop two');
  assert.equal(stored.metadata.mobileSyncConflict, false);
  assert.equal(stored.metadata.conflict, undefined);
}));
