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
  readlink,
  realpath,
  stat,
  lstat,
  symlink,
  cp,
  readdir,
} from 'node:fs/promises';
import { writeSync, readSync, closeSync as closeFdSync, fstatSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { getMeloHome } from '../config.js';
import {
  isHardBlockedWrite,
  isHardBlockedDelete,
  classifyPath,
} from './sensitivePaths.js';
import { safeResolvePath } from './pathResolver.js';
import {
  atomicOpenLeaf,
  atomicUnlink,
  atomicSymlink,
  openParentDirFd,
  splitParentLeaf,
  _raw,
  C as DC,
} from './dirfdOps.js';

const TRASH_DIR_NAME = '.melo-trash';
export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Codex ⚪ round 4 (2026-05-03): test-only DI seam — see backup.js
// for the full rationale. Default null = no-op in production.
let _restoreSwapHookForTests = null;
export function _setRestoreSwapHookForTests(hook) {
  _restoreSwapHookForTests = typeof hook === 'function' ? hook : null;
}

// Round 13 follow-up #2 (2026-05-03): test-only seam fired AFTER
// the backup phase captures parent {dev, ino} but BEFORE the final
// unlink loop. Tests inject a parent rmdir+mkdir-different-inode
// here and assert atomicUnlink is refused via the parent {dev, ino}
// cross-check. Default null = no-op in production.
let _postBackupHookForTests = null;
export function _setPostBackupHookForTests(hook) {
  _postBackupHookForTests = typeof hook === 'function' ? hook : null;
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
  // (mismatch / expired / unknown / wrong-kind), we rethrow before
  // _unsafeRaw touches disk — no partial trash entry is ever
  // produced.
  //
  // Codex D round 6 (2026-05-03): every token MUST be a DELETE
  // token. Without this enforcement, a write/edit/move token from
  // the same chat could be replayed here to skip requestDelete's
  // two-stage filename confirmation.
  //
  // Codex D round 7 (2026-05-03): the actual fs op uses the LEXICAL
  // path the user requested, NOT the realpath. realPath is used
  // only for sensitivity classification and TOCTOU verification.
  // Using the resolvedTarget here was a data-loss bug — for a
  // workspace symlink → outside/file, rm'ing the resolvedTarget
  // deleted the external file the link pointed to and left the
  // symlink behind.
  const lexicalPaths = [];
  for (const token of operationTokens) {
    const committed = await gate.commitOperation(token, {
      expectedKind: gate.OP_KIND.DELETE,
    });
    // Defence-in-depth: re-check sensitivity on BOTH lexical and
    // resolvedReal RIGHT BEFORE the actual fs op. A future refactor
    // that loosens the gate must not be able to weaken this layer.
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
      lexicalPaths.push(pair.lexical);
    }
  }

  return _unsafeRawDelete(lexicalPaths, ctx);
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

  // Round 13 follow-up #2 (2026-05-03): backup phase is now dirfd-bound.
  //   - symlink: read target via _raw.readlinkat(parentdirfd, leaf) —
  //     atomic, no path re-walk; recreate in trash via symlink().
  //   - regular file: atomicOpenLeaf(parent, leaf, O_RDONLY) → read
  //     via fd → write to trash dest. O_NOFOLLOW catches leaf swap
  //     to symlink between sensitivity check and our open.
  //   - directory: REFUSED. Recursive directory delete needs dirfd-
  //     walk to be race-free (no atomic primitive for it), and the
  //     UX/blast radius of "delete this whole tree" warrants a
  //     separate design cycle. Users who need to delete a tree must
  //     either (a) file_delete each entry one at a time, or (b)
  //     use bash (Phase 2D will gate it through bashRiskParser).
  //
  // Capture parent {dev, ino} per entry so the final unlink phase
  // below can cross-check that the parent we're about to unlinkat
  // through is the same parent we backed up from.
  const fileEntries = [];
  const parentInoByPath = new Map();
  for (const absPath of inputs) {
    let lst;
    try {
      lst = await lstat(absPath);
    } catch {
      await rm(opDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`safeDeleteToTrash: source not found: ${absPath}`);
    }

    if (lst.isDirectory() && !lst.isSymbolicLink()) {
      await rm(opDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `safeDeleteToTrash refuses to delete directory ${absPath}: ` +
        `recursive directory delete is not yet supported in the round-13 ` +
        `dirfd model (no atomic dirfd-walk primitive). Delete entries ` +
        `one at a time via file_delete, or use bash (Phase 2D gate).`,
      );
    }

    const trashedAs = shortHash(`${absPath}:${Date.now()}:${Math.random()}`);
    const dest = join(filesDir, trashedAs);
    const [parent, leaf] = splitParentLeaf(absPath);

    // Capture parent {dev, ino} via dirfd probe for cross-check at unlink.
    let probefd;
    let parentDev, parentIno;
    try {
      probefd = openParentDirFd(parent);
      const pst = fstatSync(probefd);
      parentDev = pst.dev;
      parentIno = pst.ino;
    } catch (err) {
      await rm(opDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `safeDeleteToTrash: cannot open parent ${parent} of ${absPath}: ${err.message}`,
      );
    } finally {
      if (probefd != null) try { closeFdSync(probefd); } catch {}
    }
    parentInoByPath.set(absPath, { dev: parentDev, ino: parentIno });

    if (lst.isSymbolicLink()) {
      // Read the symlink target atomically through the parent dirfd.
      // _raw.readlinkat does not follow the link (it returns the link's
      // contents as bytes), so the parent dir lookup is the only
      // syscall step we need to defend.
      let pdfd;
      let targetString;
      try {
        pdfd = openParentDirFd(parent);
        targetString = _raw.readlinkat(pdfd, leaf);
      } catch (err) {
        await rm(opDir, { recursive: true, force: true }).catch(() => {});
        throw new Error(`safeDeleteToTrash: readlinkat failed for ${absPath}: ${err.message}`);
      } finally {
        if (pdfd != null) try { closeFdSync(pdfd); } catch {}
      }
      await symlink(targetString, dest);
      let resolvedAtDelete = absPath;
      try {
        const r = await safeResolvePath(absPath);
        resolvedAtDelete = r.realPath;
      } catch {}
      fileEntries.push({
        originalPath: absPath,
        trashedAs,
        wasSymlink: true,
        wasDirectory: false,
        symlinkTarget: targetString,
        resolvedPathAtDelete: resolvedAtDelete,
        size: null,
        sha256: null,
      });
    } else {
      // Regular file: atomicOpenLeaf with O_RDONLY (O_NOFOLLOW added
      // automatically) so a leaf swapped to symlink during the gap
      // between sensitivity check and now is rejected (ELOOP). Read
      // via fd, sha256 the buffer in-memory, then writeFile to trash.
      let openLeaf;
      try {
        openLeaf = await atomicOpenLeaf(parent, leaf, DC.O_RDONLY);
      } catch (err) {
        await rm(opDir, { recursive: true, force: true }).catch(() => {});
        throw new Error(
          `safeDeleteToTrash: atomicOpenLeaf failed for ${absPath}: ${err.message}` +
          (err.code === 'ELOOP' || err.errno === 62
            ? ' (target became a symlink — O_NOFOLLOW)'
            : ''),
        );
      }
      try {
        const fileStat = fstatSync(openLeaf.leafFd);
        // Read full content via the fd we just opened.
        const buf = Buffer.allocUnsafe(fileStat.size);
        let total = 0;
        while (total < fileStat.size) {
          const n = readSync(openLeaf.leafFd, buf, total, fileStat.size - total, total);
          if (n === 0) break;
          total += n;
        }
        const finalBuf = buf.subarray(0, total);
        await writeFile(dest, finalBuf);
        const sha = createHash('sha256').update(finalBuf).digest('hex');
        fileEntries.push({
          originalPath: absPath,
          trashedAs,
          wasSymlink: false,
          wasDirectory: false,
          symlinkTarget: null,
          resolvedPathAtDelete: absPath,
          size: fileStat.size,
          sha256: sha,
        });
      } finally {
        openLeaf.closeLeaf();
      }
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

  if (_postBackupHookForTests) {
    try { await _postBackupHookForTests({ inputs, fileEntries, parentInoByPath }); } catch {}
  }

  // Round 13 follow-up #2 (2026-05-03): final unlink phase opens the
  // parent dirfd, cross-checks {dev, ino} matches the snapshot taken
  // during backup, then unlinkat through that dirfd. Catches
  // parent-rmdir+mkdir-different-inode race during the backup→unlink
  // gap. unlinkat with flags=0 doesn't follow symlinks — symlink
  // entries delete the link, never the target.
  //
  // Directory entries are no longer reachable here (the backup phase
  // refuses them above). The wasDirectory branch is kept for legacy
  // manifests that may have been written before round 13 follow-up #2;
  // they're treated as failures.
  const removed = [];
  const failed = [];
  for (const entry of fileEntries) {
    try {
      const [parent, leaf] = splitParentLeaf(entry.originalPath);
      const parentSnapshot = parentInoByPath.get(entry.originalPath);

      // Cross-check parent {dev, ino} via probe before unlinkat. If
      // the parent was rmdir'd + mkdir'd at the same path between
      // backup and now, atomicUnlink would silently delete the leaf
      // in the NEW (different inode) parent — that's the wrong file.
      let probefd;
      try {
        probefd = openParentDirFd(parent);
        const st = fstatSync(probefd);
        if (
          parentSnapshot &&
          (st.dev !== parentSnapshot.dev || st.ino !== parentSnapshot.ino)
        ) {
          throw new Error(
            `parent ${parent} was replaced (inode/device changed) ` +
            `between backup and final unlink`,
          );
        }
      } finally {
        if (probefd != null) try { closeFdSync(probefd); } catch {}
      }

      if (entry.wasDirectory) {
        // Legacy manifest path — refuse.
        throw new Error(
          `wasDirectory entry no longer supported in final unlink phase ` +
          `(directory delete is refused upstream as of round 13 follow-up #2)`,
        );
      }
      // Files + symlinks: unlinkat through the parent dirfd that
      // matches our backup-time snapshot.
      await atomicUnlink(parent, leaf);
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

  // Round 13 (2026-05-03): parent inode anchor captured via dirfd
  // probe; final fs op binds parent through openat/unlinkat.
  const expectedRealByLexical = new Map();
  const parentInoByLexical = new Map();
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

    // Codex C round 8 (2026-05-03): wasSymlink entries need an extra
    // sensitivity check on the symlinkTarget itself — otherwise a
    // tampered manifest could redirect us to recreate a symlink
    // pointing at /etc/hosts / ~/.ssh / etc. The originalPath check
    // above protects the LINK location; this protects the LINK's
    // TARGET. Both must be safe before we rebuild.
    if (entry.wasSymlink) {
      if (typeof entry.symlinkTarget !== 'string' || !entry.symlinkTarget) {
        throw new Error(
          `Refusing to restore symlink ${entry.originalPath}: ` +
          `manifest is missing a symlinkTarget field.`,
        );
      }
      const targetResolved = await safeResolvePath(
        entry.symlinkTarget.startsWith('/')
          ? entry.symlinkTarget
          // Relative symlink — resolve relative to the link's parent
          // directory (mirrors how the kernel would interpret it).
          : join(dirname(entry.originalPath), entry.symlinkTarget),
      );
      if (
        isHardBlockedWrite(entry.symlinkTarget) ||
        isHardBlockedWrite(targetResolved.realPath)
      ) {
        const targetCat = classifyPath(entry.symlinkTarget);
        const realC = classifyPath(targetResolved.realPath);
        throw new Error(
          `Refusing to restore symlink ${entry.originalPath} → ` +
          `${entry.symlinkTarget} (real target: ${targetResolved.realPath}) ` +
          `— symlink target classified as ${targetCat}/${realC}.`,
        );
      }
      // Manifest-tamper detection: resolvedPathAtDelete must still
      // match the freshly-resolved target. A mismatch means either
      // the symlinkTarget field was modified (attack) OR the
      // outside-world filesystem moved (legit, but require explicit
      // user confirmation rather than silent restore).
      if (
        typeof entry.resolvedPathAtDelete === 'string' &&
        entry.resolvedPathAtDelete !== targetResolved.realPath
      ) {
        throw new Error(
          `Refusing to restore symlink ${entry.originalPath}: ` +
          `manifest resolvedPathAtDelete=${entry.resolvedPathAtDelete} ` +
          `does not match current resolution ${targetResolved.realPath} ` +
          `of symlinkTarget=${entry.symlinkTarget}.`,
        );
      }
    }

    // After sensitivity passes, capture parent inode via a dirfd
    // probe (race detection at the final fs op).
    const parentDir = dirname(entry.originalPath);
    let probefd;
    try {
      probefd = openParentDirFd(parentDir);
      const st = fstatSync(probefd);
      parentInoByLexical.set(entry.originalPath, { ino: st.ino, dev: st.dev });
    } catch (err) {
      throw new Error(
        `Refusing to restore ${entry.originalPath}: cannot open parent ` +
        `${parentDir}: ${err.message}.`,
      );
    } finally {
      if (probefd != null) try { closeFdSync(probefd); } catch {}
    }
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
      // Codex D round 6 (2026-05-03): enforce kind.
      const committed = await gate.commitOperation(ui.operationToken, {
        expectedKinds: [gate.OP_KIND.WRITE_NEW, gate.OP_KIND.WRITE_OVERWRITE],
      });
      resolvedTarget = committed.resolvedTarget;
    } else {
      // No-UI path: module-private atomic re-resolve, no gate token mint.
      resolvedTarget = await _commitRestore(
        entry.originalPath,
        expectedRealByLexical.get(entry.originalPath),
      );
    }

    const src = join(filesDir, entry.trashedAs);
    const parentSnapshot = parentInoByLexical.get(entry.originalPath);

    if (entry.wasSymlink) {
      // Round 13 follow-up #3 (2026-05-03): symlink restore is now
      // dirfd-bound via the new symlinkat addon binding. Probe parent
      // {dev, ino} for cross-check (catches "parent path swapped to
      // a different real dir during approval"), then atomicSymlink
      // resolves the new link's parent through a dirfd opened with
      // O_DIRECTORY|O_NOFOLLOW. No more path-based symlink() race.
      const parentDir = dirname(entry.originalPath);
      const leaf = entry.originalPath.slice(parentDir.length + 1);
      let probefd;
      try {
        probefd = openParentDirFd(parentDir);
        const st = fstatSync(probefd);
        if (st.dev !== parentSnapshot.dev || st.ino !== parentSnapshot.ino) {
          throw new Error(
            `Parent ${parentDir} was replaced (inode/device changed) between ` +
            `safety check and symlink restore.`,
          );
        }
      } finally {
        if (probefd != null) try { closeFdSync(probefd); } catch {}
      }
      if (exists && opts.overwrite) {
        // Use atomicUnlink (unlinkat through the parent dirfd) instead
        // of rm — recursive rm could follow into a dir at this slot.
        try {
          await atomicUnlink(parentDir, leaf);
        } catch (err) {
          // If it's a directory at the slot, atomicUnlink with no
          // removeDir flag fails — surface so the user can decide.
          throw new Error(
            `Cannot remove existing entry at ${entry.originalPath} before ` +
            `symlink restore: ${err.message}`,
          );
        }
      }
      await atomicSymlink(parentDir, leaf, entry.symlinkTarget);
      restored.push(entry.originalPath);
    } else if (entry.wasDirectory) {
      // Round 13 follow-up #2 (2026-05-03): directory restore is
      // refused along with directory delete. Legacy manifests
      // (pre-round-13-followup-2) may contain wasDirectory entries;
      // they're surfaced as DIR_RESTORE_DISABLED so the user knows
      // to recreate manually (or via bash + Phase 2D gate).
      throw new Error(
        `DIR_RESTORE_DISABLED: directory restore at ${entry.originalPath} ` +
        `is refused — recursive directory ops need dirfd-walk semantics ` +
        `not yet implemented in melo's atomic ops layer. Use file_mkdir + ` +
        `file_write per-entry, or bash (with Phase 2D safety gate).`,
      );
    } else {
      // File restore: atomicOpenLeaf binds parent through dirfd and
      // openat-creates the leaf. Cross-check parent {dev, ino}
      // matches precheck. Then writeSync via fd.
      const [resolvedParent, resolvedLeaf] = splitParentLeaf(resolvedTarget);
      let openLeaf;
      try {
        openLeaf = await atomicOpenLeaf(
          resolvedParent,
          resolvedLeaf,
          DC.O_WRONLY | DC.O_CREAT | DC.O_TRUNC,
          0o644,
        );
      } catch (err) {
        if (err.code === 'ELOOP' || err.errno === 62) {
          throw new Error(
            `Refusing to restore over symlink at ${resolvedTarget} ` +
            `(kernel ELOOP via O_NOFOLLOW).`,
          );
        }
        throw err;
      }
      try {
        if (
          openLeaf.parentDev !== parentSnapshot.dev ||
          openLeaf.parentIno !== parentSnapshot.ino
        ) {
          throw new Error(
            `Parent ${resolvedParent} was replaced (inode/device changed) between approval and restore.`,
          );
        }
        const buf = await readFile(src);
        writeSync(openLeaf.leafFd, buf, 0, buf.length, 0);
      } finally {
        openLeaf.closeLeaf();
      }
      restored.push(resolvedTarget);
    }
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
