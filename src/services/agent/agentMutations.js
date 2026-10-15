import {capabilityMigrationPreview,migrationOptions} from './capabilityMigration.js';
import { normalizeAgentAvatar } from './agentAvatar.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import { normalizeAgentStorageId } from '../../shared/helpers.js';
import { AGENT_CHANNEL_IDS, normalizeAgentChannels } from '../../domain/agent/agentChannels.js';
import { mergeAgentInstructions } from '../../domain/agent/agentDocument.js';
import { normalizeAgentUpdatePatch, mergeChannelsWithStaleDraftGuard, buildNewCustomAgent } from './agentProfileService.js';
import { normalizeAgentProfiles, normalizeAgentOverride, normalizeProjectAgentOverrides, dedupeAgentChannelTokenOwners, effectiveAgentProfile } from '../../state/agentProfiles.js';
import { exportCommittedAgent } from './agentExport.js';

async function bootstrapAfterExport(state, binding) {
  let warning = null;
  try { await exportCommittedAgent(state,binding); }
  catch { warning = 'Agent 已保存；Markdown 导出未完成，可稍后重试。'; }
  const bootstrap = await getDesktopBootstrap();
  return warning ? {...bootstrap,agentExportWarning:warning} : bootstrap;
}

export async function updateAgentProfile(agentId, patch = {}, options = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => updateAgentProfile(...arguments));
  const home = currentRequestContext().home;
  const normalizedAgentId = normalizeAgentStorageId(agentId) || 'main';
  const scope = options.scope === 'project' && options.projectId ? 'project' : 'global';
  const projectId = scope === 'project' ? options.projectId : null;
  const { nextPatch, incomingChannelsRaw } = normalizeAgentUpdatePatch(patch);
  if (Object.hasOwn(patch, 'avatarData')) nextPatch.avatarData = await normalizeAgentAvatar(patch.avatarData);

  const committed = await updateStateAtomically(latestState => {
    const state = ensureSelectedEntities(latestState);
    if (nextPatch?.capabilities) {
      const current = effectiveAgentProfile(state,normalizedAgentId,projectId);
      if (!current.capabilities && patch.capabilityMigrationExpected !== capabilityMigrationPreview(current,migrationOptions(state)).fingerprint) throw Object.assign(new Error('请先预览并确认能力迁移；配置变化后需重新预览。'),{statusCode:409});
    }
    if (scope === 'project') {
      const overrides = normalizeProjectAgentOverrides(state.projectAgentOverrides,state.agentProfiles);
      if (options.clearProjectOverride) {
        if (overrides[projectId]) {
          delete overrides[projectId][normalizedAgentId];
          if (!Object.keys(overrides[projectId]).length) delete overrides[projectId];
        }
      } else {
        const prior = overrides[projectId]?.[normalizedAgentId] || {};
        const effective = effectiveAgentProfile(state,normalizedAgentId,projectId);
        const channels = mergeChannelsWithStaleDraftGuard(incomingChannelsRaw,prior.channels || state.agentProfiles?.[normalizedAgentId]?.channels || {});
        const merged = {...prior,...nextPatch,...(channels ? {channels} : {})};
        if (['instructions','rolePrompt','identity','identify','soulMd','soul.md','soul','systemPrompt'].some(key=>Object.hasOwn(nextPatch,key))) {
          merged.instructions = mergeAgentInstructions(effective,nextPatch);
        }
        const normalized = normalizeAgentOverride(normalizedAgentId,merged);
        if (!normalized) throw new Error('Project agent override is empty.');
        overrides[projectId] = {...overrides[projectId],[normalizedAgentId]:normalized};
      }
      state.projectAgentOverrides = overrides;
    } else {
      const prior = state.agentProfiles?.[normalizedAgentId] || {};
      const channels = mergeChannelsWithStaleDraftGuard(incomingChannelsRaw,prior.channels || {});
      let profiles = normalizeAgentProfiles({...state.agentProfiles,[normalizedAgentId]:{
        ...prior,...nextPatch,...(channels ? {channels} : {}),
        instructions:mergeAgentInstructions(prior,nextPatch),
      }});
      for (const channelId of AGENT_CHANNEL_IDS) {
        const channel = normalizeAgentChannels(profiles[normalizedAgentId]?.channels)?.[channelId];
        if (channel?.enabled && channel.botToken) profiles = dedupeAgentChannelTokenOwners(profiles,normalizedAgentId,channelId,channel.botToken);
      }
      state.agentProfiles = normalizeAgentProfiles(profiles);
    }
    state.settings.selectedCustomizeSection = 'agents';
    state.settings.selectedAgentScope = scope;
    if (projectId) state.settings.selectedProjectId = projectId;
    state.settings.selectedAgentId = normalizedAgentId;
    state.settings.activeView = options.activeView || (state.settings.activeView === 'agent' ? 'agent' : 'customize');
    return state;
  },{home});
  return bootstrapAfterExport(committed,{home,agentId:normalizedAgentId,scope,projectId});
}

export async function createCustomAgent() {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => createCustomAgent(...arguments));
  const home = currentRequestContext().home;
  let createdId;
  const committed = await updateStateAtomically(latestState => {
    const state = ensureSelectedEntities(latestState);
    const {agentId,profile} = buildNewCustomAgent(state.agentProfiles);
    createdId = agentId;
    state.agentProfiles = {...state.agentProfiles,[agentId]:profile};
    state.settings.selectedCustomizeSection = 'agents';
    state.settings.selectedAgentId = agentId;
    state.settings.selectedAgentScope = 'global';
    state.settings.activeView = 'agent';
    return state;
  },{home});
  return bootstrapAfterExport(committed,{home,agentId:createdId});
}
