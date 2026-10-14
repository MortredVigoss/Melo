import { normalizeAgentAvatar } from './agentAvatar.js';
// Architecture migration: byte-for-byte command port.
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import { join } from 'node:path';
import { getMeloHome } from '../../config.js';
import { normalizeAgentStorageId } from '../../shared/helpers.js';
import { allAgentIdsFromProfiles } from '../../domain/agent/agentLibrary.js';
import { AGENT_CHANNEL_IDS, normalizeAgentChannels } from '../../domain/agent/agentChannels.js';
import { normalizeAgentUpdatePatch, mergeChannelsWithStaleDraftGuard, buildNewCustomAgent } from './agentProfileService.js';
import { normalizeAgentProfile, normalizeAgentProfiles, normalizeAgentOverride, normalizeProjectAgentOverrides, dedupeAgentChannelTokenOwners, effectiveAgentProfile } from '../../state/agentProfiles.js';
import { createAgentMarkdownFileHelpers } from '../../persistence/agentMarkdownFiles.js';
const agentsDir = () => join(getMeloHome(), 'desktop', 'agents');
const { getAgentMarkdownPaths, writeMarkdownFile, ensureMarkdownFile } = createAgentMarkdownFileHelpers({ agentsDir });

async function syncAgentMarkdownFiles(state) {
  state.agentProfiles = normalizeAgentProfiles(state.agentProfiles);

  for (const agentId of allAgentIdsFromProfiles(state.agentProfiles)) {
    const profile = normalizeAgentProfile(agentId, state.agentProfiles?.[agentId]);
    const paths = getAgentMarkdownPaths(agentId, { scope: 'global' });
    const identity = await ensureMarkdownFile(paths.identityPath, profile.identity);
    const soulMd = await ensureMarkdownFile(paths.soulPath, profile.soulMd);
    state.agentProfiles[agentId] = normalizeAgentProfile(agentId, {
      ...profile,
      identity,
      identify: identity,
      soulMd,
      'soul.md': soulMd,
    });
  }

  state.projectAgentOverrides = normalizeProjectAgentOverrides(
    state.projectAgentOverrides,
    state.agentProfiles,
  );
  for (const [projectId, overrides] of Object.entries(state.projectAgentOverrides)) {
    for (const agentId of allAgentIdsFromProfiles(state.agentProfiles)) {
      const override = overrides?.[agentId];
      if (!override) {
        continue;
      }

      const profile = normalizeAgentProfile(agentId, override);
      const paths = getAgentMarkdownPaths(agentId, { scope: 'project', projectId });
      const identity = await ensureMarkdownFile(paths.identityPath, profile.identity);
      const soulMd = await ensureMarkdownFile(paths.soulPath, profile.soulMd);
      const normalizedOverride = normalizeAgentOverride(agentId, {
        ...profile,
        identity,
        identify: identity,
        soulMd,
        'soul.md': soulMd,
      });
      if (normalizedOverride) {
        state.projectAgentOverrides[projectId][agentId] = normalizedOverride;
      }
    }
  }

  const selectedProjectId = state.settings?.selectedProjectId || null;
  const selectedScope =
    state.settings?.selectedAgentScope === 'project' && selectedProjectId ? 'project' : 'global';
  if (selectedScope === 'project' && selectedProjectId) {
    for (const agentId of allAgentIdsFromProfiles(state.agentProfiles)) {
      const effective = effectiveAgentProfile(state, agentId, selectedProjectId);
      const paths = getAgentMarkdownPaths(agentId, {
        scope: 'project',
        projectId: selectedProjectId,
      });
      await ensureMarkdownFile(paths.identityPath, effective.identity);
      await ensureMarkdownFile(paths.soulPath, effective.soulMd);
    }
  }

  return state;
}

