// Project mutation handlers — sub-phase 7d-5ε commit 3 of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// `createProject` and `updateProject` are the project-domain CRUD entry
// points server.js calls. APP_ROOT is recomputed inside this module via
// four dirname() calls — same precedent as workspaceSnapshot.js, used
// by createProject as the fallback `workspacePath` when none is given.

import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso } from '../../shared/helpers.js';
import { loadState, saveState } from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { findProjectById } from '../../state/stateLookups.js';
import { getDesktopBootstrap } from '../../state/desktopBootstrap.js';
// `normalizeProject` here is the 1-arg wrapper from stateHydration.js
// (which binds sanitizeWorkspacePath / fallbackWorkspaceRoot /
// defaultProjectTime to the 2-arg version in projectService.js). Same
// import path desktopStore.js uses.
import { normalizeProject } from '../../state/stateHydration.js';

// APP_ROOT — original desktopStore.js: `dirname(dirname(fileURLToPath(...)))`.
// This module sits two levels deeper (`src/services/project/`); two extra
// dirname calls keep the resolved path identical.
const APP_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

export async function createProject({ name, summary, instructions, tag, workspacePath }) {
  const state = ensureSelectedEntities(await loadState());
  const timestamp = nowIso();
  const project = normalizeProject({
    id: randomUUID(),
    name: name?.trim() || 'Untitled project',
    summary: summary?.trim() || 'A local Melo project.',
    instructions:
      instructions?.trim() ||
      'Keep this project focused, actionable, and easy to continue later.',
    tag: tag?.trim() || 'Project',
    workspacePath: workspacePath?.trim() || APP_ROOT,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  state.projects.unshift(project);
  state.settings.selectedProjectId = project.id;
  state.settings.activeView = 'projects';
  state.settings.selectedFilePath = null;
  await saveState(state);
  return getDesktopBootstrap();
}

export async function updateProject(projectId, patch) {
  const state = ensureSelectedEntities(await loadState());
  const project = findProjectById(state, projectId);
  if (!project) {
    throw new Error('Project not found.');
  }

  Object.assign(project, normalizeProject({
    ...project,
    ...patch,
    id: project.id,
    createdAt: project.createdAt,
    updatedAt: nowIso(),
  }));

  await saveState(state);
  return getDesktopBootstrap();
}
