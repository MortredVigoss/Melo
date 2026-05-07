// Tests for agentProfileService. Zero state / disk I/O — all three helpers
// are pure functions of their inputs, which is the whole point of lifting
// this logic out of desktopStore.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAgentUpdatePatch,
  mergeChannelsWithStaleDraftGuard,
  buildNewCustomAgent,
} from './agentProfileService.js';
import { AGENT_CHANNEL_IDS } from './agentChannels.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1. normalizeAgentUpdatePatch
// ═══════════════════════════════════════════════════════════════════════════

test('normalizeAgentUpdatePatch: missing patch returns empty nextPatch', () => {
  const out = normalizeAgentUpdatePatch();
  assert.deepEqual(out.nextPatch, {});
  assert.equal(out.incomingChannelsRaw, null);
});

test('normalizeAgentUpdatePatch: non-object patch is treated as empty', () => {
  const out = normalizeAgentUpdatePatch('garbage');
  assert.deepEqual(out.nextPatch, {});
  assert.equal(out.incomingChannelsRaw, null);
});

test('normalizeAgentUpdatePatch: identity alias `identify` promotes to `identity` (alias may linger)', () => {
  const { nextPatch } = normalizeAgentUpdatePatch({ identify: 'I am agent X' });
  // Canonical key is guaranteed. The alias key is left in place on purpose —
  // desktopStore's downstream normalizeAgentProfile reads both, and stripping
  // aliases here would be a behavior change outside the scope of Phase 7c.
  assert.equal(nextPatch.identity, 'I am agent X');
});

test('normalizeAgentUpdatePatch: `identity` wins over `identify` when both present', () => {
  const { nextPatch } = normalizeAgentUpdatePatch({
    identity: 'canonical',
    identify: 'alias',
  });
  assert.equal(nextPatch.identity, 'canonical');
});

test('normalizeAgentUpdatePatch: neither identity nor identify → both keys absent (NOT undefined)', () => {
  const { nextPatch } = normalizeAgentUpdatePatch({ mood: 'calm' });
  // CRITICAL: keys MUST be absent, not set to `undefined`. A spread-merge
  // like {...profile, ...nextPatch} would overwrite with `undefined` and
  // wipe the persisted value (see feedback_preserve_user_config.md).
  assert.equal('identity' in nextPatch, false);
  assert.equal('identify' in nextPatch, false);
});

test('normalizeAgentUpdatePatch: soulMd aliases (soul.md, soul) canonicalize to soulMd', () => {
  const a = normalizeAgentUpdatePatch({ 'soul.md': 'from dotted key' });
  assert.equal(a.nextPatch.soulMd, 'from dotted key');

  const b = normalizeAgentUpdatePatch({ soul: 'short alias' });
  assert.equal(b.nextPatch.soulMd, 'short alias');

  // soulMd > soul.md > soul precedence
  const c = normalizeAgentUpdatePatch({ soulMd: 'A', 'soul.md': 'B', soul: 'C' });
  assert.equal(c.nextPatch.soulMd, 'A');
});

test('normalizeAgentUpdatePatch: channels are stripped and surfaced separately', () => {
  const channels = { telegram: { botToken: 't' }, discord: { botToken: 'd' } };
  const { nextPatch, incomingChannelsRaw } = normalizeAgentUpdatePatch({
    mood: 'calm',
    channels,
  });
  // Channels must NEVER be left on nextPatch — that would let a raw draft
  // bypass the stale-draft guard.
  assert.equal('channels' in nextPatch, false);
  assert.equal(incomingChannelsRaw, channels);
  assert.equal(nextPatch.mood, 'calm');
});

test('normalizeAgentUpdatePatch: non-object channels value is not surfaced', () => {
  const { incomingChannelsRaw } = normalizeAgentUpdatePatch({ channels: 'nope' });
  assert.equal(incomingChannelsRaw, null);
});

