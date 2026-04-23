/**
 * Phase 4 — statusFormat unit tests.
 *
 * The formatter is split out of the CLI so we can pin its output shape
 * (used by ops scripts and shell aliases) and its flag parsing (used by
 * CI gating the --live exit code).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_SECTIONS,
  parseStatusFlags,
  fmtBytes,
  fmtRelTime,
  formatDriftBanner,
  formatText,
  getHelpText,
} from './statusFormat.js';

const NOW = Date.UTC(2026, 3, 23, 12, 0, 0); // deterministic clock

function fakeSnapshot(overrides = {}) {
  const base = {
    schemaVersion: 1,
    meloHome: '/tmp/melo-fixture',
    store: { path: '/tmp/melo-fixture/desktop/store.sqlite', exists: true, sizeBytes: 4_567_890 },
    meta: { embedding_dims: '1024', embedding_model_id: 'bge-m3' },
    counts: { memories: 42, memoriesFts: 42, vecMemories: 42, embeddingCache: 9 },
    dreams: {
      dir: '/tmp/melo-fixture/desktop/dreams',
      count: 3,
      latest: { name: '2026-04-22.md', mtimeMs: NOW - 3600_000, path: '/tmp/d.md' },
    },
    embedding: {
      provider: 'ollama',
      cacheRows: 9,
      dimsConfigured: 1024,
      storedModelId: 'bge-m3',
      drift: { stored: 'bge-m3', inferredProvider: null, hasDrift: false, probeAttempted: false },
    },
    tuning: { mmrLambda: 0.7, recencyHalfLifeDays: 14 },
  };
  return { ...base, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────
// parseStatusFlags
// ─────────────────────────────────────────────────────────────────────

test('parseStatusFlags: no args → defaults (text, all sections, no probe)', () => {
  const f = parseStatusFlags([]);
  assert.equal(f.json, false);
  assert.equal(f.live, false);
  assert.equal(f.help, false);
  assert.deepEqual(f.sections, STATUS_SECTIONS);
});

test('parseStatusFlags: --json flips json, leaves sections default', () => {
  const f = parseStatusFlags(['--json']);
  assert.equal(f.json, true);
  assert.deepEqual(f.sections, STATUS_SECTIONS);
});

test('parseStatusFlags: --live flips live', () => {
  const f = parseStatusFlags(['--live']);
  assert.equal(f.live, true);
});

test('parseStatusFlags: --help / -h', () => {
  assert.equal(parseStatusFlags(['--help']).help, true);
  assert.equal(parseStatusFlags(['-h']).help, true);
});

test('parseStatusFlags: --meta narrows sections to [meta]', () => {
  const f = parseStatusFlags(['--meta']);
  assert.deepEqual(f.sections, ['meta']);
});

test('parseStatusFlags: --dreams narrows sections to [dreams]', () => {
  const f = parseStatusFlags(['--dreams']);
  assert.deepEqual(f.sections, ['dreams']);
});

test('parseStatusFlags: --meta + --dreams combine', () => {
  const f = parseStatusFlags(['--meta', '--dreams']);
  // Order is canonical (STATUS_SECTIONS order), not argv order.
  assert.deepEqual(f.sections, ['meta', 'dreams']);
});

test('parseStatusFlags: --sections=store,embedding parses, keeps canonical order', () => {
  const f = parseStatusFlags(['--sections=embedding,store']);
  assert.deepEqual(f.sections, ['store', 'embedding']);
});

test('parseStatusFlags: unknown --sections values are silently dropped', () => {
  const f = parseStatusFlags(['--sections=store,bogus,tuning']);
  assert.deepEqual(f.sections, ['store', 'tuning']);
});

test('parseStatusFlags: multiple flags combine', () => {
  const f = parseStatusFlags(['--json', '--live', '--meta']);
  assert.equal(f.json, true);
  assert.equal(f.live, true);
  assert.deepEqual(f.sections, ['meta']);
});

test('parseStatusFlags: unknown flag is ignored, not an error', () => {
  const f = parseStatusFlags(['--totally-bogus']);
  assert.equal(f.json, false);
  assert.equal(f.help, false);
  assert.deepEqual(f.sections, STATUS_SECTIONS);
});

// ─────────────────────────────────────────────────────────────────────
// fmtBytes / fmtRelTime
// ─────────────────────────────────────────────────────────────────────

test('fmtBytes: covers B / KB / MB + null → n/a', () => {
  assert.equal(fmtBytes(null), 'n/a');
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1023), '1023 B');
  assert.equal(fmtBytes(2048), '2.0 KB');
  assert.equal(fmtBytes(2 * 1024 * 1024), '2.00 MB');
});

test('fmtRelTime: seconds / minutes / hours / days', () => {
  const now = 10_000_000_000;
  assert.equal(fmtRelTime(null, now), 'n/a');
  assert.equal(fmtRelTime(now - 5_000, now), '5s ago');
  assert.equal(fmtRelTime(now - 3 * 60_000, now), '3m ago');
  assert.equal(fmtRelTime(now - 4 * 3600_000, now), '4h ago');
  assert.equal(fmtRelTime(now - 5 * 24 * 3600_000, now), '5d ago');
});

// ─────────────────────────────────────────────────────────────────────
// formatDriftBanner
// ─────────────────────────────────────────────────────────────────────

test('formatDriftBanner: no drift → empty string', () => {
  assert.equal(formatDriftBanner({ stored: 'a', inferredProvider: 'a', hasDrift: false }), '');
  assert.equal(formatDriftBanner(null), '');
  assert.equal(formatDriftBanner(undefined), '');
});

test('formatDriftBanner: drift → includes both modelIds + resolution hint', () => {
  const out = formatDriftBanner({
    stored: 'bge-m3',
    inferredProvider: 'text-embedding-3-large',
    hasDrift: true,
  });
  assert.ok(out.startsWith('!! EMBEDDING MODEL DRIFT'));
  assert.match(out, /stored = bge-m3/);
  assert.match(out, /live\s*= text-embedding-3-large/);
  assert.match(out, /wipe/i);
});

test('formatDriftBanner: drift with missing names degrades gracefully', () => {
  const out = formatDriftBanner({ stored: null, inferredProvider: null, hasDrift: true });
  assert.match(out, /stored = \?/);
  assert.match(out, /live\s*= \?/);
});

// ─────────────────────────────────────────────────────────────────────
// formatText
// ─────────────────────────────────────────────────────────────────────

test('formatText: full render contains every section', () => {
  const out = formatText(fakeSnapshot(), { now: NOW });
  for (const label of ['MELO_HOME', 'row counts', '_meta', 'embedding', 'tuning \\(effective\\)', 'dreams']) {
    assert.match(out, new RegExp(label), `missing "${label}" in full render`);
  }
  assert.ok(out.includes('── Melo memory status'));
  assert.ok(out.includes('───────────────────────────────────────────────────'));
});

test('formatText: --meta-only render skips store/embedding/tuning/dreams', () => {
  const out = formatText(fakeSnapshot(), { sections: ['meta'], now: NOW });
  assert.match(out, /_meta/);
  assert.match(out, /embedding_model_id\s+bge-m3/);
  assert.doesNotMatch(out, /row counts/);
  assert.doesNotMatch(out, /MMR λ/);
  assert.doesNotMatch(out, /dreams\n/);
});

test('formatText: --dreams-only render keeps dreams + drops the rest', () => {
  const out = formatText(fakeSnapshot(), { sections: ['dreams'], now: NOW });
  assert.match(out, /dreams/);
  assert.match(out, /2026-04-22\.md/);
  assert.match(out, /1h ago/);  // deterministic clock offset
  assert.doesNotMatch(out, /row counts/);
  assert.doesNotMatch(out, /tuning/);
});

test('formatText: drift banner appears at top when hasDrift=true', () => {
  const snap = fakeSnapshot({
    embedding: {
      provider: 'ollama',
      cacheRows: 9,
      dimsConfigured: 1024,
      storedModelId: 'bge-m3',
      drift: { stored: 'bge-m3', inferredProvider: 'text-embedding-3-large', hasDrift: true, probeAttempted: true },
    },
  });
  const out = formatText(snap, { now: NOW });
  const headerPos = out.indexOf('── Melo memory status');
  const bannerPos = out.indexOf('!! EMBEDDING MODEL DRIFT');
  const embeddingPos = out.indexOf('embedding\n');
  assert.ok(headerPos >= 0 && bannerPos > headerPos, 'banner must appear after header');
  assert.ok(embeddingPos > bannerPos, 'banner must appear before embedding section');
  // Embedding section also notes the drift inline.
  assert.match(out, /\[!\] drift: stored≠live/);
});

test('formatText: no drift → no banner, no inline drift note', () => {
  const out = formatText(fakeSnapshot(), { now: NOW });
  assert.doesNotMatch(out, /EMBEDDING MODEL DRIFT/);
  assert.doesNotMatch(out, /stored≠live/);
});

test('formatText: live probe skipped shows "pass --live" placeholder', () => {
  // probeAttempted=false (default) + inferredProvider=null
  const out = formatText(fakeSnapshot(), { now: NOW });
  assert.match(out, /model \(live\)\s+\(probe skipped — pass --live\)/);
});

test('formatText: live probe attempted but provider down → "(provider unavailable)"', () => {
  const snap = fakeSnapshot({
    embedding: {
      provider: 'ollama',
      cacheRows: 0,
      dimsConfigured: 1024,
      storedModelId: 'bge-m3',
      drift: { stored: 'bge-m3', inferredProvider: null, hasDrift: false, probeAttempted: true },
    },
  });
  const out = formatText(snap, { now: NOW });
  assert.match(out, /model \(live\)\s+\(provider unavailable\)/);
  assert.doesNotMatch(out, /pass --live/);
});

test('formatText: live probe succeeded → prints the live modelId', () => {
  const snap = fakeSnapshot({
    embedding: {
      provider: 'ollama',
      cacheRows: 0,
      dimsConfigured: 1024,
      storedModelId: 'bge-m3',
      drift: { stored: 'bge-m3', inferredProvider: 'bge-m3', hasDrift: false, probeAttempted: true },
    },
  });
  const out = formatText(snap, { now: NOW });
  assert.match(out, /model \(live\)\s+bge-m3/);
});

test('formatText: store.openError is surfaced', () => {
  const snap = fakeSnapshot({
    store: { path: '/tmp/x.sqlite', exists: true, sizeBytes: 0, openError: 'database is locked' },
  });
  const out = formatText(snap, { now: NOW });
  assert.match(out, /open error\s+database is locked/);
});

test('formatText: _meta.embedding_dims mismatch raises the inline warning', () => {
  const snap = fakeSnapshot({
    meta: { embedding_dims: '768', embedding_model_id: 'bge-m3' },
    embedding: {
      provider: 'ollama',
      cacheRows: 0,
      dimsConfigured: 1024,
      storedModelId: 'bge-m3',
      drift: { stored: 'bge-m3', inferredProvider: null, hasDrift: false, probeAttempted: false },
    },
  });
  const out = formatText(snap, { now: NOW });
  assert.match(out, /_meta\.embedding_dims=768 differs from configured 1024/);
});

// ─────────────────────────────────────────────────────────────────────
// help text
// ─────────────────────────────────────────────────────────────────────

test('getHelpText: mentions every user-visible flag', () => {
  const help = getHelpText();
  for (const flag of ['--json', '--live', '--meta', '--dreams', '--sections', '--help']) {
    assert.match(help, new RegExp(flag.replace('-', '\\-')), `help missing ${flag}`);
  }
});
