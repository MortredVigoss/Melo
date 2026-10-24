import { normalizeLocale } from '../../shared/agent/locale.js';
import { normalizeCapabilities, normalizeCollaboration, intersectCapabilities, intersectCollaboration } from '../domain/agent/capabilities.js';
import { composeAgentInstructions, agentInstructionFields, mergeAgentInstructions } from '../domain/agent/agentDocument.js';
// ─── Agent profile state normalizers ─────────────────────────────────────────
// Pure normalization layer for the persisted agent state slice. Given whatever
// the JSON blob looks like on disk (possibly stale, possibly missing fields,
// possibly using old alias names like `identify` / `soul.md`), these helpers
// produce a canonical in-memory shape that the rest of Melo can rely on.
//
// This module owns:
//   - readAgentIdentityValue(profile, fallback) — pull identity text out of
//     a profile honoring the `identity` / `identify` alias pair.
//   - readAgentSoulValue(profile, fallback) — pull soul/persona markdown out
//     of a profile honoring `soulMd` / `soul.md` / `soul` aliases.
//   - withLegacyAgentAliases(base, { identity, soulMd }) — decorate a
//     normalized profile with the redundant alias fields (identify / soul.md
//     / soul) so older consumers still see their expected keys.
//   - normalizeAgentProfile(agentId, profile) — full shape coercion for one
//     agent profile: identity, soul, tools, model, systemPrompt, channels,
//     per-agent whitelists, TTS overrides, mood.
//   - normalizeAgentProfiles(agentProfiles) — map over every known agent id
//     (built-ins + persisted customs) and return a canonical profile map.
//   - normalizeAgentOverride(agentId, profile) — project-scoped override
//     shape: only includes fields that were actually set, so a sparse
//     override doesn't inadvertently clobber globals.
//   - normalizeProjectAgentOverrides(projectAgentOverrides, agentProfiles) —
//     map-of-maps version keyed by projectId.
//   - dedupeAgentChannelTokenOwners(agentProfiles, targetAgentId, channelId,
//     token) — when a user assigns a bot token to agent A, revoke the same
//     token from any other agent that previously held it (prevents two
//     agents polling the same bot).
//
// Extracted from desktopStore.js in Phase 10a refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — all heavy lifting is
// delegated to service modules under `src/services/agent/`.

import {
  agentDefinitionFor,
  allAgentIdsFromProfiles,
  MOOD_OPTION_IDS,
} from '../domain/agent/agentLibrary.js';
import {
  normalizeAgentTools,
  normalizeIdWhitelist,
  normalizeMcpServerWhitelist,
} from '../domain/agent/agentTools.js';
import { normalizeAgentChannels } from '../domain/agent/agentChannels.js';

function normalizeOptionalNumber(value, { min = -Infinity, max = Infinity } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(min, Math.min(max, numeric));
}

export function readAgentIdentityValue(profile, fallback = '') {
  return typeof profile?.identity === 'string' && profile.identity.trim()
    ? profile.identity.trim()
    : typeof profile?.identify === 'string' && profile.identify.trim()
      ? profile.identify.trim()
      : String(fallback || '').trim();
}

export function readAgentSoulValue(profile, fallback = '') {
  return typeof profile?.soulMd === 'string' && profile.soulMd.trim()
    ? profile.soulMd.trim()
    : typeof profile?.['soul.md'] === 'string' && profile['soul.md'].trim()
      ? profile['soul.md'].trim()
      : typeof profile?.soul === 'string' && profile.soul.trim()
        ? profile.soul.trim()
        : String(fallback || '').trim();
}

export function withLegacyAgentAliases(base, { identity = '', soulMd = '' } = {}) {
  return {
    ...base,
    identity,
    identify: identity,
    soulMd,
    'soul.md': soulMd,
    soul: soulMd,
  };
}

// Per-agent voice reply mode whitelist. 'summary' is the default — the voice
// rewrite service summarizes before TTS. 'full' speaks the entire reply.
// 'off' disables voice output entirely for the agent.
const VOICE_REPLY_MODES = new Set(['summary', 'full', 'off']);

