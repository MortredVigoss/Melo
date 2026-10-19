// Transitional wiring for the Agent settings feature (architecture plan P2b,
// step 1: byte-for-byte move out of desktop-ui/app.js). The moved bodies still
// read these names, so app.js binds them once at startup; ES module imports of
// them are live bindings. The next step replaces uiState with the feature's
// own state and narrows this context (features/README.md).
export let uiState, app, api, render, bgRender, showError, showFlashToast, patchSettings, applyBootstrap, applyBootstrapPreservingDrafts, loadBootstrap, activeProject, agentProfileById, minimaxTtsConfigPatchForVoice, settingsFormEditors, nativeSettings, isAgentChannelAvailable, escapeHtml, icon;

export function bindAgentsContext(context) {
  ({ uiState, app, api, render, bgRender, showError, showFlashToast, patchSettings, applyBootstrap, applyBootstrapPreservingDrafts, loadBootstrap, activeProject, agentProfileById, minimaxTtsConfigPatchForVoice, settingsFormEditors, nativeSettings, isAgentChannelAvailable, escapeHtml, icon } = context);
}
