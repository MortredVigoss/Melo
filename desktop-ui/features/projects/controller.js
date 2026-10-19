// Projects feature controller (architecture plan P2, 2026-10-19): project
// list/detail page state, create/update/archive, knowledge selection (inside
// the project-update form), default Agent/team and the project page buttons.
// Step 1 is a byte-for-byte move out of desktop-ui/app.js: every function body
// below is unchanged; the action/form tables and input/change entry points
// are new wiring whose bodies are the old `case` / listener branches.
// Cross-page navigation (focus-project / select-project) stays in app.js.
import { t } from '../../i18n.js';
import { collectTeamPlan } from '../../teamPanel.js';
import { uiState, api, render, showError, patchSettings, applyBootstrap, applyBootstrapPreservingDrafts, startProjectSession } from './context.js';

function filteredProjects() {
  const query = uiState.projectSearch.trim().toLowerCase();
  const projects = (uiState.bootstrap?.projects || []).filter(project=>Boolean(project.archived)===uiState.showArchivedProjects);
  if (!query) return projects;

  return projects.filter(project =>
    `${project.name}\n${project.summary}\n${project.instructions}\n${project.workspacePath}`
      .toLowerCase()
      .includes(query),
  );
}

async function handleCreateProject() {
  const { name, summary, instructions, tag, workspacePath } = uiState.draftProject;
  if (!name.trim()) {
    showError('Project name is required.');
    return;
  }

  const payload = await api('/api/projects', {
    method: 'POST',
    body: {
      name,
      summary,
      instructions,
      tag,
      workspacePath,
    },
  });

  uiState.showProjectForm = false;
  uiState.draftProject = {
    name: '',
    tag: '',
    summary: '',
    instructions: '',
    workspacePath: '',
  };
  applyBootstrap(payload);
}

async function handleUpdateProject(form) {
  const formData = new FormData(form);
  const payload = await api('/api/projects/update', {
    method: 'POST',
    body: {
      projectId: form.dataset.projectId,
      patch: {
        name: String(formData.get('name') || ''),
        tag: String(formData.get('tag') || ''),
        summary: String(formData.get('summary') || ''),
        instructions: String(formData.get('instructions') || ''),
        workspacePath: String(formData.get('workspacePath') || ''),
        confirmWorkspace: formData.get('confirmWorkspace') === 'on',
        knowledgeIds: formData.getAll('knowledgeIds').map(String),
      },
    },
  });
  applyBootstrap(payload);
}

// Click actions, formerly `case` branches of app.js's click dispatch. Each
// handler body is the old case body without its `break` (the early
// `break` in save-project-team becomes `return`).
export const projectsActions = {
  'clear-project-selection': async () => {
        // Return from the detail view to the grid overview. Keep activeView
        // pinned to 'projects' so we stay on this page.
        await patchSettings({
          selectedProjectId: null,
          activeView: 'projects',
        });
  },
  'save-project-team': async ({ trigger }) => {
        const team=collectTeamPlan(trigger.closest('[data-team-scope]'));
        if(team.error) {showError(t(team.error));return;}
        try { applyBootstrap(await api('/api/projects/update',{method:'POST',body:{projectId:trigger.dataset.projectId,patch:{teamPlan:team.plan}}})); } catch(error) { showError(error.message); }
  },
  'clear-project-team': async ({ trigger }) => {
        try { applyBootstrap(await api('/api/projects/update',{method:'POST',body:{projectId:trigger.dataset.projectId,patch:{teamPlan:null}}})); } catch(error) { showError(error.message); }
  },
  'chat-from-project': async ({ trigger }) => {
        await startProjectSession(trigger.dataset.projectId, 'chat');
  },
  'code-from-project': async ({ trigger }) => {
        await startProjectSession(trigger.dataset.projectId, 'code');
  },
  'toggle-project-form': () => {
        uiState.showProjectForm = !uiState.showProjectForm;
        render();
  },
  'toggle-archived-projects': () => {
        uiState.showArchivedProjects = !uiState.showArchivedProjects; render();
  },
  'archive-project': async ({ trigger }) => {
        applyBootstrap(await api('/api/projects/update',{method:'POST',body:{projectId:trigger.dataset.projectId,patch:{archived:trigger.dataset.archived==='true'}}}));
  },
};

// Form submits, formerly `case` branches of app.js's submit listener.
export const projectsForms = {
  'project-create': async () => {
        await handleCreateProject();
  },
  'project-update': async ({ form }) => {
        await handleUpdateProject(form);
  },
};

// 'input' listener branches, called at their original positions. Return
// true when they handled the event.
export function handleProjectSearchInput(target) {
  if (target.id === 'project-search') {
    uiState.projectSearch = target.value;
    render();
    return true;
  }
  return false;
}

export function handleProjectDraftInput(target) {
  if (target.form?.dataset.form === 'project-create') {
    uiState.draftProject[target.name] = target.value;
    return true;
  }
  return false;
}

// 'change' listener branch that ran right after the memory-book branches.
// Synchronous unless it handles the event: returns false (not ours) or the
// pending save, which the listener awaits.
export function handleProjectsChange(target) {
  if (target.dataset?.projectDefaultAgent) return saveProjectDefaultAgent(target);
  return false;
}

async function saveProjectDefaultAgent(target) {
    try { applyBootstrapPreservingDrafts(await api('/api/projects/update',{method:'POST',body:{projectId:target.dataset.projectDefaultAgent,patch:{defaultAgentId:target.value}}})); }
    catch(error) { showError(error.message); }
    render();
}

export { filteredProjects, handleCreateProject, handleUpdateProject };
