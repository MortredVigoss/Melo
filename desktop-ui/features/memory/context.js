// Transitional wiring for the memory feature (architecture plan P2, step 1:
// byte-for-byte move out of desktop-ui/app.js). The moved bodies still read
// these names, so app.js binds them once at startup; ES module imports of
// them are live bindings. The next step replaces uiState with the feature's
// own state and narrows this context (features/README.md).
export let uiState, api, render, bgRender, showError, activeProject, escapeHtml;

export function bindMemoryContext(context) {
  ({ uiState, api, render, bgRender, showError, activeProject, escapeHtml } = context);
}
