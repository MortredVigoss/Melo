/**
 * fileSafetyGate.js — unified entrypoint for every file operation in
 * the agent runtime.
 *
 * Every read / write / edit / move / delete from a builtin tool, MCP
 * server, or bash command MUST go through this gate. The gate decides
 * whether the operation is:
 *   - hard-blocked (sensitive path → immediate deny, no UI)
 *   - auto-allowed (workspace-internal read; per-chat grant in scope)
 *   - or requires interactive approval (UI dialog via SSE)
 *
 * The gate complements (does NOT replace) src/tools/permissions.js.
 * permissions.js gates by toolId ("can this tool run at all?").
 * fileSafetyGate gates by (operation, path) ("can this specific file
 * op happen?"). Both must pass for an op to proceed.
 *
 * Lifetime model:
 *   - In-flight prompts stored in process memory keyed by requestId
 *     (same pattern as src/tools/permissions.js).
 *   - Per-chat grants stored in chatScopedGrants.js — process memory
 *     only, never persisted.
 *   - "Always allow" persistence (across processes) is intentionally
 *     NOT exposed by this gate. The user's spec said "不默认提供长期
 *     授权" — long-term policy lives in toolPermissionRules and is a
 *     deliberate config edit, not a click-through.
 *
 * SSE wire shape — every prompt fires:
 *   sseEmitter('tool_permission', {
 *     requestId, kind: 'file_safety', operation, ...payload
 *   })
 * The `kind: 'file_safety'` discriminator lets the existing
 * desktop-ui/app.js dispatcher route the dialog to the new layout
 * without disturbing the old toolId-only path.
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, sep, basename } from 'node:path';

import {
  isHardBlockedWrite,
  isHardBlockedDelete,
  readRequiresApproval,
  classifyPath,
  PATH_CATEGORY,
} from './sensitivePaths.js';
import {
  grantFile,
  grantDir,
  hasGrant,
  parentDir,
  GRANT_KIND,
} from './chatScopedGrants.js';
import { safeResolvePath } from './pathResolver.js';

// Pick the more restrictive of two PATH_CATEGORY values. Used to
// decide sensitivity from BOTH the lexical input AND the realpath
// target — an attacker who creates `/etc/foo` as a symlink to
// `/tmp/bar` shouldn't get a benign classification just because the
// real target is /tmp; nor should a workspace symlink to ~/.ssh.
const _CAT_RANK = {
  [PATH_CATEGORY.SYSTEM]: 4,
  [PATH_CATEGORY.CREDENTIAL]: 3,
  [PATH_CATEGORY.MELO_INTERNAL]: 2,
  [PATH_CATEGORY.SAFE]: 1,
};
function moreRestrictiveCategory(a, b) {
  return (_CAT_RANK[a] || 0) >= (_CAT_RANK[b] || 0) ? a : b;
}
function isAnySensitive(lexicalPath, realPath, predicate) {
  return predicate(lexicalPath) || predicate(realPath);
}

export const OP_KIND = Object.freeze({
  READ: 'read',
  READ_BATCH: 'read_batch',
  WRITE_NEW: 'write_new',
  WRITE_OVERWRITE: 'write_overwrite',
  EDIT: 'edit',
  MOVE: 'move',
  DELETE: 'delete',
  BASH: 'bash',
});

// Scope choices the UI can return from a prompt.
//   'once' — just this op
//   'file' — grant (chatId, exact path) for the rest of the chat
//   'dir'  — grant (chatId, parent dir) for the rest of the chat
//   'deny' — reject
export const SCOPE = Object.freeze({
  ONCE: 'once',
  FILE: 'file',
  DIR: 'dir',
  DENY: 'deny',
});

const REQUEST_TIMEOUT_MS = 120_000;

// Operation token TTL — how long after approval the caller has to
// commitOperation() before it expires and re-approval is required.
// 5 min is a generous window for normal tool execution while short
// enough that a long-idle approval doesn't sit around indefinitely.
const COMMIT_TTL_MS = 5 * 60 * 1000;

// requestId → pending entry
const _pending = new Map();

// Codex C round 2 (2026-05-03) — Q1C: gate now hands callers a
// `resolvedTarget` (the realPath at approval time) AND an opaque
// operationToken. Phase 2 tools normally just use resolvedTarget
// directly. For ops with a long approval-to-execution gap, the tool
// can pass the token back through commitOperation() to atomically
// re-verify that the lexical→real mapping has NOT been swapped
// since approval (defence against TOCTOU symlink swaps). On a
// mismatch commit throws and the tool MUST abort.
//
// Map: token → { kind, chatId, lexicalPath, expectedRealPath, issuedAt }
const _committedOps = new Map();

function denyError(message) {
  const err = new Error(message);
  err.code = 'FILE_SAFETY_DENIED';
  return err;
}

function toAbsolute(p, baseDir) {
  if (typeof p !== 'string' || !p) return '';
  if (isAbsolute(p)) return normalize(p);
  if (typeof baseDir === 'string' && isAbsolute(baseDir)) {
    return resolve(baseDir, p);
  }
  return resolve(p);
}

function isWithinWorkspace(absPath, workspacePath) {
  if (!workspacePath || typeof workspacePath !== 'string') return false;
  if (!isAbsolute(workspacePath)) return false;
  const ws = normalize(workspacePath);
  if (absPath === ws) return true;
  return absPath.startsWith(ws + sep);
}

function clipText(value, max) {
  if (typeof value !== 'string') return null;
  return value.length > max ? value.slice(0, max) : value;
}

// Send the prompt and wait for the UI's response. Returns the resolved
// scope choice ('once' | 'file' | 'dir'); rejects with FILE_SAFETY_DENIED
// on deny / timeout / abort.
function _prompt({ payload, sseEmitter, signal, chatId, kind, expectedConfirmation = null }) {
  return new Promise((resolveFn, rejectFn) => {
    const requestId = randomUUID();

    const timer = setTimeout(() => {
      _pending.delete(requestId);
      rejectFn(denyError(`File safety prompt timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`));
    }, REQUEST_TIMEOUT_MS);

    const onAbort = () => {
      clearTimeout(timer);
      _pending.delete(requestId);
      rejectFn(denyError('File operation aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    _pending.set(requestId, {
      chatId,
      kind,
      expectedConfirmation,
      resolve: (decision) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        _pending.delete(requestId);
        resolveFn(decision);
      },
      reject: (reason) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        _pending.delete(requestId);
        rejectFn(denyError(reason || 'Denied by user.'));
      },
    });

    if (typeof sseEmitter === 'function') {
      sseEmitter('tool_permission', {
        requestId,
        kind: 'file_safety',
        operation: kind,
        ...payload,
      });
    }
  });
}

// ── UI response router ────────────────────────────────────────────────
//
// Wired through a sibling of /api/tools/permission-response. The route
// validates, then calls resolveFileSafety(requestId, scope, extras).
//
// extras.confirmInput — for delete stage 2, the user-typed string. The
// gate validates it against the expectedConfirmation captured at prompt
// time, so the UI can't accidentally bypass the check.
export function resolveFileSafety(requestId, scope, extras = {}) {
  const entry = _pending.get(requestId);
  if (!entry) {
    return { ok: false, reason: 'Unknown or expired file-safety request.' };
  }

  if (scope === SCOPE.DENY) {
    entry.reject('User denied operation.');
    return { ok: true };
  }

  if (entry.expectedConfirmation) {
    const typed = typeof extras.confirmInput === 'string' ? extras.confirmInput : '';
    if (typed !== entry.expectedConfirmation) {
      entry.reject('Confirmation string did not match.');
      return { ok: true };
    }
  }

  if (![SCOPE.ONCE, SCOPE.FILE, SCOPE.DIR].includes(scope)) {
    entry.reject(`Unknown scope "${scope}".`);
    return { ok: false, reason: `Unknown scope "${scope}".` };
  }

  entry.resolve({ scope });
  return { ok: true };
}

export function listPendingFileSafetyRequests() {
  return Array.from(_pending.entries()).map(([id, entry]) => ({
    requestId: id,
    kind: entry.kind,
    chatId: entry.chatId,
  }));
}

// Test seam — wipes the in-flight map so a fresh suite isn't tripped
// by a leftover prompt or token from a prior assertion.
export function _clearPendingForTests() {
  for (const entry of _pending.values()) {
    try { entry.reject('Test cleanup.'); } catch {}
  }
  _pending.clear();
  _committedOps.clear();
}

// Issue an operation token after a successful approval. Phase 2
// tools may pass it to commitOperation() right before performing the
// fs op to atomically re-verify nothing was swapped underneath.
//
// `targets` is an array so a single op can bind multiple paths
// (Codex D round 3 — Q2A move-token: src AND dst must both verify;
// either being symlink-swapped after approval invalidates the move).
// Single-target callers pass a one-element array.
// Module-private — Codex C round 5 (2026-05-03) flagged the prior
// `export` as a hole: any production caller could mint a token and
// hand it to safeDeleteToTrash, bypassing requestDelete's two-stage
// approval. Tokens may now only be created via the public request*
// flow. backup.js + trash.js do their own no-UI atomic re-resolve
// via a small local helper instead of reaching into this module's
// internals.
function _issueOperationToken({ kind, chatId, targets }) {
  if (!Array.isArray(targets) || !targets.length) {
    throw new Error('_issueOperationToken requires a non-empty targets[] array.');
  }
  const token = randomUUID();
  _committedOps.set(token, {
    kind,
    chatId,
    targets: targets.map(t => ({
      lexical: t.lexical,
      expectedReal: t.expectedReal,
    })),
    issuedAt: Date.now(),
  });
  // Auto-purge expired tokens. unref() keeps the timer from holding
  // the event loop open if the process tries to exit.
  const t = setTimeout(() => _committedOps.delete(token), COMMIT_TTL_MS);
  if (typeof t.unref === 'function') t.unref();
  return token;
}

// Re-verify the lexical→real mapping captured at approval time.
// Returns { resolvedTarget, resolvedTargets, kind } on success;
// throws on expired, unknown, or symlink-swapped operations.
//
// `resolvedTarget` is shorthand for `resolvedTargets[0]` so single-
// target callers don't have to unpack the array. Multi-target callers
// (move with both src + dst, restore* with originalPath) read the
// full array. ANY single target mismatch fails the entire commit —
// partial commits are not allowed.
//
// Phase 2 contract: tools that perform their fs op more than a few
// hundred ms after approval, or that read external state in between,
// MUST call this right before the actual write/edit/move/delete and
// use the returned resolvedTarget(s) for the fs call (NOT the
// caller's original input). Tools that execute synchronously may use
// the resolvedTarget from the request* return value directly — the
// TOCTOU window is then bounded by node's microtask queue.
export async function commitOperation(token) {
  const entry = _committedOps.get(token);
  if (!entry) {
    throw denyError('Operation token unknown or already consumed.');
  }
  if (Date.now() - entry.issuedAt > COMMIT_TTL_MS) {
    _committedOps.delete(token);
    throw denyError('Operation token expired; re-approval required.');
  }
  const resolved = [];
  const targetPairs = [];
  for (const target of entry.targets) {
    const fresh = await safeResolvePath(target.lexical);
    if (fresh.realPath !== target.expectedReal) {
      _committedOps.delete(token);
      throw denyError(
        `Path mapping changed between approval and execution: ` +
        `lexical=${target.lexical} approvedReal=${target.expectedReal} nowReal=${fresh.realPath}`,
      );
    }
    resolved.push(fresh.realPath);
    targetPairs.push({ lexical: target.lexical, resolvedReal: fresh.realPath });
  }
  // Single-use: consume on success so a token can never be replayed.
  _committedOps.delete(token);
  return {
    resolvedTarget: resolved[0],
    resolvedTargets: resolved,
    // Codex C round 4 (2026-05-03): expose the lexical→real pair so
    // downstream consumers (safeDeleteToTrash) can run defence-in-depth
    // hard-block checks against BOTH ends, not just the resolved
    // target the gate originally vetted.
    targets: targetPairs,
    kind: entry.kind,
  };
}

// ── Per-operation entrypoints ─────────────────────────────────────────

// Single-file read.
//   - sensitive (~/.ssh, /etc, …) → always interactive, never auto-allowed
//   - workspace-internal AND no symlink chain → silent allow
//   - per-chat grant covers the realPath → silent allow
//   - otherwise → interactive prompt
//
// Codex C round 1 (2026-05-03) safety contract:
//   • sensitivity is decided on BOTH lexical AND realpath (most
//     restrictive wins); a workspace symlink to ~/.ssh classifies as
//     CREDENTIAL even though the lexical path is benign
//   • workspace silent-allow requires lexical AND real both inside
//     workspace (Q1A). A workspace symlink pointing OUTSIDE workspace
//     forces a prompt
//   • grants are keyed on realPath, not lexical, so re-pointing a
//     symlink invalidates the grant
export async function requestRead({
  path,
  chatId,
  sseEmitter,
  signal,
  workspacePath,
  baseDir,
}) {
  const abs = toAbsolute(path, baseDir);
  if (!abs) throw denyError('Read requested with empty path.');

  const { realPath, hasSymlinkInChain, exists } = await safeResolvePath(abs);

  // Sensitivity: most restrictive of lexical + real.
  const sensitive = isAnySensitive(abs, realPath, readRequiresApproval);
  const category = moreRestrictiveCategory(
    classifyPath(abs),
    classifyPath(realPath),
  );

  if (!sensitive) {
    const lexicalInWs = isWithinWorkspace(abs, workspacePath);
    const realInWs = isWithinWorkspace(realPath, workspacePath);
    // Q1A: silent allow only when BOTH lexical and real sit inside
    // workspace. A workspace symlink to /tmp/foo (real outside ws)
    // forces a prompt.
    if (lexicalInWs && realInWs) {
      return { resolvedTarget: realPath };
    }
    if (hasGrant(chatId, realPath, GRANT_KIND.READ)) {
      return { resolvedTarget: realPath };
    }
  }

  let size = null;
  try {
    const s = await stat(realPath || abs);
    size = s.size;
  } catch {
    // Missing file — let the actual read raise the proper ENOENT.
  }

  const decision = await _prompt({
    sseEmitter, signal, chatId,
    kind: OP_KIND.READ,
    payload: {
      path: abs,                      // what caller asked for
      realPath,                       // what'll actually be read
      hasSymlinkInChain,              // UI shows symlink warning
      exists,
      size,
      sensitive,
      category,
      withinWorkspace:
        isWithinWorkspace(abs, workspacePath) &&
        isWithinWorkspace(realPath, workspacePath),
    },
  });

  // Sensitive paths: refuse to grant session-wide approval.
  if (sensitive) {
    return { resolvedTarget: realPath };
  }

  if (decision.scope === SCOPE.FILE) {
    grantFile(chatId, realPath, [GRANT_KIND.READ]);
  } else if (decision.scope === SCOPE.DIR) {
    grantDir(chatId, parentDir(realPath), [GRANT_KIND.READ]);
  }
  return { resolvedTarget: realPath };
}

// Batch read (glob, grep, knowledge index, PDF page sweep, …).
//
// Codex C round 1 (2026-05-03) flagged the previous "trust the
// caller's summary" contract as unsafe — a glob hit list could
// quietly include `~/.ssh/id_rsa` and get a single coarse approval.
//
// New contract: caller MUST pass `paths: [absPath...]`. The gate
// resolves each one, partitions into sensitive vs. benign by
// realpath, and:
//   • benign batch → one summary prompt covering all benign paths
//   • each sensitive path → its own single-file prompt via the
//     normal requestRead() path (with sensitive=true)
//
// `summary` is still accepted as an optional caller-provided overlay
// (so tools can offer human-friendly counts / extensions / byte
// totals), but the authoritative paths array is what the gate
// audits.
export async function requestReadBatch({
  paths,
  summary,
  chatId,
  sseEmitter,
  signal,
  workspacePath,
  baseDir,
}) {
  if (!Array.isArray(paths) || !paths.length) {
    throw denyError('requestReadBatch requires a non-empty paths[] array.');
  }

  // Resolve every path safely. We collect both lexical + real so the
  // UI can show the user what's actually being touched.
  const resolved = [];
  for (const p of paths) {
    const abs = toAbsolute(p, baseDir);
    if (!abs) continue;
    const r = await safeResolvePath(abs);
    resolved.push({
      lexicalPath: abs,
      realPath: r.realPath,
      hasSymlinkInChain: r.hasSymlinkInChain,
      sensitive: isAnySensitive(abs, r.realPath, readRequiresApproval),
      category: moreRestrictiveCategory(
        classifyPath(abs),
        classifyPath(r.realPath),
      ),
    });
  }

  const sensitive = resolved.filter(r => r.sensitive);
  const benign = resolved.filter(r => !r.sensitive);

  // Sensitive paths: each goes through a single-file approval. We
  // sequentially invoke requestRead so the user sees N modal prompts
  // (one per sensitive hit) — never bundled into one coarse decision.
  for (const entry of sensitive) {
    await requestRead({
      path: entry.lexicalPath,
      chatId,
      sseEmitter,
      signal,
      workspacePath,
    });
  }

  // Benign batch (or zero, if all hits were sensitive and approved):
  // one summary prompt. Skip if the partition leaves nothing benign.
  if (benign.length === 0) return;

  await _prompt({
    sseEmitter, signal, chatId,
    kind: OP_KIND.READ_BATCH,
    payload: {
      dir: summary?.dir || null,
      fileCount: benign.length,
      extensions: Array.isArray(summary?.extensions)
        ? summary.extensions.slice(0, 32)
        : [],
      byteRange: summary?.byteRange || null,
      sample: benign.slice(0, 12).map(b => ({
        lexicalPath: b.lexicalPath,
        realPath: b.realPath,
        hasSymlinkInChain: b.hasSymlinkInChain,
      })),
      sensitiveCount: sensitive.length,
      hasSymlinks: benign.some(b => b.hasSymlinkInChain),
      withinWorkspace: benign.every(b =>
        isWithinWorkspace(b.lexicalPath, workspacePath) &&
        isWithinWorkspace(b.realPath, workspacePath),
      ),
    },
  });
  // Batch reads do not produce per-file or per-dir grants — too coarse
  // to be safe. "Allow once" only.
}

// Write — both new-file create and overwrite. The caller passes hashes
// + a diff preview when overwriting so the user can see what's about
// to change.
//
// Codex C round 1 (2026-05-03): hard-block check now uses the most
// restrictive of (lexical, real). A workspace symlink to /etc/hosts
// would write through to /etc/hosts at the kernel — must hard-reject
// even though the lexical path is benign. Q2B: when a symlink exists
// anywhere in the chain, the prompt payload sets `hasSymlinkInChain`
// + reveals `realPath` so the UI can display "WARNING: target is a
// symlink to X".
export async function requestWrite({
  path,
  chatId,
  sseEmitter,
  signal,
  workspacePath,
  baseDir,
  isCreate = false,
  contentSize = null,
  contentPreview = null,
  oldHash = null,
  newHash = null,
  diffPreview = null,
}) {
  const abs = toAbsolute(path, baseDir);
  if (!abs) throw denyError('Write requested with empty path.');

  const { realPath, hasSymlinkInChain } = await safeResolvePath(abs);

  if (isAnySensitive(abs, realPath, isHardBlockedWrite)) {
    const cat = moreRestrictiveCategory(classifyPath(abs), classifyPath(realPath));
    throw denyError(
      `Write to ${abs} is blocked by safety policy (category: ${cat}` +
      (hasSymlinkInChain ? `, real target: ${realPath}` : '') + ').',
    );
  }

  // Grants are keyed on realPath so re-pointing a symlink invalidates
  // prior approvals (defence against TOCTOU within a long chat).
  if (hasGrant(chatId, realPath, GRANT_KIND.WRITE)) {
    const operationToken = _issueOperationToken({
      kind: OP_KIND.WRITE_OVERWRITE,
      chatId,
      targets: [{ lexical: abs, expectedReal: realPath }],
      });
    return { resolvedTarget: realPath, operationToken };
  }

  const decision = await _prompt({
    sseEmitter, signal, chatId,
    kind: isCreate ? OP_KIND.WRITE_NEW : OP_KIND.WRITE_OVERWRITE,
    payload: {
      path: abs,
      realPath,
      hasSymlinkInChain,
      isCreate: !!isCreate,
      contentSize,
      contentPreview: clipText(contentPreview, 4000),
      oldHash,
      newHash,
      diffPreview: clipText(diffPreview, 8000),
      withinWorkspace:
        isWithinWorkspace(abs, workspacePath) &&
        isWithinWorkspace(realPath, workspacePath),
    },
  });

  if (decision.scope === SCOPE.FILE) {
    grantFile(chatId, realPath, [GRANT_KIND.WRITE]);
  } else if (decision.scope === SCOPE.DIR) {
    grantDir(chatId, parentDir(realPath), [GRANT_KIND.WRITE]);
  }
  const operationToken = _issueOperationToken({
    kind: isCreate ? OP_KIND.WRITE_NEW : OP_KIND.WRITE_OVERWRITE,
    chatId,
    targets: [{ lexical: abs, expectedReal: realPath }],
    });
  return { resolvedTarget: realPath, operationToken };
}

// Edit — precise old/new substring replacement.
export async function requestEdit({
  path,
  chatId,
  sseEmitter,
  signal,
  workspacePath,
  baseDir,
  oldString = null,
  newString = null,
  diffPreview = null,
}) {
  const abs = toAbsolute(path, baseDir);
  if (!abs) throw denyError('Edit requested with empty path.');

  const { realPath, hasSymlinkInChain } = await safeResolvePath(abs);

  if (isAnySensitive(abs, realPath, isHardBlockedWrite)) {
    const cat = moreRestrictiveCategory(classifyPath(abs), classifyPath(realPath));
    throw denyError(
      `Edit of ${abs} is blocked by safety policy (category: ${cat}` +
      (hasSymlinkInChain ? `, real target: ${realPath}` : '') + ').',
    );
  }

  if (
    hasGrant(chatId, realPath, GRANT_KIND.EDIT) ||
    // A WRITE grant also covers EDIT — same blast radius, narrower op.
    hasGrant(chatId, realPath, GRANT_KIND.WRITE)
  ) {
    const operationToken = _issueOperationToken({
      kind: OP_KIND.EDIT,
      chatId,
      targets: [{ lexical: abs, expectedReal: realPath }],
      });
    return { resolvedTarget: realPath, operationToken };
  }

  const decision = await _prompt({
    sseEmitter, signal, chatId,
    kind: OP_KIND.EDIT,
    payload: {
      path: abs,
      realPath,
      hasSymlinkInChain,
      oldExcerpt: clipText(oldString, 4000),
      newExcerpt: clipText(newString, 4000),
      diffPreview: clipText(diffPreview, 8000),
      withinWorkspace:
        isWithinWorkspace(abs, workspacePath) &&
        isWithinWorkspace(realPath, workspacePath),
    },
  });

  if (decision.scope === SCOPE.FILE) {
    grantFile(chatId, realPath, [GRANT_KIND.EDIT, GRANT_KIND.WRITE]);
  } else if (decision.scope === SCOPE.DIR) {
    grantDir(chatId, parentDir(realPath), [GRANT_KIND.EDIT, GRANT_KIND.WRITE]);
  }
  const operationToken = _issueOperationToken({
    kind: OP_KIND.EDIT,
    chatId,
    targets: [{ lexical: abs, expectedReal: realPath }],
    });
  return { resolvedTarget: realPath, operationToken };
}

// Move / rename. Always interactive; no session grants — every move is
// re-prompted because src and dst combine to too many surprising shapes
// to safely batch under one approval.
export async function requestMove({
  src,
  dst,
  chatId,
  sseEmitter,
  signal,
  workspacePath,
  baseDir,
}) {
  const absSrc = toAbsolute(src, baseDir);
  const absDst = toAbsolute(dst, baseDir);
  if (!absSrc || !absDst) throw denyError('Move requested with empty src or dst.');

  const srcResolved = await safeResolvePath(absSrc);
  const dstResolved = await safeResolvePath(absDst);

  if (isAnySensitive(absSrc, srcResolved.realPath, isHardBlockedWrite)) {
    const cat = moreRestrictiveCategory(
      classifyPath(absSrc),
      classifyPath(srcResolved.realPath),
    );
    throw denyError(
      `Move source ${absSrc} is blocked by safety policy (category: ${cat}).`,
    );
  }
  if (isAnySensitive(absDst, dstResolved.realPath, isHardBlockedWrite)) {
    const cat = moreRestrictiveCategory(
      classifyPath(absDst),
      classifyPath(dstResolved.realPath),
    );
    throw denyError(
      `Move destination ${absDst} is blocked by safety policy (category: ${cat}).`,
    );
  }

  await _prompt({
    sseEmitter, signal, chatId,
    kind: OP_KIND.MOVE,
    payload: {
      src: absSrc,
      dst: absDst,
      srcRealPath: srcResolved.realPath,
      dstRealPath: dstResolved.realPath,
      srcHasSymlinkInChain: srcResolved.hasSymlinkInChain,
      dstHasSymlinkInChain: dstResolved.hasSymlinkInChain,
      srcCategory: moreRestrictiveCategory(
        classifyPath(absSrc),
        classifyPath(srcResolved.realPath),
      ),
      dstCategory: moreRestrictiveCategory(
        classifyPath(absDst),
        classifyPath(dstResolved.realPath),
      ),
      withinWorkspace:
        isWithinWorkspace(absSrc, workspacePath) &&
        isWithinWorkspace(absDst, workspacePath) &&
        isWithinWorkspace(srcResolved.realPath, workspacePath) &&
        isWithinWorkspace(dstResolved.realPath, workspacePath),
    },
  });
  // No session grants for move — see header. Codex D round 3 (2026-05-03)
  // Q2A: token binds BOTH src and dst. commit-time re-resolves both;
  // if EITHER end gets symlink-swapped between approval and rename,
  // commitOperation throws. resolvedTargets[0] = src, [1] = dst.
  const operationToken = _issueOperationToken({
    kind: OP_KIND.MOVE,
    chatId,
    targets: [
      { lexical: absSrc, expectedReal: srcResolved.realPath },
      { lexical: absDst, expectedReal: dstResolved.realPath },
    ],
  });
  return {
    resolvedSrc: srcResolved.realPath,
    resolvedDst: dstResolved.realPath,
    operationToken,
  };
}

// Delete — two-stage. Stage 1 confirms intent. Stage 2 requires the
// user to type the filename (single delete) or the literal "DELETE"
// (multi delete). The gate validates the typed string itself, so the
// UI can never bypass the second check.
//
// IMPORTANT: this gate ONLY guards the prompt flow. The actual file
// removal MUST go through safeDeleteToTrash() in trash.js — never
// raw fs.unlink. fileDeleteTool.js (Phase 2) wires both halves.
export async function requestDelete({
  paths,
  chatId,
  sseEmitter,
  signal,
  workspacePath,
  baseDir,
  reason = null,
}) {
  const inputPaths = Array.isArray(paths) ? paths : [paths];
  const absPaths = inputPaths
    .map(p => toAbsolute(p, baseDir))
    .filter(Boolean);
  if (!absPaths.length) throw denyError('Delete requested with no paths.');

  // Resolve every path. Hard-block check runs against BOTH lexical
  // and real (Codex C 2026-05-03 — symlink to /etc/hosts must reject).
  const resolved = [];
  for (const p of absPaths) {
    const r = await safeResolvePath(p);
    if (isAnySensitive(p, r.realPath, isHardBlockedDelete)) {
      const cat = moreRestrictiveCategory(
        classifyPath(p),
        classifyPath(r.realPath),
      );
      throw denyError(
        `Delete of ${p} is blocked by safety policy (category: ${cat}` +
        (r.hasSymlinkInChain ? `, real target: ${r.realPath}` : '') + ').',
      );
    }
    resolved.push({ lexicalPath: p, realPath: r.realPath, hasSymlinkInChain: r.hasSymlinkInChain });
  }

  const expectedConfirmation =
    absPaths.length === 1 ? basename(absPaths[0]) : 'DELETE';

  // Stage 1 — intent.
  await _prompt({
    sseEmitter, signal, chatId,
    kind: OP_KIND.DELETE,
    payload: {
      stage: 'intent',
      paths: absPaths,
      realPaths: resolved.map(r => r.realPath),
      hasSymlinks: resolved.some(r => r.hasSymlinkInChain),
      reason,
      expectedConfirmation,
      withinWorkspace: resolved.every(r =>
        isWithinWorkspace(r.lexicalPath, workspacePath) &&
        isWithinWorkspace(r.realPath, workspacePath),
      ),
    },
  });

  // Stage 2 — string confirmation. Note expectedConfirmation is
  // captured into the entry so resolveFileSafety can validate.
  await _prompt({
    sseEmitter, signal, chatId,
    kind: OP_KIND.DELETE,
    expectedConfirmation,
    payload: {
      stage: 'confirm',
      paths: absPaths,
      realPaths: resolved.map(r => r.realPath),
      hasSymlinks: resolved.some(r => r.hasSymlinkInChain),
      expectedConfirmation,
    },
  });

  // Per-path commit tokens — Phase 2 fileDeleteTool uses these to
  // re-verify each target hasn't been symlink-swapped before
  // safeDeleteToTrash actually moves it to quarantine.
  const operationTokens = resolved.map((r, i) =>
    _issueOperationToken({
      kind: OP_KIND.DELETE,
      chatId,
      targets: [{ lexical: absPaths[i], expectedReal: r.realPath }],
      }),
  );

  return {
    confirmedPaths: absPaths,
    confirmedRealPaths: resolved.map(r => r.realPath),
    operationTokens,
    expectedConfirmation,
  };
}

// Bash command containing risky file ops. The caller (bashTool, Phase
// 2) parses the command via bashRiskParser.js and passes a non-empty
// risks array if anything was flagged. Delete-class risks are refused
// outright with a message pointing the model at fileDeleteTool;
// overwrite/truncate-class risks are sent to the user for explicit
// approval.
//
// risks: [{ kind: 'delete'|'overwrite'|'truncate'|'in_place_edit'|'unknown',
//           pattern, target?, confidence }]
export async function requestBashOp({
  command,
  risks,
  chatId,
  sseEmitter,
  signal,
  workspacePath,
}) {
  if (!Array.isArray(risks) || !risks.length) return; // nothing risky

  for (const r of risks) {
    if (r && r.kind === 'delete') {
      throw denyError(
        `Bash command contains a destructive delete pattern (${r.pattern || r.kind}). ` +
        `Use the fileDelete tool instead so the file is moved to .melo-trash/ ` +
        `with two-step confirmation.`,
      );
    }
  }

  await _prompt({
    sseEmitter, signal, chatId,
    kind: OP_KIND.BASH,
    payload: {
      command: clipText(command, 4000),
      risks: risks.slice(0, 32),
      workspacePath: workspacePath || null,
    },
  });
  // Bash approvals are always one-shot. Future commands re-prompt.
}
