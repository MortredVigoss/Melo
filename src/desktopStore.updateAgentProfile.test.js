/**
 * Regression tests for updateAgentProfile — minimal patches must not wipe
 * channel credentials, guild/channel IDs, voiceReply flags, or identity /
 * soul markdown content.
 *
 * Historical bug: updateAgentProfile built nextPatch with identity/soulMd/
 * channels explicitly set to `undefined` when the caller didn't supply them.
 * The later `{...currentProfile, ...nextPatch}` spread then overwrote the
 * existing values, silently wiping user-configured bot tokens, guild IDs,
 * and channel IDs any time the user changed a single unrelated field
 * (e.g. minimaxVoiceId). The fix: only include those keys on nextPatch when
 * the patch actually provides a value.
 *
 * MELO_HOME is set to a temp directory BEFORE importing desktopStore so the
 * real user state on disk is not touched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'melo-agentprofile-test-'));
process.env.MELO_HOME = TEMP_HOME;

const store = await import('./desktopStore.js');
// Architecture plan P1: the mutation returns a commit receipt. These checks
// read the desktop query projection, so build the bootstrap after each save
// exactly as the HTTP route does.
const updateAgentProfile = async (...args) => { await store.updateAgentProfile(...args); return store.getDesktopBootstrap(); };

function channelByIdFromBootstrap(bootstrap, agentId, channelId) {
  const agent = (bootstrap?.customize?.agents || []).find(a => a.id === agentId);
  return agent?.channels?.find(c => c.id === channelId) || null;
}

function agentFromBootstrap(bootstrap, agentId) {
  return (bootstrap?.customize?.agents || []).find(a => a.id === agentId) || null;
}

test('updateAgentProfile: minimal patch does not wipe channel credentials', async () => {
  // Seed: configure Discord + Telegram credentials on the built-in main agent.
  const seeded = await updateAgentProfile(
    'main',
    {
      channels: {
        telegram: {
          enabled: true,
          botToken: 'tg-token-AAAA',
          botUsername: 'TestBot',
          voiceReply: true,
          lastRemoteChatId: '123',
        },
        discord: {
          enabled: true,
          botToken: 'dc-token-BBBB',
          botUsername: 'Karina',
          guildId: 'guild-9999',
          channelId: 'channel-7777',
          voiceReply: false,
        },
      },
    },
    { scope: 'global', activeView: 'agent' },
  );

  const tgSeed = channelByIdFromBootstrap(seeded, 'main', 'telegram');
  const dcSeed = channelByIdFromBootstrap(seeded, 'main', 'discord');
  assert.equal(tgSeed?.botToken, 'tg-token-AAAA', 'seed sanity: telegram token present');
  assert.equal(dcSeed?.botToken, 'dc-token-BBBB', 'seed sanity: discord token present');
  assert.equal(dcSeed?.guildId, 'guild-9999', 'seed sanity: discord guildId present');
  assert.equal(dcSeed?.channelId, 'channel-7777', 'seed sanity: discord channelId present');
  assert.equal(tgSeed?.voiceReply, true, 'seed sanity: telegram voiceReply=true');

  // Now send a MINIMAL patch that only changes minimaxVoiceId. This is the
  // exact scenario that silently wiped Discord channel credentials before
  // the fix. Telegram + Discord credentials must both still be present.
  const afterPatch = await updateAgentProfile(
    'main',
    { minimaxVoiceId: 'moss_audio_test_12345' },
    { scope: 'global', activeView: 'agent' },
  );

  const agent = agentFromBootstrap(afterPatch, 'main');
  const tgAfter = channelByIdFromBootstrap(afterPatch, 'main', 'telegram');
  const dcAfter = channelByIdFromBootstrap(afterPatch, 'main', 'discord');

  assert.equal(agent?.minimaxVoiceId, 'moss_audio_test_12345', 'voice id updated');

  // Critical assertions — these all FAILED before the fix because
  // `channels: undefined` on nextPatch clobbered the existing channels.
  assert.equal(tgAfter?.enabled, true, 'telegram.enabled preserved');
  assert.equal(tgAfter?.botToken, 'tg-token-AAAA', 'telegram.botToken preserved');
  assert.equal(tgAfter?.voiceReply, true, 'telegram.voiceReply preserved');
  assert.equal(tgAfter?.lastRemoteChatId, '123', 'telegram.lastRemoteChatId preserved');

  assert.equal(dcAfter?.enabled, true, 'discord.enabled preserved');
  assert.equal(dcAfter?.botToken, 'dc-token-BBBB', 'discord.botToken preserved');
  assert.equal(dcAfter?.guildId, 'guild-9999', 'discord.guildId preserved');
  assert.equal(dcAfter?.channelId, 'channel-7777', 'discord.channelId preserved');
  assert.equal(dcAfter?.voiceReply, false, 'discord.voiceReply preserved');
});

test('updateAgentProfile: minimal patch does not wipe identity / soul markdown', async () => {
  // Seed identity + soul.
  const seeded = await updateAgentProfile(
    'main',
    {
      identity: 'Test identity line 1\nTest identity line 2',
      soulMd: 'Test soul line 1\nTest soul line 2',
    },
    { scope: 'global', activeView: 'agent' },
  );
  const seedAgent = agentFromBootstrap(seeded, 'main');
  assert.match(seedAgent?.identity || '', /Test identity line 1/);
  assert.match(seedAgent?.soulMd || seedAgent?.soul || '', /Test soul line 1/);

  // Minimal patch — no identity / soul fields supplied.
  const after = await updateAgentProfile(
    'main',
    { mood: 'calm' },
    { scope: 'global', activeView: 'agent' },
  );
  const agent = agentFromBootstrap(after, 'main');

  assert.match(
    agent?.identity || '',
    /Test identity line 1/,
    'identity preserved through unrelated patch',
  );
  assert.match(
    agent?.soulMd || agent?.soul || '',
    /Test soul line 1/,
    'soul preserved through unrelated patch',
  );
});

test('updateAgentProfile: voice-id save with blank legacy metadata does not reset custom agent name or role prompt', async () => {
  await updateAgentProfile(
    'custom-agent-1',
    {
      name: '金冬天',
      rolePrompt: 'You are 金冬天, a custom private-chat agent.',
      minimaxVoiceId: 'moss_audio_old',
    },
    { scope: 'global', activeView: 'customize' },
  );

  const after = await updateAgentProfile(
    'custom-agent-1',
    {
      name: '',
      description: '',
      rolePrompt: '',
      minimaxVoiceId: 'moss_audio_new',
    },
    { scope: 'global', activeView: 'customize' },
  );
  const agent = agentFromBootstrap(after, 'custom-agent-1');

  assert.equal(agent?.name, '金冬天');
  assert.equal(agent?.rolePrompt, 'You are 金冬天, a custom private-chat agent.');
  assert.equal(agent?.minimaxVoiceId, 'moss_audio_new');
});

test('updateAgentProfile: explicit _clearedFields marker drops description so agent falls back to definition default', async () => {
  // Seed a custom agent with a description set.
  await updateAgentProfile(
    'custom-agent-clear',
    {
      name: '清空测试',
      description: 'Old description that user wants to remove.',
      rolePrompt: 'Some role prompt',
    },
    { scope: 'global', activeView: 'customize' },
  );

  // Full-form submission where the user actively cleared `description`.
  // The UI passes `_clearedFields: ['description']` so the empty string
  // is honoured: override drops `description`, agent definition default
  // re-emerges.
  const after = await updateAgentProfile(
    'custom-agent-clear',
    {
      name: '清空测试',
      description: '',
      rolePrompt: 'Some role prompt',
      _clearedFields: ['description'],
    },
    { scope: 'global', activeView: 'customize' },
  );
  const agent = agentFromBootstrap(after, 'custom-agent-clear');

  // name preserved, role prompt preserved, description fell back to the
  // custom-agent definition default — the boilerplate string defined in
  // agentLibrary.js / agentProfileService.js. Asserting the exact text
  // (not just "different from seed") prevents future regressions where
  // a stale fallback string would still satisfy a notEqual check.
  assert.equal(agent?.name, '清空测试');
  assert.equal(agent?.rolePrompt, 'Some role prompt');
  assert.equal(
    agent?.description,
    'A user-defined Melo agent lane with its own persona, tools, and channel links.',
    'description should re-emerge as the custom-agent definition default once explicitly cleared',
  );
});

test('updateAgentProfile: MiniMax voice tuning parameters are saved with the agent profile', async () => {
  const after = await updateAgentProfile(
    'custom-agent-tts',
    {
      name: 'TTS Agent',
      minimaxVoiceId: 'moss_audio_tuned',
      ttsSpeed: 1.35,
      ttsPitch: -4,
      ttsVol: 0.75,
    },
    { scope: 'global', activeView: 'customize' },
  );
  const agent = agentFromBootstrap(after, 'custom-agent-tts');

  assert.equal(agent?.minimaxVoiceId, 'moss_audio_tuned');
  assert.equal(agent?.ttsSpeed, 1.35);
  assert.equal(agent?.ttsPitch, -4);
  assert.equal(agent?.ttsVol, 0.75);
});

test('updateAgentProfile: MiniMax voice tuning parameters are clamped to supported bounds', async () => {
  const after = await updateAgentProfile(
    'custom-agent-tts-clamp',
    {
      name: 'TTS Clamp Agent',
      ttsSpeed: 9,
      ttsPitch: -99,
      ttsVol: 0,
    },
    { scope: 'global', activeView: 'customize' },
  );
  const agent = agentFromBootstrap(after, 'custom-agent-tts-clamp');

  assert.equal(agent?.ttsSpeed, 2);
  assert.equal(agent?.ttsPitch, -12);
  assert.equal(agent?.ttsVol, 0.1);
});

test('updateAgentProfile: explicit channels in patch still replace channel config', async () => {
  // Seed.
  await updateAgentProfile(
    'main',
    {
      channels: {
        discord: {
          enabled: true,
          botToken: 'initial-token',
          guildId: 'initial-guild',
          channelId: 'initial-channel',
        },
      },
    },
    { scope: 'global', activeView: 'agent' },
  );

  // Replace discord channel with fresh values. telegram is not supplied,
  // so it stays at its current value.
  const after = await updateAgentProfile(
    'main',
    {
      channels: {
        discord: {
          enabled: true,
          botToken: 'rotated-token',
          guildId: 'rotated-guild',
          channelId: 'rotated-channel',
        },
      },
    },
    { scope: 'global', activeView: 'agent' },
  );

  const dc = channelByIdFromBootstrap(after, 'main', 'discord');
  assert.equal(dc?.botToken, 'rotated-token', 'new token written');
  assert.equal(dc?.guildId, 'rotated-guild', 'new guildId written');
  assert.equal(dc?.channelId, 'rotated-channel', 'new channelId written');
});

test.after(() => {
  try {
    rmSync(TEMP_HOME, { recursive: true, force: true });
  } catch {}
});
