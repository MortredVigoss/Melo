/**
 * Tests for `stripKoreanForMinimax` — the helper that removes Korean
 * character runs before sending text to the Chinese-trained MiniMax
 * custom voice (e.g. the "金冬天" clone). Pure-Korean input reduces to
 * an empty string, which signals the outer pipeline to fall back to
 * Edge TTS (ko-KR-SunHiNeural).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { stripKoreanForMinimax } from './tts.js';

test('pure Chinese text is untouched', () => {
  const s = '今天天气真好';
  assert.equal(stripKoreanForMinimax(s), s);
});

test('pure English text is untouched', () => {
  const s = 'hello world';
  assert.equal(stripKoreanForMinimax(s), s);
});

test('pure Korean text reduces to empty string', () => {
  assert.equal(stripKoreanForMinimax('안녕하세요'), '');
});

test('pure Compatibility Jamo also reduces to empty', () => {
  assert.equal(stripKoreanForMinimax('ㄱㄴㄷ'), '');
});

test('CN+KR mix keeps only the Chinese part', () => {
  assert.equal(stripKoreanForMinimax('你去看看어떻게'), '你去看看');
});

test('EN+KR mix keeps only the English part', () => {
  assert.equal(stripKoreanForMinimax('ok어'), 'ok');
});

test('KR→CN→KR reduces to just the CN middle', () => {
  assert.equal(stripKoreanForMinimax('어你好네'), '你好');
});

test('multiple KR runs all get removed', () => {
  assert.equal(stripKoreanForMinimax('你好어再说한번'), '你好再说');
});

test('Hangul Compatibility Jamo is treated as Korean and stripped', () => {
  assert.equal(stripKoreanForMinimax('你好ㄱㄴ再见'), '你好再见');
});

test('Hangul Jamo Extended-A/B ranges are also stripped', () => {
  // U+A960 is in Hangul Jamo Extended-A; U+D7B0 in Extended-B.
  assert.equal(stripKoreanForMinimax(`你好\uA960再见`), '你好再见');
  assert.equal(stripKoreanForMinimax(`你好\uD7B0再见`), '你好再见');
});

test('Japanese kana is NOT stripped (not in Korean ranges)', () => {
  const s = 'ありがとう';
  assert.equal(stripKoreanForMinimax(s), s);
});

test('mixed Japanese + Korean strips only Korean', () => {
  assert.equal(stripKoreanForMinimax('ありがとう어'), 'ありがとう');
});

test('CN punctuation adjacent to KR collapses cleanly', () => {
  // Leading space before a punctuation mark left by stripping is removed.
  assert.equal(stripKoreanForMinimax('你看 어, 再见'), '你看, 再见');
  assert.equal(stripKoreanForMinimax('你看，어。'), '你看，。');
});

test('double spaces left by stripping are collapsed', () => {
  assert.equal(stripKoreanForMinimax('你 어 好'), '你 好');
});

test('empty / null input returns empty string', () => {
  assert.equal(stripKoreanForMinimax(''), '');
  assert.equal(stripKoreanForMinimax(null), '');
  assert.equal(stripKoreanForMinimax(undefined), '');
});

test('idempotent: running twice produces the same output', () => {
  const once  = stripKoreanForMinimax('你好어再说한번');
  const twice = stripKoreanForMinimax(once);
  assert.equal(twice, once);
});

test('digits adjacent to KR are preserved', () => {
  assert.equal(stripKoreanForMinimax('123어456'), '123456');
});
