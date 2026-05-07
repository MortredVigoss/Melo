/**
 * Tests for `stripKoreanForMinimax` — the helper that removes Korean
 * character runs before sending text to the Chinese-trained MiniMax
 * custom voice (e.g. the "金冬天" clone). Pure-Korean input reduces to
 * an empty string, which signals the outer pipeline to fall back to
 * Edge TTS (ko-KR-SunHiNeural).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMinimaxVoiceSetting, parseSayVoiceList, stripKoreanForMinimax } from './tts.js';

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

// ─── MiniMax voice settings ─────────────────────────────────────────────────

test('normalizeMinimaxVoiceSetting keeps valid speed / pitch / volume values', () => {
  assert.deepEqual(
    normalizeMinimaxVoiceSetting({ speed: 1.25, pitch: -2, vol: 0.8 }),
    { speed: 1.25, vol: 0.8, pitch: -2 },
  );
});

test('normalizeMinimaxVoiceSetting applies MiniMax defaults and clamps bounds', () => {
  assert.deepEqual(
    normalizeMinimaxVoiceSetting({ speed: 9, pitch: -99, vol: 0 }),
    { speed: 2, vol: 0.1, pitch: -12 },
  );
  assert.deepEqual(
    normalizeMinimaxVoiceSetting({ speed: 'bad', pitch: 'bad', vol: 'bad' }),
    { speed: 1, vol: 1, pitch: 0 },
  );
});

// ─── parseSayVoiceList — covers the new TTS macOS-voice split ─────────────
// Powers GET /api/tts/say-voices. The route handler delegates here so
// these unit tests lock the parsing contract without spawning `say`.

test('parseSayVoiceList: standard line shape', () => {
  const stdout = `Albert              en_US    # Hello! My name is Albert.\nAlice               it_IT    # Ciao! Mi chiamo Alice.\n`;
  assert.deepEqual(parseSayVoiceList(stdout), [
    { name: 'Albert', lang: 'en_US', sample: 'Hello! My name is Albert.' },
    { name: 'Alice',  lang: 'it_IT', sample: 'Ciao! Mi chiamo Alice.' },
  ]);
});

test('parseSayVoiceList: handles names with spaces and parens', () => {
  // Real macOS output occasionally includes voices like
  // "Reed (English (US))" — the regex anchors on the locale token so the
  // multi-word name is captured intact.
  const stdout = `Reed (English (US))   en_US    # Hello! My name is Reed.\n`;
  assert.deepEqual(parseSayVoiceList(stdout), [
    { name: 'Reed (English (US))', lang: 'en_US', sample: 'Hello! My name is Reed.' },
  ]);
});

test('parseSayVoiceList: tolerates locale variants and CJK voices', () => {
  const stdout = [
    'Tingting            zh_CN    # 您好我叫Tingting。',
    'Yuna                ko_KR    # 안녕하세요. 제 이름은 Yuna입니다.',
    'Kyoko               ja_JP    # こんにちは! 私の名前はKyokoです.',
    'Karen               en-AU    # G\'day! My name is Karen.',  // hyphen variant
  ].join('\n');
  const result = parseSayVoiceList(stdout);
  assert.equal(result.length, 4);
  assert.equal(result[0].lang, 'zh_CN');
  assert.equal(result[1].lang, 'ko_KR');
  assert.equal(result[2].lang, 'ja_JP');
  assert.equal(result[3].lang, 'en-AU');
});

test('parseSayVoiceList: silently skips unparseable lines', () => {
  // Future macOS may add header lines or trailing notes — tolerant skip
  // beats throwing on a single bad line.
  const stdout = [
    '',                                    // blank
    '   ',                                 // whitespace
    'Albert              en_US    # ok',   // valid
    'something completely unexpected',     // no #, no locale → skip
    'Alice               it_IT    # ok',   // valid
  ].join('\n');
  const result = parseSayVoiceList(stdout);
  assert.deepEqual(result.map(v => v.name), ['Albert', 'Alice']);
});

test('parseSayVoiceList: empty / null input returns []', () => {
  assert.deepEqual(parseSayVoiceList(''),     []);
  assert.deepEqual(parseSayVoiceList(null),   []);
  assert.deepEqual(parseSayVoiceList(undefined), []);
});