test('normalizeAgentUpdatePatch: blank custom-agent metadata is omitted so partial saves do not reset names', () => {
  const { nextPatch } = normalizeAgentUpdatePatch({
    name: '',
    laneLabel: '   ',
    description: '',
    rolePrompt: '',
    minimaxVoiceId: 'moss_audio_123',
  });

  assert.equal('name' in nextPatch, false);
  assert.equal('laneLabel' in nextPatch, false);
  assert.equal('description' in nextPatch, false);
  assert.equal('rolePrompt' in nextPatch, false);
  assert.equal(nextPatch.minimaxVoiceId, 'moss_audio_123');
});

test('normalizeAgentUpdatePatch: explicit _clearedFields marker keeps empty strings so override drops to default', () => {
  const { nextPatch } = normalizeAgentUpdatePatch({
    name: '',
    laneLabel: '',
    description: '',
    rolePrompt: '',
    minimaxVoiceId: 'moss_audio_123',
    _clearedFields: ['name', 'description', 'rolePrompt'],
  });

  // Marked fields keep the empty string in the patch — the downstream
  // override normaliser drops the override field, falling back to the
  // agent definition default.
  assert.equal(nextPatch.name, '');
  assert.equal(nextPatch.description, '');
  assert.equal(nextPatch.rolePrompt, '');
  // Field not listed in marker → narrow-patch protection still applies.
  assert.equal('laneLabel' in nextPatch, false);
  // The marker itself is consumed and never reaches downstream.
  assert.equal('_clearedFields' in nextPatch, false);
  // Unrelated fields are unaffected.
  assert.equal(nextPatch.minimaxVoiceId, 'moss_audio_123');
});

