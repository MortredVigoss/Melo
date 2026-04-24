// Workspace-file orchestration layer.
//
// The low-level primitives (readWorkspaceFile / writeWorkspaceFile, plus
// path sanitation and size caps) already live in ./workspaceFiles.js. What
// this module adds is the middle layer:
//
//   • Project → workspacePath resolution (injected, so unit tests don't
//     need the desktopStore state machine).
//   • Input validation with user-facing error messages (the primitives
//     throw on traversal / oversize but with internal-flavored messages).
//   • A consistent `{ project, relativeFilePath }` / `{ project, targetPath }`
//     return shape so desktopStore wrappers can apply state side-effects
//     (selectedFilePath, project.updatedAt, saveState) without re-resolving.
//
// Extracted from src/desktopStore.js in Phase 7b (workspaceService split).
// desktopStore keeps thin wrappers that build the resolver from its state
// snapshot and layer on UI state mutation — this service stays pure I/O.

import {
  readWorkspaceFile as defaultReadFile,
  writeWorkspaceFile as defaultWriteFile,
} from './workspaceFiles.js';

function requireResolver(resolveProject) {
  if (typeof resolveProject !== 'function') {
    throw new TypeError('workspaceService: deps.resolveProject is required');
  }
}

/**
 * Read a workspace file for read-only preview (citation drawer).
 *
 * Mirrors the original desktopStore behavior: rejects empty paths before
 * resolver runs, rejects missing projects, rejects projects without a
 * materialized workspace, and delegates path-traversal + size enforcement
 * to the primitive (which throws on violations).
 *
 * @param {{ filePath: string, projectId?: string }} params
 * @param {{ resolveProject: (id: string) => Promise<object|null>, readFile?: typeof defaultReadFile }} deps
 * @returns {Promise<{ path: string, name: string, language: string, content: string, truncated: boolean, size: number, isBinary: boolean }>}
 */
export async function readWorkspaceFilePreview(
  { filePath, projectId } = {},
  { resolveProject, readFile = defaultReadFile } = {},
) {
  requireResolver(resolveProject);
  const relative = String(filePath || '').trim();
  if (!relative) throw new Error('File path is required.');

  const project = await resolveProject(projectId);
  if (!project) throw new Error('Project not found.');
  if (!project.workspacePath) throw new Error('Project has no workspace.');

  return readFile(project.workspacePath, relative);
}

/**
 * Write text content to a workspace file. Returns the resolved project and
 * the (trimmed) relative path so the caller can apply state side-effects
 * without re-resolving.
 *
 * Caller is responsible for state mutation (selectedFilePath, updatedAt,
 * saveState) — this function only owns the filesystem write.
 *
 * @param {{ filePath: string, content: string, projectId?: string }} params
 * @param {{ resolveProject: (id: string) => Promise<object|null>, writeFile?: typeof defaultWriteFile }} deps
 * @returns {Promise<{ project: object, relativeFilePath: string }>}
 */
export async function saveWorkspaceFileContent(
  { filePath, content, projectId } = {},
  { resolveProject, writeFile = defaultWriteFile } = {},
) {
  requireResolver(resolveProject);
  const relative = String(filePath || '').trim();
  if (!relative) throw new Error('File path is required.');
  if (typeof content !== 'string') throw new Error('File content must be text.');

  const project = await resolveProject(projectId);
  if (!project) throw new Error('Project not found.');
  if (!project.workspacePath) throw new Error('Project has no workspace.');

  await writeFile(project.workspacePath, relative, content);
  return { project, relativeFilePath: relative };
}

/**
 * Write an artifact's content to a target workspace file.
 *
 * Differs from saveWorkspaceFileContent in two ways:
 *   • The caller is responsible for looking up the artifact (we take
 *     pre-resolved `artifactContent`, not an artifactId) — the artifact
 *     store lives in desktopStore state and isn't the service's concern.
 *   • `targetFilePath` empty-fallback to "currently selected file" is also
 *     a caller concern (same reason: selection is state-machine-owned).
 *
 * @param {{ artifactContent: string, targetFilePath: string, projectId?: string }} params
 * @param {{ resolveProject: (id: string) => Promise<object|null>, writeFile?: typeof defaultWriteFile }} deps
 * @returns {Promise<{ project: object, targetPath: string }>}
 */
export async function applyArtifactContentToWorkspace(
  { artifactContent, targetFilePath, projectId } = {},
  { resolveProject, writeFile = defaultWriteFile } = {},
) {
  requireResolver(resolveProject);
  if (typeof artifactContent !== 'string') {
    throw new Error('Artifact content must be text.');
  }
  const target = String(targetFilePath || '').trim();
  if (!target) throw new Error('Choose a target file before applying this artifact.');

  const project = await resolveProject(projectId);
  if (!project) throw new Error('Project not found.');
  if (!project.workspacePath) throw new Error('Project has no workspace.');

  await writeFile(project.workspacePath, target, artifactContent);
  return { project, targetPath: target };
}
