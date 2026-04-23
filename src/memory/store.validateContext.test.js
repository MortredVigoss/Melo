import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContext } from './store.js';

// ─── helpers ─────────────────────────────────────────────────────────────────
function row({
  id,
  kind,
  text = '',
  updated_at = Date.now(),
  metadata = {},
} = {}) {
  return { id, kind, text, updated_at, metadata };
}

// A. expired rows are flagged + reported
test('validateContext flags rows whose validTo has passed', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const input = {
    scenes: [],
    frames: [],
    contents: [
      row({ id: 'a', kind: 'fact', text: 'stale', metadata: { validTo: past } }),
      row({ id: 'b', kind: 'fact', text: 'fresh' }),
    ],
  };
  const out = validateContext(input);
  assert.equal(out.contents[0]._invalidated, true);
  assert.equal(out.contents[1]._invalidated, undefined);
  assert.ok(out.conflicts.some(c => c.type === 'expired' && c.loserId === 'a'));
});

// B. explicit correction beats older peer on the same topic
test('validateContext marks older peers losers to an explicit correction', () => {
  const older = row({
    id: 'old',
    kind: 'fact',
    text: 'Build target is ES2020',
    updated_at: 1_000,
    metadata: { category: 'technical_detail', factKey: 'build-target' },
  });
  const correction = row({
    id: 'corr',
    kind: 'verification-correction',
    text: 'Build target is ES2023',
    updated_at: 2_000,
    metadata: { factKey: 'build-target' },
  });
  const out = validateContext({ scenes: [], frames: [], contents: [older, correction] });
  const loser = out.contents.find(r => r.id === 'old');
  assert.equal(loser._contested, true);
  assert.equal(loser._contestedBy, 'corr');
  assert.ok(out.conflicts.some(c => c.type === 'correction' && c.loserId === 'old' && c.winnerId === 'corr'));
});

// C. single-value category collision — only the newest wins
test('validateContext supersedes older identity rows on single-value categories', () => {
  const older = row({
    id: 'role-old',
    kind: 'identity',
    text: 'Role: student',
    updated_at: 1_000,
    metadata: { category: 'role' },
  });
  const newer = row({
    id: 'role-new',
    kind: 'identity',
    text: 'Role: researcher',
    updated_at: 5_000,
    metadata: { category: 'role' },
  });
  const out = validateContext({ scenes: [], frames: [], contents: [older, newer] });
  const loser = out.contents.find(r => r.id === 'role-old');
  assert.equal(loser._contested, true);
  assert.equal(loser._contestedBy, 'role-new');
});

// C'. same single-value category with identical text is NOT a conflict
test('validateContext does not conflict rows that agree on the value', () => {
  const r1 = row({
    id: 'loc-1', kind: 'identity', text: 'Location: Tokyo',
    updated_at: 1_000, metadata: { category: 'location' },
  });
  const r2 = row({
    id: 'loc-2', kind: 'identity', text: 'Location: Tokyo',
    updated_at: 5_000, metadata: { category: 'location' },
  });
  const out = validateContext({ scenes: [], frames: [], contents: [r1, r2] });
  assert.equal(out.conflicts.length, 0);
  assert.equal(out.contents[0]._contested, undefined);
  assert.equal(out.contents[1]._contested, undefined);
});

// D. content with frameId outside recalled frames → orphan
test('validateContext flags content whose frameId is not in recalled frames', () => {
  const frame = row({ id: 'f1', kind: 'frame', metadata: { frameId: 'f1' } });
  const orphan = row({
    id: 'p-orphan',
    kind: 'prompt',
    text: 'leftover content',
    metadata: { frameId: 'f-missing' },
  });
  const good = row({
    id: 'p-good',
    kind: 'prompt',
    text: 'ratified content',
    metadata: { frameId: 'f1' },
  });
  const out = validateContext({ scenes: [], frames: [frame], contents: [orphan, good] });
  assert.equal(out.contents.find(r => r.id === 'p-orphan')._orphan, true);
  assert.equal(out.contents.find(r => r.id === 'p-good')._orphan, undefined);
  assert.ok(out.conflicts.some(c => c.type === 'orphan' && c.loserId === 'p-orphan'));
});

// E. dropContested mode actually removes losers
test('validateContext dropContested=true removes contested+expired rows', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const expired = row({ id: 'exp', kind: 'fact', text: 'x', metadata: { validTo: past } });
  const older = row({
    id: 'role-old', kind: 'identity', text: 'Role: A',
    updated_at: 1_000, metadata: { category: 'role' },
  });
  const newer = row({
    id: 'role-new', kind: 'identity', text: 'Role: B',
    updated_at: 5_000, metadata: { category: 'role' },
  });
  const out = validateContext(
    { scenes: [], frames: [], contents: [expired, older, newer] },
    { dropContested: true },
  );
  const ids = out.contents.map(r => r.id);
  assert.deepEqual(ids.sort(), ['role-new']);
});

// F. empty input stays empty — no throw
test('validateContext handles empty tiers', () => {
  const out = validateContext({});
  assert.deepEqual(out.scenes, []);
  assert.deepEqual(out.frames, []);
  assert.deepEqual(out.contents, []);
  assert.deepEqual(out.conflicts, []);
});

// G. corrections don't fight each other
test('validateContext does not contest correction vs correction', () => {
  const c1 = row({
    id: 'c1', kind: 'verification-correction', text: 'x',
    updated_at: 1_000, metadata: { factKey: 'k1' },
  });
  const c2 = row({
    id: 'c2', kind: 'verification-correction', text: 'y',
    updated_at: 5_000, metadata: { factKey: 'k1' },
  });
  const out = validateContext({ scenes: [], frames: [], contents: [c1, c2] });
  const contestedConflicts = out.conflicts.filter(c => c.type === 'correction');
  assert.equal(contestedConflicts.length, 0);
});
