import { scopeMatches } from './permissionContext.js';
import { recordPermission } from './permissionAudit.js';
import { currentRequestContext } from '../runtime/requestScope.js';
// fileSafetyAllowlist.js — persistent "Always allow" rules for the
// file-safety gate. Phase 3b sibling of chatScopedGrants.js (which is
// process-memory-only).
//
// Storage: config.fileSafetyAllowlist on disk, mutated through
// withConfigLock so a click-through cannot race a parallel updateModelConfig.
//
// Rule shape:
//   {
//     id: uuid,
//     operation: 'read' | 'write' | 'edit',
//     scope: 'file' | 'dir',          // file = exact path, dir = prefix match
//     realPath: '/abs/resolved/path',  // matched against the resolved real path,
//                                      // never the lexical path — re-pointing
//                                      // a symlink invalidates the rule the
//                                      // same way per-chat grants behave.
//     label: string | null,
//     createdAt: ms timestamp,
//   }
//
// Operations *not* covered:
//   - move / delete / read_batch / bash → these stay one-shot per
//     gate API; persistent allow-listing them would defeat the
//     two-step-confirm / sensitive-batch-split / risk-classified
//     bash design. Phase 3c may add `bash` exact-command rules with
//     a more careful canonicalization step.
//
// Match semantics:
//   scope=file → entry.realPath === lookup.realPath
//   scope=dir  → lookup.realPath === entry.realPath OR
//                lookup.realPath starts with entry.realPath + path.sep
//
// "edit" covers itself OR "write" rules — same blast radius (overwriting
// content) but a narrower op, mirroring chatScopedGrants behaviour.

import { resolveRuntimePaths } from '../runtime/paths.js';
import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import { loadConfig, saveConfig, withConfigLock } from '../config.js';

const VALID_OPERATIONS = new Set(['read', 'write', 'edit']);
const VALID_SCOPES = new Set(['file', 'dir']);

const caches = new Map();

function _normalizeRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const operation = String(raw.operation || '');
  const scope = String(raw.scope || '');
  const realPath = String(raw.realPath || '');
  if (!VALID_OPERATIONS.has(operation)) return null;
  if (!VALID_SCOPES.has(scope)) return null;
  if (!realPath) return null;
  return {
    id: String(raw.id || randomUUID()),
    ...(raw.permissionScope ? {permissionScope:raw.permissionScope} : {}),
    operation,
    scope,
    realPath,
    label: typeof raw.label === 'string' ? raw.label : null,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
  };
}

async function _loadCache() {
  const home = resolveRuntimePaths().home;
  if (caches.has(home)) return caches.get(home);
  const config = await loadConfig();
  const stored = Array.isArray(config.fileSafetyAllowlist) ? config.fileSafetyAllowlist : [];
  const rules = stored.map(_normalizeRule).filter(Boolean);
  caches.set(home, rules);
  return rules;
}

// Test seam — clears the in-process cache so a test can mutate config
// on disk and observe the new state.
export function _resetCacheForTesting() {
  caches.clear();
}

export async function listFileSafetyRules() {
  const rules = await _loadCache();
  return rules.map(r => ({ ...r }));
}

export async function addFileSafetyRule({ operation, scope, realPath, label = null }) {
  const candidate = _normalizeRule({ operation, scope, realPath, label, permissionScope: currentRequestContext()?.permissionScope || null });
  if (!candidate) {
    throw new Error(
      `Invalid file-safety rule: operation=${operation}, scope=${scope}, realPath=${realPath}.`,
    );
  }

  const home = resolveRuntimePaths().home;
  return withConfigLock(async () => {
    const current = await loadConfig();
    const existing = Array.isArray(current.fileSafetyAllowlist)
      ? current.fileSafetyAllowlist.map(_normalizeRule).filter(Boolean)
      : [];

    // De-dupe on (operation, scope, realPath) — repeated clicks shouldn't
    // proliferate identical rules.
    const isDuplicate = existing.some(r =>
      r.operation === candidate.operation &&
      r.scope === candidate.scope &&
      r.realPath === candidate.realPath && JSON.stringify(r.permissionScope || null) === JSON.stringify(candidate.permissionScope || null),
    );
    if (isDuplicate) {
      caches.set(home, existing);
      return existing.find(r =>
        r.operation === candidate.operation &&
        r.scope === candidate.scope &&
        r.realPath === candidate.realPath && JSON.stringify(r.permissionScope || null) === JSON.stringify(candidate.permissionScope || null),
      );
    }

    const next = [...existing, candidate];
    await saveConfig({ ...current, fileSafetyAllowlist: next });
    caches.set(home, next);
    return candidate;
  });
}

export async function removeFileSafetyRule(id) {
  if (!id) return false;
  const home = resolveRuntimePaths().home;
  return withConfigLock(async () => {
    const current = await loadConfig();
    const existing = Array.isArray(current.fileSafetyAllowlist)
      ? current.fileSafetyAllowlist.map(_normalizeRule).filter(Boolean)
      : [];
    const next = existing.filter(r => r.id !== id);
    if (next.length === existing.length) {
      caches.set(home, existing);
      return false;
    }
    await saveConfig({ ...current, fileSafetyAllowlist: next });
    caches.set(home, next);
    return true;
  });
}

function _matchesRule(rule, operation, realPath) {
  if (rule.operation === operation) {
    // pass
  } else if (operation === 'edit' && rule.operation === 'write') {
    // write rule covers edit (same blast radius, narrower op)
  } else {
    return false;
  }

  if (rule.scope === 'file') {
    return rule.realPath === realPath;
  }
  // dir scope: realPath === rule.realPath OR realPath starts with rule.realPath + sep
  if (rule.realPath === realPath) return true;
  return realPath.startsWith(rule.realPath + sep);
}

export async function findMatchingFileSafetyRule(operation, realPath) {
  if (!realPath || !VALID_OPERATIONS.has(operation)) return null;
  const rules = await _loadCache();
  for (const rule of rules) {
    if (_matchesRule(rule, operation, realPath) && scopeMatches(rule.permissionScope, currentRequestContext()?.permissionScope)) {
      recordPermission({operation,decision:'allow',reason:'匹配真实路径与操作授权',ruleId:rule.id,path:realPath});
      return rule;
    }
  }
  return null;
}
