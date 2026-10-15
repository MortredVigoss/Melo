import {requireProjectWorkspace} from './workspacePolicy.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
// Workspace mutation handlers — sub-phase 7d-5ε commit 3 of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// The seven exported entries here are the workspace-domain CRUD
// orchestrators server.js calls — file selection, file save / preview
// reads, artifact creation + workspace-application, and the curated
// `runLocalCommand` template runner.
//
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { nowIso } from '../../shared/helpers.js';
import { loadState, updateStateAtomically } from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { findProjectById } from '../../state/stateLookups.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import {
  readWorkspaceFilePreview as readWorkspaceFilePreviewService,
  saveWorkspaceFileContent as saveWorkspaceFileContentService,
  applyArtifactContentToWorkspace as applyArtifactContentToWorkspaceService,
} from './workspaceService.js';
import { normalizeArtifact } from '../../domain/artifact/artifactService.js';
import { COMMAND_TEMPLATES } from '../command/commandTemplates.js';
import { MAX_COMMAND_RUNS } from '../../domain/activity/activityLog.js';

const execFile = promisify(execFileCallback);

export async function selectWorkspaceFile(filePath) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => selectWorkspaceFile(...arguments));
  await updateStateAtomically(state => {
    state.settings.selectedFilePath = filePath || null;
    state.settings.activeMode = 'code';
    state.settings.activeView = 'chat';
    return state;
  });
  return getDesktopBootstrap();
}

function buildWorkspaceProjectResolver(state) {
  return async projectId => {
    const project=findProjectById(state,projectId);
    if (project) await requireProjectWorkspace(project);
    return project;
  };
}

export async function readWorkspaceFilePreview(params = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => readWorkspaceFilePreview(...arguments));
  const state = ensureSelectedEntities(await loadState());
  return readWorkspaceFilePreviewService(params, {
    resolveProject: buildWorkspaceProjectResolver(state),
  });
}

export async function saveWorkspaceFile({ filePath, content, projectId } = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => saveWorkspaceFile(...arguments));
  const state = ensureSelectedEntities(await loadState());
  const { project, relativeFilePath } = await saveWorkspaceFileContentService(
    { filePath, content, projectId },
    { resolveProject: buildWorkspaceProjectResolver(state) },
  );

  await updateStateAtomically(latest => {
    latest.settings.selectedFilePath = relativeFilePath;
    latest.settings.activeMode = 'code';
    latest.settings.activeView = 'chat';
    const currentProject = findProjectById(latest, project.id);
    if (currentProject) currentProject.updatedAt = nowIso();
  });

  return getDesktopBootstrap();
}

export async function createArtifact({ title, content, language, projectId, kind = 'note' }) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => createArtifact(...arguments));
  await updateStateAtomically(state => {
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
      projectId: projectId,
      createdAt: nowIso(),
    });

    state.artifacts.unshift(artifact);
    const project = findProjectById(state, artifact.projectId);
    if (project) {
      project.updatedAt = nowIso();
    }

    return state;
  });
  return getDesktopBootstrap();
}

/**
 * Patch an artifact in place (rename, edit content, change kind/language).
 * Wrapped in updateStateAtomically so concurrent writes (e.g. a chat reply
 * adding a new artifact while the user edits an existing one) merge cleanly.
 *
 * `patch` is a partial — only the keys present are applied. Empty/missing
 * `title` / `content` are treated as "no change" (delete the key from patch
 * before calling) so the UI can send a single field.
 */
