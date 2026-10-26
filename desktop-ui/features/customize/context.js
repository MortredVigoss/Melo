// The narrow context app.js hands the Customize feature (architecture B3
// step 2, features/README.md). No uiState: page data is read through
// getBootstrap(), modelSetupDraft() (raw in-flight edits, for the credential
// chip) and effectiveModelSetupDraft() (saved config merged with the draft, for
// form values); bootstrap changes, the top-level error
// line and the TTS voice selection go through app.js callbacks. Bound once by
// installCustomizeFeature(); the feature's modules import these names (ES
// module live bindings). resolveActiveMinimaxVoiceId comes from the served
// /shared/minimaxVoiceResolver.js and arrives here so the feature stays
// importable from node tests.
import { checkFeatureContext } from '../featureContext.js';

export const CUSTOMIZE_CONTEXT = Object.freeze([
  'agentsFeature', 'allChatAgentProfiles', 'api', 'applyBootstrap', 'applyBootstrapPreservingDrafts', 'approvalsFeature', 'bgRender', 'effectiveModelSetupDraft', 'escapeHtml', 'getBootstrap', 'memoryFeature', 'minimaxTtsConfigPatchForVoice', 'modelSetupDraft', 'patchSettings', 'refreshBootstrap', 'render', 'renderApprovalPanel', 'renderCommandRunner', 'renderProjectArtifactShelf', 'renderSelectedFilePreview', 'renderTaskPanel', 'resolveActiveMinimaxVoiceId', 'setError', 'setTtsVoice', 'notify', 'ttsVoice',
]);

export let agentsFeature, allChatAgentProfiles, api, applyBootstrap, applyBootstrapPreservingDrafts, approvalsFeature, bgRender, effectiveModelSetupDraft, escapeHtml, getBootstrap, memoryFeature, minimaxTtsConfigPatchForVoice, modelSetupDraft, patchSettings, refreshBootstrap, render, renderApprovalPanel, renderCommandRunner, renderProjectArtifactShelf, renderSelectedFilePreview, renderTaskPanel, resolveActiveMinimaxVoiceId, setError, setTtsVoice, notify, ttsVoice;

export function bindCustomizeContext(context) {
  checkFeatureContext('customize', context, CUSTOMIZE_CONTEXT);
  ({ agentsFeature, allChatAgentProfiles, api, applyBootstrap, applyBootstrapPreservingDrafts, approvalsFeature, bgRender, effectiveModelSetupDraft, escapeHtml, getBootstrap, memoryFeature, minimaxTtsConfigPatchForVoice, modelSetupDraft, patchSettings, refreshBootstrap, render, renderApprovalPanel, renderCommandRunner, renderProjectArtifactShelf, renderSelectedFilePreview, renderTaskPanel, resolveActiveMinimaxVoiceId, setError, setTtsVoice, notify, ttsVoice } = context);
}
