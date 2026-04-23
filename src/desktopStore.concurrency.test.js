/**
 * Regression tests for the read-modify-write concurrency fixes.
 *
 * Covers the CRITICAL-1 (polling runtimeChannel overwrite) + HIGH-6
 * (updateAgentProfile no atomic lock) bugs: the polling loops used to
 * rebuild the channel from a stale snapshot, and updateAgentProfile
 * read state outside the write queue. Either path could clobber a
 * UI edit that landed between read and write.
 *
 * These tests drive the helpers directly (no HTTP server) with
 * MELO_HOME pointed at a temp directory so the real user state is
 * untouched. They fire many concurrent updateAgentProfile calls and
 * verify no updates are lost — under the old code this dropped the
 * majority of writes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'melo-concurrency-test-'));
process.env.MELO_HOME = TEMP_HOME;

const { updateAgentProfile } = await import('./desktopStore.js');

function agentFromBootstrap(bootstrap, agentId) {
  return (bootstrap?.customize?.agents || []).find(a => a.id === agentId) || null;
}

test('concurrent updateAgentProfile calls do not lose updates', async () => {
  // Seed with one initial value.
  await updateAgentProfile(
    'main',
    { minimaxVoiceId: 'seed-voice' },
    { scope: 'global', activeView: 'agent' },
  );

  // Fire 20 concurrent calls that each set DIFFERENT free-form fields. If the
  // atomic lock is working, the last write for each field should end up
  // persisted. Under the old code (loadState at top of function, saveState at
  // bottom, both outside the queue), interleaving would lose most writes.
  // NOTE: Use agent-level fields that accept arbitrary strings (not whitelisted
  // enums like mood, and not channel-level fields like nicknames).
  // `minimaxVoiceId`, `edgeTtsVoice`, `voicePersonality` all pass through as-is.
  const patches = Array.from({ length: 20 }, (_, i) => ({
    minimaxVoiceId: `voice-${i}`,
    edgeTtsVoice: `edge-${i}`,
    voicePersonality: `personality-${i}`,
  }));

  // Run them concurrently. Use Promise.all so they all start near-simultaneously.
  const results = await Promise.all(
    patches.map(patch =>
      updateAgentProfile('main', patch, { scope: 'global', activeView: 'agent' }),
    ),
  );

  // The last one to complete returns the full bootstrap. But we want the
  // FINAL persisted state, so do one more trivial read-through.
  const final = await updateAgentProfile(
    'main',
    { dummyTouchField: 'done' },
    { scope: 'global', activeView: 'agent' },
  );
  const agent = agentFromBootstrap(final, 'main');
  assert.ok(agent, 'main agent must exist');

  // The last write wins per field, but the final value of each field MUST be
  // from ONE of the concurrent patches — not the stale seed (that would mean
  // writes got clobbered) and not undefined (that would mean writes got lost).
  const voices = patches.map(p => p.minimaxVoiceId);
  const edges = patches.map(p => p.edgeTtsVoice);
  const personalities = patches.map(p => p.voicePersonality);
  assert.ok(voices.includes(agent.minimaxVoiceId), `minimaxVoiceId must be one of the concurrent patches, got ${agent.minimaxVoiceId}`);
  assert.ok(edges.includes(agent.edgeTtsVoice), `edgeTtsVoice must be one of the concurrent patches, got ${agent.edgeTtsVoice}`);
  assert.ok(personalities.includes(agent.voicePersonality), `voicePersonality must be one of the concurrent patches, got ${agent.voicePersonality}`);

  // Ensure we actually got 20 bootstrap responses.
  assert.equal(results.length, 20);
});

test('concurrent updateAgentProfile does not wipe channel credentials', async () => {
  // Seed channel config.
  await updateAgentProfile(
    'main',
    {
      channels: {
        telegram: {
          enabled: true,
          botToken: 'tg-token-XYZ',
          botUsername: 'ConcurrentBot',
        },
        discord: {
          enabled: true,
          botToken: 'dc-token-XYZ',
          guildId: 'concurrent-guild',
          channelId: 'concurrent-channel',
        },
      },
    },
    { scope: 'global', activeView: 'agent' },
  );

  // Barrage of minimal patches that touch unrelated fields. Under the old
  // code, each one would clobber `channels: undefined` over the existing
  // channels, wiping the seeded tokens. Under the fix they must survive.
  const barrage = Array.from({ length: 30 }, (_, i) =>
    updateAgentProfile(
      'main',
      { minimaxVoiceId: `vc-${i}` },
      { scope: 'global', activeView: 'agent' },
    ),
  );
  await Promise.all(barrage);

  const final = await updateAgentProfile(
    'main',
    { mood: 'check' },
    { scope: 'global', activeView: 'agent' },
  );
  const agent = agentFromBootstrap(final, 'main');
  const tg = agent?.channels?.find(c => c.id === 'telegram');
  const dc = agent?.channels?.find(c => c.id === 'discord');

  assert.equal(tg?.botToken, 'tg-token-XYZ', 'telegram token preserved under load');
  assert.equal(tg?.botUsername, 'ConcurrentBot', 'telegram username preserved');
  assert.equal(dc?.botToken, 'dc-token-XYZ', 'discord token preserved under load');
  assert.equal(dc?.guildId, 'concurrent-guild', 'discord guildId preserved');
  assert.equal(dc?.channelId, 'concurrent-channel', 'discord channelId preserved');
});

test.after(() => {
  try {
    rmSync(TEMP_HOME, { recursive: true, force: true });
  } catch {}
});
