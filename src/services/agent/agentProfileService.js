// Agent-profile orchestration — pure functional core.
//
// Complements the data-layer modules around it:
//   • src/state/agentProfiles.js      — normalizers (normalizeAgentProfile,
//                                         normalizeAgentOverride, etc.)
//   • src/services/agent/agentLibrary.js    — built-in presets + ID allocator
//   • src/services/agent/agentChannels.js   — channel schema + normalization
//   • src/services/agent/agentTools.js      — tool/skill/connector filters
//   • src/services/agent/markdownFiles.js   — identity.md / soul.md I/O
//
// This module owns the three pieces of non-trivial logic that used to live
// inline inside `updateAgentProfile` / `createCustomAgent` in desktopStore:
//
//   1. normalizeAgentUpdatePatch  — pull identity/soul alias keys together
//      (`identify`, `soul.md`, `soul` → `identity`, `soulMd`) and separate
//      raw channel draft out of the patch so we can apply the stale-draft
//      guard against freshly-loaded persisted channels inside the atomic
//      block.
//
//   2. mergeChannelsWithStaleDraftGuard — the channel-clobber guard
//      described in feedback_preserve_user_config.md. If the UI posts a
//      channel draft that is "completely empty" (no token / ids / nicknames /
//      enabled / voiceReply) AND the persisted channel has any of those,
//      the persisted channel wins. This prevents a stale UI draft from
//      silently wiping a real Telegram / Discord config.
//
//   3. buildNewCustomAgent — allocate the next custom agent id and assemble
//      a normalized default profile, ready for the caller to splat into
//      state.agentProfiles.
//
// desktopStore wrappers keep ownership of the atomic state mutation,
// markdown-file writes, and UI settings toggles. This module is pure — its
// tests don't need to boot state or touch disk.

import {
  AGENT_CHANNEL_IDS,
  normalizeAgentChannels,
} from './agentChannels.js';
import { nextCustomAgentId } from './agentLibrary.js';
import { DEFAULT_AGENT_TOOL_IDS } from './agentTools.js';
import { normalizeAgentProfile } from '../../state/agentProfiles.js';

