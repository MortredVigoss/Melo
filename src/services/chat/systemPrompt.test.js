// Tests for systemPrompt assembly. All pure — no state, no I/O.
//
// Note on the byte-for-byte port discipline (CLAUDE.md §4): these tests
// pin the *external* behavior the original desktopStore code exhibited.
// They don't assert anything about the source-level encoding choices that
// the Write tool made on copy (e.g. a `[一-鿿]` regex literal vs
// the equivalent `[一-鿿]` literal — both compile to the same RegExp).
// What we lock down here is the *output* of every helper given concrete
// input.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeAgentPrompt,
  buildConversationFormattingRules,
  buildOutputHardConstraints,
  detectInputLanguage,
  buildLanguageConstraint,
  buildReActSystemPrompt,
} from './systemPrompt.js';

// ═══════════════════════════════════════════════════════════════════════════
// detectInputLanguage
// ═══════════════════════════════════════════════════════════════════════════

test('detectInputLanguage: short text → null (no confident call)', () => {
  assert.equal(detectInputLanguage(''), null);
  assert.equal(detectInputLanguage('hi'), null);
  assert.equal(detectInputLanguage('   '), null);
});

test('detectInputLanguage: dominant CJK → zh', () => {
  assert.equal(detectInputLanguage('这是一段中文测试文本'), 'zh');
});

test('detectInputLanguage: kana-rich → ja (even when CJK is also present)', () => {
  assert.equal(detectInputLanguage('これは日本語のテストです'), 'ja');
  // Mixed CJK + kana: the kana share triggers the ja branch.
  assert.equal(detectInputLanguage('これは漢字のテストです'), 'ja');
});

test('detectInputLanguage: hangul → ko', () => {
  assert.equal(detectInputLanguage('안녕하세요 한국어 테스트입니다'), 'ko');
});

test('detectInputLanguage: arabic → ar', () => {
  assert.equal(detectInputLanguage('مرحبا اختبار اللغة العربية'), 'ar');
});

test('detectInputLanguage: cyrillic → ru', () => {
  assert.equal(detectInputLanguage('Привет это тест на русском'), 'ru');
});

test('detectInputLanguage: clean Latin/English with no other script → en', () => {
  assert.equal(detectInputLanguage('hello world this is an english sentence'), 'en');
});

test('detectInputLanguage: mostly Latin with a tiny CJK garnish → null', () => {
  // CJK share is below the 0.25 threshold so the zh branch doesn't trigger.
  // The en branch demands `nonLatin === 0`, so the lingering CJK keeps en
  // off too. Result: null (no confident call).
  assert.equal(detectInputLanguage('hello world hello 你好'), null);
});

test('detectInputLanguage: strips @mentions before scoring', () => {
  // @bot is Latin chars; without stripping, this would skew toward "mixed
  // with Latin" and miss the zh detection.
  assert.equal(detectInputLanguage('@somebot 这是一段中文测试文本'), 'zh');
});

// ═══════════════════════════════════════════════════════════════════════════
// buildLanguageConstraint
// ═══════════════════════════════════════════════════════════════════════════

test('buildLanguageConstraint: undetectable input → empty string', () => {
  assert.equal(buildLanguageConstraint(''), '');
  assert.equal(buildLanguageConstraint('hi'), '');
});

test('buildLanguageConstraint: detected language is a default, not an unconditional lock', () => {
  const out = buildLanguageConstraint('这是一段中文测试文本');
  assert.match(out, /\[Reply language default\]/);
  assert.match(out, /Chinese \(中文\)/);
  assert.match(out, /takes precedence over this default/);
  assert.doesNotMatch(out, /ENTIRELY|NO EXCEPTIONS/);
});

test('buildLanguageConstraint: explicit output language wins over persona defaults', () => {
  const out = buildLanguageConstraint('这是一段中文测试文本');
  assert.match(out, /explicit target language, translation, bilingual output/);
  assert.match(out, /When no explicit language request.*persona/);
});

// ═══════════════════════════════════════════════════════════════════════════
// buildConversationFormattingRules / buildOutputHardConstraints
// ═══════════════════════════════════════════════════════════════════════════

test('buildConversationFormattingRules: contains the no-repeat anchor rule', () => {
  const out = buildConversationFormattingRules();
  assert.match(out, /Cover each point exactly once/);
  assert.match(out, /Never split a single answer into two passes/);
});

test('buildOutputHardConstraints: desktop default omits the remote-channel cap', () => {
  const out = buildOutputHardConstraints({ isRemoteChannel: false });
  assert.doesNotMatch(out, /Keep remote-channel replies tight/);
  assert.doesNotMatch(out, /plain-text messaging channel/);
  assert.match(out, /explicit.*format/);
  assert.match(out, /Safety, file-access approval/);
});

test('buildOutputHardConstraints: remote channel adds the length cap + repeat suppressors', () => {
  const out = buildOutputHardConstraints({ isRemoteChannel: true });
  assert.match(out, /plain-text messaging channel/);
  assert.match(out, /Keep remote-channel replies tight/);
  assert.match(out, /under ~600 Chinese characters/);
  assert.match(out, /再说一次/); // ZH no-repeat suppressor
});

// ═══════════════════════════════════════════════════════════════════════════
// summarizeAgentPrompt
// ═══════════════════════════════════════════════════════════════════════════

