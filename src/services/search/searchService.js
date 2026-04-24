// Orchestration layer for workspace content search.
//
// The ripgrep-backed primitive lives in src/search/fileSearch.js; this module
// adds:
//   • project/workspace resolution (injected — so the service is unit-testable
//     without booting desktopStore state),
//   • UI-tuned caps (12 files × 3 representative lines each),
//   • a back-compat adapter (streamSearchFileHits) for older callers that
//     consume one event per line-hit instead of one event per file group.
//
// Extracted from src/desktopStore.js in the Phase 7a service split. Callers
// outside desktopStore should prefer importing from here directly.

import { streamWorkspaceContentByFile as defaultStreamByFile } from '../../search/fileSearch.js';

// The UI panel shows one row per file, with up to N representative lines
// collapsed under it. 12 × 3 ≈ 36 raw hits — comparable cost to the previous
// flat 18-cap, but each row is now a distinct file instead of several copies
// of the same dense config.
export const MAX_SEARCH_FILE_GROUPS = 12;
export const MAX_LINES_PER_FILE_GROUP = 3;

/**
 * Stream file-grouped search results for a project's workspace.
 *
 * @param {string}   query       - search term (empty → no-op summary)
 * @param {string}   projectId   - target project id (empty → resolver picks selected)
 * @param {Function} onGroup     - async callback invoked for each file group
 * @param {Object}   deps
 * @param {(projectId: string) => Promise<{ project?: { id?: string }, workspace?: { rootPath?: string, exists?: boolean } }>} deps.resolveWorkspace
 *     Returns the materialized workspace for the given project id. May return
 *     `{ workspace: { exists: false } }` when the project has no folder yet.
 * @param {Function} [deps.streamFn]
 *     Override of the search primitive; defaults to the ripgrep pipeline.
 *     Tests use this to inject fixtures.
 * @returns {Promise<{ query: string, projectId: string | null, workspaceExists: boolean, groups: number, hits: number }>}
 */
export async function streamSearchFileGroups(
  query = '',
  projectId = '',
  onGroup = async () => {},
  { resolveWorkspace, streamFn = defaultStreamByFile } = {},
) {
  if (typeof resolveWorkspace !== 'function') {
    throw new TypeError('streamSearchFileGroups: deps.resolveWorkspace is required');
  }

  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) {
    return {
      query: normalizedQuery,
      projectId: projectId || null,
      workspaceExists: false,
      groups: 0,
      hits: 0,
    };
  }

  const { project, workspace } = (await resolveWorkspace(projectId)) || {};

  if (!workspace?.exists) {
    return {
      query: normalizedQuery,
      projectId: project?.id || null,
      workspaceExists: false,
      groups: 0,
      hits: 0,
    };
  }

  let groups = 0;
  let hits = 0;
  try {
    for await (const group of streamFn(workspace.rootPath, normalizedQuery, {
      maxFiles: MAX_SEARCH_FILE_GROUPS,
      hitsPerFile: MAX_LINES_PER_FILE_GROUP,
    })) {
      await onGroup(group);
      groups += 1;
      hits += Array.isArray(group.hits) ? group.hits.length : 1;
    }
  } catch (error) {
    // ENOENT: the workspace folder was removed between resolve and stream —
    // treat it as an empty result rather than bubbling a crash into the SSE
    // stream. Anything else is a real error.
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  return {
    query: normalizedQuery,
    projectId: project?.id || null,
    workspaceExists: true,
    groups,
    hits,
  };
}

/**
 * Back-compat adapter: flattens each file group into its line-level hits.
 * New callers should prefer {@link streamSearchFileGroups}.
 */
export async function streamSearchFileHits(
  query = '',
  projectId = '',
  onHit = async () => {},
  deps = {},
) {
  return streamSearchFileGroups(
    query,
    projectId,
    async group => {
      for (const hit of group.hits || []) {
        await onHit(hit);
      }
    },
    deps,
  );
}
