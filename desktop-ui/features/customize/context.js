// Transitional wiring for the Customize page (architecture B3 step 1): the
// moved bodies still read these app.js names, so app.js binds them once at
// startup; ES module imports of them are live bindings. Step 2 replaces
// uiState with feature-owned state and narrows this context
// (features/README.md). Every name here is a const or a hoisted function in
// app.js, so binding it once is equivalent to the former module scope.
export let agentsFeature, allChatAgentProfiles, api, applyBootstrap, applyBootstrapPreservingDrafts, approvalsFeature, bgRender, effectiveModelSetupDraft, escapeHtml, loadBootstrap, memoryFeature, minimaxTtsConfigPatchForVoice, patchSettings, refreshAdvancedStatus, render, renderApprovalPanel, renderCommandRunner, renderProjectArtifactShelf, renderSelectedFilePreview, renderTaskPanel, showError, uiState;

export function bindCustomizeContext(context) {
  ({ agentsFeature, allChatAgentProfiles, api, applyBootstrap, applyBootstrapPreservingDrafts, approvalsFeature, bgRender, effectiveModelSetupDraft, escapeHtml, loadBootstrap, memoryFeature, minimaxTtsConfigPatchForVoice, patchSettings, refreshAdvancedStatus, render, renderApprovalPanel, renderCommandRunner, renderProjectArtifactShelf, renderSelectedFilePreview, renderTaskPanel, showError, uiState } = context);
}
