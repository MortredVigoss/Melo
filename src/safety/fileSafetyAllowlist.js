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

import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import { loadConfig, saveConfig, withConfigLock } from '../config.js';

const VALID_OPERATIONS = new Set(['read', 'write', 'edit']);
const VALID_SCOPES = new Set(['file', 'dir']);

let _cache = null;

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
    operation,
    scope,
    realPath,
    label: typeof raw.label === 'string' ? raw.label : null,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
  };
}

async function _loadCache() {
  if (_cache) return _cache;
  const config = await loadConfig();
  const stored = Array.isArray(config.fileSafetyAllowlist) ? config.fileSafetyAllowlist : [];
  _cache = stored.map(_normalizeRule).filter(Boolean);
  return _cache;
}

// Test seam — clears the in-process cache so a test can mutate config
// on disk and observe the new state.
export function _resetCacheForTesting() {
  _cache = null;
}

export async function listFileSafetyRules() {
  const rules = await _loadCache();
  return rules.map(r => ({ ...r }));
}

export async function addFileSafetyRule({ operation, scope, realPath, label = null }) {
  const candidate = _normalizeRule({ operation, scope, realPath, label });
  if (!candidate) {
    throw new Error(
      `Invalid file-safety rule: operation=${operation}, scope=${scope}, realPath=${realPath}.`,
    );
  }

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
      r.realPath === candidate.realPath,
    );
    if (isDuplicate) {
      _cache = existing;
      return existing.find(r =>
        r.operation === candidate.operation &&
        r.scope === candidate.scope &&
        r.realPath === candidate.realPath,
      );
    }

    const next = [...existing, candidate];
    await saveConfig({ ...current, fileSafetyAllowlist: next });
    _cache = next;
    return candidate;
  });
}

export async function removeFileSafetyRule(id) {
  if (!id) return false;
  return withConfigLock(async () => {
    const current = await loadConfig();
    const existing = Array.isArray(current.fileSafetyAllowlist)
      ? current.fileSafetyAllowlist.map(_normalizeRule).filter(Boolean)
      : [];
    const next = existing.filter(r => r.id !== id);
    if (next.length === existing.length) {
      _cache = existing;
      return false;
    }
    await saveConfig({ ...current, fileSafetyAllowlist: next });
    _cache = next;
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
    if (_matchesRule(rule, operation, realPath)) {
      return rule;
    }
  }
  return null;
}