// ────────────────────────────────────────────────────────────────────────────
// 1. Patch normalization
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse a raw patch coming from the UI / an API call into:
 *   - nextPatch            — the patch ready to merge into a profile, with
 *                            identity/soulMd consolidated to canonical keys
 *                            and `channels` removed.
 *   - incomingChannelsRaw  — the raw channels object the caller sent (or
 *                            null if they didn't touch channels). The
 *                            caller is expected to pass this through
 *                            mergeChannelsWithStaleDraftGuard inside their
 *                            atomic block, then splice the result back onto
 *                            nextPatch before the normalize pass.
 *
 * Why both? We can't run the stale-draft guard until we know the latest
 * persisted channels, which are only safe to read inside the atomic block.
 * The patch normalizer runs before the atomic block (cheap, no I/O), so we
 * hand the raw channels to the caller to handle after acquiring the lock.
 *
 * @param {object} patch       - raw patch, may be missing / malformed
 * @returns {{ nextPatch: object, incomingChannelsRaw: object | null }}
 */
export function normalizeAgentUpdatePatch(patch = {}) {
  const safePatch = patch && typeof patch === 'object' ? patch : {};
  const nextPatch = { ...safePatch };

  // identity/identify aliases — pick the first string-valued one.
  const resolvedIdentity =
    typeof safePatch.identity === 'string'
      ? safePatch.identity
      : typeof safePatch.identify === 'string'
        ? safePatch.identify
        : undefined;
  if (resolvedIdentity !== undefined) {
    nextPatch.identity = resolvedIdentity;
  } else {
    // IMPORTANT: delete both keys rather than leaving `undefined` in place.
    // A later spread-merge would interpret `undefined` as "overwrite with
    // undefined" and wipe the existing value (see
    // feedback_preserve_user_config.md).
    delete nextPatch.identity;
    delete nextPatch.identify;
  }

  const resolvedSoulMd =
    typeof safePatch.soulMd === 'string'
      ? safePatch.soulMd
      : typeof safePatch['soul.md'] === 'string'
        ? safePatch['soul.md']
        : typeof safePatch.soul === 'string'
          ? safePatch.soul
          : undefined;
  if (resolvedSoulMd !== undefined) {
    nextPatch.soulMd = resolvedSoulMd;
  } else {
    delete nextPatch.soulMd;
    delete nextPatch['soul.md'];
    delete nextPatch.soul;
  }

  // Partial forms must not erase custom-agent metadata. The Customize
  // detail panel can submit a narrow patch such as { minimaxVoiceId } while
  // older UI builds still include absent text fields as empty strings. Treat
  // blank metadata strings as "not supplied"; callers that need a true clear
  // can use a dedicated clear action later.
  for (const key of ['name', 'laneLabel', 'description', 'rolePrompt']) {
    if (
      key in nextPatch &&
      typeof nextPatch[key] === 'string' &&
      !nextPatch[key].trim()
    ) {
      delete nextPatch[key];
    }
  }

  // Extract raw channel draft; caller applies the stale-draft guard inside
  // the atomic block. Never leave `channels` on nextPatch — letting a raw
  // draft through would bypass the guard entirely.
  const incomingChannelsRaw =
    safePatch.channels && typeof safePatch.channels === 'object'
      ? safePatch.channels
      : null;
  delete nextPatch.channels;

  return { nextPatch, incomingChannelsRaw };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Stale-draft channel merge guard
// ────────────────────────────────────────────────────────────────────────────

function channelHasUserConfig(channel) {
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

/**
 * If the incoming draft claims a channel is empty (no user config) while
 * the persisted copy has real config, prefer persisted. Otherwise trust
 * incoming. See feedback_preserve_user_config.md for the incident that
 * motivated this guard.
 *
 * @param {object | null} incomingChannelsRaw   - raw channels draft from UI
 *                                                or null when patch omitted them
 * @param {object}        persistedChannelsRaw  - channels from the freshest
 *                                                state read inside the
 *                                                atomic block
 * @returns {object | null}  merged channels map, or null when incoming is null
 */
export function mergeChannelsWithStaleDraftGuard(incomingChannelsRaw, persistedChannelsRaw) {
  if (!incomingChannelsRaw) return null;
  const persisted = normalizeAgentChannels(persistedChannelsRaw || {});
  const incoming = normalizeAgentChannels(incomingChannelsRaw);
  const merged = {};
  for (const channelId of AGENT_CHANNEL_IDS) {
    const p = persisted[channelId];
    const i = incoming[channelId];
    if (!channelHasUserConfig(i) && channelHasUserConfig(p)) {
      merged[channelId] = p;
    } else {
      merged[channelId] = i;
    }
  }
  return merged;
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Default custom-agent profile builder
// ────────────────────────────────────────────────────────────────────────────

/**
 * Allocate the next custom agent id (based on existing profiles) and build
 * a normalized default profile for it. Caller splats `{ [agentId]: profile }`
 * onto `state.agentProfiles` and runs its own markdown sync + saveState.
 *
 * @param {object} existingProfiles  - current state.agentProfiles map
 * @returns {{ agentId: string, displayName: string, profile: object }}
 */
export function buildNewCustomAgent(existingProfiles = {}) {
  const agentId = nextCustomAgentId(existingProfiles);
  const idSuffix = agentId.split('-').pop();
  const displayName = `Custom agent ${idSuffix}`;
  const defaultSoul =
    'Stay adaptive, clear, and dependable. Use the configured tools and channels deliberately, and keep collaboration smooth.';
  const profile = normalizeAgentProfile(agentId, {
    isCustom: true,
    name: displayName,
    laneLabel: 'Custom lane',
    description:
      'A user-defined Melo agent lane with its own persona, tools, and channel links.',
    rolePrompt: `You are ${displayName}, a custom Melo agent lane. Stay aligned with the user's intent, act clearly, and use configured tools and channels deliberately.`,
    identity: `You are ${displayName}, a custom Melo agent inside Melo Desktop.`,
    identify: `You are ${displayName}, a custom Melo agent inside Melo Desktop.`,
    soulMd: defaultSoul,
    'soul.md': defaultSoul,
    mood: 'calm',
    tools: [...DEFAULT_AGENT_TOOL_IDS],
  });
  return { agentId, displayName, profile };
}
