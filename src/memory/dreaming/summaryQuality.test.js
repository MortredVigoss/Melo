import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tokenize,
  extractEntities,
  evaluateSummaryQuality,
  auditSummary,
  appendSummaryAuditLine,
  summaryDiaryPath,
  QUALITY_DEFAULT_THRESHOLD,
  QUALITY_MIN_LENGTH,
  QUALITY_MAX_LENGTH,
} from './summaryQuality.js';

// ─── tokenize ────────────────────────────────────────────────────────────────

test('tokenize keeps latin words ≥ 2 chars and drops stopwords', () => {
  const tokens = tokenize('We decided the LRU capacity should be 64');
  assert.ok(tokens.includes('decided'));
  assert.ok(tokens.includes('lru'));
  assert.ok(tokens.includes('capacity'));
  assert.ok(tokens.includes('64'));
  // stopwords gone
  assert.ok(!tokens.includes('the'));
  assert.ok(!tokens.includes('we'));
});

test('tokenize handles CJK as per-character tokens', () => {
  const tokens = tokenize('阿里 LRU 改成 64');
  assert.ok(tokens.includes('阿'));
  assert.ok(tokens.includes('里'));
  assert.ok(tokens.includes('改'));
  assert.ok(tokens.includes('lru'));
});

test('tokenize on empty / non-string is graceful', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
});

// ─── extractEntities ─────────────────────────────────────────────────────────

test('extractEntities picks capitalised words + acronyms + CJK bigrams', () => {
  const ents = extractEntities('Alice asked about LRU and 阿里 phase 4');
  assert.ok(ents.includes('alice'));
  assert.ok(ents.includes('lru'));
  assert.ok(ents.includes('阿里'));
});

test('extractEntities caps to 8 entries', () => {
  const text = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda';
  const ents = extractEntities(text);
  assert.equal(ents.length, 8);
});

// ─── evaluateSummaryQuality ──────────────────────────────────────────────────

test('grounded summary scores high', () => {
  const source = 'Alice and Bob agreed the LRU cache capacity should be 64. ' +
                 'Phase 4 ships by Friday with the migration script and rollback flag.';
  const summary = 'Alice and Bob agreed LRU cache capacity should be 64; Phase 4 ships Friday.';
  const r = evaluateSummaryQuality(summary, source);
  assert.ok(r.score >= 0.85, `expected ≥0.85, got ${r.score}`);
  assert.equal(r.pass, true);
  assert.equal(r.metrics.lengthOk, true);
  assert.ok(r.metrics.entityCoverage >= 0.5);
  assert.ok(r.metrics.tokenGroundedness >= 0.8);
});

test('hallucinated summary fails', () => {
  const source = 'Alice and Bob agreed the LRU cache capacity should be 64.';
  const summary = 'Carol decided to use Redis with TTL 30 minutes for sessions.';
  const r = evaluateSummaryQuality(summary, source);
  assert.equal(r.pass, false);
  assert.ok(r.score < 0.6);
  assert.ok(r.issues.some(s => /grounded|entity/i.test(s)));
});

test('summary that drops the entities flags entityCoverage', () => {
  const source = 'Alice asked Bob about Phase 4 deadline for the LRU cache work.';
  // grounded enough on filler tokens but no entity left
  const summary = 'asked about deadline for the cache work yesterday morning today again';
  const r = evaluateSummaryQuality(summary, source);
  assert.ok(r.metrics.entityCoverage < 0.5);
  assert.ok(r.issues.some(s => /entity coverage/i.test(s)));
});

test('too-short summary is flagged', () => {
  const source = 'A long enough source sentence about Phase 4 launching tomorrow.';
  const summary = 'short.';
  const r = evaluateSummaryQuality(summary, source);
  assert.equal(r.metrics.lengthOk, false);
  assert.ok(r.issues.some(s => /too short/.test(s)));
});

test('too-long summary is flagged', () => {
  const source = 'Source about LRU cache.';
  const summary = 'a'.repeat(QUALITY_MAX_LENGTH + 10);
  const r = evaluateSummaryQuality(summary, source);
  assert.equal(r.metrics.lengthOk, false);
  assert.ok(r.issues.some(s => /too long/.test(s)));
});

