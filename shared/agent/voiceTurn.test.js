// Live voice call rules (2026-11-16): the JavaScript half of the contract
// fixtures in shared/protocol/agent-loop.json → fixtures.voiceTurn. The iPhone
// port (ios/Melo/VoiceTurnRules.swift) runs the same cases in
// ios/Tests/VoiceCallTests.swift, so both ends read the same words aloud.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VOICE_TURN, voiceCallSpeech, isVoiceStopPhrase, voiceTurnInstruction, voiceCallTiming, voiceCallPhrase, voiceTurnLanguage, splitSpeechSentences } from './voiceTurn.js';

async function fixtures() {
  const contract = JSON.parse(await readFile(new URL('../protocol/agent-loop.json', import.meta.url), 'utf8'));
  return contract.fixtures.voiceTurn;
}

test('the contract section is complete and consistent', () => {
  for (const language of ['zh', 'en']) {
    assert.ok(VOICE_TURN.instruction[language].includes('{moreInChat}'), `${language} instruction names the closing phrase`);
    assert.ok(VOICE_TURN.style[language].includes('{style}'));
    assert.ok(VOICE_TURN.spokenMaxChars[language] > 40);
    for (const key of ['tools', 'approval', 'moreInChat', 'failed', 'stopped']) assert.ok(VOICE_TURN.phrases[key][language].trim(), `${key}.${language}`);
  }
  const { endpointMs, endpointMinMs, endpointMaxMs, bargeInMs, utteranceLimitMs, echoTailMs, echoSimilarity } = VOICE_TURN.timing;
  assert.ok(endpointMinMs <= endpointMs && endpointMs <= endpointMaxMs);
  assert.ok(bargeInMs > 0 && bargeInMs < endpointMs && utteranceLimitMs >= 10_000 && echoTailMs > 0);
  assert.ok(echoSimilarity > 0 && echoSimilarity <= 1);
  assert.ok(VOICE_TURN.stopPhrases.length >= 5);
});

test('fixtures: what a call reads aloud for a reply (same cases as the iPhone)', async () => {
  const { speech } = await fixtures();
  assert.ok(speech.length >= 10);
  for (const entry of speech) {
    const result = voiceCallSpeech(entry.text);
    assert.deepEqual(result.sentences, entry.sentences, entry.text.slice(0, 40));
    assert.equal(result.condensed, entry.condensed, entry.text.slice(0, 40));
    assert.equal(result.language, entry.language, entry.text.slice(0, 40));
    assert.equal(result.text, entry.sentences.join(' '));
  }
});

test('fixtures: stop phrases, instructions and timings (same cases as the iPhone)', async () => {
  const { stop, instruction, timing } = await fixtures();
  for (const entry of stop) assert.equal(isVoiceStopPhrase(entry.text), entry.stop, entry.text);
  for (const entry of instruction) assert.equal(voiceTurnInstruction(entry.text, { style: entry.style }), entry.expected, entry.text);
  for (const entry of timing) assert.equal(voiceCallTiming(entry.endpointMs == null ? {} : { endpointMs: entry.endpointMs }).endpointMs, entry.expected);
});

test('a stop phrase is the whole utterance, never a word inside a request', () => {
  for (const text of ['停', '停！', '算了吧。', ' Stop it! ', 'NEVER mind', '取消']) assert.equal(isVoiceStopPhrase(text), true, text);
  for (const text of ['停车场在哪', '取消明天的会议', 'stop the timer at five', '帮我暂停一下音乐播放器', '', '。']) assert.equal(isVoiceStopPhrase(text), false, text);
});

test('the instruction follows the utterance language and carries the Agent style, capped', () => {
  const zh = voiceTurnInstruction('明天几点开会');
  assert.ok(zh.startsWith('【语音通话】') && zh.includes(voiceCallPhrase('moreInChat', 'zh')));
  const en = voiceTurnInstruction('when is the meeting');
  assert.ok(en.startsWith('[Live voice call]') && en.includes(voiceCallPhrase('moreInChat', 'en')));
  const styled = voiceTurnInstruction('明天几点开会', { style: 'x'.repeat(900) });
  assert.equal(styled.split('\n').at(-1), `说话风格：${'x'.repeat(400)}`);
  assert.equal(voiceTurnInstruction('明天几点开会', { style: '   ' }), zh, 'a blank style adds nothing');
  assert.equal(voiceTurnLanguage(''), 'en');
});

test('what is read never exceeds the language cap except for the closing phrase', () => {
  const zhSentence = '这是一句用来检查朗读长度上限的中文句子。';
  const enSentence = 'This sentence checks the spoken length limit of a call reply. ';
  for (let count = 1; count <= 40; count += 3) {
    for (const [text, language] of [[zhSentence.repeat(count), 'zh'], [enSentence.repeat(count), 'en']]) {
      const result = voiceCallSpeech(text);
      const closing = voiceCallPhrase('moreInChat', language);
      const body = result.sentences.filter(sentence => sentence !== closing);
      const used = body.reduce((sum, sentence) => sum + sentence.length, 0);
      assert.ok(used <= VOICE_TURN.spokenMaxChars[language], `${language} ×${count}: ${used}`);
      assert.equal(result.condensed, result.sentences.at(-1) === closing, `${language} ×${count}: the closing phrase marks unread text`);
    }
  }
});

test('sentences split like the iPhone: decimals and versions stay whole', () => {
  assert.deepEqual(splitSpeechSentences('版本 0.7.19 已装好，耗时 3.5 分钟。下一步？好的!'), ['版本 0.7.19 已装好，耗时 3.5 分钟。', '下一步？', '好的!']);
  assert.deepEqual(splitSpeechSentences('It costs 3.5 dollars. Done'), ['It costs 3.5 dollars.', 'Done']);
});
