import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ruleBasedCompact,
  extractKeySentences,
  compactOffline,
  _setCallLocalLlmForTests,
} from './compact.js';

// Helper: run `fn` with MELO_HOME pointed at a tmp dir + arbitrary env
// overrides, restoring the original values + cleaning the dir afterwards.
// Centralised so the gate-mode tests below stay readable.
async function withIsolatedEnv(overrides, fn) {
  const tmpHome = mkdtempSync(join(tmpdir(), 'melo-compact-test-'));
  const saved = {};
  const target = { MELO_HOME: tmpHome, ...overrides };
  for (const key of Object.keys(target)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(target)) process.env[key] = value;
  try {
    return await fn(tmpHome);
  } finally {
    for (const key of Object.keys(target)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

const FIXTURE_MESSAGES = [
  { role: 'user', content: 'Please help me decide between bun and npm for the build script.' },
  { role: 'assistant', content: 'We previously decided on bun for this project.' },
  { role: 'user', content: 'Right, let us confirm bun stays.' },
];

test('ruleBasedCompact produces all 6 sections with bullet placeholders', () => {
  const messages = [
    { role: 'user', content: 'I prefer concise answers please.' },
    { role: 'assistant', content: 'Got it. Short replies.' },
    { role: 'user', content: 'We decided to use bun over npm.' },
    { role: 'assistant', content: 'Okay, using bun then.' },
  ];
  const summary = ruleBasedCompact(messages);
  assert.ok(summary.includes('1. Primary Request'));
  assert.ok(summary.includes('2. Key Facts'));
  assert.ok(summary.includes('3. What Was Accomplished'));
  assert.ok(summary.includes('4. Pending'));
  assert.ok(summary.includes('5. Tone and Style Preferences'));
  assert.ok(summary.includes('6. Recent Context'));
});

test('ruleBasedCompact returns empty string on empty input', () => {
  assert.equal(ruleBasedCompact([]), '');
  assert.equal(ruleBasedCompact([{ role: 'system', content: 'ignored' }]), '');
});

test('extractKeySentences ranks sentences by lexical overlap', () => {
  const text =
    'The cache is an LRU cache with capacity 64. ' +
    'The LRU cache trades latency for memory. ' +
    'Unrelated observation about weather. ' +
    'The cache implementation uses a doubly linked list. ' +
    'Capacity tuning matters for performance.';
  const top = extractKeySentences(text, 3);
  assert.equal(top.length, 3);
  // At least two of the top-3 sentences should mention "cache"
  const withCache = top.filter(s => /cache/i.test(s)).length;
  assert.ok(withCache >= 2);
});

test('extractKeySentences handles short inputs by returning them all', () => {
  const out = extractKeySentences('Hi there! This is a short note.', 5);
  assert.ok(out.length <= 5);
});

test('compactOffline returns a non-empty summary when transcript has content', async () => {
  // No local LLM is running in tests — this exercises the rule fallback.
  const messages = [
    { role: 'user', content: 'Please help me decide between bun and npm.' },
    { role: 'assistant', content: 'We previously decided on bun.' },
    { role: 'user', content: 'Actually let us confirm that choice.' },
  ];
  const saved = process.env.MELO_OFFLINE_DISABLE_LLM;
  process.env.MELO_OFFLINE_DISABLE_LLM = '1';
  try {
    const summary = await compactOffline(messages, { config: {} });
    assert.ok(summary.length > 0);
    assert.ok(summary.includes('Primary Request'));
  } finally {
    if (saved == null) delete process.env.MELO_OFFLINE_DISABLE_LLM;
    else process.env.MELO_OFFLINE_DISABLE_LLM = saved;
  }
});

// ─── Quality-gate fallback path ──────────────────────────────────────────────
//
// These tests simulate "LLM is reachable, returned a string" via the
// _setCallLocalLlmForTests DI hook so we can drive both branches of the
// fallback gate without a live model.  Each test isolates MELO_HOME so the
// audit-diary append goes into a tmp dir that's cleaned up after.

test('quality gate=fallback skips a hallucinated LLM summary and rule-falls-back', async () => {
  await withIsolatedEnv(
    { MELO_COMPACT_QUALITY_GATE: 'fallback' },
    async () => {
      // Mock summary shares almost no tokens / entities with the source;
      // both groundedness and entity-coverage should fail the threshold.
      _setCallLocalLlmForTests(async () =>
        'Carol decided to use Redis with TTL 30 minutes for sessions tomorrow.');
      try {
        const summary = await compactOffline(FIXTURE_MESSAGES, { config: {} });
        // Rule fallback always emits the "Primary Request" header — that's
        // our fingerprint that the LLM result was rejected.
        assert.ok(summary.includes('Primary Request'));
        assert.ok(!summary.includes('Carol'));
        assert.ok(!summary.includes('Redis'));
      } finally {
        _setCallLocalLlmForTests(null);
      }
    },
  );
});

test('quality gate=fallback keeps a grounded LLM summary', async () => {
  await withIsolatedEnv(
    { MELO_COMPACT_QUALITY_GATE: 'fallback' },
    async () => {
      _setCallLocalLlmForTests(async () =>
        'User asked about bun versus npm; assistant confirmed bun was previously decided for this project build.');
      try {
        const summary = await compactOffline(FIXTURE_MESSAGES, { config: {} });
        assert.ok(summary.includes('bun'));
        // Not the 6-section rule template.
        assert.ok(!summary.includes('Primary Request'));
      } finally {
        _setCallLocalLlmForTests(null);
      }
    },
  );
});

test('quality gate=audit (default) keeps even low-quality LLM output (diary-only)', async () => {
  await withIsolatedEnv(
    { MELO_COMPACT_QUALITY_GATE: 'audit' },
    async () => {
      _setCallLocalLlmForTests(async () =>
        'Carol decided to use Redis with TTL 30 minutes for sessions tomorrow.');
      try {
        const summary = await compactOffline(FIXTURE_MESSAGES, { config: {} });
        // Audit mode never rewrites the LLM output — it just records the
        // score in DREAMS.md.  So we should still see the (bad) LLM text.
        assert.ok(summary.includes('Carol'));
        assert.ok(!summary.includes('Primary Request'));
      } finally {
        _setCallLocalLlmForTests(null);
      }
    },
  );
});

test('quality gate=fallback treats MELO_SUMMARY_QUALITY_THRESHOLD="" as unset (not 0)', async () => {
  // Regression: Number('') === 0 in JS, so a stray empty env var would
  // silently set the threshold to 0 and let every LLM summary through the
  // fallback gate.  compactQualityThreshold() must trim + treat empty as
  // null so the evaluator's compiled-in default (0.6) still applies.
  await withIsolatedEnv(
    {
      MELO_COMPACT_QUALITY_GATE: 'fallback',
      MELO_SUMMARY_QUALITY_THRESHOLD: '',
    },
    async () => {
      _setCallLocalLlmForTests(async () =>
        'Carol decided to use Redis with TTL 30 minutes for sessions tomorrow.');
      try {
        const summary = await compactOffline(FIXTURE_MESSAGES, { config: {} });
        // Default threshold should still apply → low-quality summary rejected
        // → rule fallback emits the "Primary Request" header.
        assert.ok(summary.includes('Primary Request'));
        assert.ok(!summary.includes('Carol'));
      } finally {
        _setCallLocalLlmForTests(null);
      }
    },
  );
});

test('quality gate=fallback honours MELO_SUMMARY_QUALITY_THRESHOLD whitespace as unset', async () => {
  await withIsolatedEnv(
    {
      MELO_COMPACT_QUALITY_GATE: 'fallback',
      MELO_SUMMARY_QUALITY_THRESHOLD: '   ',
    },
    async () => {
      _setCallLocalLlmForTests(async () =>
        'Carol decided to use Redis with TTL 30 minutes for sessions.');
      try {
        const summary = await compactOffline(FIXTURE_MESSAGES, { config: {} });
        assert.ok(summary.includes('Primary Request'));
      } finally {
        _setCallLocalLlmForTests(null);
      }
    },
  );
});

test('compactOffline captures threshold at entry — mid-call env mutation does not leak', async () => {
  // Contract test for Codex follow-up #3: previously the threshold
  // helper could return null on empty env, then the evaluator would
  // re-read process.env at audit time, breaking the "capture at entry"
  // contract.  Now the helper always returns a finite number; an LLM
  // call that mutates the env mid-flight should NOT change the
  // already-captured threshold.
  await withIsolatedEnv(
    {
      MELO_COMPACT_QUALITY_GATE: 'fallback',
      MELO_SUMMARY_QUALITY_THRESHOLD: '', // empty → captured as default 0.6
    },
    async () => {
      _setCallLocalLlmForTests(async () => {
        // Adversary: bump threshold to 0 mid-flight so the bad summary
        // would slip through if the evaluator re-read env.  The capture
        // at compactOffline entry must shield us.
        process.env.MELO_SUMMARY_QUALITY_THRESHOLD = '0';
        return 'Carol decided to use Redis with TTL 30 minutes for sessions.';
      });
      try {
        const summary = await compactOffline(FIXTURE_MESSAGES, { config: {} });
        // If the contract holds, the captured 0.6 default still rejects
        // the hallucinated summary → rule fallback fires.
        assert.ok(summary.includes('Primary Request'));
        assert.ok(!summary.includes('Carol'));
      } finally {
        _setCallLocalLlmForTests(null);
      }
    },
  );
});

test('quality gate=disabled skips audit + always returns LLM output unchanged', async () => {
  await withIsolatedEnv(
    { MELO_COMPACT_QUALITY_GATE: '0' },
    async () => {
      _setCallLocalLlmForTests(async () =>
        'Some entirely unrelated string that should still be returned.');
      try {
        const summary = await compactOffline(FIXTURE_MESSAGES, { config: {} });
        assert.equal(summary, 'Some entirely unrelated string that should still be returned.');
      } finally {
        _setCallLocalLlmForTests(null);
      }
    },
  );
});

test('compactOfflineDetailed reports the rule fallback when no local model answers', async () => {
  const { compactOfflineDetailed, compactOffline } = await import('./compact.js');
  const previous = process.env.MELO_OFFLINE_DISABLE_LLM;
  process.env.MELO_OFFLINE_DISABLE_LLM = '1';
  try {
    const messages = [{ role: 'user', content: 'The deploy window is Friday evening.' }, { role: 'assistant', content: 'Understood, Friday evening.' }];
    const detailed = await compactOfflineDetailed(messages, {});
    assert.equal(detailed.source, 'rule');
    assert.ok(detailed.summary.length > 0);
    assert.equal(await compactOffline(messages, {}), detailed.summary, 'string API unchanged');
    assert.deepEqual(await compactOfflineDetailed([], {}), { summary: '', source: 'none' });
  } finally {
    if (previous === undefined) delete process.env.MELO_OFFLINE_DISABLE_LLM; else process.env.MELO_OFFLINE_DISABLE_LLM = previous;
  }
});