export async function updateArtifact(artifactId, patch = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => updateArtifact(...arguments));
  if (!artifactId || typeof artifactId !== 'string') {
    throw new Error('Artifact id is required.');
  }

  await updateStateAtomically(latestState => {
    const state = ensureSelectedEntities(latestState);
    const index = state.artifacts.findIndex(entry => entry?.id === artifactId);
    if (index < 0) {
      throw new Error('Artifact not found.');
    }

    const existing = state.artifacts[index];
    // Soft-deleted rows are bootstrap-invisible; the UI can't reach them
    // through normal selection, but a stale id on disk (or a buggy
    // caller) shouldn't be allowed to mutate a tombstone.  Treat as
    // "not found" so the API surface matches deleteArtifact.
    if (existing.deletedAt) {
      throw new Error('Artifact not found.');
    }
    const next = { ...existing };

    if (typeof patch.title === 'string' && patch.title.trim()) {
      next.title = patch.title.trim();
    }
    if (typeof patch.content === 'string') {
      const trimmedContent = patch.content.trim();
      if (!trimmedContent) {
        throw new Error('Artifact content cannot be empty.');
      }
      next.content = trimmedContent;
    }
    if (typeof patch.language === 'string' && patch.language.trim()) {
      next.language = patch.language.trim();
    }
    if (typeof patch.kind === 'string' && patch.kind.trim()) {
      next.kind = patch.kind.trim();
    }

    state.artifacts[index] = normalizeArtifact({
      ...next,
      // Preserve identity + creation provenance — these are never patched.
      id: existing.id,
      chatId: existing.chatId,
      projectId: existing.projectId,
      createdAt: existing.createdAt,
    });

    const project = findProjectById(state, existing.projectId);
    if (project) {
      project.updatedAt = nowIso();
    }
    return state;
  });

  return getDesktopBootstrap();
}

/**
 * Soft-delete an artifact: stamp `deletedAt` instead of dropping the row.
 *
 * The UI undo flow relies on the server already having recorded the
 * tombstone — that way a 5-second undo window survives reload, kill -9,
 * the user dragging Melo into the dock, etc.  The previous version
 * filtered the row out of `state.artifacts` immediately, which forced
 * the client to keep the data in memory and synthesise a recreate path
 * (id changes, breaks any cross-session reference).
 *
 * Visibility: `getDesktopBootstrap` filters out rows with `deletedAt`
 * set, so from the UI's perspective this still looks like an immediate
 * delete.  `restoreArtifact` clears the field for the undo path; old
 * rows are eventually evicted by `purgeStaleSoftDeletes`.
 *
 * Errors:
 *   - missing id  → "Artifact id is required."
 *   - unknown id  → "Artifact not found."
 *   - already-deleted id → "Artifact not found." (the bootstrap-visible
 *     state is what counts; double-delete is the same as deleting an
 *     unknown row)
 */
export async function deleteArtifact(artifactId) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => deleteArtifact(...arguments));
  if (!artifactId || typeof artifactId !== 'string') {
    throw new Error('Artifact id is required.');
  }

  await updateStateAtomically(latestState => {
    const state = ensureSelectedEntities(latestState);
    const target = state.artifacts.find(entry => entry?.id === artifactId);
    if (!target || target.deletedAt) {
      // Already gone (or already soft-deleted) — surface a clear error
      // rather than silently returning a fresh bootstrap that "looks the
      // same".  Matches the original API surface.
      throw new Error('Artifact not found.');
    }

    target.deletedAt = nowIso();

    if (target.projectId) {
      const project = findProjectById(state, target.projectId);
      if (project) {
        project.updatedAt = nowIso();
      }
    }
    return state;
  });

  return getDesktopBootstrap();
}

/**
 * Reverse a `deleteArtifact` call: clear `deletedAt`, bump the owner
 * project's `updatedAt`, refresh the bootstrap.  Used by the client's
 * undo-toast path.  Throws when the id is unknown OR when the artifact
 * isn't currently soft-deleted (defensive against a double-undo race).
 */
export async function restoreArtifact(artifactId) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => restoreArtifact(...arguments));
  if (!artifactId || typeof artifactId !== 'string') {
    throw new Error('Artifact id is required.');
  }

  await updateStateAtomically(latestState => {
    const state = ensureSelectedEntities(latestState);
    const target = state.artifacts.find(entry => entry?.id === artifactId);
    if (!target) {
      throw new Error('Artifact not found.');
    }
    if (!target.deletedAt) {
      throw new Error('Artifact is not soft-deleted; nothing to restore.');
    }

    delete target.deletedAt;

    if (target.projectId) {
      const project = findProjectById(state, target.projectId);
      if (project) {
        project.updatedAt = nowIso();
      }
    }
    return state;
  });

  return getDesktopBootstrap();
}

