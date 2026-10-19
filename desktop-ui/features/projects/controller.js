// Projects feature controller (architecture plan P2, 2026-10-19): project
// list/detail page state, create/update/archive, knowledge selection (inside
// the project-update form), default Agent/team and the project page buttons.
// Moved out of desktop-ui/app.js byte-for-byte first (commit 2/5); since then
// the bodies read the feature's own state (./state.js), the bootstrap through
// getBootstrap() and save through ./api.js. Cross-page navigation
// (focus-project / select-project) stays in app.js. See features/README.md.
import { t } from '../../i18n.js';
import { collectTeamPlan } from '../../teamPanel.js';
import { projectsState, resetProjectsState } from './state.js';
import { bindProjectsContext, projectsApi, getBootstrap, render, showError, patchSettings, applyBootstrap, applyBootstrapPreservingDrafts, startProjectSession } from './context.js';

// Binds the narrow context and starts from fresh feature state. app.js calls
// this once at startup (through ./index.js); tests call it per case.
export function installProjectsController(context) {
  bindProjectsContext(context);
  resetProjectsState();
}

function filteredProjects() {
  const query = projectsState.projectSearch.trim().toLowerCase();
  const projects = (getBootstrap()?.projects || []).filter(project=>Boolean(project.archived)===projectsState.showArchivedProjects);
  if (!query) return projects;

  return projects.filter(project =>
    `${project.name}\n${project.summary}\n${project.instructions}\n${project.workspacePath}`
      .toLowerCase()
      .includes(query),
  );
}

async function handleCreateProject() {
  if (projectsState.projectCreating) return;
  const { name, summary, instructions, tag, workspacePath } = projectsState.draftProject;
  if (!name.trim()) {
    showError('Project name is required.');
    return;
  }

  projectsState.projectCreating = true;
  render();
  try {
    const payload = await projectsApi.create({
      name,
      summary,
      instructions,
      tag,
      workspacePath,
    });

    projectsState.showProjectForm = false;
    projectsState.draftProject = {
      name: '',
      tag: '',
      summary: '',
      instructions: '',
      workspacePath: '',
    };
    applyBootstrap(payload);
  } finally {
    projectsState.projectCreating = false;
    render();
  }
}

async function handleUpdateProject(form) {
  const formData = new FormData(form);
  const payload = await projectsApi.update(form.dataset.projectId, {
    name: String(formData.get('name') || ''),
    tag: String(formData.get('tag') || ''),
    summary: String(formData.get('summary') || ''),
    instructions: String(formData.get('instructions') || ''),
    workspacePath: String(formData.get('workspacePath') || ''),
    confirmWorkspace: formData.get('confirmWorkspace') === 'on',
    knowledgeIds: formData.getAll('knowledgeIds').map(String),
  });
  applyBootstrap(payload);
}

// Click actions (formerly `case` branches of app.js's click dispatch),
// registered once by app.js through the feature registry.
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
    try { applyBootstrap(await projectsApi.update(trigger.dataset.projectId,{teamPlan:team.plan})); } catch(error) { showError(error.message); }
  },
  'clear-project-team': async ({ trigger }) => {
    try { applyBootstrap(await projectsApi.update(trigger.dataset.projectId,{teamPlan:null})); } catch(error) { showError(error.message); }
  },
  'chat-from-project': async ({ trigger }) => {
    await startProjectSession(trigger.dataset.projectId, 'chat');
  },
  'code-from-project': async ({ trigger }) => {
    await startProjectSession(trigger.dataset.projectId, 'code');
  },
  'toggle-project-form': () => {
    if (projectsState.projectCreating) return;
    projectsState.showProjectForm = !projectsState.showProjectForm;
    render();
  },
  'toggle-archived-projects': () => {
    projectsState.showArchivedProjects = !projectsState.showArchivedProjects; render();
  },
  'archive-project': async ({ trigger }) => {
    applyBootstrap(await projectsApi.update(trigger.dataset.projectId,{archived:trigger.dataset.archived==='true'}));
  },
};

// Form submits (formerly `case` branches of app.js's submit listener).
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
    projectsState.projectSearch = target.value;
    render();
    return true;
  }
  return false;
}

export function handleProjectDraftInput(target) {
  if (target.form?.dataset.form === 'project-create') {
    projectsState.draftProject[target.name] = target.value;
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
  try { applyBootstrapPreservingDrafts(await projectsApi.update(target.dataset.projectDefaultAgent,{defaultAgentId:target.value})); }
  catch(error) { showError(error.message); }
  render();
}

export { filteredProjects, handleCreateProject, handleUpdateProject };