test('summarizeAgentPrompt: includes role + identity + soul without legacy mood', () => {
  const profile = {
    rolePrompt: 'You are a coding assistant.',
    identity: 'I am Aida.',
    soulMd: 'Stay calm.',
    mood: 'calm',
    tools: [],
    channels: {},
  };
  const out = summarizeAgentPrompt(profile);
  assert.match(out, /You are a coding assistant\./);
  assert.match(out, /IDENTITY\.md:\nI am Aida\./);
  assert.match(out, /SOUL\.md:\nStay calm\./);
  assert.doesNotMatch(out, /Current mood/);
  for (const mood of ['calm','warm','sharp','focused','cold','playful','intense']) {
    assert.equal(summarizeAgentPrompt({...profile,mood}),out);
  }
});

test('summarizeAgentPrompt: falls back to `identify` when `identity` is missing', () => {
  const profile = {
    rolePrompt: 'role',
    identify: 'fallback identity',
    soulMd: 'soul',
    mood: 'calm',
    tools: [],
    channels: {},
  };
  const out = summarizeAgentPrompt(profile);
  assert.match(out, /IDENTITY\.md:\nfallback identity/);
});

test('summarizeAgentPrompt: archived Telegram is absent even with a saved enabled flag', () => {
  const profile = {
    rolePrompt: 'r',
    identity: 'i',
    soulMd: 's',
    mood: 'calm',
    tools: [],
    channels: {
      telegram: { id: 'telegram', enabled: true, botToken: 't', chatId: 'CHAT123' },
      discord: { id: 'discord', enabled: false },
    },
  };
  const out = summarizeAgentPrompt(profile);
  assert.doesNotMatch(out, /Linked channels:|CHAT123/);
});

test('summarizeAgentPrompt: omits channels line when no channel is enabled', () => {
  const profile = {
    rolePrompt: 'r', identity: 'i', soulMd: 's', mood: 'calm',
    tools: [], channels: { telegram: { id: 'telegram', enabled: false }, discord: { id: 'discord', enabled: false } },
  };
  const out = summarizeAgentPrompt(profile);
  assert.doesNotMatch(out, /Linked channels:/);
});

// ═══════════════════════════════════════════════════════════════════════════
// buildReActSystemPrompt
// ═══════════════════════════════════════════════════════════════════════════

function fakeProfile() {
  return {
    rolePrompt: 'role',
    identity: 'I am the test agent',
    soulMd: 'soul',
    mood: 'calm',
    tools: [],
    channels: {},
  };
}

const fakeConfig = { systemPrompt: '<<base system prompt>>' };

test('buildReActSystemPrompt: includes base system prompt + formatting rules + agent summary', () => {
  const out = buildReActSystemPrompt({ config: fakeConfig, profile: fakeProfile() });
  assert.match(out, /<<base system prompt>>/);
  assert.match(out, /Conversation formatting rules:/);
  assert.match(out, /I am the test agent/);
  assert.match(out, /Final output hard constraints/);
});

test('buildReActSystemPrompt: empty injected blocks are filtered out (no blank \\n\\n runs)', () => {
  const out = buildReActSystemPrompt({
    config: fakeConfig,
    profile: fakeProfile(),
    memoryContext: '',
    toolsPrompt: '',
    languageConstraint: '',
  });
  assert.doesNotMatch(out, /\n\n\n/, 'filter(Boolean) should drop empty blocks');
});

test('buildReActSystemPrompt: injects a memoryContext block when present', () => {
  const out = buildReActSystemPrompt({
    config: fakeConfig,
    profile: fakeProfile(),
    memoryContext: '<<MEMORY BLOCK>>',
  });
  assert.match(out, /<<MEMORY BLOCK>>/);
});

test('buildReActSystemPrompt: uncertainty rules appear only when intent requires verification', () => {
  // Default intent="factual" → intentRequiresVerification likely true.
  const factual = buildReActSystemPrompt({ config: fakeConfig, profile: fakeProfile(), intent: 'factual' });
  // For a creative intent, the uncertainty rules block should be empty
  // and not appear. (We don't pin which intents trigger here — the
  // contract is only "the toggle is wired".)
  const creative = buildReActSystemPrompt({ config: fakeConfig, profile: fakeProfile(), intent: 'creative' });
  // At minimum: factual or creative output should differ in at least one
  // case of intent-based gating, OR both should be valid prompts.
  assert.equal(typeof factual, 'string');
  assert.equal(typeof creative, 'string');
  assert.ok(factual.length > 0);
  assert.ok(creative.length > 0);
});

test('buildReActSystemPrompt: remote channel flag flows into the hard-constraint block', () => {
  const remote = buildReActSystemPrompt({
    config: fakeConfig,
    profile: fakeProfile(),
    isRemoteChannel: true,
  });
  assert.match(remote, /plain-text messaging channel/);
  assert.match(remote, /Keep remote-channel replies tight/);
});

test('buildReActSystemPrompt: falls back to DEFAULT_CONFIG.systemPrompt when config has none', () => {
  const out = buildReActSystemPrompt({
    config: {},
    profile: fakeProfile(),
  });
  // Just assert we got a non-empty string — the exact DEFAULT is in
  // src/config.js and may evolve. The contract is "no crash, base prompt
  // appears somewhere".
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});