export async function updateAgentProfile(agentId, patch = {}, options = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => updateAgentProfile(...arguments));
  const normalizedAgentId = normalizeAgentStorageId(agentId) || 'main';
  const scope =
    options.scope === 'project' && options.projectId ? 'project' : 'global';

  // Normalize identity/soul aliases and extract the raw channels draft. The
  // stale-draft channel merge happens inside the atomic block below against
  // the freshest persisted state. See src/services/agent/agentProfileService.js
  // and feedback_preserve_user_config.md for why both halves live behind
  // service helpers: minimal patches (e.g. only `minimaxVoiceId`) used to
  // wipe user-configured tokens via `undefined` spread-merges.
  const { nextPatch, incomingChannelsRaw } = normalizeAgentUpdatePatch(patch);
  if (Object.hasOwn(patch, 'avatarData')) nextPatch.avatarData = await normalizeAgentAvatar(patch.avatarData);

  // Wrap the whole read-modify-write in updateStateAtomically so that two
  // concurrent updateAgentProfile calls (for example the poller writing a
  // runtime field and the UI writing a token at the same moment) cannot
  // lose each other's update. updateStateAtomically re-reads the latest
  // state inside the write queue, applies the mutator, and then persists
  // — all serialized with every other saveState / updateStateAtomically.
  await updateStateAtomically(async latestState => {
    const state = ensureSelectedEntities(latestState);
    if (scope === 'project') {
      const projectId = options.projectId;
      const currentProjectOverrides = normalizeProjectAgentOverrides(state.projectAgentOverrides);

      if (options.clearProjectOverride) {
        if (currentProjectOverrides[projectId]) {
          delete currentProjectOverrides[projectId][normalizedAgentId];
          if (!Object.keys(currentProjectOverrides[projectId]).length) {
            delete currentProjectOverrides[projectId];
          }
        }
        state.projectAgentOverrides = currentProjectOverrides;
        const effective = effectiveAgentProfile(state, normalizedAgentId, projectId);
        await writeMarkdownFile(
          getAgentMarkdownPaths(normalizedAgentId, {
            scope: 'project',
            projectId,
          }).identityPath,
          effective.identity,
        );
        await writeMarkdownFile(
          getAgentMarkdownPaths(normalizedAgentId, {
            scope: 'project',
            projectId,
          }).soulPath,
          effective.soulMd,
        );
      } else {
        // For project scope: prefer the project-override's persisted channels
        // if present, otherwise fall back to the agent's global channels so the
        // guard still catches a stale-draft wipe at the project level.
        const persistedForProject =
          currentProjectOverrides?.[projectId]?.[normalizedAgentId]?.channels
          || state.agentProfiles?.[normalizedAgentId]?.channels
          || {};
        const mergedProjectChannels = mergeChannelsWithStaleDraftGuard(
          incomingChannelsRaw,
          persistedForProject,
        );
        if (mergedProjectChannels) {
          nextPatch.channels = mergedProjectChannels;
        }
        const normalizedOverride = normalizeAgentOverride(normalizedAgentId, nextPatch);
        if (!normalizedOverride) {
          throw new Error('Project agent override is empty.');
        }
        state.projectAgentOverrides = {
          ...currentProjectOverrides,
          [projectId]: {
            ...(currentProjectOverrides[projectId] || {}),
            [normalizedAgentId]: normalizedOverride,
          },
        };
        const paths = getAgentMarkdownPaths(normalizedAgentId, {
          scope: 'project',
          projectId,
        });
        const identity = await writeMarkdownFile(paths.identityPath, normalizedOverride.identity);
        const soulMd = await writeMarkdownFile(paths.soulPath, normalizedOverride.soulMd);
        state.projectAgentOverrides[projectId][normalizedAgentId] = normalizeAgentOverride(
          normalizedAgentId,
          {
            ...normalizedOverride,
            identity,
            identify: identity,
            soulMd,
            'soul.md': soulMd,
          },
        );
      }
    } else {
      // Apply the stale-draft channel guard for the global scope against the
      // freshest persisted channels. If the UI posted both channels but one of
      // them looks empty relative to persisted, preserve persisted instead of
      // letting the incoming shell wipe a real config.
      const mergedGlobalChannels = mergeChannelsWithStaleDraftGuard(
        incomingChannelsRaw,
        state.agentProfiles?.[normalizedAgentId]?.channels || {},
      );
      if (mergedGlobalChannels) {
        nextPatch.channels = mergedGlobalChannels;
      }
      let nextAgentProfiles = normalizeAgentProfiles({
        ...state.agentProfiles,
        [normalizedAgentId]: {
          ...state.agentProfiles?.[normalizedAgentId],
          ...nextPatch,
        },
      });

      for (const channelId of AGENT_CHANNEL_IDS) {
        const nextChannel = normalizeAgentChannels(nextAgentProfiles?.[normalizedAgentId]?.channels)?.[channelId];
        if (!nextChannel?.enabled || !nextChannel?.botToken) {
          continue;
        }

        nextAgentProfiles = dedupeAgentChannelTokenOwners(
          nextAgentProfiles,
          normalizedAgentId,
          channelId,
          nextChannel.botToken,
        );
      }

      state.agentProfiles = normalizeAgentProfiles(nextAgentProfiles);
      const currentProfile = normalizeAgentProfile(normalizedAgentId, state.agentProfiles[normalizedAgentId]);
      const paths = getAgentMarkdownPaths(normalizedAgentId, { scope: 'global' });
      const identity = await writeMarkdownFile(paths.identityPath, currentProfile.identity);
      const soulMd = await writeMarkdownFile(paths.soulPath, currentProfile.soulMd);
      state.agentProfiles[normalizedAgentId] = normalizeAgentProfile(normalizedAgentId, {
        ...currentProfile,
        identity,
        identify: identity,
        soulMd,
        'soul.md': soulMd,
      });
    }

    state.settings.selectedCustomizeSection = 'agents';
    state.settings.selectedAgentScope = scope;
    if (scope === 'project' && options.projectId) {
      state.settings.selectedProjectId = options.projectId;
    }
    state.settings.selectedAgentId = normalizedAgentId;
    state.settings.activeView =
      options.activeView || (state.settings.activeView === 'agent' ? 'agent' : 'customize');

    return state;
  });

  return getDesktopBootstrap();
}

export async function createCustomAgent() {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => createCustomAgent(...arguments));
  // Default profile construction (id allocation + seed identity / soul /
  // tools) is pure logic — lifted into agentProfileService in Phase 7c.
  // desktopStore still owns the splice into state + markdown-file sync +
  // saveState side-effects.
  //
  // 2026-05-23 架构 audit #3: id allocation MUST happen inside the mutator —
  // buildNewCustomAgent derives the next id from state.agentProfiles, so a
  // pre-atomic read would let two concurrent createCustomAgent calls allocate
  // the SAME id against a stale profile map (closure-capture trap the skill
  // warns about). syncAgentMarkdownFiles stays inside so the markdown files
  // sync against the merged state, matching updateAgentProfile's pattern.
  await updateStateAtomically(async latestState => {
    const state = ensureSelectedEntities(latestState);
    const { agentId, profile } = buildNewCustomAgent(state.agentProfiles);

    state.agentProfiles = {
      ...state.agentProfiles,
      [agentId]: profile,
    };
    state.settings.selectedCustomizeSection = 'agents';
    state.settings.selectedAgentId = agentId;
    state.settings.activeView = 'agent';
    await syncAgentMarkdownFiles(state);
    return state;
  });
  return getDesktopBootstrap();
}
