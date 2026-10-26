// The narrow context app.js hands the projects feature (architecture plan P2,
// features/README.md). No uiState: the bootstrap is read through
// getBootstrap() and the active-project accessors; navigation, chat creation
// and bootstrap application are app.js callbacks; the memory book section is
// rendered by the memory feature (renderMemoryBook). Bound once by
// installProjectsController(); the feature's modules import these names (ES
// module live bindings).
import { checkFeatureContext } from '../featureContext.js';
import { createProjectsApi } from './api.js';

export const PROJECTS_CONTEXT = Object.freeze([
  'getBootstrap', 'api', 'render', 'notify', 'patchSettings', 'applyBootstrap', 'applyBootstrapPreservingDrafts',
  'startProjectSession', 'activeProject', 'activeProjectChats', 'activeProjectArtifacts', 'renderMemoryBook',
  'escapeHtml', 'truncate', 'icon',
]);

export let getBootstrap, render, notify, patchSettings, applyBootstrap, applyBootstrapPreservingDrafts, startProjectSession, activeProject, activeProjectChats, activeProjectArtifacts, renderMemoryBook, escapeHtml, truncate, icon, projectsApi;

export function bindProjectsContext(context) {
  checkFeatureContext('projects', context, PROJECTS_CONTEXT);
  ({ getBootstrap, render, notify, patchSettings, applyBootstrap, applyBootstrapPreservingDrafts, startProjectSession, activeProject, activeProjectChats, activeProjectArtifacts, renderMemoryBook, escapeHtml, truncate, icon } = context);
  projectsApi = createProjectsApi(context.api);
}
