// Bug audit 2026-10-18 M13 / M15 / M16: the sync path applies the same scope
// rules as editMemoryFact; conflict resolution never falls back to version 0;
// the register clock guards the wall-clock conflict heuristic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertMemory, getMemoriesByIds, _resetStoreForTests } from '../../memory/store.js';
import { refreshPortableWorkspace } from './portableWorkspace.js';
import { refreshPortableMemory, applyPortableMemory, portableMemoryID, hasMemoryConflict } from './portableMemory.js';
import { putWorkspace, mergeWorkspaces } from '../../../mobile-sync/workspaceProtocol.js';

const T = n => `2026-10-17T0${n}:00:00.000Z`;
async function withStore(fn) {
  const home = mkdtempSync(join(tmpdir(), 'melo-memory-audit-'));
  const old = process.env.MELO_HOME; process.env.MELO_HOME = home; _resetStoreForTests();
  try { return await fn(); }
  finally { if (old === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = old; _resetStoreForTests(); rmSync(home, { recursive: true, force: true }); }
}
function seed(metadata = {}) {
  const state = { chats: [{ id: 'chat-a', source: 'desktop', title: 'A', projectId: 'P', messages: [] }], projects: [{ id: 'P', name: 'P' }], artifacts: [], agentProfiles: {} };
  const row = { id: 'book:promoted:x', kind: 'session-fact', namespace: 'project:P', sourceId: 'chat-a', text: 'API uses snake_case', searchText: 'api uses snake_case',
    createdAt: T(0), updatedAt: T(0), metadata: { chatId: 'chat-a', agentId: 'main', scope: 'project', projectId: 'P', audience: 'local', category: 'decision', bookStatus: 'auto', section: 'decision', needsConfirmation: true, ...metadata } };
  upsertMemory(row);
  refreshPortableWorkspace(state);
  return { state, row, id: portableMemoryID(row.id) };
}
function phoneEdit(state, id, patch) {
  const expected = refreshPortableMemory(state);
  const mobile = structuredClone(state.mobileWorkspaceSync);
  const v = mobile.records.find(r => r.kind === 'memory' && r.id === id).versions[0].value;
  putWorkspace(mobile, 'memory', id, { ...v, ...patch }, 'phone');
  state.mobileWorkspaceSync = mergeWorkspaces(state.mobileWorkspaceSync, mobile);
  applyPortableMemory(state, expected);
}

test('M13: a phone edit that leaves project scope drops the book fields; personal coerces the category; bookStatus user is not accepted from the wire', () => withStore(() => {
  const { state, row, id } = seed();
  phoneEdit(state, id, { bookStatus: 'user', section: 'convention', updatedAt: T(1) });
  let stored = getMemoriesByIds([row.id])[0];
  assert.equal(stored.metadata.bookStatus, 'confirmed', 'user is reserved for hand-written rows');
  assert.equal(stored.metadata.section, 'convention');
  phoneEdit(state, id, { scope: 'personal', category: 'decision', updatedAt: T(2) });
  stored = getMemoriesByIds([row.id])[0];
  assert.equal(stored.metadata.scope, 'personal'); assert.equal(stored.namespace, 'user:local');
  assert.equal(stored.metadata.category, 'user_preference', 'non-profile category becomes a preference, like editMemoryFact');
  assert.equal(stored.metadata.bookStatus, undefined); assert.equal(stored.metadata.section, undefined); assert.equal(stored.metadata.needsConfirmation, undefined);
  // back to the project: a missing section is derived from the category, status defaults to confirmed
  phoneEdit(state, id, { scope: 'project', category: 'decision', updatedAt: T(3) });
  stored = getMemoriesByIds([row.id])[0];
  assert.equal(stored.metadata.scope, 'project'); assert.equal(stored.metadata.bookStatus, 'confirmed'); assert.equal(stored.metadata.section, 'decision');
}));

test('M16: hasMemoryConflict uses the register clock when known — concurrent is a conflict, a non-phone version is not, a sequential phone edit falls back to the timestamp rule', () => {
  const prior = { text: 'desk', metadata: { scope: 'chat', userEdited: true, editedAt: T(3) } };
  const v = { text: 'phone', scope: 'chat', status: 'active', userEdited: true, updatedAt: T(2) };
  const base = { desktop: 2 };
  assert.equal(hasMemoryConflict(prior, v, { clock: { desktop: 1, phone: 1 }, baseClock: base, device: 'desktop' }), true, 'concurrent with the desktop version');
  assert.equal(hasMemoryConflict(prior, { ...v, updatedAt: T(4) }, { clock: { desktop: 1, phone: 1 }, baseClock: base, device: 'desktop' }), true, 'concurrent regardless of wall clocks');
  assert.equal(hasMemoryConflict(prior, v, { clock: { desktop: 3 }, baseClock: base, device: 'desktop' }), false, 'only the desktop actor advanced: not a phone edit');
  assert.equal(hasMemoryConflict(prior, v, { clock: { desktop: 2, phone: 1 }, baseClock: base, device: 'desktop' }), true, 'sequential phone edit stamped before the desktop edit: timestamp rule');
  assert.equal(hasMemoryConflict(prior, { ...v, updatedAt: T(4) }, { clock: { desktop: 2, phone: 1 }, baseClock: base, device: 'desktop' }), false);
  assert.equal(hasMemoryConflict(prior, v), true, 'no clocks: timestamp rule unchanged');
});

test('M15: resolving a conflict whose register no longer holds a matching version leaves the register alone', () => withStore(async () => {
  const { state, row, id } = seed({ userEdited: true, editedAt: T(1) });
  refreshPortableMemory(state);
  // two concurrent versions, neither matching what the desktop row will say after resolution
  const fork = structuredClone(state.mobileWorkspaceSync);
  const value = fork.records.find(r => r.id === id).versions[0].value;
  putWorkspace(fork, 'memory', id, { ...value, text: 'phone one', userEdited: true, updatedAt: T(2) }, 'phone');
  putWorkspace(state.mobileWorkspaceSync, 'memory', id, { ...value, text: 'desktop one', userEdited: true, updatedAt: T(2) }, state.mobileWorkspaceDevice);
  state.mobileWorkspaceSync = mergeWorkspaces(state.mobileWorkspaceSync, fork);
  assert.equal(state.mobileWorkspaceSync.records.find(r => r.id === id).versions.length, 2);
  upsertMemory({ ...row, text: 'desktop two', metadata: { ...row.metadata, userEdited: true, editedAt: T(3), conflict: { text: 'stale phone', scope: 'project', editedAt: T(0), source: 'mobile' } } });
  const { saveState, loadState } = await import('../../state/stateStore.js');
  await saveState({ projects: state.projects, chats: state.chats, tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [], agentProfiles: {}, projectAgentOverrides: {},
    settings: { selectedProjectId: null, selectedChatId: null, selectedAgentId: 'main', selectedConnectorId: null, selectedFilePath: null, activeMode: 'chat', promptHistory: [] },
    mobileWorkspaceSync: state.mobileWorkspaceSync, mobileWorkspaceDevice: state.mobileWorkspaceDevice });
  const { updateMemoryFact } = await import('../memory/memoryManagement.js');
  const resolved = await updateMemoryFact({ id: row.id, patch: { resolveConflict: 'desktop' } });
  assert.equal(resolved.text, 'desktop two'); assert.equal(resolved.metadata.conflict, undefined);
  const after = await loadState();
  const register = after.mobileWorkspaceSync.records.find(r => r.id === id);
  assert.equal(register.versions.length, 2, 'no version matched → version 0 was not silently chosen');
  assert.deepEqual(register.versions.map(v => v.value.text).sort(), ['desktop one', 'phone one']);
}));
