// The narrow context app.js hands the memory feature (architecture plan P2,
// features/README.md): request + render callbacks, error toast, the active
// project accessor and the shared HTML escaper. No uiState. Bound once by
// installMemoryController(); the feature's modules import these names (ES
// module live bindings).
import { checkFeatureContext } from '../featureContext.js';
import { createMemoryApi } from './api.js';

export const MEMORY_CONTEXT = Object.freeze(['api', 'render', 'bgRender', 'showError', 'activeProject', 'escapeHtml']);

export let render, bgRender, showError, activeProject, escapeHtml, memoryApi;

export function bindMemoryContext(context) {
  checkFeatureContext('memory', context, MEMORY_CONTEXT);
  ({ render, bgRender, showError, activeProject, escapeHtml } = context);
  memoryApi = createMemoryApi(context.api);
}
