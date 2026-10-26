// The narrow context app.js hands the Agent settings feature (architecture
// plan P2b, features/README.md). No uiState: the bootstrap is read through
// getBootstrap(); bootstrap changes go through app.js callbacks
// (applyBootstrap*, patchSettings, refreshBootstrap); the
// settingsFormEditors edit boundary is reached through beginFormEdit /
// formEditToken. /shared/channelAvailability.js and localSettings.js'
// nativeSettings arrive here too, so the feature stays importable from node
// tests. renderCapabilityGrants is the approvals feature's «临时授权» list
// (capability elevation, 2026-10-20). Bound once by installAgentsController(); the feature's modules import
// these names (ES module live bindings).
import { checkFeatureContext } from '../featureContext.js';
import { createAgentsApi } from './api.js';

export const AGENTS_CONTEXT = Object.freeze([
  'getBootstrap', 'app', 'api', 'render', 'bgRender', 'notify',
  'patchSettings', 'applyBootstrap', 'applyBootstrapPreservingDrafts', 'refreshBootstrap',
  'activeProject', 'agentProfileById', 'minimaxTtsConfigPatchForVoice', 'beginFormEdit', 'formEditToken',
  'nativeSettings', 'isAgentChannelAvailable', 'escapeHtml', 'icon', 'renderCapabilityGrants',
]);

export let getBootstrap, app, render, bgRender, notify, patchSettings, applyBootstrap, applyBootstrapPreservingDrafts, refreshBootstrap, activeProject, agentProfileById, minimaxTtsConfigPatchForVoice, beginFormEdit, formEditToken, nativeSettings, isAgentChannelAvailable, escapeHtml, icon, renderCapabilityGrants, agentsApi;

export function bindAgentsContext(context) {
  checkFeatureContext('agents', context, AGENTS_CONTEXT);
  ({ getBootstrap, app, render, bgRender, notify, patchSettings, applyBootstrap, applyBootstrapPreservingDrafts, refreshBootstrap, activeProject, agentProfileById, minimaxTtsConfigPatchForVoice, beginFormEdit, formEditToken, nativeSettings, isAgentChannelAvailable, escapeHtml, icon, renderCapabilityGrants } = context);
  agentsApi = createAgentsApi(context.api);
}
