/**
 * chatScopedGrants.js — in-memory per-chat path grants.
 *
 * When the user clicks "Allow this file in this chat" (or the folder
 * variant) in a FileSafetyGate dialog, the (chatId, path-or-dir, kind)
 * tuple is stored here. Subsequent operations of the same kind on the
 * same path within the same chat skip the dialog.
 *
 * Lifetime: process memory only — NEVER persisted to disk. On process
 * restart every chat starts from zero. This is intentional; the user's
 * original spec said "默认不提供长期授权" — long-term authorization
 * must be a deliberate, separate config edit (toolPermissionRules in
 * config.json), not a side effect of clicking through a dialog.
 *
 * Reads, writes, and edits each have independent grant kinds. Granting
 * "read foo.txt" never silently authorizes "write foo.txt" — different
 * blast radii, different decisions.
 */

import { dirname, normalize, sep } from 'node:path';

export const GRANT_KIND = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  EDIT: 'edit',
});

const DEFAULT_CHAT_SCOPE = '__default__';

// chatId → { files: Map<absPath, Set<kind>>, dirs: Map<absDir, Set<kind>> }
const _chatGrants = new Map();

function scopeKey(chatId) {
  if (chatId === undefined || chatId === null || chatId === '') {
    return DEFAULT_CHAT_SCOPE;
  }
  return String(chatId);
}

function ensureBucket(chatId) {
  const key = scopeKey(chatId);
  let bucket = _chatGrants.get(key);
  if (!bucket) {
    bucket = { files: new Map(), dirs: new Map() };
    _chatGrants.set(key, bucket);
  }
  return bucket;
}

function norm(p) {
  if (typeof p !== 'string' || !p) return '';
  let n = normalize(p);
  if (n.length > 1 && n.endsWith(sep)) n = n.slice(0, -1);
  return n;
}

// True when `p` is strictly inside `dir`. `p === dir` returns false
// because a directory grant is meant for files under it, not the
// directory entry itself (which doesn't have a meaningful read/write).
function dirContains(dir, p) {
  if (!dir || !p || p === dir) return false;
  return p.startsWith(dir + sep);
}

function asKindArray(kinds) {
  if (Array.isArray(kinds)) return kinds.filter(Boolean).map(String);
  if (kinds) return [String(kinds)];
  return [];
}

export function grantFile(chatId, absPath, kinds) {
  const p = norm(absPath);
  if (!p) return;
  const arr = asKindArray(kinds);
  if (!arr.length) return;
  const bucket = ensureBucket(chatId);
  let set = bucket.files.get(p);
  if (!set) {
    set = new Set();
    bucket.files.set(p, set);
  }
  for (const k of arr) set.add(k);
}

export function grantDir(chatId, absDir, kinds) {
  const d = norm(absDir);
  if (!d) return;
  const arr = asKindArray(kinds);
  if (!arr.length) return;
  const bucket = ensureBucket(chatId);
  let set = bucket.dirs.get(d);
  if (!set) {
    set = new Set();
    bucket.dirs.set(d, set);
  }
  for (const k of arr) set.add(k);
}

export function hasGrant(chatId, absPath, kind) {
  const p = norm(absPath);
  if (!p || !kind) return false;
  const bucket = _chatGrants.get(scopeKey(chatId));
  if (!bucket) return false;
  const fileSet = bucket.files.get(p);
  if (fileSet && fileSet.has(String(kind))) return true;
  for (const [dir, kinds] of bucket.dirs.entries()) {
    if (kinds.has(String(kind)) && dirContains(dir, p)) return true;
  }
  return false;
}

// Helper exposed so the gate's callers can grant against the natural
// parent directory without re-importing path.dirname themselves.
export function parentDir(absPath) {
  const p = norm(absPath);
  if (!p) return '';
  return dirname(p);
}

export function clearChat(chatId) {
  if (chatId === undefined) {
    _chatGrants.clear();
    return;
  }
  _chatGrants.delete(scopeKey(chatId));
}

// Snapshot for debug / admin UI. Returns the active grants for one
// chat (or all chats if no chatId given).
export function snapshot(chatId) {
  if (chatId === undefined) {
    const out = {};
    for (const [key, bucket] of _chatGrants.entries()) {
      out[key] = bucketToView(bucket);
    }
    return out;
  }
  const bucket = _chatGrants.get(scopeKey(chatId));
  if (!bucket) return { files: [], dirs: [] };
  return bucketToView(bucket);
}

function bucketToView(bucket) {
  return {
    files: Array.from(bucket.files.entries()).map(([path, kinds]) => ({
      path,
      kinds: [...kinds],
    })),
    dirs: Array.from(bucket.dirs.entries()).map(([path, kinds]) => ({
      path,
      kinds: [...kinds],
    })),
  };
}
