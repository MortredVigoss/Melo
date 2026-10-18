// Bug audit 2026-10-18 M7 / M10: admin listing pages and filters in SQL without
// the embedding BLOB; a rejection hit carries no query hash / rank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from './store.js';

let home, previous;
test.beforeEach(() => { previous = process.env.MELO_HOME; home = mkdtempSync(join(tmpdir(), 'melo-records-')); process.env.MELO_HOME = home; store._resetStoreForTests(); });
test.afterEach(() => { store._resetStoreForTests(); if (previous === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = previous; rmSync(home, { recursive: true, force: true }); });

const row = (id, text, chatTitle, updatedAt) => ({ id, namespace: 'chat:c', kind: 'session-fact', sourceId: 'c', text, searchText: text.toLowerCase(), createdAt: updatedAt, updatedAt,
  metadata: { chatId: 'c', chatTitle, scope: 'chat', audience: 'local', category: 'decision' } });

test('M10: listMemoryRecords filters by text or source title in SQL, pages, counts, and never returns the embedding', () => {
  for (let i = 0; i < 7; i += 1) store.upsertMemory(row(`r${i}`, i % 2 ? `Alpha_note ${i}` : `beta ${i}`, i === 6 ? 'Alpha chat' : 'other', `2026-10-0${i + 1}T00:00:00.000Z`));
  store.saveMemoryEmbedding('r1', 'alpha_note 1', new Float32Array([1, 0, 0, 0]));
  assert.equal(store.countMemoryRecords(), 7);
  assert.equal(store.countMemoryRecords({ query: 'alpha' }), 4, 'text (3) + source title (1), case-insensitive');
  const page = store.listMemoryRecords({ query: 'alpha', limit: 2, offset: 0 });
  assert.deepEqual(page.map(r => r.id), ['r6', 'r5'], 'newest first');
  assert.deepEqual(store.listMemoryRecords({ query: 'alpha', limit: 2, offset: 2 }).map(r => r.id), ['r3', 'r1']);
  assert.ok(page.every(r => !('embedding' in r)), 'no BLOB column');
  assert.ok(!('embedding' in store.listMemoryRecords({ query: 'alpha_note 1' })[0]));
  assert.equal(store.countMemoryRecords({ query: '%' }), 0, 'LIKE wildcards are literal');
  assert.equal(store.countMemoryRecords({ query: 'alpha_' }), 3, 'underscore is literal');
  assert.equal(store.listMemoryRecords({ chatId: 'nope' }).length, 0);
});

test('M7: a rejection hit has no query hash and no rank, so it neither counts as a distinct query nor improves the average rank', () => {
  store.upsertMemory(row('a', 'fact a', 't', '2026-10-01T00:00:00.000Z'));
  store.recordMemoryHitsBatch([{ memoryId: 'a', queryHash: 'q1', rank: 4, outcome: 'used' }]);
  store.recordMemoryRejection('a');
  const [stats] = store.getHitStats({ memoryIds: ['a'] });
  assert.equal(stats.hits, 2);
  assert.equal(stats.distinctQueries, 1, 'user-feedback is not a query');
  assert.equal(stats.avgRank, 4, 'rank of the rejection is not averaged in');
  assert.equal(stats.rejectedOutcomes, 1);
});
