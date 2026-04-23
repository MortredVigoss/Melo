/**
 * Search audit P2: tokenizer coverage.  The tokenizer is the foundation that
 * the scorer and snippet builder both sit on; any slip in its grapheme /
 * code-unit accounting silently corrupts downstream ranking and UI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codeUnitIndexToGraphemeIndex,
  normalizeSearchValue,
  sliceByGrapheme,
  splitGraphemes,
  tokenizeHaystack,
  tokenizeQuery,
} from './tokenizer.js';

// ─── splitGraphemes ────────────────────────────────────────────────────────

test('splitGraphemes keeps CJK characters as single graphemes', () => {
  assert.deepEqual(splitGraphemes('北京天气'), ['北', '京', '天', '气']);
});

test('splitGraphemes keeps emoji with ZWJ joiners as one grapheme', () => {
  // Family emoji: man + ZWJ + woman + ZWJ + girl — 8 code units, 1 grapheme.
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  const parts = splitGraphemes(family);
  assert.equal(parts.length, 1, `one grapheme, got ${parts.length}`);
  assert.equal(parts[0], family);
});

test('splitGraphemes keeps combining marks attached to base character', () => {
  // "é" as e + U+0301 combining acute → 1 grapheme.
  const decomposed = 'e\u0301';
  assert.deepEqual(splitGraphemes(decomposed), [decomposed]);
});

test('splitGraphemes handles empty and nullish input', () => {
  assert.deepEqual(splitGraphemes(''), []);
  assert.deepEqual(splitGraphemes(null), []);
  assert.deepEqual(splitGraphemes(undefined), []);
});

// ─── sliceByGrapheme ───────────────────────────────────────────────────────

test('sliceByGrapheme clips at grapheme boundaries for CJK strings', () => {
  assert.equal(sliceByGrapheme('北京天气预报', 0, 2), '北京');
  assert.equal(sliceByGrapheme('北京天气预报', 2, 4), '天气');
});

test('sliceByGrapheme does not split surrogate pairs', () => {
  // Two astral-plane codepoints (🚀 = U+1F680, 🌟 = U+1F31F).  Naïve
  // String#slice(0, 1) would lop one surrogate off mid-pair.
  const rocketAndStar = '🚀🌟';
  assert.equal(sliceByGrapheme(rocketAndStar, 0, 1), '🚀');
  assert.equal(sliceByGrapheme(rocketAndStar, 1, 2), '🌟');
});

test('sliceByGrapheme clamps negative start and oversize end', () => {
  assert.equal(sliceByGrapheme('abc', -10, 2), 'ab');
  assert.equal(sliceByGrapheme('abc', 1, 999), 'bc');
});

// ─── codeUnitIndexToGraphemeIndex ──────────────────────────────────────────

test('codeUnitIndexToGraphemeIndex maps ASCII positions 1:1', () => {
  assert.equal(codeUnitIndexToGraphemeIndex('hello world', 6), 6);
});

test('codeUnitIndexToGraphemeIndex maps surrogate-pair positions', () => {
  // "🚀🌟abc" — 🚀 and 🌟 are 2 code units each.  The 'a' sits at code-unit
  // index 4 but grapheme index 2.
  assert.equal(codeUnitIndexToGraphemeIndex('🚀🌟abc', 4), 2);
  // 'c' is code-unit 6, grapheme 4.
  assert.equal(codeUnitIndexToGraphemeIndex('🚀🌟abc', 6), 4);
});

test('codeUnitIndexToGraphemeIndex returns grapheme count when index past end', () => {
  assert.equal(codeUnitIndexToGraphemeIndex('abc', 999), 3);
});

// ─── tokenizeQuery ─────────────────────────────────────────────────────────

test('tokenizeQuery returns empty shape for empty / whitespace input', () => {
  assert.deepEqual(tokenizeQuery(''), { raw: '', tokens: [], graphemes: [] });
  assert.deepEqual(tokenizeQuery('   '), { raw: '', tokens: [], graphemes: [] });
});

test('tokenizeQuery lowercases, trims, and splits ASCII words', () => {
  const result = tokenizeQuery('  Hello World Foo  ');
  assert.equal(result.raw, 'hello world foo');
  assert.deepEqual(result.tokens, ['hello', 'world', 'foo']);
  assert.deepEqual(result.graphemes, []);
});

test('tokenizeQuery extracts per-character graphemes for CJK queries', () => {
  const result = tokenizeQuery('北京天气');
  assert.equal(result.raw, '北京天气');
  // Intl.Segmenter treats CJK as word-like, so tokens may include the whole
  // phrase or per-character segments depending on ICU version — the contract
  // we care about is the grapheme list used for char-level matching.
  assert.deepEqual(result.graphemes, ['北', '京', '天', '气']);
});

test('tokenizeQuery handles mixed CJK + ASCII input', () => {
  const result = tokenizeQuery('北京 Weather 天气');
  assert.equal(result.raw, '北京 weather 天气');
  assert.ok(result.tokens.includes('weather'), 'ascii token preserved');
  assert.ok(result.graphemes.includes('北'));
  assert.ok(result.graphemes.includes('气'));
});

test('tokenizeQuery ignores pure punctuation', () => {
  const result = tokenizeQuery('!!!???,,,');
  assert.equal(result.raw, '!!!???,,,');
  assert.deepEqual(result.tokens, [], 'no word-like tokens from pure punctuation');
  assert.deepEqual(result.graphemes, [], 'no CJK graphemes');
});

// ─── normalizeSearchValue / tokenizeHaystack ───────────────────────────────

test('normalizeSearchValue collapses whitespace and lowercases', () => {
  assert.equal(normalizeSearchValue('  Hello\t\nWorld  '), 'hello world');
});

test('tokenizeHaystack shares the normaliser contract', () => {
  assert.equal(tokenizeHaystack('  Hello\t\nWorld  '), 'hello world');
});
