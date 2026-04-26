// Workspace mutation handlers — sub-phase 7d-5ε commit 3 of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// The seven exported entries here are the workspace-domain CRUD
// orchestrators server.js calls — file selection, file save / preview
// reads, artifact creation + workspace-application, and the curated
// `runLocalCommand` template runner.
//
// Mechanical adaptation (same pattern as Phase 7d-5α-A1 commit 7's
// stateHydration.js + commit 3's workspaceSnapshot.js): APP_ROOT is
// recomputed via four dirname() calls so the module observes the same
// project-root directory desktopStore did, and the local 1-arg
// `sanitizeWorkspacePath` wrapper is duplicated byte-identically.

import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso } from '../../shared/helpers.js';
import { loadState, saveState } from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { findProjectById } from '../../state/stateLookups.js';
import { getDesktopBootstrap } from '../../state/desktopBootstrap.js';
import {
  sanitizeWorkspacePath as sanitizeWorkspacePathRaw,
} from './workspaceFiles.js';
import {
  readWorkspaceFilePreview as readWorkspaceFilePreviewService,
  saveWorkspaceFileContent as saveWorkspaceFileContentService,
  applyArtifactContentToWorkspace as applyArtifactContentToWorkspaceService,
} from './workspaceService.js';
import { normalizeArtifact } from '../artifact/artifactService.js';
import { COMMAND_TEMPLATES } from '../command/commandTemplates.js';
import { MAX_COMMAND_RUNS } from '../activity/activityLog.js';

const APP_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const execFile = promisify(execFileCallback);

function sanitizeWorkspacePath(rawPath) {
  return sanitizeWorkspacePathRaw(rawPath, APP_ROOT);
}

export async function selectWorkspaceFile(filePath) {
  const state = ensureSelectedEntities(await loadState());
  state.settings.selectedFilePath = filePath || null;
  state.settings.activeMode = 'code';
  state.settings.activeView = 'chat';
  await saveState(state);
  return getDesktopBootstrap();
}

function buildWorkspaceProjectResolver(state) {
  return async projectId =>
    findProjectById(state, projectId || state.settings.selectedProjectId);
}

export async function readWorkspaceFilePreview(params = {}) {
  const state = ensureSelectedEntities(await loadState());
  return readWorkspaceFilePreviewService(params, {
    resolveProject: buildWorkspaceProjectResolver(state),
  });
}

export async function saveWorkspaceFile({ filePath, content, projectId } = {}) {
  const state = ensureSelectedEntities(await loadState());
  const { project, relativeFilePath } = await saveWorkspaceFileContentService(
    { filePath, content, projectId },
    { resolveProject: buildWorkspaceProjectResolver(state) },
  );

  state.settings.selectedFilePath = relativeFilePath;
  state.settings.activeMode = 'code';
  state.settings.activeView = 'chat';
  project.updatedAt = nowIso();
  await saveState(state);

  return getDesktopBootstrap();
}

export async function createArtifact({ title, content, language, projectId, kind = 'note' }) {
  const state = ensureSelectedEntities(await loadState());
  const trimmedContent = (content || '').trim();
  if (!trimmedContent) {
    throw new Error('Artifact content cannot be empty.');
  }

  const artifact = normalizeArtifact({
    id: randomUUID(),
    title: title?.trim() || 'Untitled artifact',
    content: trimmedContent,
    language: language?.trim() || 'text',
    kind,
    projectId: projectId || state.settings.selectedProjectId,
    createdAt: nowIso(),
  });

  state.artifacts.unshift(artifact);
  const project = findProjectById(state, artifact.projectId);
  if (project) {
    project.updatedAt = nowIso();
  }

  await saveState(state);
  return getDesktopBootstrap();
}

export async function applyArtifactToWorkspaceFile({ artifactId, filePath, projectId } = {}) {
  const state = ensureSelectedEntities(await loadState());
  const artifact = state.artifacts.find(entry => entry.id === artifactId);
  if (!artifact) {
    throw new Error('Artifact not found.');
  }

  // Resolve the caller's projectId chain (explicit → artifact's project →
  // selected project) before handing off to the service. The "target path
  // empty? fall back to selected file" rule is also a state-machine call.
  const { project, targetPath } = await applyArtifactContentToWorkspaceService(
    {
      artifactContent: artifact.content,
      targetFilePath: filePath || state.settings.selectedFilePath,
      projectId: projectId || artifact.projectId,
    },
    { resolveProject: buildWorkspaceProjectResolver(state) },
  );

  state.settings.selectedFilePath = targetPath;
  state.settings.activeMode = 'code';
  state.settings.activeView = 'chat';
  project.updatedAt = nowIso();
  await saveState(state);

  return getDesktopBootstrap();
}

export async function runLocalCommand({ templateId, query, projectId }) {
  const state = ensureSelectedEntities(await loadState());
  const project = findProjectById(state, projectId || state.settings.selectedProjectId);
  if (!project) {
    throw new Error('Project not found.');
  }

  const workspacePath = sanitizeWorkspacePath(project.workspacePath);
  const template = COMMAND_TEMPLATES.find(entry => entry.id === templateId);
  if (!template) {
    throw new Error('Unknown command template.');
  }

  const trimmedQuery = (query || '').trim();
  if (template.requiresInput && !trimmedQuery) {
    throw new Error('This command requires input.');
  }

  const args = template.args(trimmedQuery);
  let success = false;
  let output = '';

  try {
    const { stdout, stderr } = await execFile(template.command, args, {
      cwd: workspacePath,
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
    success = true;
    output = `${stdout || ''}${stderr || ''}`.trim() || '(no output)';
  } catch (error) {
    output = `${error.stdout || ''}${error.stderr || ''}`.trim() || error.message;
  }

  state.commandRuns.unshift({
    id: randomUUID(),
    projectId: project.id,
    templateId: template.id,
    label: template.label,
    command: [template.command, ...args].join(' '),
    query: trimmedQuery,
    success,
    output: output.slice(0, 12000),
    executedAt: nowIso(),
  });
  state.commandRuns = state.commandRuns.slice(0, MAX_COMMAND_RUNS);
  project.updatedAt = nowIso();
  await saveState(state);

  return {
    bootstrap: await getDesktopBootstrap(),
    commandRun: state.commandRuns[0],
  };
}
