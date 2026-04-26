// Trivial state-entity lookup helpers — sub-phase 7d-5δ commit 2 of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Four single-line `find{Project,ExternalConnector,Task,Approval}ById`
// finders that walk the matching state array and return the first match
// or `null`. They were tightly themed and adjacent in desktopStore, so
// they ship together as a self-contained leaf module — same packaging
// as Phase 7d-5γ commit 1 (`COMMAND_TEMPLATES` + descriptor).
//
// Total internal callers across desktopStore: ~35. Pulling these out is
// a prerequisite for extracting the chat / task execution graph runners
// to their own modules without circular imports.

export function findProjectById(state, projectId) {
  return state.projects.find(project => project.id === projectId) || null;
}

export function findExternalConnectorById(state, connectorId) {
  return state.externalConnectors.find(connector => connector.id === connectorId) || null;
}

export function findTaskById(state, taskId) {
  return state.tasks.find(task => task.id === taskId) || null;
}

export function findApprovalById(state, approvalId) {
  return state.approvals.find(approval => approval.id === approvalId) || null;
}
