import test from 'node:test';
import assert from 'node:assert/strict';
import { planIdentitySupersession, identityAttributeKey } from './supersede.js';

const NOW = Date.parse('2026-04-18T00:00:00Z');

function idRow({ id, text = '', updatedAt = '2026-04-01T00:00:00Z', metadata = {}, kind = 'identity', namespace = 'agent:alice' }) {
  return { id, namespace, kind, text, updatedAt, metadata };
}

test('identityAttributeKey parses common prefixes', () => {
  assert.equal(identityAttributeKey({ text: 'Role: data scientist' }), 'role');
  assert.equal(identityAttributeKey({ text: 'Name: Alice' }), 'name');
  assert.equal(identityAttributeKey({ text: 'Works at: Acme' }), 'works at');
  assert.equal(identityAttributeKey({ text: 'Location：Shanghai' }), 'location');  // full-width colon
  assert.equal(identityAttributeKey({ text: 'no colon here' }), '');
});

test('identityAttributeKey honours metadata.attribute override', () => {
  const row = { text: 'mumble', metadata: { attribute: 'role' } };
  assert.equal(identityAttributeKey(row), 'role');
});

test('planIdentitySupersession retires older rows in same attribute', () => {
  const old = idRow({ id: 'old', text: 'Role: student', updatedAt: '2024-01-01T00:00:00Z' });
  const neu = idRow({ id: 'new', text: 'Role: researcher', updatedAt: '2026-01-01T00:00:00Z' });
  const plan = planIdentitySupersession([old, neu], { nowMs: NOW });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].id, 'old');
  assert.equal(plan[0].winnerId, 'new');
  assert.equal(plan[0].reason, 'identity-supersession');
  assert.ok(plan[0].validTo.startsWith('2026-04-18'));
});

test('planIdentitySupersession does not cross namespaces', () => {
  const a = idRow({ id: 'a', namespace: 'agent:alice', text: 'Role: x', updatedAt: '2024-01-01T00:00:00Z' });
  const b = idRow({ id: 'b', namespace: 'agent:bob',   text: 'Role: y', updatedAt: '2026-01-01T00:00:00Z' });
  const plan = planIdentitySupersession([a, b], { nowMs: NOW });
  assert.equal(plan.length, 0);
});

test('planIdentitySupersession does not cross attributes', () => {
  const role = idRow({ id: 'r', text: 'Role: x', updatedAt: '2024-01-01T00:00:00Z' });
  const name = idRow({ id: 'n', text: 'Name: y', updatedAt: '2026-01-01T00:00:00Z' });
  const plan = planIdentitySupersession([role, name], { nowMs: NOW });
  assert.equal(plan.length, 0);
});

test('planIdentitySupersession ignores rows already retired', () => {
  const retired = idRow({ id: 'r', text: 'Role: x', updatedAt: '2024-01-01T00:00:00Z', metadata: { validTo: '2025-01-01T00:00:00Z' } });
  const active = idRow({ id: 'a', text: 'Role: y', updatedAt: '2026-01-01T00:00:00Z' });
  const plan = planIdentitySupersession([retired, active], { nowMs: NOW });
  assert.equal(plan.length, 0, 'already-retired row is not the loser — it is out of the pool');
});

test('planIdentitySupersession leaves pinned rows alone', () => {
  const pinned = idRow({ id: 'p', text: 'Role: ceo', updatedAt: '2024-01-01T00:00:00Z', metadata: { pinned: true } });
  const other  = idRow({ id: 'o', text: 'Role: founder', updatedAt: '2026-01-01T00:00:00Z' });
  const plan = planIdentitySupersession([pinned, other], { nowMs: NOW });
  // Pinned is excluded entirely; with only one unpinned row, nothing to supersede.
  assert.equal(plan.length, 0);
});

test('planIdentitySupersession collapses N→1 within same attribute', () => {
  const rows = [
    idRow({ id: '1', text: 'Role: a', updatedAt: '2024-01-01T00:00:00Z' }),
    idRow({ id: '2', text: 'Role: b', updatedAt: '2024-06-01T00:00:00Z' }),
    idRow({ id: '3', text: 'Role: c', updatedAt: '2025-01-01T00:00:00Z' }),
    idRow({ id: '4', text: 'Role: d', updatedAt: '2026-04-01T00:00:00Z' }),  // winner
  ];
  const plan = planIdentitySupersession(rows, { nowMs: NOW });
  assert.equal(plan.length, 3);
  assert.ok(plan.every(p => p.winnerId === '4'));
  const losers = plan.map(p => p.id).sort();
  assert.deepEqual(losers, ['1', '2', '3']);
});

test('planIdentitySupersession ignores non-identity rows', () => {
  const a = idRow({ id: 'a', kind: 'fact',           text: 'Role: x' });
  const b = idRow({ id: 'b', kind: 'session-fact',   text: 'Role: y', metadata: { category: 'decision' } });
  const c = idRow({ id: 'c', kind: 'fact',           text: 'Role: z', metadata: { category: 'identity' } });
  // Only c is identity — single row → no supersession.
  assert.equal(planIdentitySupersession([a, b, c], { nowMs: NOW }).length, 0);

  // Add another identity row in same namespace/attribute → should retire the older.
  const d = idRow({ id: 'd', kind: 'fact', text: 'Role: w', updatedAt: '2026-04-10T00:00:00Z', metadata: { category: 'identity' } });
  const plan = planIdentitySupersession([a, b, c, d], { nowMs: NOW });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].winnerId, 'd');
});

test('planIdentitySupersession is deterministic on ties (lexicographically smaller id wins)', () => {
  const a = idRow({ id: 'a', text: 'Role: x', updatedAt: '2026-01-01T00:00:00Z' });
  const b = idRow({ id: 'b', text: 'Role: y', updatedAt: '2026-01-01T00:00:00Z' });  // same timestamp
  const plan = planIdentitySupersession([a, b], { nowMs: NOW });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].winnerId, 'a', 'tie broken by lexical id ordering');
  assert.equal(plan[0].id, 'b');
});
