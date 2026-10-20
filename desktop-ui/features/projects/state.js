// Projects feature state (architecture plan P2, 2026-10-19). Owned by this
// feature: app.js neither reads nor writes it. Project records themselves
// stay in the bootstrap (read through the context's getBootstrap()).
const emptyDraft = () => ({
  name: '',
  tag: '',
  summary: '',
  instructions: '',
  workspacePath: '',
});

export function createProjectsState() {
  return {
    // Overview search box and archived / active switch.
    projectSearch: '',
    showArchivedProjects: false,
    showDeletedProjects: false,
    pendingDeleteProjectId: null,
    lifecycleBusy: false,
    // "New project" form and its draft (kept across background renders).
    showProjectForm: false,
    projectCreating: false,
    draftProject: emptyDraft(),
  };
}

// Live binding: importers always see the current object.
export let projectsState = createProjectsState();

export function resetProjectsState() {
  projectsState = createProjectsState();
  return projectsState;
}
