// Projects feature entry (architecture plan P2, 2026-10-19): the only module
// app.js imports for the projects page. installProjectsFeature(context)
// returns the action/form tables for the registry, the listener entry points
// (called at their original positions) and the page renderer.
import {
  installProjectsController,
  projectsActions,
  projectsForms,
  handleProjectSearchInput,
  handleProjectDraftInput,
  handleProjectsChange,
} from './controller.js';
import { projectsState } from './state.js';
import { renderProjectsPage } from './view.js';

export function installProjectsFeature(context) {
  installProjectsController(context);
  return {
    actions: projectsActions,
    forms: projectsForms,
    // 'input': #project-search, then (later in the listener) the create-form draft.
    handleSearchInput: handleProjectSearchInput,
    handleDraftInput: handleProjectDraftInput,
    // 'change': project default Agent. Returns false or the pending save.
    handleChange: handleProjectsChange,
    renderPage: renderProjectsPage,
    cancelCreateForm() { projectsState.showProjectForm=false; projectsState.draftProject={name:'',tag:'',summary:'',instructions:'',workspacePath:''}; },
    getState: () => projectsState,
  };
}