export function normalizeAgentProfile(agentId, profile) {
  const definition = agentDefinitionFor(agentId, profile);
  const legacyIdentity = profile?.portableIdentity && typeof profile.identity === 'string' ? profile.identity : readAgentIdentityValue(profile, definition.defaultIdentity);
  const legacySoulMd = profile?.portableIdentity && typeof profile.soulMd === 'string' ? profile.soulMd : readAgentSoulValue(profile, definition.defaultSoul);
  const tools = normalizeAgentTools(profile?.tools);
  const model =
    typeof profile?.model === 'string' && profile.model.trim()
      ? profile.model.trim()
      : '';
  const systemPrompt =
    typeof profile?.systemPrompt === 'string' && profile.systemPrompt.trim()
      ? profile.systemPrompt.trim()
      : '';
  const instructions = typeof profile?.instructions === 'string' ? profile.instructions : composeAgentInstructions({
    rolePrompt: typeof profile?.rolePrompt === 'string' ? profile.rolePrompt : definition.rolePrompt,
    identity: legacyIdentity, soulMd: legacySoulMd, systemPrompt,
  });
  const persona = agentInstructionFields(instructions);
  const { identity, soulMd } = persona;
  const channels = normalizeAgentChannels(profile?.channels);
  const enabledSkillIds = normalizeIdWhitelist(profile?.enabledSkillIds);
  const enabledConnectorIds = normalizeIdWhitelist(profile?.enabledConnectorIds);
  // Stdio MCP servers default to **deny all**.  See
  // `normalizeMcpServerWhitelist` for the rationale: stdio MCPs run
  // arbitrary local processes, so an agent has to opt-in to each server.
  const enabledMcpServerIds = normalizeMcpServerWhitelist(profile?.enabledMcpServerIds);
  // Per-agent TTS voice override (MiniMax voice ID)
  const minimaxVoiceId =
    typeof profile?.minimaxVoiceId === 'string' && profile.minimaxVoiceId.trim()
      ? profile.minimaxVoiceId.trim()
      : '';
  // Per-agent voice reply mode: 'summary' (default) | 'full' | 'off'
  const voiceReplyMode =
    typeof profile?.voiceReplyMode === 'string' && VOICE_REPLY_MODES.has(profile.voiceReplyMode)
      ? profile.voiceReplyMode
      : 'summary';
  // Per-agent voice personality instructions (injected into voice rewrite prompt)
  const voicePersonality =
    typeof profile?.voicePersonality === 'string' ? profile.voicePersonality.trim() : '';
  // Per-agent Edge TTS voice override (e.g. 'ko-KR-SunHiNeural' for Korean)
  const edgeTtsVoice =
    typeof profile?.edgeTtsVoice === 'string' ? profile.edgeTtsVoice.trim() : '';
  // Per-agent MiniMax TTS speed / pitch / volume
  const ttsSpeed = normalizeOptionalNumber(profile?.ttsSpeed, { min: 0.5, max: 2.0 });
  const ttsPitch = normalizeOptionalNumber(profile?.ttsPitch, { min: -12, max: 12 });
  const ttsVol   = normalizeOptionalNumber(profile?.ttsVol,   { min: 0.1, max: 10.0 });
  return withLegacyAgentAliases(
    {
      id: definition.id,
      name: typeof profile?.name === 'string' && (profile.portableIdentity || profile.name.trim()) ? profile.name : definition.name,
      portableIdentity: profile?.portableIdentity === true,
      symbol: typeof profile?.symbol === 'string' ? profile.symbol : 'person.crop.square',
      avatarData: typeof profile?.avatarData === 'string' && profile.avatarData.length < 500000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(profile.avatarData) ? profile.avatarData : '',
      laneLabel: definition.laneLabel,
      description: typeof profile?.description === 'string' && (profile.portableIdentity || profile.description.trim()) ? profile.description : definition.description,
      instructions,
      replyLanguage: normalizeLocale(profile?.replyLanguage, ''),
      rolePrompt: persona.rolePrompt,
      isCustom: Boolean(definition.isCustom),
      mood: MOOD_OPTION_IDS.has(profile?.mood) ? profile.mood : definition.defaultMood,
      tools,
      capabilities: normalizeCapabilities(profile?.capabilities),
      collaboration: normalizeCollaboration(profile?.collaboration),
      contextSources: profile?.contextSources && typeof profile.contextSources === 'object' ? {projects:profile.contextSources.projects!==false,knowledge:profile.contextSources.knowledge!==false,memory:profile.contextSources.memory!==false} : {projects:true,knowledge:true,memory:true},
      model,
      systemPrompt: persona.systemPrompt,
      channels,
      enabledSkillIds,
      enabledConnectorIds,
      enabledMcpServerIds,
      minimaxVoiceId,
      voiceReplyMode,
      voicePersonality,
      edgeTtsVoice,
      ttsSpeed,
      ttsPitch,
      ttsVol,
    },
    {
      identity,
      soulMd,
    },
  );
}

