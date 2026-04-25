// ─── Agent markdown file I/O helpers ─────────────────────────────────────────
// Thin filesystem layer for the two markdown files that back each agent
// profile: IDENTITY.md (persona / instructions) and SOUL.md (internal notes
// the model can reflect on). Every agent has a `global` scope copy; a
// project-specific agent may also have a `project` scope override.
//
// This module owns:
//   - createAgentMarkdownFileHelpers({ agentsDir }) — factory that returns
//     a bundle of helpers bound to the caller's AGENTS_DIR. The factory
//     pattern is used so we don't have to re-derive AGENTS_DIR from
//     desktopStore internals.
//       • getAgentMarkdownPaths(agentId, { scope, projectId })
//         → { dir, identityPath, soulPath }
//   - readTextIfExists(filePath) — read + return file contents, or null
//     if the file does not exist. Any other fs error re-throws.
//   - ensureMarkdownFile(filePath, fallback) — read if exists, otherwise
//     write `fallback` normalized to storage form and return it. Used
//     for lazy-init of IDENTITY.md / SOUL.md on first access.
//   - writeMarkdownFile(filePath, value) — normalize + write, return the
//     normalized content.
//
// `ensureParentDir` is kept private to this module — the only callers in
// desktopStore were `ensureMarkdownFile` / `writeMarkdownFile`, both of
// which moved here in this phase.
//
// Extracted from desktopStore.js in the Phase 9j refactor (see
// _refactor-backup/REFACTOR_PLAN.md). The factory takes `agentsDir` rather
// than being a fully pure module because desktopStore derives AGENTS_DIR
// from APP_ROOT, and we don't want this service to know about APP_ROOT.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  normalizeAgentStorageId,
  normalizeMarkdownContent,
} from '../../shared/helpers.js';

async function ensureParentDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function ensureMarkdownFile(filePath, fallback = '') {
  await ensureParentDir(filePath);
  const existing = await readTextIfExists(filePath);
  if (typeof existing === 'string') {
    return normalizeMarkdownContent(existing);
  }

  const normalized = normalizeMarkdownContent(fallback);
  await writeFile(filePath, normalized ? `${normalized}\n` : '', 'utf8');
  return normalized;
}

export async function writeMarkdownFile(filePath, value = '') {
  await ensureParentDir(filePath);
  const normalized = normalizeMarkdownContent(value);
  await writeFile(filePath, normalized ? `${normalized}\n` : '', 'utf8');
  return normalized;
}

/**
 * Factory — binds `getAgentMarkdownPaths` to the caller's AGENTS_DIR.
 *
 * Agent markdown files live under one of two directories:
 *   - `<agentsDir>/global/<agentId>/{IDENTITY,SOUL}.md`
 *   - `<agentsDir>/projects/<projectId>/<agentId>/{IDENTITY,SOUL}.md`
 *
 * `agentsDir` accepts either a literal string (for callers like desktopStore
 * that compute the path once and never change it) OR a `() => string` getter
 * (for callers like src/state/markdownSync.js whose underlying MELO_HOME may
 * change between calls — see CLAUDE.md §5 carve-out for Phase 7d-5α-A1
 * commit 9 follow-up). The factory normalizes both forms internally.
 *
 * The returned object also re-exports the pure helpers so callers can
 * grab them from a single import site.
 */
export function createAgentMarkdownFileHelpers({ agentsDir }) {
  if (!agentsDir) {
    throw new Error('createAgentMarkdownFileHelpers: agentsDir is required');
  }
  const resolveAgentsDir =
    typeof agentsDir === 'function' ? agentsDir : () => agentsDir;

  function getAgentMarkdownPaths(agentId, { scope = 'global', projectId = null } = {}) {
    const safeAgentId = normalizeAgentStorageId(agentId);
    const safeProjectId = projectId || 'default-project';
    const currentAgentsDir = resolveAgentsDir();
    const baseDir =
      scope === 'project'
        ? join(currentAgentsDir, 'projects', safeProjectId, safeAgentId)
        : join(currentAgentsDir, 'global', safeAgentId);

    return {
      dir: baseDir,
      identityPath: join(baseDir, 'IDENTITY.md'),
      soulPath: join(baseDir, 'SOUL.md'),
    };
  }

  return {
    getAgentMarkdownPaths,
    readTextIfExists,
    ensureMarkdownFile,
    writeMarkdownFile,
  };
}
