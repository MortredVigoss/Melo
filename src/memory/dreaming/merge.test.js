import test from 'node:test';
import assert from 'node:assert/strict';
import { planDuplicateMerges } from './merge.js';

function vec(values, dims = 4) {
  const out = new Float32Array(dims);
  for (let i = 0; i < Math.min(values.length, dims); i++) out[i] = values[i];
  // L2-normalize so cosine == dot
  let s = 0;
  for (let i = 0; i < dims; i++) s += out[i] * out[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < dims; i++) out[i] /= n;
  return out;
}

test('planDuplicateMerges picks survivor with higher useCount', () => {
  const a = { id: 'a', namespace: 'chat:1', kind: 'fact', text: 'x', embedding: vec([1, 0, 0, 0]), metadata: { useCount: 1 } };
  const b = { id: 'b', namespace: 'chat:1', kind: 'fact', text: 'y', embedding: vec([1, 0, 0, 0]), metadata: { useCount: 5 } };
  const plan = planDuplicateMerges([a, b]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].keepId, 'b');
  assert.equal(plan[0].dropId, 'a');
});

test('planDuplicateMerges respects cosine threshold', () => {
  const a = { id: 'a', namespace: 'n', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: {} };
  const b = { id: 'b', namespace: 'n', kind: 'fact', text: '', embedding: vec([0, 1, 0, 0]), metadata: {} };
  const plan = planDuplicateMerges([a, b]);
  assert.equal(plan.length, 0);  // orthogonal — never merge
});

test('planDuplicateMerges does not cross namespace', () => {
  const a = { id: 'a', namespace: 'n1', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: {} };
  const b = { id: 'b', namespace: 'n2', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: {} };
  const plan = planDuplicateMerges([a, b]);
  assert.equal(plan.length, 0);  // different namespaces never merge
});

test('planDuplicateMerges does not cross unrelated kinds (e.g. fact vs scene)', () => {
  const a = { id: 'a', namespace: 'n', kind: 'fact',  text: '', embedding: vec([1, 0, 0, 0]), metadata: {} };
  const b = { id: 'b', namespace: 'n', kind: 'scene', text: '', embedding: vec([1, 0, 0, 0]), metadata: {} };
  const plan = planDuplicateMerges([a, b]);
  assert.equal(plan.length, 0);
});

test('planDuplicateMerges skips rows without embeddings', () => {
  const a = { id: 'a', namespace: 'n', kind: 'fact', text: '', embedding: null, metadata: {} };
  const b = { id: 'b', namespace: 'n', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: {} };
  const plan = planDuplicateMerges([a, b]);
  assert.equal(plan.length, 0);
});

test('planDuplicateMerges skips already-merged rows', () => {
  const a = { id: 'a', namespace: 'n', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: { mergedInto: 'zzz' } };
  const b = { id: 'b', namespace: 'n', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: {} };
  const plan = planDuplicateMerges([a, b]);
  assert.equal(plan.length, 0);
});

test('planDuplicateMerges carries useCountBonus', () => {
  const a = { id: 'a', namespace: 'n', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: { useCount: 3 } };
  const b = { id: 'b', namespace: 'n', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: { useCount: 7 } };
  const [plan] = planDuplicateMerges([a, b]);
  assert.equal(plan.keepId, 'b');
  assert.equal(plan.useCountBonus, 3);
});

// ─── P1-5 regression: protect corrections/decisions/identity/pinned ──────────

test('planDuplicateMerges never merges correction/decision/identity rows', () => {
  const kinds = ['correction', 'decision', 'identity'];
  for (const category of kinds) {
    const a = { id: `a-${category}`, namespace: 'n', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: { category, useCount: 5 } };
    const b = { id: `b-${category}`, namespace: 'n', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: { category, useCount: 1 } };
    const plan = planDuplicateMerges([a, b]);
    assert.equal(plan.length, 0, `category=${category} must not be merged`);
  }
});

test('planDuplicateMerges never merges pinned rows', () => {
  const a = { id: 'pinned', namespace: 'n', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: { pinned: true, useCount: 5 } };
  const b = { id: 'normal', namespace: 'n', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: { useCount: 1 } };
  const plan = planDuplicateMerges([a, b]);
  assert.equal(plan.length, 0, 'pinned row excluded from merge planner entirely');
});

