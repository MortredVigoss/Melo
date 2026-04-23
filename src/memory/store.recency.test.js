/**
 * Phase 1 #2 — recency decay multiplier.
 *
 * recencyMultiplier(metadata, updatedAt) returns a value in [RECENCY_FLOOR, 1]
 * so old rows de-prioritize but never vanish. Dreaming-protected rows (pinned,
 * correction, decision, identity) bypass the decay entirely so the recall
 * scorer and dreaming's merge/supersede gates can't drift against each other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { recencyMultiplier, RECENCY_HALF_LIFE_DAYS } from './store.js';

const DAY_MS = 86_400_000;
const FLOOR = 0.5;

test('recencyMultiplier: fresh row (updatedAt = now) returns 1', () => {
  const nowIso = new Date().toISOString();
  const w = recencyMultiplier({}, nowIso);
  // allow 1e-6 slop for Date.now() advancing between the two calls
  assert.ok(Math.abs(w - 1) < 1e-3, `expected ~1, got ${w}`);
});

test('recencyMultiplier: one-half-life-old row decays to ~0.75', () => {
  // half-life days → decay = e^(-1) ≈ 0.3679 → weight = 0.5 + 0.5*0.3679 ≈ 0.684
  const ts = new Date(Date.now() - RECENCY_HALF_LIFE_DAYS * DAY_MS).toISOString();
  const w = recencyMultiplier({}, ts);
  const expected = FLOOR + (1 - FLOOR) * Math.exp(-1);
  assert.ok(
    Math.abs(w - expected) < 1e-3,
    `expected ~${expected.toFixed(4)}, got ${w.toFixed(4)}`,
  );
});

test('recencyMultiplier: ancient row converges to the 0.5 floor', () => {
  // 10 years old — decay ≈ 0, weight ≈ FLOOR
  const ts = new Date(Date.now() - 3650 * DAY_MS).toISOString();
  const w = recencyMultiplier({}, ts);
  assert.ok(w >= FLOOR - 1e-6, `expected >= ${FLOOR}, got ${w}`);
  assert.ok(w - FLOOR < 1e-3, `expected ~${FLOOR}, got ${w}`);
});

test('recencyMultiplier: pinned rows bypass decay', () => {
  const ts = new Date(Date.now() - 365 * DAY_MS).toISOString();
  assert.equal(recencyMultiplier({ pinned: true }, ts), 1);
});

for (const category of ['correction', 'decision', 'identity']) {
  test(`recencyMultiplier: evergreen category "${category}" bypasses decay`, () => {
    const ts = new Date(Date.now() - 365 * DAY_MS).toISOString();
    assert.equal(recencyMultiplier({ category }, ts), 1);
    // metadata.kind should also match (recency shares dreaming's field lookup)
    assert.equal(recencyMultiplier({ kind: category }, ts), 1);
  });
}

test('recencyMultiplier: unknown category still decays', () => {
  const ts = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const w = recencyMultiplier({ category: 'preference' }, ts);
  assert.ok(w < 1, `expected < 1 for aged non-evergreen row, got ${w}`);
  assert.ok(w >= FLOOR, `expected >= ${FLOOR}, got ${w}`);
});

test('recencyMultiplier: null metadata returns 1 (fail-open)', () => {
  assert.equal(recencyMultiplier(null, new Date(0).toISOString()), 1);
  assert.equal(recencyMultiplier(undefined, new Date(0).toISOString()), 1);
});

test('recencyMultiplier: missing updatedAt returns 1 (fail-open)', () => {
  // No timestamp → scorer can't tell age, so apply no penalty rather than
  // punishing rows whose updated_at column was never populated.
  assert.equal(recencyMultiplier({}, null), 1);
  assert.equal(recencyMultiplier({}, ''), 1);
  assert.equal(recencyMultiplier({}, undefined), 1);
});

test('recencyMultiplier: metadata.updatedAt fallback is honored', () => {
  // When the SQL column is absent but metadata carries its own updatedAt.
  const ts = new Date(Date.now() - RECENCY_HALF_LIFE_DAYS * DAY_MS).toISOString();
  const w = recencyMultiplier({ updatedAt: ts }, null);
  const expected = FLOOR + (1 - FLOOR) * Math.exp(-1);
  assert.ok(
    Math.abs(w - expected) < 1e-3,
    `expected ~${expected.toFixed(4)}, got ${w.toFixed(4)}`,
  );
});

test('recencyMultiplier: unparseable updatedAt returns 1 (fail-open)', () => {
  assert.equal(recencyMultiplier({}, 'not-a-date'), 1);
});