/**
 * Drop soft-deleted artifacts older than `olderThanDays` (default 7).
 *
 * The UI's undo window is 5 seconds; anything still soft-deleted a week
 * later is ours to evict.  Run this once at server boot so we don't
 * accumulate tombstones forever.  Pure logic except for the
 * `updateStateAtomically` write, so it's safe to call from anywhere
 * (idempotent — running it twice in a row drops nothing the second
 * time).
 *
 * @param {Object} [opts]
 * @param {number} [opts.olderThanDays=7]
 * @param {number} [opts.nowMs=Date.now()] override for tests.
 * @returns {Promise<{purged: number}>} how many rows were evicted.
 */
export async function purgeStaleSoftDeletes({ olderThanDays = 7, nowMs = Date.now() } = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => purgeStaleSoftDeletes(...arguments));
  const cutoffMs = nowMs - olderThanDays * 86_400_000;
  let purged = 0;

  await updateStateAtomically(latestState => {
    const state = ensureSelectedEntities(latestState);
    const before = state.artifacts.length;
    state.artifacts = state.artifacts.filter(entry => {
      if (!entry?.deletedAt) return true;
      const ts = Date.parse(entry.deletedAt);
      // Keep rows with unparseable `deletedAt` (treat as "we don't know,
      // be conservative").  Drop rows whose deletion is older than the
      // cutoff.
      if (!Number.isFinite(ts)) return true;
      return ts > cutoffMs;
    });
    purged = before - state.artifacts.length;
    return state;
  });

  return { purged };
}

export async function applyArtifactToWorkspaceFile({ artifactId, filePath, projectId } = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => applyArtifactToWorkspaceFile(...arguments));
  const state = ensureSelectedEntities(await loadState());
  const artifact = state.artifacts.find(entry => entry.id === artifactId);
  // Reject stale ids that point at a soft-deleted row — writing
  // tombstoned content back to the workspace would be an obvious data
  // surprise (Codex 2026-04-27 audit).
  if (!artifact || artifact.deletedAt) {
    throw new Error('Artifact not found.');
  }

  // Resolve explicit project membership before handing off to the service. The "target path
  // empty? fall back to selected file" rule is also a state-machine call.
  const { project, targetPath } = await applyArtifactContentToWorkspaceService(
    {
      artifactContent: artifact.content,
      targetFilePath: filePath || state.settings.selectedFilePath,
      projectId: projectId || artifact.projectId,
    },
    { resolveProject: buildWorkspaceProjectResolver(state) },
  );

  await updateStateAtomically(latest => {
    latest.settings.selectedFilePath = targetPath;
    latest.settings.activeMode = 'code';
    latest.settings.activeView = 'chat';
    const currentProject = findProjectById(latest, project.id);
    if (currentProject) currentProject.updatedAt = nowIso();
  });

  return getDesktopBootstrap();
}

export async function runLocalCommand({ templateId, query, projectId }) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => runLocalCommand(...arguments));
  const state = ensureSelectedEntities(await loadState());
  const project = findProjectById(state, projectId);
  if (!project) {
    throw new Error('Project not found.');
  }

  const workspacePath = await requireProjectWorkspace(project);
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

  const commandRun = {
    id: randomUUID(),
    projectId: project.id,
    templateId: template.id,
    label: template.label,
    command: [template.command, ...args].join(' '),
    query: trimmedQuery,
    success,
    output: output.slice(0, 12000),
    executedAt: nowIso(),
  };
  await updateStateAtomically(latest => {
    latest.commandRuns = [commandRun, ...latest.commandRuns].slice(0, MAX_COMMAND_RUNS);
    const currentProject = findProjectById(latest, project.id);
    if (currentProject) currentProject.updatedAt = nowIso();
  });

  return {
    bootstrap: await getDesktopBootstrap(),
    commandRun,
  };
}
