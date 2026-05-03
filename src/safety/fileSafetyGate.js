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

// requestId → pending entry
const _pending = new Map();

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
// by a leftover prompt from a prior assertion.
export function _clearPendingForTests() {
  for (const entry of _pending.values()) {
    try { entry.reject('Test cleanup.'); } catch {}
  }
  _pending.clear();
}

// ── Per-operation entrypoints ─────────────────────────────────────────

// Single-file read.
//   - sensitive (~/.ssh, /etc, …) → always interactive, never auto-allowed
//   - workspace-internal → silent allow
//   - per-chat grant covers it → silent allow
//   - otherwise → interactive prompt
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

  const sensitive = readRequiresApproval(abs);

  if (!sensitive) {
    if (isWithinWorkspace(abs, workspacePath)) return;
    if (hasGrant(chatId, abs, GRANT_KIND.READ)) return;
  }

  let size = null;
  try {
    const s = await stat(abs);
    size = s.size;
  } catch {
    // Missing file — let the actual read raise the proper ENOENT.
  }

  const decision = await _prompt({
    sseEmitter, signal, chatId,
    kind: OP_KIND.READ,
    payload: {
      path: abs,
      size,
      sensitive,
      category: classifyPath(abs),
      withinWorkspace: isWithinWorkspace(abs, workspacePath),
    },
  });

  // Sensitive paths: refuse to grant session-wide approval. Each
  // sensitive read must re-prompt — explicit by design.
  if (sensitive) return;

  if (decision.scope === SCOPE.FILE) {
    grantFile(chatId, abs, [GRANT_KIND.READ]);
  } else if (decision.scope === SCOPE.DIR) {
    grantDir(chatId, parentDir(abs), [GRANT_KIND.READ]);
  }
}

// Batch read (glob, grep, knowledge index, PDF page sweep, …). The
// caller summarizes what's about to be read; the gate shows the user
// "you're about to scan N files in this dir; extensions x/y/z; size
// range a..b". One approval covers the batch.
export async function requestReadBatch({
  summary,
  chatId,
  sseEmitter,
  signal,
  workspacePath,
}) {
  if (!summary || typeof summary !== 'object') {
    throw denyError('requestReadBatch requires a summary object.');
  }

  await _prompt({
    sseEmitter, signal, chatId,
    kind: OP_KIND.READ_BATCH,
    payload: {
      dir: summary.dir || null,
      fileCount: typeof summary.fileCount === 'number' ? summary.fileCount : null,
      extensions: Array.isArray(summary.extensions) ? summary.extensions.slice(0, 32) : [],
      byteRange: summary.byteRange || null,
      sample: Array.isArray(summary.sample) ? summary.sample.slice(0, 12) : [],
      withinWorkspace: isWithinWorkspace(
        toAbsolute(summary.dir || '', null),
        workspacePath,
      ),
    },
  });
  // Batch reads do not produce per-file or per-dir grants — too coarse
  // to be safe. "Allow once" only.
}

// Write — both new-file create and overwrite. The caller passes hashes
// + a diff preview when overwriting so the user can see what's about
// to change.
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

  if (isHardBlockedWrite(abs)) {
    throw denyError(
      `Write to ${abs} is blocked by safety policy (category: ${classifyPath(abs)}).`,
    );
  }

  if (hasGrant(chatId, abs, GRANT_KIND.WRITE)) return;

  const decision = await _prompt({
    sseEmitter, signal, chatId,
    kind: isCreate ? OP_KIND.WRITE_NEW : OP_KIND.WRITE_OVERWRITE,
    payload: {
      path: abs,
      isCreate: !!isCreate,
      contentSize,
      contentPreview: clipText(contentPreview, 4000),
      oldHash,
      newHash,
      diffPreview: clipText(diffPreview, 8000),
      withinWorkspace: isWithinWorkspace(abs, workspacePath),
    },
  });

  if (decision.scope === SCOPE.FILE) {
    grantFile(chatId, abs, [GRANT_KIND.WRITE]);
  } else if (decision.scope === SCOPE.DIR) {
    grantDir(chatId, parentDir(abs), [GRANT_KIND.WRITE]);
  }
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

  if (isHardBlockedWrite(abs)) {
    throw denyError(
      `Edit of ${abs} is blocked by safety policy (category: ${classifyPath(abs)}).`,
    );
  }

  if (hasGrant(chatId, abs, GRANT_KIND.EDIT)) return;
  // A WRITE grant also covers EDIT — same blast radius, narrower op.
  if (hasGrant(chatId, abs, GRANT_KIND.WRITE)) return;

  const decision = await _prompt({
    sseEmitter, signal, chatId,
    kind: OP_KIND.EDIT,
    payload: {
      path: abs,
      oldExcerpt: clipText(oldString, 4000),
      newExcerpt: clipText(newString, 4000),
      diffPreview: clipText(diffPreview, 8000),
      withinWorkspace: isWithinWorkspace(abs, workspacePath),
    },
  });

  if (decision.scope === SCOPE.FILE) {
    grantFile(chatId, abs, [GRANT_KIND.EDIT, GRANT_KIND.WRITE]);
  } else if (decision.scope === SCOPE.DIR) {
    grantDir(chatId, parentDir(abs), [GRANT_KIND.EDIT, GRANT_KIND.WRITE]);
  }
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

  if (isHardBlockedWrite(absSrc)) {
    throw denyError(
      `Move source ${absSrc} is blocked by safety policy (category: ${classifyPath(absSrc)}).`,
    );
  }
  if (isHardBlockedWrite(absDst)) {
    throw denyError(
      `Move destination ${absDst} is blocked by safety policy (category: ${classifyPath(absDst)}).`,
    );
  }

  await _prompt({
    sseEmitter, signal, chatId,
    kind: OP_KIND.MOVE,
    payload: {
      src: absSrc,
      dst: absDst,
      srcCategory: classifyPath(absSrc),
      dstCategory: classifyPath(absDst),
      withinWorkspace:
        isWithinWorkspace(absSrc, workspacePath) &&
        isWithinWorkspace(absDst, workspacePath),
    },
  });
  // No session grants for move — see header.
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

  for (const p of absPaths) {
    if (isHardBlockedDelete(p)) {
      throw denyError(
        `Delete of ${p} is blocked by safety policy (category: ${classifyPath(p)}).`,
      );
    }
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
      reason,
      expectedConfirmation,
      withinWorkspace: absPaths.every(p => isWithinWorkspace(p, workspacePath)),
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
      expectedConfirmation,
    },
  });

  return { confirmedPaths: absPaths, expectedConfirmation };
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
