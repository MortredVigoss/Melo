import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAtticLevel, enabledTiers, atticEnabled } from './attic.js';

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