test('empty inputs return deterministic fail', () => {
  const a = evaluateSummaryQuality('', 'source');
  assert.equal(a.pass, false);
  assert.deepEqual(a.issues, ['empty summary']);
  const b = evaluateSummaryQuality('summary', '');
  assert.equal(b.pass, false);
  assert.deepEqual(b.issues, ['empty source']);
});

test('threshold override changes pass/fail decision', () => {
  const source = 'Alice and Bob agreed the LRU cache capacity should be 64.';
  const summary = 'Carol decided to use Redis with TTL 30 minutes for sessions.';
  const lowBar = evaluateSummaryQuality(summary, source, { threshold: 0.05 });
  assert.equal(lowBar.pass, true);
  const highBar = evaluateSummaryQuality(summary, source, { threshold: 0.99 });
  assert.equal(highBar.pass, false);
});

test('default threshold is the documented constant', () => {
  const r = evaluateSummaryQuality('a', 'b');
  assert.equal(r.threshold, QUALITY_DEFAULT_THRESHOLD);
  assert.equal(QUALITY_MIN_LENGTH, 10);
});

// ─── auditSummary + diary write ──────────────────────────────────────────────

test('auditSummary writes a single audit block to the day diary', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'melo-summaryq-'));
  try {
    const source = 'Alice and Bob agreed the LRU cache capacity should be 64.';
    const summary = 'Alice and Bob agreed LRU cache capacity should be 64.';
    const result = auditSummary({
      summary,
      source,
      label: 'compact:test',
      homeOverride: tmp,
    });
    assert.equal(result.pass, true);
    assert.ok(result.diaryPath);
    assert.equal(result.diaryError, null);
    assert.ok(existsSync(result.diaryPath));
    const content = readFileSync(result.diaryPath, 'utf8');
    assert.ok(content.includes('# Melo Dream Diary'));
    assert.ok(content.includes('Summary audit'));
    assert.ok(content.includes('compact:test'));
    assert.ok(content.includes('PASS'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('auditSummary records FAIL marker for low-quality summaries', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'melo-summaryq-'));
  try {
    const result = auditSummary({
      summary: 'Carol used Redis with TTL 30 minutes today again later we go',
      source: 'Alice and Bob agreed the LRU cache capacity should be 64.',
      label: 'compact:fail-case',
      homeOverride: tmp,
    });
    assert.equal(result.pass, false);
    const content = readFileSync(result.diaryPath, 'utf8');
    assert.ok(content.includes('FAIL'));
    assert.ok(content.includes('compact:fail-case'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('auditSummary with write=false skips diary IO', () => {
  const result = auditSummary({
    summary: 'a',
    source: 'b',
    label: 'no-write',
    write: false,
  });
  assert.equal(result.diaryPath, null);
});

test('appendSummaryAuditLine is append-only across calls', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'melo-summaryq-'));
  try {
    const iso = '2026-04-27T10:00:00.000Z';
    const evaluation = evaluateSummaryQuality('grounded text in source', 'grounded text in source extra');
    appendSummaryAuditLine({ label: 'first', evaluation, iso, homeOverride: tmp });
    appendSummaryAuditLine({ label: 'second', evaluation, iso, homeOverride: tmp });
    const path = summaryDiaryPath(iso, tmp);
    const content = readFileSync(path, 'utf8');
    // Header appears once, two audit blocks below it.
    const headers = content.match(/# Melo Dream Diary/g) || [];
    assert.equal(headers.length, 1);
    assert.ok(content.includes('first'));
    assert.ok(content.includes('second'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('summaryDiaryPath honours homeOverride', () => {
  const path = summaryDiaryPath('2026-04-27T10:00:00.000Z', '/tmp/melo-test-home');
  assert.ok(path.startsWith('/tmp/melo-test-home/desktop/dreams/'));
  assert.ok(path.endsWith('2026-04-27.md'));
});