test('planDuplicateMerges honours protection via kind-inferred category', () => {
  // Even if metadata.category is absent, kind="correction" should be protected.
  const a = { id: 'c1', namespace: 'n', kind: 'correction', text: '', embedding: vec([1, 0, 0, 0]), metadata: {} };
  const b = { id: 'c2', namespace: 'n', kind: 'correction', text: '', embedding: vec([1, 0, 0, 0]), metadata: {} };
  const plan = planDuplicateMerges([a, b]);
  assert.equal(plan.length, 0);
});

test('planDuplicateMerges still merges within a group even when a protected row is alongside', () => {
  // The protected row is filtered out; the other two still cluster.
  const prot = { id: 'prot', namespace: 'n', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: { category: 'correction' } };
  const a = { id: 'a', namespace: 'n', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: { category: 'preference', useCount: 1 } };
  const b = { id: 'b', namespace: 'n', kind: 'fact', text: '', embedding: vec([1, 0, 0, 0]), metadata: { category: 'preference', useCount: 5 } };
  const plan = planDuplicateMerges([prot, a, b]);
  assert.equal(plan.length, 1, 'only a↔b merge, prot excluded');
  assert.equal(plan[0].keepId, 'b');
  assert.equal(plan[0].dropId, 'a');
});

// ─── C-5 regression: cross-kind merge between fact and session-fact ──────────

test('C-5: session-fact is merged INTO fact when both exist in same namespace', () => {
  // fact has lower useCount but is still the preferred survivor — it's the
  // more general / permanent form.
  const sf = { id: 'sf-1', namespace: 'chat:u1', kind: 'session-fact', text: '',
               embedding: vec([1, 0, 0, 0]), metadata: { useCount: 9 }, updatedAt: '2026-01-01' };
  const f  = { id: 'f-1',  namespace: 'chat:u1', kind: 'fact',         text: '',
               embedding: vec([1, 0, 0, 0]), metadata: { useCount: 2 }, updatedAt: '2026-02-01' };
  const plan = planDuplicateMerges([sf, f]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].keepId, 'f-1', 'fact always wins over session-fact');
  assert.equal(plan[0].dropId, 'sf-1');
  assert.equal(plan[0].crossKind, true, 'crossKind flag set on plan');
});

test('C-5: two session-facts still merge within same kind with useCount winning', () => {
  const a = { id: 'sf-a', namespace: 'chat:u1', kind: 'session-fact', text: '',
              embedding: vec([1, 0, 0, 0]), metadata: { useCount: 1 }, updatedAt: '2026-01-01' };
  const b = { id: 'sf-b', namespace: 'chat:u1', kind: 'session-fact', text: '',
              embedding: vec([1, 0, 0, 0]), metadata: { useCount: 7 }, updatedAt: '2026-01-02' };
  const plan = planDuplicateMerges([a, b]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].keepId, 'sf-b');
  assert.equal(plan[0].crossKind, false, 'same-kind merges are not cross-kind');
});

test('C-5: cross-kind merge only fires on near-duplicate embeddings', () => {
  const sf = { id: 'sf', namespace: 'n', kind: 'session-fact', text: '',
               embedding: vec([1, 0, 0, 0]), metadata: {} };
  const f  = { id: 'f',  namespace: 'n', kind: 'fact',         text: '',
               embedding: vec([0, 1, 0, 0]), metadata: {} };
  const plan = planDuplicateMerges([sf, f]);
  // Orthogonal embeddings — still no merge, even across kinds.
  assert.equal(plan.length, 0);
});

test('C-5: cross-kind grouping is namespace-scoped', () => {
  const sf = { id: 'sf', namespace: 'ns-A', kind: 'session-fact', text: '',
               embedding: vec([1, 0, 0, 0]), metadata: {} };
  const f  = { id: 'f',  namespace: 'ns-B', kind: 'fact',         text: '',
               embedding: vec([1, 0, 0, 0]), metadata: {} };
  const plan = planDuplicateMerges([sf, f]);
  assert.equal(plan.length, 0, 'different namespaces still never merge');
});

test('C-5: cross-kind merge still respects protection (fact-correction pair)', () => {
  const sf = { id: 'sf', namespace: 'n', kind: 'session-fact', text: '',
               embedding: vec([1, 0, 0, 0]), metadata: {} };
  const f  = { id: 'f',  namespace: 'n', kind: 'fact',         text: '',
               embedding: vec([1, 0, 0, 0]), metadata: { category: 'correction' } };
  const plan = planDuplicateMerges([sf, f]);
  // The fact is correction-protected and removed from the planner entirely,
  // so there's no partner for the session-fact → no merge.
  assert.equal(plan.length, 0);
});
