import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateStateAtomically, loadState } from '../state/stateStore.js';
import { withMemoryHome, getMemoriesByIds } from '../memory/store.js';
import { createUserBookRow } from '../memory/projectBook.js';
import { reconcileDerivedFacts } from './reconcileDerivedFacts.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'melo-derived-source-race-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stale = await updateStateAtomically(state => { state.projects = []; state.chats = []; }, { home });
  await updateStateAtomically(state => { state.projects.push({ id: 'new-project', name: 'Fixture' }); }, { home });
  const row = withMemoryHome(home, () => createUserBookRow({ projectId: 'new-project', text: 'Keep this newly committed memory', section: 'convention', home }));
  return { home, stale, row, read: () => withMemoryHome(home, () => getMemoriesByIds([row.id])[0]) };
}

test('a delayed first index snapshot cannot quarantine facts of a project committed after that snapshot', async t => {
  const f = await fixture(t);
  assert.equal(f.stale.projects.length, 0, 'force the actual stale-snapshot boundary');
  reconcileDerivedFacts({ home: f.home, snapshot: f.stale, initialize: true });
  const row = f.read();
  assert.equal(row.text, 'Keep this newly committed memory');
  assert.notEqual(row.metadata.quarantined, true);
  assert.notEqual(row.metadata.sourceDeleted, true);
});

test('authoritatively removed sources are still quarantined; a stale snapshot cannot keep them alive', async t => {
  const f = await fixture(t);
  const staleWithProject = await loadState({ home: f.home });
  await updateStateAtomically(state => { state.projects = []; }, { home: f.home });
  reconcileDerivedFacts({ home: f.home, snapshot: staleWithProject, initialize: true });
  assert.equal(f.read().metadata.quarantined, true);
  assert.equal(f.read().metadata.sourceDeleted, true);
});

test('missing authoritative manifest defers reconciliation without invalidating existing facts', async t => {
  const f = await fixture(t);
  await rm(join(f.home, 'desktop/state.json'));
  assert.throws(() => reconcileDerivedFacts({ home: f.home, snapshot: f.stale, initialize: true }), { code: 'ENOENT' });
  assert.notEqual(f.read().metadata.quarantined, true);
});
