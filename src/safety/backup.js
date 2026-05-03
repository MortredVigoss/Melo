/**
 * backup.js — auto-snapshot a file before a write/edit so it can be
 * rolled back even if the change isn't a "delete".
 *
 * Layout under $MELO_HOME/.melo-backups/:
 *
 *   .melo-backups/
 *     <operationId>/
 *       before/<basename>    <- the file's pre-write content (if it existed)
 *       after.diff           <- optional, written by recordAfterDiff()
 *       manifest.json
 *
 * One snapshot per operationId. The caller (FileSafetyGate's write/edit
 * path) calls snapshotBeforeWrite() right before performing the write.
 * If the actual write later succeeds, the caller can also call
 * recordAfterDiff() so the manifest captures what changed.
 *
 * Retention mirrors trash.js — the 7-day window is a hint, not an
 * auto-clean. pruneBackupsHint() reports expired entries; the UI must
 * call purgeBackup() explicitly to evict.
 *
 * CLAUDE.md §6 compliance: getMeloHome() is captured synchronously
 * at the top of every public function and never re-read across an
 * await boundary downstream.
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
  readdir,
  open,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, join, sep } from 'node:path';

const { O_RDONLY, O_NOFOLLOW } = fsConstants;

import { getMeloHome } from '../config.js';
import { isHardBlockedWrite, classifyPath } from './sensitivePaths.js';
import { safeResolvePath } from './pathResolver.js';

const BACKUP_DIR_NAME = '.melo-backups';
export const BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Codex ⚪ round 4 (2026-05-03): test-only DI seam to inject a state
// change between layer (b)'s sensitivity check and the commit-on-write
// step. Tests use this to swap a symlink target during the gap a real
// attacker would race for, then assert that the commit step catches
// the swap and aborts the restore. Default null = no-op in production.
// Never call this from production code.
let _restoreSwapHookForTests = null;
export function _setRestoreSwapHookForTests(hook) {
  _restoreSwapHookForTests = typeof hook === 'function' ? hook : null;
}

// Codex C round 5 (2026-05-03): module-private commit helper for the
// no-UI restore path. Re-resolves the originalPath and verifies it
// still maps to the realPath captured at layer (b). Returns the
// fresh resolved target on success; throws FILE_SAFETY_DENIED on
// mismatch — restore must abort rather than write to a swapped target.
//
// Replaces the prior reach-into-gate `_issueOperationToken` design.
// We deliberately do NOT mint or hand out a token here: this is a
// purely local atomic check, no caller-facing API surface.
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

// Whitelist for operationId values supplied by the API / UI. Codex C
// round 1 (2026-05-03): `purgeBackup(operationId)` joined the value
// directly under `.melo-backups/` and rm -r'd it, so a `../` form
// could escape and delete arbitrary directories. Restrict to opaque
// IDs only.
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
function assertValidOperationId(operationId) {
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error(
      `Invalid operationId: must match ${OPERATION_ID_PATTERN}.`,
    );
  }
}

function backupRoot(meloHome) {
  return join(meloHome, BACKUP_DIR_NAME);
}

// Defence-in-depth: even after the operationId pattern check, resolve
// the candidate dir via realpath and assert it sits inside backupRoot.
// Catches the case where backupRoot itself is a symlink whose target
// changed mid-session, or any other path-confusion vector.
//
// When the root itself doesn't exist (no backups have ever been
// taken on this MELO_HOME), the candidate dir definitely doesn't
// exist either — surface the same "No backup with operationId"
// shape so callers see a uniform error.
async function assertWithinRoot(candidateDir, root) {
  let resolvedRoot;
  try {
    resolvedRoot = await realpath(root);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`No backup with operationId at ${candidateDir}.`);
    }
    throw err;
  }
  let resolvedCandidate;
  try {
    resolvedCandidate = await realpath(candidateDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`No backup with operationId at ${candidateDir}.`);
    }
    throw err;
  }
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(resolvedRoot + sep)
  ) {
    throw new Error(
      `Resolved backup path ${resolvedCandidate} is outside backup root ${resolvedRoot}.`,
    );
  }
}

async function fileSha256(absPath) {
  try {
    const buf = await readFile(absPath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

// ── snapshotBeforeWrite ──────────────────────────────────────────────
//
// Copy the file at `absPath` into a fresh backup folder, then write a
// manifest. If the file does not exist (a "create" write), the
// manifest records `wasMissing: true` and no copy is made — restore
// will then re-delete the file rather than reanimate empty content.
//
// Codex D round 3 (2026-05-03): if ctx.operationId is supplied, it
// MUST pass OPERATION_ID_PATTERN. The whitelist already forbids `/`
// and `..`, so the resulting opDir cannot escape backupRoot — but we
// still defend in depth so a malformed value never reaches disk.
//
// Returns { operationId, opDir, beforePath, manifestPath, wasMissing }.
export async function snapshotBeforeWrite(absPath, ctx = {}) {
  if (typeof absPath !== 'string' || !absPath) {
    throw new Error('snapshotBeforeWrite requires an absolute path.');
  }

  const meloHome = getMeloHome();
  let operationId;
  if (ctx.operationId !== undefined && ctx.operationId !== null) {
    assertValidOperationId(ctx.operationId);
    operationId = ctx.operationId;
  } else {
    operationId = randomUUID();
  }
  const opDir = join(backupRoot(meloHome), operationId);
  const beforeDir = join(opDir, 'before');

  let st = null;
  let wasMissing = false;
  try {
    st = await stat(absPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      wasMissing = true;
    } else {
      throw err;
    }
  }

  await mkdir(beforeDir, { recursive: true });

  let beforePath = null;
  let sha = null;
  if (!wasMissing) {
    if (st.isDirectory()) {
      // Backup of an entire directory write is an unusual op — refuse
      // for now. The gate's write/edit paths are file-level.
      await rm(opDir, { recursive: true, force: true }).catch(() => {});
      throw new Error('snapshotBeforeWrite does not support directories.');
    }
    beforePath = join(beforeDir, basename(absPath));
    // Codex D Phase 2A round 5 (2026-05-03): O_NOFOLLOW. If absPath
    // becomes a symlink between the stat() above and this open()
    // (post-commit attacker race), the kernel returns ELOOP and we
    // surface the failure rather than silently reading the symlink's
    // target into the backup folder. copyFile() would have followed.
    let fh;
    try {
      fh = await open(absPath, O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      await rm(opDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `snapshotBeforeWrite refusing to read ${absPath}: ${err.message}` +
        (err.code === 'ELOOP' ? ' (target became a symlink — O_NOFOLLOW)' : ''),
      );
    }
    try {
      const buf = await fh.readFile();
      await writeFile(beforePath, buf);
      sha = createHash('sha256').update(buf).digest('hex');
    } finally {
      await fh.close().catch(() => {});
    }
  }

  const now = new Date();
  const manifest = {
    operationId,
    snapshotAt: now.toISOString(),
    // Codex D Phase 2A round 2 (2026-05-03): callers MUST pass the
    // commit-resolved real path here so this snapshot doesn't follow
    // a symlink that was swapped between commit and snapshot. Phase
    // 2 tools record the user-supplied lexical path separately under
    // `lexicalPath` for UI display.
    originalPath: absPath,
    lexicalPath: typeof ctx.lexicalPath === 'string' && ctx.lexicalPath
      ? ctx.lexicalPath
      : null,
    wasMissing,
    size: st && !st.isDirectory() ? st.size : null,
    sha256: sha,
    expiresAfter: new Date(now.getTime() + BACKUP_RETENTION_MS).toISOString(),
    chatId: ctx.chatId || null,
    requestedBy: ctx.requestedBy || 'agent',
    reason: ctx.reason || null,
    afterDiffRecorded: false,
  };

  const manifestPath = join(opDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return { operationId, opDir, beforePath, manifestPath, wasMissing };
}

// ── recordAfterDiff ──────────────────────────────────────────────────
//
// Persist a unified-diff (or any caller-supplied diff blob) for this
// backup. Called by the gate's write path after the write succeeds.
// Updates the manifest's `afterDiffRecorded` flag so listBackups()
// can flag entries that have a recorded diff vs. those that don't.
//
// Codex D round 3 (2026-05-03): operationId now goes through the same
// whitelist + assertWithinRoot defence as purgeBackup/restoreFromBackup
// so a malformed value cannot direct writes outside .melo-backups.
export async function recordAfterDiff(operationId, diffText) {
  assertValidOperationId(operationId);
  const meloHome = getMeloHome();
  const root = backupRoot(meloHome);
  const opDir = join(root, operationId);
  await assertWithinRoot(opDir, root);
  const manifestPath = join(opDir, 'manifest.json');

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(`No backup manifest for operationId=${operationId}.`);
  }

  await writeFile(join(opDir, 'after.diff'), String(diffText ?? ''), 'utf8');
  manifest.afterDiffRecorded = true;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { ok: true, diffPath: join(opDir, 'after.diff') };
}

// ── listBackups ──────────────────────────────────────────────────────
//
// All backup entries newest-first. Each entry includes the parsed
// manifest plus `opDir` so callers can resolve the before/ contents.
export async function listBackups() {
  const meloHome = getMeloHome();
  const root = backupRoot(meloHome);

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
      out.push({
        opDir: join(root, entry.name),
        ...manifest,
      });
    } catch {
      // Skip orphan / corrupt entries.
    }
  }
  out.sort((a, b) => String(b.snapshotAt).localeCompare(String(a.snapshotAt)));
  return out;
}

// ── restoreFromBackup ────────────────────────────────────────────────
//
// Roll the original file back to its pre-write content. If the
// snapshot recorded `wasMissing: true`, the restore will DELETE the
// current file at originalPath — that's how we undo a "create" write.
//
// Codex C round 2 (2026-05-03) — Q2C double-layer defence:
//   (a) operationId is whitelisted via assertValidOperationId and the
//       resolved opDir is asserted within backup root (mirrors purge*)
//   (b) target.originalPath is safeResolvePath'd at restore time AND
//       classified against BOTH lexical + real; any hard-blocked
//       category throws — a tampered manifest with originalPath
//       pointing at /etc/passwd cannot punch through
//   (c) when opts.sseEmitter + opts.chatId are provided, the actual
//       restore runs through gate.requestWrite for benign paths so
//       the user sees a normal write approval (with symlink warning
//       if applicable). When omitted (programmatic / CLI), only
//       layers (a) + (b) apply.
//
// By default removes the backup folder after a successful restore;
// pass { purgeAfterRestore: false } to keep it for repeat restores.
export async function restoreFromBackup(operationId, opts = {}) {
  assertValidOperationId(operationId);

  const list = await listBackups();
  const target = list.find(b => b.operationId === operationId);
  if (!target) {
    throw new Error(`No backup with operationId=${operationId}.`);
  }

  const meloHome = getMeloHome();
  const root = backupRoot(meloHome);
  await assertWithinRoot(target.opDir || join(root, operationId), root);

  // Layer (b): reject a tampered manifest pointing at a sensitive path.
  const { realPath: realOriginal, hasSymlinkInChain: originalHasSymlink } =
    await safeResolvePath(target.originalPath);
  if (
    isHardBlockedWrite(target.originalPath) ||
    isHardBlockedWrite(realOriginal)
  ) {
    const lexCat = classifyPath(target.originalPath);
    const realC = classifyPath(realOriginal);
    throw new Error(
      `Refusing to restore to ${target.originalPath} ` +
      (originalHasSymlink ? `(real target: ${realOriginal}) ` : '') +
      `— manifest target classified as ${lexCat}/${realC}.`,
    );
  }

  // Codex ⚪ round 4 (2026-05-03): test-only seam — fired AFTER the
  // sensitivity check but BEFORE the commit. Lets integration tests
  // simulate an attacker racing the gap by re-pointing a symlink
  // here; the commit step below MUST then detect the mismatch and
  // abort. No-op in production.
  if (_restoreSwapHookForTests) {
    await _restoreSwapHookForTests({
      originalPath: target.originalPath,
      expectedReal: realOriginal,
    });
  }

  // Layer (c) + (d): atomic approval-and-commit. Codex C round 5
  // (2026-05-03): the no-UI path now uses a module-private
  // _commitRestore helper instead of reaching into gate internals
  // — keeps gate's token-mint API closed to all production code.
  // Both paths still verify the lexical→real mapping atomically
  // before the actual fs op; a symlink swap between layer (b) and
  // copyFile/rm aborts via FILE_SAFETY_DENIED.
  let resolvedTarget;
  if (opts.sseEmitter && opts.chatId && !target.wasMissing) {
    const gate = await import('./fileSafetyGate.js');
    const ui = await gate.requestWrite({
      path: target.originalPath,
      chatId: opts.chatId,
      sseEmitter: opts.sseEmitter,
      signal: opts.signal,
      workspacePath: opts.workspacePath,
      isCreate: false,
      contentSize: target.size ?? null,
      newHash: target.sha256 || null,
    });
    // Codex D round 6 (2026-05-03): enforce kind so a stray
    // edit/delete/move token can't be passed in here.
    const committed = await gate.commitOperation(ui.operationToken, {
      expectedKinds: [gate.OP_KIND.WRITE_NEW, gate.OP_KIND.WRITE_OVERWRITE],
    });
    resolvedTarget = committed.resolvedTarget;
  } else {
    // No-UI path (programmatic / wasMissing undo-create): no user
    // approval, but mandatory atomic re-resolve before fs.
    resolvedTarget = await _commitRestore(target.originalPath, realOriginal);
  }

  if (target.wasMissing) {
    // Undo of a "create" snapshot — remove the resolved target.
    // Using resolvedTarget (not originalPath) means a symlink swap
    // between approval and rm cannot redirect us at a sensitive file.
    await rm(resolvedTarget, { force: true });
  } else {
    const beforePath = join(target.opDir, 'before', basename(target.originalPath));
    await mkdir(join(resolvedTarget, '..'), { recursive: true }).catch(() => {});
    await copyFile(beforePath, resolvedTarget);
  }

  if (opts.purgeAfterRestore !== false) {
    await rm(target.opDir, { recursive: true, force: true });
  }
  // Codex C round 4 (2026-05-03): unify return shape with trash —
  // `restored` is the commit-resolved real path actually written;
  // `originalPath` is the lexical path the manifest captured at
  // backup time; `hasSymlinkInChain` lets the UI flag the alias.
  return {
    restored: resolvedTarget,
    originalPath: target.originalPath,
    hasSymlinkInChain: originalHasSymlink,
  };
}

// ── purgeBackup ──────────────────────────────────────────────────────
//
// Manual eviction. UI's "delete this backup" button.
//
// Codex C round 1 (2026-05-03): operationId is now whitelisted to
// `[A-Za-z0-9_-]{8,64}` and the resolved opDir is asserted to sit
// inside the backup root before any rm. A caller that fakes
// `../../../etc` or pre-shapes a malicious operationId can no longer
// cause this function to remove anything outside `.melo-backups/`.
export async function purgeBackup(operationId) {
  assertValidOperationId(operationId);
  const meloHome = getMeloHome();
  const root = backupRoot(meloHome);
  const opDir = join(root, operationId);
  try { await stat(opDir); } catch {
    throw new Error(`No backup with operationId=${operationId}.`);
  }
  await assertWithinRoot(opDir, root);
  await rm(opDir, { recursive: true, force: true });
  return { purged: operationId };
}

// ── pruneBackupsHint ─────────────────────────────────────────────────
//
// Reports backups past the 7-day retention. NEVER deletes — UI must
// call purgeBackup() explicitly. Mirrors trash.pruneTrashHint shape
// so the UI can render both with the same helper.
export async function pruneBackupsHint(now = new Date()) {
  const list = await listBackups();
  const expired = [];
  for (const entry of list) {
    if (!entry.expiresAfter) continue;
    if (new Date(entry.expiresAfter).getTime() <= now.getTime()) {
      expired.push({
        operationId: entry.operationId,
        snapshotAt: entry.snapshotAt,
        expiresAfter: entry.expiresAfter,
        originalPath: entry.originalPath,
      });
    }
  }
  return { expired };
}

// Test seam.
export const _backupRoot = backupRoot;
