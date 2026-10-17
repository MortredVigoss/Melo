import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateAtticLevel, enabledTiers, atticEnabled, injectHotAttic } from './attic.js';
import { upsertMemory, getMemoriesByIds, _resetStoreForTests } from './store.js';

function day(n) {
  return Date.now() - n * 86_400_000;
}

test('evaluateAtticLevel returns hot when metadata.pinned', () => {
  const row = { metadata: { pinned: true }, updatedAt: new Date(day(100)).toISOString() };
  assert.equal(evaluateAtticLevel(row), 'hot');
});

test('evaluateAtticLevel returns hot for correction category', () => {
  const row = { metadata: { category: 'correction' } };
  assert.equal(evaluateAtticLevel(row), 'hot');
});

test('evaluateAtticLevel returns hot for decision category', () => {
  const row = { metadata: { category: 'decision' } };
  assert.equal(evaluateAtticLevel(row), 'hot');
});

test('evaluateAtticLevel returns hot when useCount >= 5 & fresh', () => {
  const row = {
    metadata: { useCount: 6 },
    lastUsedAt: new Date(day(5)).toISOString(),
  };
  assert.equal(evaluateAtticLevel(row), 'hot');
});

test('evaluateAtticLevel returns warm for useCount >= 1 within 30d', () => {
  const row = {
    metadata: { useCount: 2 },
    lastUsedAt: new Date(day(20)).toISOString(),
  };
  assert.equal(evaluateAtticLevel(row), 'warm');
});

test('evaluateAtticLevel returns cold when idle for more than 90 days', () => {
  const row = {
    metadata: { useCount: 1 },
    lastUsedAt: new Date(day(100)).toISOString(),
  };
  assert.equal(evaluateAtticLevel(row), 'cold');
});

test('evaluateAtticLevel respects identity kind', () => {
  const row = { kind: 'identity', metadata: {} };
  assert.equal(evaluateAtticLevel(row), 'hot');
});

test('evaluateAtticLevel preserves existing warm/hot when no clear signal', () => {
  const row = {
    metadata: { attic: 'warm', useCount: 0 },
    lastUsedAt: new Date(day(10)).toISOString(),
  };
  assert.equal(evaluateAtticLevel(row), 'warm');
});

test('enabledTiers defaults to all three when MELO_MEMORY_TIERS is unset', () => {
  const saved = process.env.MELO_MEMORY_TIERS;
  delete process.env.MELO_MEMORY_TIERS;
  try {
    const tiers = enabledTiers();
    assert.ok(tiers.has('scene'));
    assert.ok(tiers.has('frame'));
    assert.ok(tiers.has('content'));
  } finally {
    if (saved != null) process.env.MELO_MEMORY_TIERS = saved;
  }
});

test('enabledTiers honours MELO_MEMORY_TIERS selective overrides', () => {
  const saved = process.env.MELO_MEMORY_TIERS;
  process.env.MELO_MEMORY_TIERS = 'content';
  try {
    const tiers = enabledTiers();
    assert.ok(tiers.has('content'));
    assert.equal(tiers.has('scene'), false);
    assert.equal(tiers.has('frame'), false);
  } finally {
    if (saved == null) delete process.env.MELO_MEMORY_TIERS;
    else process.env.MELO_MEMORY_TIERS = saved;
  }
});

test('atticEnabled is true by default and false when MELO_ATTIC_ENABLED=0', () => {
  const saved = process.env.MELO_ATTIC_ENABLED;
  try {
    delete process.env.MELO_ATTIC_ENABLED;
    assert.equal(atticEnabled(), true);
    process.env.MELO_ATTIC_ENABLED = '0';
    assert.equal(atticEnabled(), false);
  } finally {
    if (saved == null) delete process.env.MELO_ATTIC_ENABLED;
    else process.env.MELO_ATTIC_ENABLED = saved;
  }
});

async function withTempMeloHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'melo-attic-'));
  const prevHome = process.env.MELO_HOME;
  process.env.MELO_HOME = dir;
  _resetStoreForTests?.();
  try {
    await fn();
  } finally {
    _resetStoreForTests?.();
    if (prevHome === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  }
}

test('injectHotAttic does not touch non-hot candidate rows while scanning', async () => {
  await withTempMeloHome(async () => {
    const now = '2026-05-01T00:00:00.000Z';
    upsertMemory({
      id: 'attic-hot-decision',
      namespace: 'agent:attic-test',
      kind: 'fact',
      text: 'Always confirm destructive actions twice',
      searchText: 'always confirm destructive actions twice',
      createdAt: now,
      updatedAt: now,
      metadata: { category: 'decision' },
    });
    upsertMemory({
      id: 'attic-cold-preference',
      namespace: 'agent:attic-test',
      kind: 'fact',
      text: 'A cold candidate that should not be heated by inspection',
      searchText: 'cold candidate should not be heated by inspection',
      createdAt: now,
      updatedAt: now,
      metadata: { category: 'preference' },
    });

    const block = injectHotAttic({ namespaces: ['agent:attic-test'], limit: 8 });
    assert.match(block, /Always confirm destructive actions twice/);
    assert.doesNotMatch(block, /cold candidate/i);

    const [cold] = getMemoriesByIds(['attic-cold-preference']);
    assert.ok(cold, 'cold row still exists');
    assert.equal(cold.metadata.useCount, undefined);
    assert.equal(cold.lastUsedAt, null);
  });
});

test('injectHotAttic never re-injects the agent identity and skips oversized rows instead of stopping', async () => {
  // 2026-10-17 audit B-1 / C-9: the persona is already in the `agent` system
  // prompt section; a second copy via memory doubled the token cost and, with
  // a project override, surfaced the stale global persona. An oversized row
  // also used to `break` the loop and blank every later decision.
  await withTempMeloHome(async () => {
    const now = '2026-05-01T00:00:00.000Z';
    upsertMemory({
      id: 'attic-identity',
      namespace: 'agent:attic-identity-test',
      kind: 'identity',
      text: 'User-selected role: Persona\n## 身份\nA very long persona document ' + 'x'.repeat(5000),
      searchText: 'persona identity',
      createdAt: now, updatedAt: now,
      metadata: { category: 'identity' },
    });
    upsertMemory({
      id: 'attic-huge-decision',
      namespace: 'agent:attic-identity-test',
      kind: 'fact',
      text: 'Oversized decision ' + 'y'.repeat(6000),
      searchText: 'oversized decision',
      createdAt: now, updatedAt: now,
      metadata: { category: 'decision' },
    });
    upsertMemory({
      id: 'attic-small-decision',
      namespace: 'agent:attic-identity-test',
      kind: 'fact',
      text: 'Keep replies in Chinese',
      searchText: 'keep replies in chinese',
      createdAt: now, updatedAt: now,
      metadata: { category: 'decision' },
    });
    const block = injectHotAttic({ namespaces: ['agent:attic-identity-test'], limit: 8 });
    assert.doesNotMatch(block, /User-selected role|身份/);
    assert.doesNotMatch(block, /Oversized decision/);
    assert.match(block, /Keep replies in Chinese/, 'a later small decision survives an earlier oversized row');
  });
});
