import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterActiveFacts,
  formatSessionMemoryBlock,
  mergeMemoryFacts,
} from './sessionMemory.js';

test('mergeMemoryFacts stamps validFrom and leaves validTo null for active facts', () => {
  const merged = mergeMemoryFacts([], [
    { fact: 'User prefers TypeScript', category: 'user_preference' },
  ]);

  assert.equal(merged.length, 1);
  const [fact] = merged;
  assert.equal(typeof fact.validFrom, 'string');
  assert.ok(Date.parse(fact.validFrom) > 0);
  assert.equal(fact.validTo, null);
});

test('mergeMemoryFacts deduplicates on exact lowercased fact string', () => {
  const first = mergeMemoryFacts([], [
    { fact: 'Deadline: Friday', category: 'decision' },
  ]);
  const second = mergeMemoryFacts(first, [
    { fact: 'deadline: friday', category: 'decision' }, // different case
  ]);

  assert.equal(second.length, 1);
  // Same validFrom — no new entry was appended.
  assert.equal(second[0].validFrom, first[0].validFrom);
});

test('mergeMemoryFacts invalidates prior corrections when a new correction lands', () => {
  let facts = mergeMemoryFacts([], [
    { fact: 'Build target is ES2020, not ES2022', category: 'correction', subjectKey: 'build.ecmascript' },
  ]);
  assert.equal(facts[0].validTo, null);

  facts = mergeMemoryFacts(facts, [
    { fact: 'Actually ES2023, not ES2020', category: 'correction', subjectKey: 'build.ecmascript' },
  ]);

  assert.equal(facts.length, 2);
  assert.ok(typeof facts[0].validTo === 'string');
  assert.equal(facts[1].validTo, null);
});

test('mergeMemoryFacts does not invalidate non-correction categories', () => {
  let facts = mergeMemoryFacts([], [
    { fact: 'Prefers dark mode', category: 'user_preference' },
  ]);
  facts = mergeMemoryFacts(facts, [
    { fact: 'Prefers concise answers', category: 'user_preference' },
  ]);

  // Both preferences still active.
  assert.equal(facts.length, 2);
  assert.equal(facts[0].validTo, null);
  assert.equal(facts[1].validTo, null);
});

test('mergeMemoryFacts retires prior identity facts that share an attribute prefix', () => {
  let facts = mergeMemoryFacts([], [
    { fact: 'Role: student', category: 'identity' },
    { fact: 'Name: Alice', category: 'identity' },
  ]);
  assert.equal(facts.length, 2);
  assert.ok(facts.every(f => f.validTo === null));

  facts = mergeMemoryFacts(facts, [
    { fact: 'Role: researcher', category: 'identity' },
  ]);
  assert.equal(facts.length, 3);
  // "Role: student" gets retired; "Name: Alice" stays active; new "Role: researcher" is active.
  const byFact = Object.fromEntries(facts.map(f => [f.fact, f]));
  assert.ok(byFact['Role: student'].validTo, 'prior role fact is retired');
  assert.equal(byFact['Name: Alice'].validTo, null, 'name is untouched by a role update');
  assert.equal(byFact['Role: researcher'].validTo, null);
});

test('mergeMemoryFacts does not touch identity facts from a non-identity category', () => {
  let facts = mergeMemoryFacts([], [
    { fact: 'Role: student', category: 'identity' },
  ]);
  facts = mergeMemoryFacts(facts, [
    { fact: 'Role: elevated', category: 'user_preference' },
  ]);
  // Only a preference with a "Role:" prefix — should NOT retire the identity row.
  assert.equal(facts[0].validTo, null, 'identity row is only retired by another identity row');
  assert.equal(facts.length, 2);
});

test('filterActiveFacts drops entries whose validTo has passed', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const facts = [
    { fact: 'A', category: 'decision', validTo: past },
    { fact: 'B', category: 'decision', validTo: null },
    { fact: 'C', category: 'decision', validTo: future },
    { fact: 'D', category: 'decision' }, // legacy entry, no validTo
  ];

  const active = filterActiveFacts(facts);
  assert.deepEqual(active.map(f => f.fact), ['B', 'C', 'D']);
});

test('formatSessionMemoryBlock omits invalidated facts entirely', () => {
  const facts = [
    {
      fact: 'Old deadline: Friday',
      category: 'decision',
      extractedAt: '2026-04-10T00:00:00Z',
      validTo: '2026-04-15T00:00:00Z',
    },
    {
      fact: 'New deadline: next Monday',
      category: 'decision',
      extractedAt: '2026-04-17T00:00:00Z',
      validTo: null,
    },
  ];

  const block = formatSessionMemoryBlock(facts);
  assert.ok(!block.includes('Old deadline'));
  assert.ok(block.includes('New deadline: next Monday'));
});

test('formatSessionMemoryBlock returns empty string when every fact is invalidated', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const block = formatSessionMemoryBlock([
    { fact: 'Stale', category: 'decision', validTo: past },
  ]);
  assert.equal(block, '');
});


test('corrections replace any explicit subject for the same speaker, while unknown subjects coexist', () => {
  const facts = mergeMemoryFacts([
    {fact: 'Warranty is one year', category: 'technical_detail', subjectKey: 'product.warranty', sourceSenderId: 'alice'},
    {fact: 'Warranty is three years', category: 'technical_detail', subjectKey: 'product.warranty', sourceSenderId: 'bob'},
    {fact: 'Shipping takes one week', category: 'technical_detail', subjectKey: 'product.shipping', sourceSenderId: 'alice'},
  ], [{fact: 'Actually the warranty is two years', category: 'correction', subjectKey: ' PRODUCT.WARRANTY ', sourceSenderId: 'alice'}]);
  assert.ok(facts[0].validTo);
  assert.equal(facts[1].validTo, undefined);
  assert.equal(facts[2].validTo, undefined);
  assert.equal(facts[3].subjectKey, 'product.warranty');
  const unknown = mergeMemoryFacts([{fact: 'Build target ES2020', category: 'correction'}], [{fact: 'Actually ES2023', category: 'correction'}]);
  assert.equal(filterActiveFacts(unknown).length, 2, 'word overlap must not invent a correction subject');
});