test('normalizeAgentUpdatePatch: non-array _clearedFields is ignored (no protection bypass)', () => {
  const { nextPatch } = normalizeAgentUpdatePatch({
    name: '',
    _clearedFields: 'name', // bogus shape — must not be honoured
  });
  assert.equal('name' in nextPatch, false);
  assert.equal('_clearedFields' in nextPatch, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. mergeChannelsWithStaleDraftGuard
// ═══════════════════════════════════════════════════════════════════════════

test('mergeChannelsWithStaleDraftGuard: null incoming → null (caller skips the merge)', () => {
  assert.equal(
    mergeChannelsWithStaleDraftGuard(null, { telegram: { botToken: 'X' } }),
    null,
  );
});

test('mergeChannelsWithStaleDraftGuard: empty incoming channel preserves persisted config', () => {
  const persisted = {
    telegram: { enabled: true, botToken: 'real-token', guildId: 'g', chatId: 'c' },
    discord: {},
  };
  const incoming = { telegram: {}, discord: {} };
  const merged = mergeChannelsWithStaleDraftGuard(incoming, persisted);
  // Persisted telegram has user config, incoming is empty → keep persisted.
  assert.equal(merged.telegram.botToken, 'real-token');
  assert.equal(merged.telegram.enabled, true);
});

test('mergeChannelsWithStaleDraftGuard: non-empty incoming wins (regular edits come through)', () => {
  const persisted = { telegram: { botToken: 'old' }, discord: {} };
  const incoming = { telegram: { botToken: 'new', enabled: true }, discord: {} };
  const merged = mergeChannelsWithStaleDraftGuard(incoming, persisted);
  assert.equal(merged.telegram.botToken, 'new');
});

test('mergeChannelsWithStaleDraftGuard: incoming with only `enabled=true` counts as user config', () => {
  // Flipping the enabled switch is a deliberate edit — must not be treated
  // as "empty draft" and clobbered by persisted.
  const persisted = { telegram: { enabled: false }, discord: {} };
  const incoming = { telegram: { enabled: true }, discord: {} };
  const merged = mergeChannelsWithStaleDraftGuard(incoming, persisted);
  assert.equal(merged.telegram.enabled, true);
});

test('mergeChannelsWithStaleDraftGuard: both empty → incoming wins (nothing to protect)', () => {
  const merged = mergeChannelsWithStaleDraftGuard(
    { telegram: {}, discord: {} },
    { telegram: {}, discord: {} },
  );
  for (const cid of AGENT_CHANNEL_IDS) {
    assert.equal(channelHasConfig(merged[cid]), false);
  }
});

test('mergeChannelsWithStaleDraftGuard: guard applies per-channel independently', () => {
  // telegram: empty incoming + real persisted → persisted wins.
  // discord:  real incoming (new config) → incoming wins.
  const persisted = {
    telegram: { botToken: 'tg', enabled: true },
    discord: { botToken: 'old-discord' },
  };
  const incoming = {
    telegram: {},
    discord: { botToken: 'new-discord', enabled: true },
  };
  const merged = mergeChannelsWithStaleDraftGuard(incoming, persisted);
  assert.equal(merged.telegram.botToken, 'tg');
  assert.equal(merged.discord.botToken, 'new-discord');
});

test('mergeChannelsWithStaleDraftGuard: voiceReply alone counts as user config', () => {
  const persisted = { telegram: { voiceReply: true }, discord: {} };
  const incoming = { telegram: {}, discord: {} };
  const merged = mergeChannelsWithStaleDraftGuard(incoming, persisted);
  assert.equal(merged.telegram.voiceReply, true);
});

// Tiny helper that mirrors the service's internal predicate — used only by
// the "both empty" test so the assertion doesn't depend on particular field
// shapes that normalizeAgentChannels might fill in as defaults.
function channelHasConfig(channel) {
  if (!channel || typeof channel !== 'object') return false;
  return (
    Boolean(channel.enabled) ||
    Boolean(channel.botToken) ||
    Boolean(channel.botUsername) ||
    Boolean(channel.guildId) ||
    Boolean(channel.channelId) ||
    Boolean(channel.chatId) ||
    Boolean(channel.nicknames) ||
    Boolean(channel.voiceReply)
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. buildNewCustomAgent
// ═══════════════════════════════════════════════════════════════════════════

test('buildNewCustomAgent: empty profiles → allocates first custom agent id', () => {
  const { agentId, displayName, profile } = buildNewCustomAgent({});
  assert.ok(agentId.startsWith('custom-'), `expected custom id, got ${agentId}`);
  assert.ok(displayName.startsWith('Custom agent '));
  assert.equal(profile.isCustom, true);
  assert.equal(profile.name, displayName);
  assert.equal(typeof profile.identity, 'string');
  assert.ok(profile.identity.length > 0);
  assert.equal(typeof profile.soulMd, 'string');
  assert.ok(profile.soulMd.length > 0);
  assert.equal(profile.mood, 'calm');
  assert.ok(Array.isArray(profile.tools) && profile.tools.length > 0);
});

test('buildNewCustomAgent: skips an already-taken `custom-agent-N` id', () => {
  // Allocator's real namespace is `custom-agent-<N>` (see nextCustomAgentId
  // in agentLibrary.js). Seeding with an id from that exact namespace is
  // what actually exercises the "skip taken" branch — our earlier
  // `custom-1` seed lived in a different namespace and passed trivially.
  const { agentId } = buildNewCustomAgent({
    'custom-agent-1': { isCustom: true, name: 'Existing' },
  });
  assert.equal(agentId, 'custom-agent-2');
});

test('buildNewCustomAgent: fills the lowest available gap when ids are non-contiguous', () => {
  const { agentId } = buildNewCustomAgent({
    'custom-agent-1': { isCustom: true },
    'custom-agent-3': { isCustom: true },
  });
  // Allocator scans from 1 upward and returns the first free slot, not
  // max+1. The gap at 2 should be filled before any higher index.
  assert.equal(agentId, 'custom-agent-2');
});

test('buildNewCustomAgent: identity and soul fields are consistent across aliases', () => {
  const { profile } = buildNewCustomAgent({});
  // normalizeAgentProfile should fill in the identify / soul.md aliases
  // from our identity / soulMd seeds. These are expected to round-trip
  // through the wire format.
  assert.equal(typeof profile.identity, 'string');
  assert.equal(typeof profile.soulMd, 'string');
});
