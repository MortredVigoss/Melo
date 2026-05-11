/**
 * scripts/inspect-search-trail.test.js
 *
 * Codex manual-review follow-up on 4d572de (B → 🔵 + ⚪).  Tests the CLI
 * contract end-to-end via spawn — this is the right granularity because:
 *   - the CLI's value is its exit codes + stdout shape (not internal funcs)
 *   - synthetic JSONL is easy to compose and exercises the full pipeline
 *   - locks in the strict-arg behavior so a future "Math.max(1, …)" creep
 *     can't silently re-introduce the parse-then-fold-to-1 bug
 *
 * Coverage:
 *   - --help prints usage, exit 0
 *   - missing log dir exit 1
 *   - invalid --day exit 2 (the 🔵)
 *   - invalid --days exit 2 (the 🔵)
 *   - invalid --source exit 2
 *   - invalid --status exit 2
 *   - unknown argument exit 2
 *   - synthetic JSONL → aggregation render contains expected sections
 *   - --raw → pure JSONL passthrough, no header
 *   - --status filter narrows the result set
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'inspect-search-trail.js');

function runInspect(args, { home } = {}) {
  const env = { ...process.env };
  if (home) env.MELO_HOME = home;
  return spawnSync('node', [SCRIPT, ...args], { env, encoding: 'utf8' });
}

let _home = null;

test.beforeEach(() => {
  _home = mkdtempSync(join(tmpdir(), 'melo-inspect-test-'));
});

test.afterEach(() => {
  try { rmSync(_home, { recursive: true, force: true }); } catch {}
  _home = null;
});

// ─── --help + exit codes ──────────────────────────────────────────────────────

test('--help prints usage and exits 0', () => {
  const r = runInspect(['--help'], { home: _home });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /inspect-search-trail/);
  assert.match(r.stdout, /--day=YYYY-MM-DD/);
  assert.match(r.stdout, /Prerequisite/);
});

test('missing log directory exits 1 with helpful message', () => {
  // _home was just mkdtemp'd and has no desktop/search-trail-log subdir.
  const r = runInspect([], { home: _home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not exist/);
  assert.match(r.stderr, /MELO_SEARCH_TRAIL_LOG/);
});

// ─── Codex 🔵: strict --day / --days validation ──────────────────────────────

test('--day=bad exits 2 (was silently returning 0 entries pre-fix)', () => {
  const r = runInspect(['--day=bad'], { home: _home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--day must be YYYY-MM-DD/);
});

test('--day=2026-13-99 (regex-shaped but invalid date) exits 2', () => {
  const r = runInspect(['--day=2026-13-99'], { home: _home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--day must be YYYY-MM-DD/);
});

test('--day=2026-05-11 (well-formed) passes parse → exit 1 only because dir missing', () => {
  // Well-formed date but log dir doesn't exist → exit 1, not 2.
  // Distinguishes "arg ok, data missing" from "arg malformed".
  const r = runInspect(['--day=2026-05-11'], { home: _home });
  assert.equal(r.status, 1);
});

test('--days=abc exits 2 (was silently folding to 1)', () => {
  const r = runInspect(['--days=abc'], { home: _home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--days must be a positive integer/);
});

test('--days=0 exits 2 (was silently folding to 1)', () => {
  const r = runInspect(['--days=0'], { home: _home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--days must be a positive integer/);
});

test('--days=-3 exits 2 (was silently folding to 1)', () => {
  const r = runInspect(['--days=-3'], { home: _home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--days must be a positive integer/);
});

test('--days=7 (well-formed) passes parse', () => {
  const r = runInspect(['--days=7'], { home: _home });
  assert.equal(r.status, 1); // dir still missing — not 2.
});

// ─── --source / --status / unknown-arg validation ─────────────────────────────

test('--source=bogus exits 2', () => {
  const r = runInspect(['--source=bogus'], { home: _home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--source must be one of/);
});

test('--status=bogus exits 2', () => {
  const r = runInspect(['--status=bogus'], { home: _home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--status must be one of/);
});

test('unknown --flag exits 2 with hint to --help', () => {
  const r = runInspect(['--bogus-flag'], { home: _home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown argument/);
});

// ─── synthetic JSONL → aggregation ───────────────────────────────────────────

function seedTrail(home, day, lines) {
  const dir = join(home, 'desktop', 'search-trail-log');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${day}.jsonl`),
    lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );
}

const FIXTURE = [
  { ts: '2026-05-11T10:00:00Z', source: 'url-fetch', input: { url: 'https://a.test' }, ok: true, evidenceTrail: [{ tier: 'jina', outcome: 'ok', latencyMs: 250 }] },
  { ts: '2026-05-11T10:00:01Z', source: 'url-fetch', input: { url: 'https://b.test' }, ok: false, error: 'jina timeout', evidenceTrail: [
    { tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' },
    { tier: 'direct', outcome: 'fail', latencyMs: 120, reason: 'http-403' },
  ] },
  { ts: '2026-05-11T10:00:02Z', source: 'social-link', input: { url: 'https://xhslink.com/c' }, ok: true, evidenceTrail: [
    { tier: 'yt-dlp', outcome: 'fail', latencyMs: 900, reason: 'http-403' },
    { tier: 'oembed', outcome: 'ok', latencyMs: 300 },
  ], body: 'body' },
  { ts: '2026-05-11T10:00:03Z', source: 'web-search', input: { query: 'weather' }, ok: true, evidenceTrail: [{ tier: 'cache', outcome: 'skip' }, { tier: 'serp', outcome: 'ok', latencyMs: 1100 }] },
];

test('aggregation render contains by-source / tier×outcome / fail reasons / latency sections', () => {
  seedTrail(_home, '2026-05-11', FIXTURE);
  const r = runInspect(['--day=2026-05-11'], { home: _home });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /4 entries/);
  assert.match(r.stdout, /## by-source breakdown/);
  assert.match(r.stdout, /url-fetch.*total=\s*2/);
  assert.match(r.stdout, /## evidenceTrail tier × outcome/);
  assert.match(r.stdout, /jina/);
  assert.match(r.stdout, /## top fail reasons/);
  assert.match(r.stdout, /url-fetch\/jina:timeout/);
  assert.match(r.stdout, /## top failing URLs/);
  assert.match(r.stdout, /https:\/\/b\.test/);
  assert.match(r.stdout, /## latency P50/);
});

test('--status=fail narrows the aggregate to only failures', () => {
  seedTrail(_home, '2026-05-11', FIXTURE);
  const r = runInspect(['--day=2026-05-11', '--status=fail'], { home: _home });
  assert.equal(r.status, 0);
  // Only the b.test url-fetch failure should be in scope.
  assert.match(r.stdout, /1 entries/);
  assert.match(r.stdout, /url-fetch.*total=\s*1/);
  // social-link / web-search OK rows must not appear in the breakdown
  // (the source-key shows up only if total > 0 within the filtered set).
  assert.doesNotMatch(r.stdout, /social-link\s+total=/);
  assert.doesNotMatch(r.stdout, /web-search\s+total=/);
});

test('--raw emits filtered JSONL with no aggregation header', () => {
  seedTrail(_home, '2026-05-11', FIXTURE);
  const r = runInspect(['--day=2026-05-11', '--raw', '--status=fail'], { home: _home });
  assert.equal(r.status, 0);
  // No aggregation sections in --raw output.
  assert.doesNotMatch(r.stdout, /## by-source breakdown/);
  assert.doesNotMatch(r.stdout, /## evidenceTrail tier × outcome/);
  // Exactly one JSONL line (the b.test failure).
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const obj = JSON.parse(lines[0]);
  assert.equal(obj.source, 'url-fetch');
  assert.equal(obj.input.url, 'https://b.test');
  assert.equal(obj.ok, false);
});

test('empty matching set still exits 0 with helpful zero-entries message', () => {
  // No JSONL file for the requested day — but the log dir exists.
  mkdirSync(join(_home, 'desktop', 'search-trail-log'), { recursive: true });
  const r = runInspect(['--day=2026-05-11'], { home: _home });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /0 entries/);
  assert.match(r.stdout, /No entries matched/);
});
