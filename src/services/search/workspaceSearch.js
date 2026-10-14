import { loadState } from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { findProjectById } from '../../state/stateLookups.js';
import { buildWorkspaceSnapshot } from '../workspace/workspaceSnapshot.js';
import { streamSearchFileGroups as streamSearchFileGroupsService, streamSearchFileHits as streamSearchFileHitsService } from './searchService.js';

async function resolveWorkspaceForSearch(projectId) {
  const state = ensureSelectedEntities(await loadState());
  const project = findProjectById(state, projectId || state.settings.selectedProjectId);
  const workspace = await buildWorkspaceSnapshot(state, project);
  return { project, workspace };
}

export async function streamSearchFileGroups(
  query = '',
  projectId = '',
  onGroup = async () => {},
) {
  return streamSearchFileGroupsService(query, projectId, onGroup, {
    resolveWorkspace: resolveWorkspaceForSearch,
  });
}

export async function streamSearchFileHits(
  query = '',
  projectId = '',
  onHit = async () => {},
) {
  return streamSearchFileHitsService(query, projectId, onHit, {
    resolveWorkspace: resolveWorkspaceForSearch,
  });
}
