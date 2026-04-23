import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchSnippet,
  fuzzySearchScore,
  fuzzySubsequenceScore,
  weightedKeywordScore,
} from './scoring.js';

test('fuzzySearchScore handles Chinese queries at token and grapheme level', () => {
  const cityWeather = fuzzySearchScore('北京天气', '今天北京天气很好，适合出门。');
  const onlyWeather = fuzzySearchScore('北京天气', '天气预报说明今天有风。');

  assert.ok(cityWeather > 0);
  assert.ok(cityWeather > onlyWeather);
});

test('buildSearchSnippet keeps CJK text intact around the match window', () => {
  const snippet = buildSearchSnippet(
    '今天北京天气很好，空气清新，适合傍晚散步和拍照。',
    '北京天气',
    10,
  );

  assert.match(snippet, /北京天气/);
  assert.doesNotMatch(snippet, /�/);
});

test('weightedKeywordScore respects weighted aliases', () => {
  const strong = weightedKeywordScore('persona', [
    { keyword: 'agent', weight: 1 },
    { keyword: 'persona', weight: 0.6 },
  ]);
  const none = weightedKeywordScore('calendar', [
    { keyword: 'agent', weight: 1 },
    { keyword: 'persona', weight: 0.6 },
  ]);

  assert.ok(strong > 0);
  assert.equal(none, 0);
});

// ─── P2: buildSearchSnippet branch coverage ────────────────────────────────

test('buildSearchSnippet returns short text unchanged (no ellipsis)', () => {
  const out = buildSearchSnippet('short answer here', 'answer', 96);
  assert.equal(out, 'short answer here');
  assert.doesNotMatch(out, /…/);
});

test('buildSearchSnippet does not prepend ellipsis when match is at start', () => {
  const body = 'hello world '.repeat(20).trim();
  const out = buildSearchSnippet(body, 'hello', 32);
  assert.ok(out.startsWith('hello'), `expected start with "hello", got ${JSON.stringify(out)}`);
  assert.ok(!out.startsWith('…'), 'no leading ellipsis for match-at-start');
});

test('buildSearchSnippet appends trailing ellipsis when more content follows', () => {
  const body = `${'x '.repeat(40)}needle ${'y '.repeat(40)}`;
  const out = buildSearchSnippet(body, 'needle', 40);
  assert.ok(out.endsWith('…'), `expected trailing ellipsis, got ${JSON.stringify(out)}`);
});

test('buildSearchSnippet truncates with trailing ellipsis when no match is found', () => {
  const body = 'the quick brown fox jumps over the lazy dog '.repeat(5);
  const out = buildSearchSnippet(body, 'nonexistenttoken', 32);
  assert.ok(out.endsWith('…'), 'trailing ellipsis for no-match truncation');
  assert.ok(out.length <= 48, 'stays within a small multiple of maxLength');
});

test('buildSearchSnippet falls back to truncation when case-fold changes length (Bug 4)', () => {
  // German ß lowercases to "ss" under String#toLowerCase, growing the string
  // by one code unit.  The guard must abort the index-math branch and emit a
  // plain truncated snippet.
  const body = `straßenbahn ${'x'.repeat(200)}`;
  const out = buildSearchSnippet(body, 'bahn', 60);
  assert.ok(out.endsWith('…'), 'fallback snippet is an end-truncation, not a match window');
  assert.ok(!out.startsWith('…'), 'no leading ellipsis in the fallback');
});

test('buildSearchSnippet returns empty string for empty input (P2: no hardcoded UI)', () => {
  assert.equal(buildSearchSnippet('', 'anything'), '');
  assert.equal(buildSearchSnippet('   ', 'anything'), '');
  assert.equal(buildSearchSnippet(null, 'anything'), '');
});

test('buildSearchSnippet honours fallback option for empty input (i18n opt-in)', () => {
  assert.equal(
    buildSearchSnippet('', 'x', 96, { fallback: '未命名结果' }),
    '未命名结果',
  );
  assert.equal(
    buildSearchSnippet(null, 'x', 96, { fallback: 'Untitled result' }),
    'Untitled result',
  );
  // Fallback is ignored when the text is non-empty.
  assert.equal(
    buildSearchSnippet('real title', 'x', 96, { fallback: 'never-shown' }),
    'real title',
  );
});

// ─── P2: fuzzySubsequenceScore / fuzzySearchScore fallback ─────────────────

test('fuzzySubsequenceScore returns 0 for single-char query (Bug 5 noise guard)', () => {
  // Pre-fix, any single letter from the query trivially appeared in the
  // haystack and we awarded a nonzero floor — everything looked like a match.
  assert.equal(fuzzySubsequenceScore('a', 'a long passage of prose with many as'), 0);
  assert.equal(fuzzySubsequenceScore('z', 'no z in this sentence at all'), 0);
});

test('fuzzySubsequenceScore returns 0 when gap penalty swamps base (Bug 5 floor removal)', () => {
  // Query chars appear in order but buried in a very long haystack — the
  // score must be allowed to fall to 0, not floor at 18.
  const buried = 'a' + 'x'.repeat(500) + 'b' + 'y'.repeat(500) + 'c';
  assert.equal(fuzzySubsequenceScore('abc', buried), 0);
});

test('fuzzySearchScore does not reward "spaces are ubiquitous" (Bug 5 fallback fix)', () => {
  // A multi-word query like "hello world" used to score against any haystack
  // just because ' ' reliably appears somewhere.  The compacted-fallback now
  // strips inner whitespace before running the subsequence scorer.
  const score = fuzzySearchScore('zzq yyz', 'the quick brown fox jumps over the lazy dog');
  assert.equal(score, 0, 'unrelated multi-word query no longer lands a score');
});

test('fuzzySearchScore still rewards real fuzzy matches', () => {
  // Sanity check that we haven't thrown the baby out with the bathwater —
  // a genuine in-order match against a reasonable-length haystack still scores.
  const score = fuzzySearchScore('quick fox', 'the quick brown fox jumps over the lazy dog');
  assert.ok(score > 0, `expected > 0, got ${score}`);
});

// ─── P2: weightedKeywordScore weight clamp ─────────────────────────────────

test('weightedKeywordScore clamps negative and non-finite weights', () => {
  const positive = weightedKeywordScore('persona', [
    { keyword: 'persona', weight: 1 },
  ]);

  // Negative weight must not flip the sort order into negative scores.
  const negative = weightedKeywordScore('persona', [
    { keyword: 'persona', weight: -5 },
  ]);
  assert.equal(negative, 0, 'negative weight clamps to 0');

  // NaN / Infinity must not propagate into the total.
  const nan = weightedKeywordScore('persona', [
    { keyword: 'persona', weight: Number.NaN },
  ]);
  const infinite = weightedKeywordScore('persona', [
    { keyword: 'persona', weight: Number.POSITIVE_INFINITY },
  ]);
  assert.equal(nan, positive, 'NaN weight defaults to 1');
  assert.equal(infinite, positive, 'Infinity weight defaults to 1');
});
