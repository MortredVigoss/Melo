import { assertAgentChannelAvailable } from '../../shared/channelAvailability.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
import { loadState } from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { nowIso, normalizeAgentStorageId } from '../../shared/helpers.js';
import { effectiveAgentProfile } from '../../state/agentProfiles.js';
import { normalizeAgentChannels, normalizeAgentChannel } from '../../domain/agent/agentChannels.js';
import { pingTelegramChannel } from '../remote/telegramApi.js';
import { pingDiscordChannel } from '../remote/discordApi.js';
import { updateAgentProfile } from './agentMutations.js';

// Saves the probe result through updateAgentProfile and returns its commit
// receipt (architecture plan P1); the HTTP route rebuilds the legacy bootstrap.
/** @returns {Promise<import('./agentMutations.js').AgentCommitReceipt>} */
export async function testAgentChannelConnection(agentId, channelId, patch = {}, options = {}) {
  assertAgentChannelAvailable(channelId);
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => testAgentChannelConnection(...arguments));
  const state = ensureSelectedEntities(await loadState());
  const normalizedAgentId = normalizeAgentStorageId(agentId) || 'main';
  const scope = options.scope === 'project' && options.projectId ? 'project' : 'global';
  const profile = effectiveAgentProfile(
    state,
    normalizedAgentId,
    scope === 'project' ? options.projectId : null,
  );
  const currentChannel = normalizeAgentChannels(profile.channels)?.[channelId];
  if (!currentChannel) {
    throw new Error(`Unknown channel: ${channelId}`);
  }

  // Sanitize the incoming patch: for secret/ID fields (botToken, botUsername,
  // guildId, channelId, chatId, nicknames), treat a blank string the same as
  // "not provided" — i.e. keep the current value. The UI's "Test connection"
  // button may post a partially-filled form (user only pasted the new token
  // and left other fields empty); without this guard the test would overwrite
  // the persisted guildId / channelId with empty strings. See
  // feedback_preserve_user_config.md.
  const SECRET_LIKE_KEYS = [
    'botToken',
    'botUsername',
    'guildId',
    'channelId',
    'chatId',
    'nicknames',
  ];
  const safePatch = { ...patch };
  for (const key of SECRET_LIKE_KEYS) {
    const v = safePatch[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v.trim()) {
      delete safePatch[key];
    }
  }

  const nextChannel = normalizeAgentChannel(channelId, {
    ...currentChannel,
    ...safePatch,
    enabled:
      typeof safePatch?.enabled === 'boolean' ? safePatch.enabled : currentChannel.enabled,
  });
  const checkedAt = nowIso();
  let runtimeChannel = {
    ...nextChannel,
    lastCheckedAt: checkedAt,
  };

  try {
    if (channelId === 'telegram') {
      const result = await pingTelegramChannel(nextChannel);
      runtimeChannel = {
        ...runtimeChannel,
        botUsername:
          typeof result?.result?.username === 'string' && result.result.username.trim()
            ? result.result.username.trim()
            : nextChannel.botUsername,
        lastStatus: 'connected',
        lastError: '',
      };
    } else if (channelId === 'discord') {
      const result = await pingDiscordChannel(nextChannel);
      runtimeChannel = {
        ...runtimeChannel,
        botUsername:
          typeof result?.username === 'string' && result.username.trim()
            ? result.username.trim()
            : nextChannel.botUsername,
        lastStatus: 'connected',
        lastError: '',
      };
    } else {
      runtimeChannel = {
        ...runtimeChannel,
        lastStatus: nextChannel.enabled ? 'connected' : 'idle',
        lastError: '',
      };
    }
  } catch (error) {
    runtimeChannel = {
      ...runtimeChannel,
      lastStatus: 'error',
      lastError: error.message || String(error),
    };
  }

  return updateAgentProfile(
    normalizedAgentId,
    {
      channels: {
        ...profile.channels,
        [channelId]: runtimeChannel,
      },
    },
    {
      scope,
      projectId: options.projectId,
      activeView: 'agent',
    },
  );
}
