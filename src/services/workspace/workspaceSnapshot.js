// Workspace snapshot builder — sub-phase 7d-5δ commit 3 of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Returns the per-turn workspace snapshot the rest of the runtime hangs
// off (rootPath, file entries / paths, the currently-selected file
// contents, plus the curated command-template UI block + recent command
// runs for this project). Used by:
//   • the chat / task execution graphs (prep node, fallback path)
//   • the desktop bootstrap loader
//   • the workspace UI tabs (server.js routes)
//
// Mechanical adaptation (same pattern as Phase 7d-5α-A1 commit 7's
// stateHydration.js): this module lives at `src/services/workspace/`
// (3 levels deep), so APP_ROOT — computed from `import.meta.url` — needs
// FOUR `dirname()` calls to resolve to the same project-root directory
// that desktopStore (1 level deep) gets with two. Output is identical;
// only the formula differs by file depth.
//
// `sanitizeWorkspacePath` is the local 1-arg wrapper that binds
// APP_ROOT to the 2-arg `sanitizeWorkspacePathRaw` from workspaceFiles —
// kept byte-identical to the desktopStore version for the same reason
// stateHydration kept its own copy: the wrapper IS the byte-for-byte
// surface that the function expects to call.

import { stat } from 'node:fs/promises';
import { cachedWorkspaceTree } from './workspaceTreeCache.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sanitizeWorkspacePath as sanitizeWorkspacePathRaw,
  readWorkspaceFile,
  listWorkspaceEntries,
} from './workspaceFiles.js';
import {
  COMMAND_TEMPLATES,
  commandTemplateDescriptor,
} from '../command/commandTemplates.js';

// APP_ROOT — original desktopStore.js: `dirname(dirname(fileURLToPath(import.meta.url)))`.
// This module lives two levels deeper than desktopStore (`src/services/workspace/`),
// so we need two extra `dirname()` calls for the resolved path to be identical.
// The output is the same project-root directory; only the formula differs.
const APP_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

function sanitizeWorkspacePath(rawPath) {
  return sanitizeWorkspacePathRaw(rawPath, APP_ROOT);
}

export async function buildWorkspaceSnapshot(state, project) {
  if (!project) {
    return {
      rootPath: APP_ROOT,
      exists: false,
      entries: [],
      filePaths: [],
      fileCount: 0,
      selectedFilePath: null,
      selectedFile: null,
      commandTemplates: COMMAND_TEMPLATES.map(commandTemplateDescriptor),
      commandRuns: [],
    };
  }

  const rootPath = sanitizeWorkspacePath(project.workspacePath);
  const rootStat = await stat(rootPath).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    return {
      rootPath,
      exists: false,
      entries: [],
      filePaths: [],
      fileCount: 0,
      selectedFilePath: null,
      selectedFile: null,
      commandTemplates: COMMAND_TEMPLATES.map(commandTemplateDescriptor),
      commandRuns: state.commandRuns.filter(run => run.projectId === project.id).slice(0, 6),
    };
  }

  const { entries, filePaths } = await cachedWorkspaceTree(rootPath, () => listWorkspaceEntries(rootPath));
  const selectedFilePath = filePaths.includes(state.settings.selectedFilePath)
    ? state.settings.selectedFilePath
    : filePaths[0] || null;

  const selectedFile = selectedFilePath
    ? await readWorkspaceFile(rootPath, selectedFilePath).catch(() => null)
    : null;

  return {
    rootPath,
    exists: true,
    entries,
    filePaths,
    fileCount: filePaths.length,
    selectedFilePath,
    selectedFile,
    commandTemplates: COMMAND_TEMPLATES.map(commandTemplateDescriptor),
    commandRuns: state.commandRuns.filter(run => run.projectId === project.id).slice(0, 6),
  };
}
