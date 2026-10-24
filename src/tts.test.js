/** Legacy strip helper compatibility tests. Active synthesis preserves every
 * language; transport regressions below assert the actual outgoing text. */

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

test('custom voice on another port uses that service, with no cloud credentials or MiniMax detour', async t => {
 const {synthesizeSpeech}=await import('./tts.js'); const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return new Response(new Uint8Array([1,2]),{status:200});});
 const result=await synthesizeSpeech('안녕하세요',{ttsProvider:'custom',customVoiceBaseUrl:'http://127.0.0.1:8923/v1',whisperBaseUrl:'https://transcription.invalid/v1',whisperApiKey:'keep-transcription-key',minimaxApiKey:'unused-cloud-key',minimaxVoiceId:'fixture'});
 assert.equal(calls.length,1);assert.equal(calls[0].url,'http://127.0.0.1:8923/v1/audio/speech');
 assert.equal(calls[0].options.headers.Authorization,undefined);assert.equal(JSON.parse(calls[0].options.body).input,'안녕하세요');assert.equal(result.buffer.length,2);
});
test('MiniMax synthesis preserves Korean instead of stripping text based on language',async t=>{
 const {synthesizeSpeech}=await import('./tts.js');let body;
 t.mock.method(globalThis,'fetch',async(url,options)=>{body=JSON.parse(options.body);return Response.json({data:{audio:'0102'}});});
 const result=await synthesizeSpeech('안녕하세요',{ttsProvider:'minimax',minimaxApiKey:'fixture-key',minimaxVoiceId:'fixture'});
 assert.equal(body.text,'안녕하세요');assert.equal(result.buffer.length,2);
});


test('explicit TTS selection owns both success and failure; saved credentials never override it',async t=>{
  const {synthesizeSpeech,getTtsUnavailableReason}=await import('./tts.js');
  const config={minimaxApiKey:'fixture',minimaxVoiceId:'fixture',whisperApiKey:'speech-key',whisperBaseUrl:'https://speech.invalid/v1',customVoiceBaseUrl:'http://127.0.0.1:8911/v1'};
  let fail=false, urls=[], edgeCalls=0;
  t.mock.method(globalThis,'fetch',async url=>{urls.push(String(url)); if(fail)return new Response('',{status:500}); return String(url).includes('minimaxi')?Response.json({data:{audio:'0102'}}):new Response(new Uint8Array([1,2]));});
  const edgeSynthesize=async()=>{edgeCalls++;return fail?null:{buffer:Buffer.from([1,2]),mimeType:'audio/mpeg'};};
  for(const provider of ['edge','openai','custom','minimax']) for(const failure of [false,true]) {
    fail=failure;urls=[];edgeCalls=0;
    const result=await synthesizeSpeech('hello',{...config,ttsProvider:provider},{edgeSynthesize});
    assert.equal(!!result,!failure,provider);
    assert.equal(edgeCalls,provider==='edge'?1:0,provider);
    assert.equal(urls.length,provider==='edge'?0:1,provider);
    if(urls.length)assert.equal(new URL(urls[0]).hostname,{openai:'speech.invalid',custom:'127.0.0.1',minimax:'api.minimaxi.chat'}[provider]);
  }
  assert.ok(getTtsUnavailableReason({ttsProvider:'openai',authMode:'codex',minimaxApiKey:'fixture',minimaxVoiceId:'fixture'}));
  assert.ok(getTtsUnavailableReason({ttsProvider:'minimax',...config,minimaxVoiceId:''}));
});


test('legacy automatic fallback retains the pre-await route snapshot',async t=>{
 const {synthesizeSpeech}=await import('./tts.js');const urls=[];
 const original=process.env.MELO_WHISPER_BASE_URL;
 t.after(()=>{if(original===undefined)delete process.env.MELO_WHISPER_BASE_URL;else process.env.MELO_WHISPER_BASE_URL=original;});
 process.env.MELO_WHISPER_BASE_URL='https://before.invalid/v1';
 t.mock.method(globalThis,'fetch',async url=>{urls.push(String(url));return String(url).includes('minimaxi')?new Response('',{status:500}):new Response(new Uint8Array([1,2]));});
 const audio=await synthesizeSpeech('fixture',{minimaxApiKey:'fixture',minimaxVoiceId:'fixture',whisperApiKey:'fixture'},{edgeSynthesize:async()=>{process.env.MELO_WHISPER_BASE_URL='https://after.invalid/v1';return null;}});
 assert.ok(audio);assert.deepEqual(urls,['https://api.minimaxi.chat/v1/t2a_v2','https://before.invalid/v1/audio/speech']);
});
