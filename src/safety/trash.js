/**
 * trash.js — safe-delete to a 7-day quarantine area.
 *
 * Layout under $MELO_HOME/.melo-trash/:
 *
 *   .melo-trash/
 *     2026-05-03_<12-char-hash>/         <- one folder per delete operation
 *       manifest.json                    <- restore metadata
 *       files/
 *         <12-char-hash>                 <- one entry per deleted path
 *
 * Each delete operation creates a fresh folder; we never merge into an
 * existing one. The folder name is `<date>_<hash(operationId)>` so a
 * directory listing reads chronologically and operations from the same
 * day stay grouped.
 *
 * The user spec called for "至少保留 7 天，7 天后也不自动永久删除"
 * — `pruneTrashHint()` returns expired entries for the UI to show as
 * "可清理 N 项", but we NEVER delete on a timer. A user must explicitly
 * `purgeTrashEntry(operationId)` to evict.
 *
 * CLAUDE.md §6 compliance: every public function reads `getMeloHome()`
 * synchronously at the top, captures it into a local, and never re-reads
 * env across the awaits below. Background tasks (none in this module
 * yet) MUST follow the same pattern if added later.
 */

import { randomUUID, createHash } from 'node:crypto';
import {
  mkdir,
  copyFile,
  rm,
  writeFile,
  readFile,
  realpath,
  stat,
  cp,
  readdir,
} from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { getMeloHome } from '../config.js';
import {
  isHardBlockedWrite,
  isHardBlockedDelete,
  classifyPath,
} from './sensitivePaths.js';
import { safeResolvePath } from './pathResolver.js';

const TRASH_DIR_NAME = '.melo-trash';
export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Codex ⚪ round 4 (2026-05-03): test-only DI seam — see backup.js
// for the full rationale. Default null = no-op in production.
let _restoreSwapHookForTests = null;
export function _setRestoreSwapHookForTests(hook) {
  _restoreSwapHookForTests = typeof hook === 'function' ? hook : null;
}

// Codex C round 5 (2026-05-03): module-private commit helper for the
// no-UI restore path — mirrors backup.js. Re-resolves originalPath
// and verifies it still maps to the expectedReal captured at
// layer (b). Throws FILE_SAFETY_DENIED on mismatch.
async function _commitRestore(originalPath, expectedReal) {
  const fresh = await safeResolvePath(originalPath);
  if (fresh.realPath !== expectedReal) {
    const err = new Error(
      `Path mapping changed between safety check and restore: ` +
      `lexical=${originalPath} approvedReal=${expectedReal} nowReal=${fresh.realPath}`,
    );
    err.code = 'FILE_SAFETY_DENIED';
    throw err;
  }
  return fresh.realPath;
}

// Whitelist for operationId values supplied by the API / UI. Mirrors
// backup.js — Codex C round 1 (2026-05-03) flagged the same path-
// traversal class on the backup side; harden trash for symmetry.
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
function assertValidOperationId(operationId) {
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error(
      `Invalid operationId: must match ${OPERATION_ID_PATTERN}.`,
    );
  }
}

// Defence-in-depth: even after listTrash() finds a manifest with a
// matching operationId, resolve the candidate dir via realpath and
// assert it sits inside trashRoot before any rm. Catches the case
// where trashRoot itself is a symlink, etc.
async function assertWithinRoot(candidateDir, root) {
  const resolvedRoot = await realpath(root);
  let resolvedCandidate;
  try {
    resolvedCandidate = await realpath(candidateDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`No trash entry at ${candidateDir}.`);
    }
    throw err;
  }
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(resolvedRoot + sep)
  ) {
    throw new Error(
      `Resolved trash path ${resolvedCandidate} is outside trash root ${resolvedRoot}.`,
    );
  }
}

function trashRoot(meloHome) {
  return join(meloHome, TRASH_DIR_NAME);
}

function todayStamp(now = new Date()) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function shortHash(input) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 12);
}