export function normalizeAgentProfiles(agentProfiles) {
  return Object.fromEntries(
    allAgentIdsFromProfiles(agentProfiles).map(agentId => [
      agentId,
      normalizeAgentProfile(agentId, agentProfiles?.[agentId]),
    ]),
  );
}

export function normalizeAgentOverride(agentId, profile) {
  if (!profile || typeof profile !== 'object') {
    return null;
  }

  const normalized = {};
  if (typeof profile.replyLanguage === 'string') normalized.replyLanguage = normalizeLocale(profile.replyLanguage, '');
  if (profile.capabilities !== undefined) normalized.capabilities = normalizeCapabilities(profile.capabilities);
  if (profile.collaboration !== undefined) normalized.collaboration = normalizeCollaboration(profile.collaboration);
  if (profile.contextSources !== undefined) normalized.contextSources = {projects:profile.contextSources.projects!==false,knowledge:profile.contextSources.knowledge!==false,memory:profile.contextSources.memory!==false};
  if (typeof profile.instructions === 'string') normalized.instructions = profile.instructions;
  const identity = readAgentIdentityValue(profile);
  const soulMd = readAgentSoulValue(profile);

  if (identity) {
    normalized.identity = identity;
    normalized.identify = identity;
  }
  if (soulMd) {
    normalized.soulMd = soulMd;
    normalized['soul.md'] = soulMd;
    normalized.soul = soulMd;
  }
  if (MOOD_OPTION_IDS.has(profile.mood)) {
    normalized.mood = profile.mood;
  }
  for (const key of ['name', 'laneLabel', 'description', 'rolePrompt', 'symbol']) {
    if (typeof profile?.[key] === 'string' && profile[key].trim()) {
      normalized[key] = profile[key].trim();
    }
  }
  if (profile.tools !== undefined) {
    normalized.tools = normalizeAgentTools(profile.tools);
  }
  if (typeof profile.avatarData === 'string') normalized.avatarData = profile.avatarData;
  if (profile.portableIdentity) { normalized.portableIdentity = true; normalized.identity = profile.identity || ''; normalized.soulMd = profile.soulMd || ''; }
  if (typeof profile.model === 'string') {
    normalized.model = profile.model.trim();
  }
  if (typeof profile.systemPrompt === 'string') {
    normalized.systemPrompt = profile.systemPrompt.trim();
  }
  if (profile.channels && typeof profile.channels === 'object') {
    normalized.channels = normalizeAgentChannels(profile.channels);
  }
  if (profile.enabledSkillIds !== undefined) {
    normalized.enabledSkillIds = normalizeIdWhitelist(profile.enabledSkillIds);
  }
  if (profile.enabledConnectorIds !== undefined) {
    normalized.enabledConnectorIds = normalizeIdWhitelist(profile.enabledConnectorIds);
  }
  if (profile.enabledMcpServerIds !== undefined) {
    normalized.enabledMcpServerIds = normalizeMcpServerWhitelist(profile.enabledMcpServerIds);
  }
  for (const key of ['minimaxVoiceId','voicePersonality','edgeTtsVoice']) {
    if (typeof profile[key] === 'string') normalized[key] = profile[key].trim();
  }
  if (VOICE_REPLY_MODES.has(profile.voiceReplyMode)) normalized.voiceReplyMode = profile.voiceReplyMode;
  const ttsSpeed = normalizeOptionalNumber(profile?.ttsSpeed, { min: 0.5, max: 2.0 });
  const ttsPitch = normalizeOptionalNumber(profile?.ttsPitch, { min: -12, max: 12 });
  const ttsVol = normalizeOptionalNumber(profile?.ttsVol, { min: 0.1, max: 10.0 });
  if (ttsSpeed !== null) {
    normalized.ttsSpeed = ttsSpeed;
  }
  if (ttsPitch !== null) {
    normalized.ttsPitch = ttsPitch;
  }
  if (ttsVol !== null) {
    normalized.ttsVol = ttsVol;
  }

  return Object.keys(normalized).length ? normalized : null;
}

