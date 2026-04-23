/**
 * Search audit C-1 / C-2 regression:
 *   - tokenizeForMatch is the single shared implementation used by both
 *     skillMatcher.js and skillIndex.js.
 *   - CJK text is segmented into words via Intl.Segmenter, while the whole
 *     piece is still emitted so verbatim triggers keep matching.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeForMatch, MIN_WORD_LEN } from './skillTokenize.js';

test('MIN_WORD_LEN exported and sane', () => {
  assert.equal(MIN_WORD_LEN, 3);
});

test('drops short ASCII tokens', () => {
  const toks = tokenizeForMatch('hi there friend');
  assert.ok(!toks.includes('hi'));      // length 2
  assert.ok(toks.includes('there'));
  assert.ok(toks.includes('friend'));
});

test('ASCII tokens are lowercased', () => {
  const toks = tokenizeForMatch('Hello World');
  assert.ok(toks.includes('hello'));
  assert.ok(toks.includes('world'));
});

test('splits on ASCII + Unicode punctuation', () => {
  const toks = tokenizeForMatch('alpha,beta;gamma—delta');
  assert.ok(toks.includes('alpha'));
  assert.ok(toks.includes('beta'));
  assert.ok(toks.includes('gamma'));
  assert.ok(toks.includes('delta'));
});

test('CJK piece is segmented into words via Intl.Segmenter', () => {
  // 天气真好 — classic "the weather is nice" test case.
  const toks = new Set(tokenizeForMatch('天气真好'));
  // The whole piece is retained for verbatim matches...
  assert.ok(toks.has('天气真好'));
  // ...and the segmenter should find at least one sub-token shorter
  // than the full piece. We don't assert the exact segmentation because
  // ICU word break data may evolve, but any reasonable segmenter will
  // produce at least one inner word.
  const subTokens = [...toks].filter(t => t !== '天气真好');
  assert.ok(subTokens.length >= 1, `expected sub-tokens, got ${JSON.stringify([...toks])}`);
  // Common segmentations include "天气" and "真好" — at least one of these
  // should be present when Segmenter is available.
  assert.ok(
    toks.has('天气') || toks.has('真好'),
    `expected 天气 or 真好 in ${JSON.stringify([...toks])}`,
  );
});

test('CJK trigger stored verbatim still appears as a whole token', () => {
  const toks = tokenizeForMatch('天气预报');
  assert.ok(toks.includes('天气预报'));
});

test('bare emoji is stripped as punctuation/symbol (not a match-worthy token)', () => {
  // \p{S} includes "Symbol, Other" which covers most emoji. The tokenizer
  // splits on \p{P}\p{S}, so an emoji-only input produces zero tokens.
  // This matches the pre-C-2 behaviour and is fine — a lone emoji isn't
  // useful for skill matching anyway.
  assert.deepEqual(tokenizeForMatch('🚀'), []);
});

test('latin + emoji mix keeps the latin tokens', () => {
  const toks = tokenizeForMatch('launch 🚀 rocket');
  assert.ok(toks.includes('launch'));
  assert.ok(toks.includes('rocket'));
});

test('mixed latin + CJK in one message', () => {
  const toks = new Set(tokenizeForMatch('Translate 天气 please'));
  assert.ok(toks.has('translate'));
  assert.ok(toks.has('please'));
  assert.ok(toks.has('天气'));
});

test('empty / non-string returns empty array', () => {
  assert.deepEqual(tokenizeForMatch(''), []);
  assert.deepEqual(tokenizeForMatch(null), []);
  assert.deepEqual(tokenizeForMatch(undefined), []);
  assert.deepEqual(tokenizeForMatch(123), []);
});

test('Japanese hiragana + katakana + kanji all recognised as CJK', () => {
  const toks = new Set(tokenizeForMatch('こんにちは世界'));
  assert.ok(toks.has('こんにちは世界'));
});

test('Korean hangul recognised as CJK', () => {
  const toks = new Set(tokenizeForMatch('안녕하세요'));
  assert.ok(toks.has('안녕하세요'));
});
