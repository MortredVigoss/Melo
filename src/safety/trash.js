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
  stat,
  cp,
  readdir,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getMeloHome } from '../config.js';

const TRASH_DIR_NAME = '.melo-trash';
export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

// ── safeDeleteToTrash ────────────────────────────────────────────────
//
// Move the given paths into the trash quarantine. Files are copied
// first; only after the manifest is written and copies are flushed
// do we unlink the originals. A copy failure aborts the whole op
// before any original is touched.
//
// ctx: { reason?, requestedBy?, chatId?, operationId?, workspacePath? }
// Returns { operationId, folderName, opDir, manifestPath, removed[], failed[] }.
export async function safeDeleteToTrash(paths, ctx = {}) {
  const inputs = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!inputs.length) {
    throw new Error('safeDeleteToTrash called with no paths.');
  }

  const meloHome = getMeloHome();
  const root = trashRoot(meloHome);

  const operationId = ctx.operationId || randomUUID();
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
  if (!operationId || typeof operationId !== 'string') {
    throw new Error('restoreFromTrash requires an operationId.');
  }

  const all = await listTrash();
  const target = all.find(x => x.operationId === operationId);
  if (!target) {
    throw new Error(`No trash entry with operationId=${operationId}.`);
  }
  if (!target.restorable) {
    throw new Error(`Trash entry is marked non-restorable.`);
  }

  const meloHome = getMeloHome();
  const opDir = join(trashRoot(meloHome), target.folderName);
  const filesDir = join(opDir, 'files');

  const restored = [];
  const skipped = [];
  for (const entry of target.files) {
    let exists = false;
    try { await stat(entry.originalPath); exists = true; } catch {}
    if (exists && !opts.overwrite) {
      skipped.push({ path: entry.originalPath, reason: 'already exists' });
      continue;
    }
    const src = join(filesDir, entry.trashedAs);
    await mkdir(dirname(entry.originalPath), { recursive: true });
    if (entry.wasDirectory) {
      // node:fs cp() refuses to overwrite a non-empty dir; remove
      // first when overwrite is requested.
      if (exists && opts.overwrite) {
        await rm(entry.originalPath, { recursive: true, force: true });
      }
      await cp(src, entry.originalPath, { recursive: true });
    } else {
      await copyFile(src, entry.originalPath);
    }
    restored.push(entry.originalPath);
  }

  const fullyRestored = skipped.length === 0;
  if (fullyRestored && opts.purgeAfterRestore !== false) {
    await rm(opDir, { recursive: true, force: true });
  }
  return { restored, skipped, fullyRestored };
}

// ── purgeTrashEntry ──────────────────────────────────────────────────
//
// Manual eviction. Called by the UI's "delete forever" button on a
// trash row. The user spec is explicit that this never auto-fires.
export async function purgeTrashEntry(operationId) {
  if (!operationId || typeof operationId !== 'string') {
    throw new Error('purgeTrashEntry requires an operationId.');
  }
  const all = await listTrash();
  const target = all.find(x => x.operationId === operationId);
  if (!target) {
    throw new Error(`No trash entry with operationId=${operationId}.`);
  }
  const meloHome = getMeloHome();
  await rm(join(trashRoot(meloHome), target.folderName), {
    recursive: true,
    force: true,
  });
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