export function normalizeProjectAgentOverrides(projectAgentOverrides, agentProfiles = {}) {
  if (!projectAgentOverrides || typeof projectAgentOverrides !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(projectAgentOverrides)
      .map(([projectId, overrides]) => {
        if (!projectId || !overrides || typeof overrides !== 'object') {
          return null;
        }

        const normalizedOverrides = Object.fromEntries(
          [...new Set([...allAgentIdsFromProfiles(agentProfiles), ...Object.keys(overrides || {})])].map(agentId => {
            const normalized = normalizeAgentOverride(agentId, overrides?.[agentId]);
            return normalized ? [agentId, normalized] : null;
          }).filter(Boolean),
        );

        return Object.keys(normalizedOverrides).length ? [projectId, normalizedOverrides] : null;
      })
      .filter(Boolean),
  );
}

// When a user assigns a channel bot token to an agent, revoke the same token
// from every other agent that was holding it — otherwise two agents would
// poll the same bot (Telegram/Discord only allow one holder per token).
// The revoked side is marked `enabled:false` with status reset so the UI can
// show the switchover clearly.
export function dedupeAgentChannelTokenOwners(agentProfiles, targetAgentId, channelId, token) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) {
    return agentProfiles;
  }

  const nextProfiles = { ...agentProfiles };
  for (const agentId of allAgentIdsFromProfiles(agentProfiles)) {
    if (agentId === targetAgentId) {
      continue;
    }

    const profile = normalizeAgentProfile(agentId, agentProfiles?.[agentId]);
    const channel = normalizeAgentChannels(profile.channels)?.[channelId];
    if (!channel || String(channel.botToken || '').trim() !== normalizedToken) {
      continue;
    }

    nextProfiles[agentId] = normalizeAgentProfile(agentId, {
      ...profile,
      channels: {
        ...profile.channels,
        [channelId]: {
          ...channel,
          enabled: false,
          lastStatus: 'idle',
          lastError: '',
        },
      },
    });
  }

  return nextProfiles;
}

// ─── Phase 7d-5δ commit 5 — byte-for-byte port from desktopStore.js ──
//
// `projectAgentOverrideFor` returns the per-project override (if any) the
// state currently holds for `agentId`. `effectiveAgentProfile` composes
// the base profile with that override and tags the result with which
// scope produced it. They live next to `normalizeAgentProfile` because
// they read the same state shape and feed the same downstream consumers
// (the chat / task execution graphs and the bootstrap loader). Both
// originally lived in desktopStore.js as LOCAL helpers; this commit
// moves them out so the runners can extract without an import cycle.

export function projectAgentOverrideFor(state, projectId, agentId) {
  if (!projectId) {
    return null;
  }

  return state.projectAgentOverrides?.[projectId]?.[agentId] || null;
}

export function effectiveAgentProfile(state, agentId, projectId = null) {
  const globalProfile = normalizeAgentProfile(agentId, state.agentProfiles?.[agentId]);
  const projectOverride = projectAgentOverrideFor(state, projectId, agentId);

  if (!projectOverride) {
    return {
      ...globalProfile,
      scopeSource: 'global',
      hasProjectOverride: false,
    };
  }

  return {
    ...normalizeAgentProfile(agentId, {
      ...globalProfile,
      ...projectOverride,
      instructions: mergeAgentInstructions(globalProfile, projectOverride),
      capabilities: intersectCapabilities(globalProfile.capabilities,projectOverride.capabilities),
      collaboration: projectOverride.collaboration ? intersectCollaboration(globalProfile.collaboration,projectOverride.collaboration) : globalProfile.collaboration,
    }),
    scopeSource: 'project',
    hasProjectOverride: true,
  };
}
