import test from 'node:test';
import assert from 'node:assert/strict';
import { planTemporalBackfill, BACKFILL_CONFIG } from './backfill.js';

function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

test('planTemporalBackfill skips rows with validTo already set', async () => {
  const rows = [{
    id: 'a',
    text: 'Using Node 18',
    createdAt: daysAgo(200),
    metadata: { validTo: daysAgo(10) },
  }];
  const plan = await planTemporalBackfill(rows);
  assert.equal(plan.length, 0);
});

test('planTemporalBackfill skips young rows', async () => {
  const rows = [{
    id: 'a',
    text: 'Using Node 18 now',
    createdAt: daysAgo(30),
    metadata: {},
  }];
  const plan = await planTemporalBackfill(rows);
  assert.equal(plan.length, 0);
});

test('planTemporalBackfill fires version-string rule at 180+ days', async () => {
  const rows = [{
    id: 'a',
    text: 'This project uses Node 18',
    createdAt: daysAgo(210),
    metadata: {},
  }];
  const plan = await planTemporalBackfill(rows);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].id, 'a');
  assert.ok(plan[0].reason.includes('version-string'));
});

test('planTemporalBackfill uses llm classifier for ambiguous rows', async () => {
  const rows = [{
    id: 'a',
    text: 'We prefer shorter replies.',
    createdAt: daysAgo(120),
    metadata: {},
  }];
  const plan = await planTemporalBackfill(rows, {
    llmClassifier: async (row) => row.text.includes('shorter'),
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].reason, 'llm-classifier');
});

test('planTemporalBackfill is defensive against classifier errors', async () => {
  const rows = [{
    id: 'a',
    text: 'Neutral fact.',
    createdAt: daysAgo(120),
    metadata: {},
  }];
  const plan = await planTemporalBackfill(rows, {
    llmClassifier: async () => { throw new Error('boom'); },
  });
  assert.equal(plan.length, 0);  // classifier errors must not propagate
});

test('BACKFILL_CONFIG exposes thresholds', () => {
  assert.ok(BACKFILL_CONFIG.STALE_MIN_AGE_DAYS > 0);
  assert.ok(BACKFILL_CONFIG.STALE_FORCE_AGE_DAYS >= BACKFILL_CONFIG.STALE_MIN_AGE_DAYS);
});