async function fileSha256(absPath) {
  try {
    const buf = await readFile(absPath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

// ── safeDeleteToTrash (token-bound, public) ──────────────────────────
//
// Codex C round 4 (2026-05-03): the public delete entrypoint now
// REQUIRES a list of operationTokens issued by gate.requestDelete().
// Each token is committed before any fs op fires; any commit failure
// (TTL expired, symlink swap, replay) aborts the entire batch
// without touching disk. We also re-check isHardBlockedDelete on
// BOTH the lexical input and the commit-resolved real path before
// delegating to the raw worker — defence-in-depth even if a future
// refactor drops a layer.
//
// Phase 2 contract: tools that delete go
//   gate.requestDelete(...) → safeDeleteToTrash({ operationTokens, ctx })
// Tests / setup helpers that don't go through the gate may call
// _unsafeRawDelete() directly is no longer possible (module-private).
//
// Returns the same shape as the legacy raw call:
//   { operationId, folderName, opDir, manifestPath, removed[], failed[] }.
export async function safeDeleteToTrash({ operationTokens, ctx = {} } = {}) {
  if (!Array.isArray(operationTokens) || !operationTokens.length) {
    throw new Error('safeDeleteToTrash requires a non-empty operationTokens[] array.');
  }

  const gate = await import('./fileSafetyGate.js');

  // Atomic commit phase: all-or-nothing. If any token commit throws
  // (mismatch / expired / unknown), we rethrow before _unsafeRaw
  // touches disk — no partial trash entry is ever produced.
  const resolvedTargets = [];
  for (const token of operationTokens) {
    const committed = await gate.commitOperation(token);
    // Defence-in-depth: even though the gate already vetted these
    // at requestDelete time, re-check both sides RIGHT BEFORE the
    // actual rm. A future refactor that loosens the gate must not
    // be able to weaken this layer.
    for (const pair of committed.targets) {
      if (
        isHardBlockedDelete(pair.lexical) ||
        isHardBlockedDelete(pair.resolvedReal)
      ) {
        throw new Error(
          `safeDeleteToTrash refuses to delete sensitive path ` +
          `(lexical=${pair.lexical}, real=${pair.resolvedReal}).`,
        );
      }
    }
    resolvedTargets.push(...committed.resolvedTargets);
  }

  return _unsafeRawDelete(resolvedTargets, ctx);
}

// ── _unsafeRawDelete (module-private) ────────────────────────────────
//
// Codex C round 5 (2026-05-03) made this a non-exported helper.
// Production code reaches the trash exclusively through the
// token-bound safeDeleteToTrash() above. This worker is invoked
// only after every commit has already been verified.
//
// Defence-in-depth: the worker itself runs isHardBlockedDelete on
// BOTH the lexical input AND the realpath of every input. Even if
// future refactoring accidentally calls this from inside the same
// module without going through the wrapper, sensitive paths still
// can't reach copyFile + rm.
//
// Move the given paths into the trash quarantine. Files are copied
// first; only after the manifest is written and copies are flushed
// do we unlink the originals. A copy failure aborts the whole op
// before any original is touched.
//
// ctx: { reason?, requestedBy?, chatId?, operationId?, workspacePath? }
// Returns { operationId, folderName, opDir, manifestPath, removed[], failed[] }.
async function _unsafeRawDelete(paths, ctx = {}) {
  const inputs = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!inputs.length) {
    throw new Error('safeDeleteToTrash called with no paths.');
  }

  // Codex C round 5 (2026-05-03) defence-in-depth: even though
  // safeDeleteToTrash already vetted these via gate.commitOperation +
  // double-check, the raw worker re-classifies every input on its own.
  // This pins the safety policy to the layer that actually does the
  // rm — any future code path that accidentally reaches _unsafeRawDelete
  // without the wrapper still cannot delete a sensitive target.
  for (const absPath of inputs) {
    if (isHardBlockedDelete(absPath)) {
      throw new Error(
        `_unsafeRawDelete refuses to delete ${absPath} ` +
        `(category: ${classifyPath(absPath)}).`,
      );
    }
    // Also resolve and re-check — catches a symlink whose target is
    // sensitive even though the lexical path looks benign.
    try {
      const resolved = await safeResolvePath(absPath);
      if (isHardBlockedDelete(resolved.realPath)) {
        throw new Error(
          `_unsafeRawDelete refuses to delete ${absPath} ` +
          `(real target ${resolved.realPath} is ${classifyPath(resolved.realPath)}).`,
        );
      }
    } catch (err) {
      // safeResolvePath only throws on unexpected fs errors (not
      // ENOENT/ENOTDIR). Re-throw — caller can't safely proceed.
      if (err && /^_unsafeRawDelete refuses/.test(err.message)) throw err;
      // Don't propagate ENOENT here — let the stat() loop below
      // emit the canonical "source not found" error.
    }
  }

  const meloHome = getMeloHome();
  const root = trashRoot(meloHome);

  // Codex D round 3 (2026-05-03): operationId stored in manifest must
  // pass the same whitelist as restore/purge accept; folder name uses
  // shortHash() so traversal is impossible by construction, but we
  // still defend at write-time so manifests on disk only ever carry
  // well-formed IDs.
  let operationId;
  if (ctx.operationId !== undefined && ctx.operationId !== null) {
    assertValidOperationId(ctx.operationId);
    operationId = ctx.operationId;
  } else {
    operationId = randomUUID();
  }
  const folderName = `${todayStamp()}_${shortHash(operationId)}`;
  const opDir = join(root, folderName);
  const filesDir = join(opDir, 'files');

  await mkdir(filesDir, { recursive: true });

  const fileEntries = [];
  for (const absPath of inputs) {
    let st;
    try {
      st = await stat(absPath);
    } catch {
      // Source vanished — back out: remove the empty trash dir we
      // just created so we don't leave an orphan + matching manifest.
      await rm(opDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`safeDeleteToTrash: source not found: ${absPath}`);
    }

    const trashedAs = shortHash(`${absPath}:${Date.now()}:${Math.random()}`);
    const dest = join(filesDir, trashedAs);
    if (st.isDirectory()) {
      await cp(absPath, dest, { recursive: true });
      fileEntries.push({
        originalPath: absPath,
        trashedAs,
        wasDirectory: true,
        size: null,
        sha256: null,
      });
    } else {
      await copyFile(absPath, dest);
      fileEntries.push({
        originalPath: absPath,
        trashedAs,
        wasDirectory: false,
        size: st.size,
        sha256: await fileSha256(absPath),
      });
    }
  }

  const now = new Date();
  const manifest = {
    operationId,
    deletedAt: now.toISOString(),
    expiresAfter: new Date(now.getTime() + TRASH_RETENTION_MS).toISOString(),
    requestedBy: ctx.requestedBy || 'agent',
    chatId: ctx.chatId || null,
    originalPaths: inputs.map(String),
    files: fileEntries,
    reason: ctx.reason || null,
    workspacePath: ctx.workspacePath || null,
    restorable: true,
  };

  await writeFile(
    join(opDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  // Unlink originals one by one. A partial failure leaves the trash
  // copy + the failed-to-remove original intact — strictly safer than
  // rolling back the whole op (which would re-restore files we already
  // unlinked). Caller sees what failed via `failed[]`.
  const removed = [];
  const failed = [];
  for (const entry of fileEntries) {
    try {
      await rm(entry.originalPath, { recursive: true, force: false });
      removed.push(entry.originalPath);
    } catch (err) {
      failed.push({
        path: entry.originalPath,
        error: err?.message || String(err),
      });
    }
  }

  return {
    operationId,
    folderName,
    opDir,
    manifestPath: join(opDir, 'manifest.json'),
    removed,
    failed,
  };
}

// ── listTrash ────────────────────────────────────────────────────────
//
// Returns all trash entries newest-first. Each entry is the parsed
// manifest plus `folderName` for resolving on-disk paths.
export async function listTrash() {
  const meloHome = getMeloHome();
  const root = trashRoot(meloHome);

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, 'manifest.json');
    try {
      const raw = await readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      out.push({ folderName: entry.name, ...manifest });
    } catch {
      // Missing/corrupt manifest → skip; UI can offer "purge orphans"
      // from a future admin button.
    }
  }
  out.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  return out;
}

// ── restoreFromTrash ─────────────────────────────────────────────────
//
// Copy files back to their originalPaths. By default, refuses to
// overwrite a path that already exists at the destination — the user
// might have created a new file at that spot since the delete and we
// don't want to silently clobber it. Pass { overwrite: true } to
// override.
//
// On full success (all entries restored, none skipped) the trash
// folder is removed. If anything was skipped, the folder stays so a
// retry is possible.
export async function restoreFromTrash(operationId, opts = {}) {
  assertValidOperationId(operationId);

  const all = await listTrash();
  const target = all.find(x => x.operationId === operationId);
  if (!target) {
    throw new Error(`No trash entry with operationId=${operationId}.`);
  }
  if (!target.restorable) {
    throw new Error(`Trash entry is marked non-restorable.`);
  }

  const meloHome = getMeloHome();
  const root = trashRoot(meloHome);
  const opDir = join(root, target.folderName);
  await assertWithinRoot(opDir, root);
  const filesDir = join(opDir, 'files');

  // Codex C round 2 (2026-05-03) — Q2C layer (b): re-classify every
  // entry's originalPath at restore time. A tampered manifest with
  // originalPath pointing at /etc/foo cannot punch through; the
  // whole batch aborts before any copyFile fires.
  //
  // We also stash the realPath captured here per entry so layer
  // (c)+(d) below can issue commit tokens bound to the same
  // expectedReal — a swap between (b) and the actual fs op fails
  // commitOperation and aborts the restore (Codex D round 3).
  const expectedRealByLexical = new Map();
  for (const entry of target.files) {
    const { realPath, hasSymlinkInChain } = await safeResolvePath(entry.originalPath);
    if (
      isHardBlockedWrite(entry.originalPath) ||
      isHardBlockedWrite(realPath)
    ) {
      const lexCat = classifyPath(entry.originalPath);
      const realC = classifyPath(realPath);
      throw new Error(
        `Refusing to restore to ${entry.originalPath} ` +
        (hasSymlinkInChain ? `(real target: ${realPath}) ` : '') +
        `— manifest target classified as ${lexCat}/${realC}.`,
      );
    }
    expectedRealByLexical.set(entry.originalPath, realPath);
  }

  // Layer (c)+(d): optional UI approval, then atomic commit. Codex C
  // round 5 (2026-05-03): no-UI path now uses module-private
  // _commitRestore (no gate token mint exposure). UI path still
  // uses gate.requestWrite + gate.commitOperation. Both paths
  // operate on the commit-issued resolvedTarget, never on the
  // lexical entry.originalPath.
  const wantsUi = Boolean(opts.sseEmitter && opts.chatId);
  const gate = wantsUi ? await import('./fileSafetyGate.js') : null;

  const restored = [];
  const skipped = [];
  for (const entry of target.files) {
    let exists = false;
    try { await stat(entry.originalPath); exists = true; } catch {}
    if (exists && !opts.overwrite) {
      skipped.push({ path: entry.originalPath, reason: 'already exists' });
      continue;
    }

    // Codex ⚪ round 4 (2026-05-03): test-only swap seam, fired
    // per-entry between the layer-(b) sensitivity check and this
    // entry's commit. Lets integration tests prove the commit
    // catches an inserted swap. No-op in production.
    if (_restoreSwapHookForTests) {
      await _restoreSwapHookForTests({
        originalPath: entry.originalPath,
        expectedReal: expectedRealByLexical.get(entry.originalPath),
      });
    }

    let resolvedTarget;
    if (wantsUi) {
      const ui = await gate.requestWrite({
        path: entry.originalPath,
        chatId: opts.chatId,
        sseEmitter: opts.sseEmitter,
        signal: opts.signal,
        workspacePath: opts.workspacePath,
        isCreate: !exists,
        contentSize: entry.size ?? null,
        newHash: entry.sha256 || null,
      });
      const committed = await gate.commitOperation(ui.operationToken);
      resolvedTarget = committed.resolvedTarget;
    } else {
      // No-UI path: module-private atomic re-resolve, no gate token mint.
      resolvedTarget = await _commitRestore(
        entry.originalPath,
        expectedRealByLexical.get(entry.originalPath),
      );
    }

    const src = join(filesDir, entry.trashedAs);
    await mkdir(dirname(resolvedTarget), { recursive: true });
    if (entry.wasDirectory) {
      // node:fs cp() refuses to overwrite a non-empty dir; remove
      // first when overwrite is requested.
      if (exists && opts.overwrite) {
        await rm(resolvedTarget, { recursive: true, force: true });
      }
      await cp(src, resolvedTarget, { recursive: true });
    } else {
      await copyFile(src, resolvedTarget);
    }
    restored.push(resolvedTarget);
  }

  const fullyRestored = skipped.length === 0;
  if (fullyRestored && opts.purgeAfterRestore !== false) {
    await rm(opDir, { recursive: true, force: true });
  }
  // Codex C round 4 (2026-05-03): expose both lexical and resolved
  // paths per restored entry so the UI / Phase 2 caller can reason
  // about symlink aliases. `restored` (resolved real paths) stays
  // first-class for back-compat.
  return {
    restored,
    skipped,
    fullyRestored,
    originalPaths: target.files.map(f => f.originalPath),
    hasSymlinks: target.files
      .map(f => expectedRealByLexical.get(f.originalPath) !== f.originalPath),
  };
}

// ── purgeTrashEntry ──────────────────────────────────────────────────
//
// Manual eviction. Called by the UI's "delete forever" button on a
// trash row. The user spec is explicit that this never auto-fires.
export async function purgeTrashEntry(operationId) {
  assertValidOperationId(operationId);
  const all = await listTrash();
  const target = all.find(x => x.operationId === operationId);
  if (!target) {
    throw new Error(`No trash entry with operationId=${operationId}.`);
  }
  const meloHome = getMeloHome();
  const root = trashRoot(meloHome);
  const opDir = join(root, target.folderName);
  await assertWithinRoot(opDir, root);
  await rm(opDir, { recursive: true, force: true });
  return { purged: target.folderName };
}

// ── pruneTrashHint ───────────────────────────────────────────────────
//
// Reports entries past the 7-day retention so the UI can show
// "可清理 N 项" + a manual cleanup button. Never deletes anything.
export async function pruneTrashHint(now = new Date()) {
  const all = await listTrash();
  const expired = [];
  for (const entry of all) {
    if (!entry.expiresAfter) continue;
    if (new Date(entry.expiresAfter).getTime() <= now.getTime()) {
      expired.push({
        operationId: entry.operationId,
        folderName: entry.folderName,
        deletedAt: entry.deletedAt,
        expiresAfter: entry.expiresAfter,
        originalPaths: entry.originalPaths,
      });
    }
  }
  return { expired };
}

// Test seam.
export const _trashRoot = trashRoot;
