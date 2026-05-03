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
} from 'node:fs/promises';
import { basename, join, sep } from 'node:path';

import { getMeloHome } from '../config.js';

const BACKUP_DIR_NAME = '.melo-backups';
export const BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
async function assertWithinRoot(candidateDir, root) {
  const resolvedRoot = await realpath(root);
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
// Returns { operationId, opDir, beforePath, manifestPath, wasMissing }.
export async function snapshotBeforeWrite(absPath, ctx = {}) {
  if (typeof absPath !== 'string' || !absPath) {
    throw new Error('snapshotBeforeWrite requires an absolute path.');
  }

  const meloHome = getMeloHome();
  const operationId = ctx.operationId || randomUUID();
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
    await copyFile(absPath, beforePath);
    sha = await fileSha256(absPath);
  }

  const now = new Date();
  const manifest = {
    operationId,
    snapshotAt: now.toISOString(),
    originalPath: absPath,
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
export async function recordAfterDiff(operationId, diffText) {
  if (!operationId || typeof operationId !== 'string') {
    throw new Error('recordAfterDiff requires an operationId.');
  }
  const meloHome = getMeloHome();
  const opDir = join(backupRoot(meloHome), operationId);
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
// By default removes the backup folder after a successful restore;
// pass { purgeAfterRestore: false } to keep it for repeat restores.
export async function restoreFromBackup(operationId, opts = {}) {
  if (!operationId || typeof operationId !== 'string') {
    throw new Error('restoreFromBackup requires an operationId.');
  }

  const list = await listBackups();
  const target = list.find(b => b.operationId === operationId);
  if (!target) {
    throw new Error(`No backup with operationId=${operationId}.`);
  }

  if (target.wasMissing) {
    // The original file did not exist at snapshot time. The "before"
    // state is "no file", so restoring means removing whatever's
    // there now. Use force:true so a missing file isn't an error.
    await rm(target.originalPath, { force: true });
  } else {
    const beforePath = join(target.opDir, 'before', basename(target.originalPath));
    await mkdir(join(target.originalPath, '..'), { recursive: true }).catch(() => {});
    await copyFile(beforePath, target.originalPath);
  }

  if (opts.purgeAfterRestore !== false) {
    await rm(target.opDir, { recursive: true, force: true });
  }
  return { restored: target.originalPath };
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
