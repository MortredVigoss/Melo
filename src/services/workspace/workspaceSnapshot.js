import {projectWorkspaceStatus} from './workspacePolicy.js';
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
import { stat } from 'node:fs/promises';
import { cachedWorkspaceTree } from './workspaceTreeCache.js';
import {
  readWorkspaceFile,
  listWorkspaceEntries,
} from './workspaceFiles.js';
import {
  COMMAND_TEMPLATES,
  commandTemplateDescriptor,
} from '../command/commandTemplates.js';

export async function buildWorkspaceSnapshot(state, project) {
  if (!project) {
    return {
      rootPath: null,
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

  const status=await projectWorkspaceStatus(project);
  const rootPath=status.rootPath;
  const rootStat=rootPath?await stat(rootPath).catch(()=>null):null;
  if (!rootStat || !rootStat.isDirectory()) {
    return {
      rootPath,
      requiresConfirmation:status.requiresConfirmation===true,
      projectId:project.id,
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
