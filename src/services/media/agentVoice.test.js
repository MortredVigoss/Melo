// Per-Agent voice on the desktop (2026-10-22): the card's mode, voice and style
// decide what is read aloud and with which voice; an unknown Agent keeps the
// old desktop behaviour (the full reply).
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentVoiceProfile, agentVoiceMode, agentTtsConfig, voiceTextForAgent } from './agentVoice.js';

const state = { agentProfiles: {
  main: { id: 'main', name: 'Main' },
  trump: { id: 'trump', name: '懂王', voiceReplyMode: 'summary', voicePersonality: 'Speak like Trump.', edgeTtsVoice: 'en-US-GuyNeural', minimaxVoiceId: 'moss_audio_x', ttsSpeed: 1.2 },
  quiet: { id: 'quiet', name: 'Quiet', voiceReplyMode: 'off' },
  full: { id: 'full', name: 'Full', voiceReplyMode: 'full' },
} };

test('the mode comes from the profile; a known Agent defaults to summary, no Agent to full', () => {
  assert.equal(agentVoiceMode(agentVoiceProfile(state, 'main')), 'summary');
  assert.equal(agentVoiceMode(agentVoiceProfile(state, 'trump')), 'summary');
  assert.equal(agentVoiceMode(agentVoiceProfile(state, 'quiet')), 'off');
  assert.equal(agentVoiceMode(agentVoiceProfile(state, 'full')), 'full');
  assert.equal(agentVoiceProfile(state, 'nobody'), null);
  assert.equal(agentVoiceMode(null), 'full');
  assert.equal(agentVoiceProfile(state, '__proto__'), null, 'only real profiles');
});

test("the Agent's own voice ids and MiniMax tuning override the global TTS settings", () => {
  const config = { ttsEdgeVoice: 'zh-CN-XiaoxiaoNeural', minimaxVoiceId: 'global', ttsSpeed: 1, ttsPitch: 0, ttsVol: 1 };
  const trump = agentTtsConfig(config, agentVoiceProfile(state, 'trump'));
  assert.equal(trump.ttsEdgeVoice, 'en-US-GuyNeural');
  assert.equal(trump.minimaxVoiceId, 'moss_audio_x');
  assert.equal(trump.ttsSpeed, 1.2);
  assert.equal(trump.ttsPitch, 0, 'untouched tuning keeps the global value');
  assert.deepEqual(agentTtsConfig(config, agentVoiceProfile(state, 'main')), config, 'no voice set, nothing changes');
  assert.equal(agentTtsConfig(config, null), config);
});

test('summary mode rewrites, full and off pass the text through, and a failed rewrite falls back to the text', async () => {
  const text = '第一句是结论。第二句解释原因。第三句补充细节，内容足够长以触发摘要。';
  const calls = [];
  const rewrite = async (input, config, personality) => { calls.push({ input, personality }); return '口述版本'; };
  assert.deepEqual(await voiceTextForAgent({ text, profile: agentVoiceProfile(state, 'trump'), config: {}, rewrite }), { mode: 'summary', text: '口述版本' });
  assert.deepEqual(calls, [{ input: text, personality: 'Speak like Trump.' }]);
  assert.deepEqual(await voiceTextForAgent({ text, profile: agentVoiceProfile(state, 'full'), config: {}, rewrite }), { mode: 'full', text });
  assert.deepEqual(await voiceTextForAgent({ text, profile: agentVoiceProfile(state, 'quiet'), config: {}, rewrite }), { mode: 'off', text });
  assert.equal(calls.length, 1, 'only summary mode calls the rewrite');
  const failing = async () => { throw new Error('model down'); };
  assert.deepEqual(await voiceTextForAgent({ text, profile: agentVoiceProfile(state, 'main'), config: {}, rewrite: failing }), { mode: 'summary', text });
  assert.deepEqual(await voiceTextForAgent({ text, profile: agentVoiceProfile(state, 'main'), config: {}, rewrite: async () => '   ' }), { mode: 'summary', text }, 'an empty rewrite is not spoken as silence');
});

test('without voice style instructions the summary is the rule-based extract and never calls a model', async () => {
  const text = '首先，我查了三个来源。然后我比较了它们的说法。最终结论：墨尔本明天晴，最高 30 度，带件薄外套就够了。附带说明：数据来自气象局。';
  const { mode, text: spoken } = await voiceTextForAgent({ text, profile: agentVoiceProfile(state, 'main'), config: { authMode: 'unset', apiKey: '', baseUrl: '' } });
  assert.equal(mode, 'summary');
  assert.match(spoken, /墨尔本明天晴/);
  assert.doesNotMatch(spoken, /^\s*$/);
});
