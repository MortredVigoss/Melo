import {currentRequestContext} from '../runtime/requestScope.js';
/**
 * sensitivePaths.js — classify file paths into safety categories.
 *
 * Used by FileSafetyGate to make hard-block / require-approval decisions
 * before any file IO happens. Pure synchronous helpers; no fs reads.
 *
 * Categories:
 *   'system'        OS / system paths (/etc, /System, /usr, /bin, /sbin,
 *                   /Library, …). Hard-block writes & deletes; reads
 *                   require explicit approval.
 *   'credential'    Files holding secrets (~/.ssh, ~/.aws, ~/.gnupg,
 *                   ~/.netrc, ~/.docker, ~/.kube, ~/.npmrc, ~/.pypirc,
 *                   GitHub/GCloud config, macOS Keychains/Cookies).
 *                   Hard-block writes & deletes; reads require approval.
 *   'melo_internal' $MELO_HOME (default ~/.melo). Direct writes/deletes
 *                   from agents are blocked — config goes through
 *                   loadConfig/saveConfig, not raw file ops. Reads OK.
 *   'safe'          Anything else. Standard FileSafetyGate flow applies.
 *
 * Notes:
 *   - Path matching is purely lexical (normalize + prefix). The caller
 *     is responsible for resolving symlinks via realpath() if a tighter
 *     guarantee is needed. We deliberately stay sync to keep the gate's
 *     fast path fast.
 *   - getMeloHome() is read on every classifyPath() call so MELO_HOME
 *     env changes (used heavily in tests) are picked up. This is sync;
 *     CLAUDE.md §6 only forbids re-reading env across an `await`.
 */

import { homedir, platform } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { getMeloHome } from '../config.js';

export const PATH_CATEGORY = Object.freeze({
  SYSTEM: 'system',
  CREDENTIAL: 'credential',
  MELO_INTERNAL: 'melo_internal',
  SAFE: 'safe',
});

const HOME = homedir();
const IS_DARWIN = platform() === 'darwin';
const IS_WIN = platform() === 'win32';

function norm(p) {
  if (typeof p !== 'string' || !p) return '';
  let n = normalize(p);
  if (IS_WIN && /^[a-z]:/.test(n)) n = n[0].toUpperCase() + n.slice(1);
  if (n.length > 1 && n.endsWith(sep)) n = n.slice(0, -1);
  return n;
}

// True when `p` equals `dir` or sits inside it (recursive).
function startsWithDir(p, dir) {
  if (!p || !dir) return false;
  if (p === dir) return true;
  return p.startsWith(dir + sep);
}

const SYSTEM_DIRS = (() => {
  if (IS_DARWIN) {
    return ['/etc', '/private/etc', '/System', '/usr', '/bin', '/sbin', '/Library'];
  }
  if (IS_WIN) {
    return [
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\System Volume Information',
    ];
  }
  return ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/sys', '/proc'];
})();

const CREDENTIAL_DIRS = (() => {
  const dirs = [
    join(HOME, '.ssh'),
    join(HOME, '.aws'),
    join(HOME, '.gnupg'),
    join(HOME, '.docker'),
    join(HOME, '.kube'),
    join(HOME, '.netrc'),
    join(HOME, '.npmrc'),
    join(HOME, '.pypirc'),
    join(HOME, '.config', 'gh'),
    join(HOME, '.config', 'gcloud'),
  ];
  if (IS_DARWIN) {
    dirs.push(join(HOME, 'Library', 'Keychains'));
    dirs.push(join(HOME, 'Library', 'Cookies'));
    dirs.push(join(HOME, 'Library', 'Application Support', '1Password'));
  }
  return dirs.map(norm);
})();

const SYSTEM_DIRS_NORM = SYSTEM_DIRS.map(norm);

export function classifyPath(absPath) {
  const p = norm(absPath);
  if (!p) return PATH_CATEGORY.SAFE;

  for (const dir of SYSTEM_DIRS_NORM) {
    if (startsWithDir(p, dir)) return PATH_CATEGORY.SYSTEM;
  }
  for (const dir of CREDENTIAL_DIRS) {
    if (startsWithDir(p, dir)) return PATH_CATEGORY.CREDENTIAL;
  }
  // MELO_HOME is read fresh — see header notes about test friendliness.
  const meloHome = norm(getMeloHome());
  const owned=currentRequestContext()?.ownedWorkspace;
  if (meloHome && (startsWithDir(p, meloHome) || owned?.home && startsWithDir(p,norm(owned.home)))) {
    // Only this operation's validated chat directory is writable. Its root,
    // sibling chats, app state and real targets outside it remain protected.
    if (owned && [owned.path,owned.canonical].some(root => p !== norm(root) && startsWithDir(p,norm(root)))) return PATH_CATEGORY.SAFE;
    return PATH_CATEGORY.MELO_INTERNAL;
  }
  return PATH_CATEGORY.SAFE;
}

// Hard-block predicates — these are checked by FileSafetyGate BEFORE
// any per-chat grant lookup, so a granted "Allow this folder in chat"
// can never punch through. The user's own request explicitly named
// "最高的安全性为第一原则".
export function isHardBlockedWrite(absPath) {
  const cat = classifyPath(absPath);
  return (
    cat === PATH_CATEGORY.SYSTEM ||
    cat === PATH_CATEGORY.CREDENTIAL ||
    cat === PATH_CATEGORY.MELO_INTERNAL
  );
}

export function isHardBlockedDelete(absPath) {
  // Same set as writes — anything we refuse to write to, we refuse to
  // delete. Deletes are strictly higher risk.
  return isHardBlockedWrite(absPath);
}

// Reads of credential / system / $MELO_HOME files are not hard-blocked
// (the user might legitimately want "show me my known_hosts" or "read
// /etc/hosts"), but they MUST go through the interactive approval path.
// Workspace-internal silent-allow does not apply here.
//
// Phase 2B follow-up #3 (Codex 🟠, 2026-05-04): added MELO_INTERNAL.
// Reading from $MELO_HOME (.melo-trash, .melo-backups, grants table)
// would otherwise be classified as benign external and become eligible
// for silent allow or persistent file/dir grants — neither acceptable
// for what is effectively the user's own private data store for this
// app. The gate's sensitive branch (`!_grant_after_prompt`) already
// ensures sensitive reads get a fresh prompt every call.
export function readRequiresApproval(absPath) {
  const cat = classifyPath(absPath);
  return cat === PATH_CATEGORY.SYSTEM
      || cat === PATH_CATEGORY.CREDENTIAL
      || cat === PATH_CATEGORY.MELO_INTERNAL;
}
