/**
 * backup.test.js — pin snapshotBeforeWrite + recordAfterDiff + restore
 * + list + prune + purge against a temp MELO_HOME.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, mkdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freshBackup() {
  const mod = await import(`./backup.js?tc=${Date.now()}-${Math.random()}`);
  return mod;
}

// Helper sets MELO_HOME to one tempdir (where .melo-backups/ lives)
// AND creates a SEPARATE workspace tempdir for the user's files.
// In production, MELO_HOME and the user's workspace are always
// distinct — backing up files inside MELO_HOME would conflict with
// the melo_internal hard-block at restore time. Tests must mirror
// that separation.
async function withTempMeloHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'melo-backup-home-'));
  // Codex D round 3: realpath() the workspace so the gate's commit-time
  // re-resolve doesn't mismatch on macOS /var → /private/var.
  const ws = await realpath(await mkdtemp(join(tmpdir(), 'melo-backup-ws-')));
  const prev = process.env.MELO_HOME;
  process.env.MELO_HOME = home;
  try {
    await mkdir(home, { recursive: true });
    await mkdir(ws, { recursive: true });
    await fn(ws, home);
  } finally {
    if (prev === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prev;
    await rm(home, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  }
}

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// ─── snapshotBeforeWrite ───────────────────────────────────────────────

test('snapshotBeforeWrite copies the file into before/ and writes manifest', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite } = await freshBackup();
    const target = join(home, 'work', 'a.txt');
    await mkdir(join(home, 'work'), { recursive: true });
    await writeFile(target, 'pre-write content', 'utf8');

    const result = await snapshotBeforeWrite(target, {
      chatId: 'chat-A',
      requestedBy: 'agent',
      reason: 'about to overwrite',
    });

    assert.equal(result.wasMissing, false);
    assert.ok(result.beforePath);
    assert.equal(await readFile(result.beforePath, 'utf8'), 'pre-write content');

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.originalPath, target);
    assert.equal(manifest.chatId, 'chat-A');
    assert.equal(manifest.requestedBy, 'agent');
    assert.equal(manifest.wasMissing, false);
    assert.equal(manifest.size, 17);
    assert.match(manifest.sha256 || '', /^[0-9a-f]{64}$/);
    assert.match(manifest.expiresAfter, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(manifest.afterDiffRecorded, false);
  });
});

test('snapshotBeforeWrite for missing file records wasMissing=true (no copy)', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite } = await freshBackup();
    const target = join(home, 'never-existed.txt');
    const result = await snapshotBeforeWrite(target);

    assert.equal(result.wasMissing, true);
    assert.equal(result.beforePath, null);

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.wasMissing, true);
    assert.equal(manifest.size, null);
    assert.equal(manifest.sha256, null);
  });
});

test('snapshotBeforeWrite refuses directories (writes are file-level)', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite } = await freshBackup();
    const target = join(home, 'somedir');
    await mkdir(target, { recursive: true });
    await assert.rejects(snapshotBeforeWrite(target), /does not support directories/);
  });
});

test('snapshotBeforeWrite with empty path throws', async () => {
  await withTempMeloHome(async () => {
    const { snapshotBeforeWrite } = await freshBackup();
    await assert.rejects(snapshotBeforeWrite(''), /requires an absolute path/);
  });
});

test('snapshotBeforeWrite uses provided operationId for correlation', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite, listBackups } = await freshBackup();
    const target = join(home, 'a.txt');
    await writeFile(target, 'hi', 'utf8');
    const result = await snapshotBeforeWrite(target, { operationId: 'op-fixed-123' });
    assert.equal(result.operationId, 'op-fixed-123');

    const list = await listBackups();
    assert.equal(list.length, 1);
    assert.equal(list[0].operationId, 'op-fixed-123');
  });
});

// ─── recordAfterDiff ───────────────────────────────────────────────────

test('recordAfterDiff persists a diff and flips manifest.afterDiffRecorded', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite, recordAfterDiff } = await freshBackup();
    const target = join(home, 'a.txt');
    await writeFile(target, 'old', 'utf8');
    const snap = await snapshotBeforeWrite(target);

    const diff = '--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-old\n+new\n';
    const result = await recordAfterDiff(snap.operationId, diff);
    assert.equal(result.ok, true);
    assert.equal(await readFile(result.diffPath, 'utf8'), diff);

    const manifest = JSON.parse(await readFile(snap.manifestPath, 'utf8'));
    assert.equal(manifest.afterDiffRecorded, true);
  });
});

test('recordAfterDiff on unknown operationId throws', async () => {
  await withTempMeloHome(async () => {
    const { recordAfterDiff } = await freshBackup();
    // Codex D round 3: assertWithinRoot now uniformizes the "no
    // entry" shape across purge/restore/recordAfterDiff. Either
    // the in-root check (root missing → no entry) or the readFile
    // (root present but manifest missing → no manifest) can fire.
    await assert.rejects(
      recordAfterDiff('not-realll', 'x'),
      /No backup (manifest|with operationId)/,
    );
  });
});

// ─── restoreFromBackup ─────────────────────────────────────────────────

test('restoreFromBackup brings a modified file back to its pre-write state', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite, restoreFromBackup } = await freshBackup();
    const target = join(home, 'a.txt');
    await writeFile(target, 'original', 'utf8');
    const snap = await snapshotBeforeWrite(target);

    // Simulate the actual write that the gate would perform.
    await writeFile(target, 'changed (oops)', 'utf8');

    const result = await restoreFromBackup(snap.operationId);
    assert.equal(result.restored, target);
    assert.equal(await readFile(target, 'utf8'), 'original');
  });
});

test('restoreFromBackup of a "create" snapshot deletes the file (undo of new-create)', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite, restoreFromBackup } = await freshBackup();
    const target = join(home, 'created.txt');
    // File doesn't exist → snapshot records wasMissing.
    const snap = await snapshotBeforeWrite(target);

    // Simulate the write that just created the file.
    await writeFile(target, 'fresh content', 'utf8');
    assert.equal(await fileExists(target), true);

    await restoreFromBackup(snap.operationId);
    assert.equal(await fileExists(target), false, 'undo of create should remove the file');
  });
});

test('restoreFromBackup defaults to purging the entry after success', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite, restoreFromBackup, listBackups } = await freshBackup();
    const target = join(home, 'a.txt');
    await writeFile(target, 'x', 'utf8');
    const snap = await snapshotBeforeWrite(target);
    await writeFile(target, 'y', 'utf8');
    await restoreFromBackup(snap.operationId);
    assert.equal((await listBackups()).length, 0);
  });
});

test('restoreFromBackup with purgeAfterRestore:false keeps the entry around', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite, restoreFromBackup, listBackups } = await freshBackup();
    const target = join(home, 'a.txt');
    await writeFile(target, 'x', 'utf8');
    const snap = await snapshotBeforeWrite(target);
    await writeFile(target, 'y', 'utf8');
    await restoreFromBackup(snap.operationId, { purgeAfterRestore: false });
    const list = await listBackups();
    assert.equal(list.length, 1);
  });
});

test('restoreFromBackup on unknown operationId throws', async () => {
  await withTempMeloHome(async () => {
    const { restoreFromBackup } = await freshBackup();
    await assert.rejects(restoreFromBackup('not-real'), /No backup with operationId/);
  });
});

// ─── listBackups ───────────────────────────────────────────────────────

test('listBackups returns [] when no backup dir exists', async () => {
  await withTempMeloHome(async () => {
    const { listBackups } = await freshBackup();
    assert.deepEqual(await listBackups(), []);
  });
});

test('listBackups returns entries newest-first', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite, listBackups } = await freshBackup();
    const target = join(home, 'a.txt');
    await writeFile(target, '1', 'utf8');
    const a = await snapshotBeforeWrite(target);
    await writeFile(target, '2', 'utf8');
    const b = await snapshotBeforeWrite(target);
    // Sorting is a persisted-timestamp contract, not a wall-clock/timer test.
    for (const [entry, timestamp] of [[a, '2026-01-01T00:00:00.000Z'], [b, '2026-01-02T00:00:00.000Z']]) {
      const path = join(entry.opDir, 'manifest.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...manifest, snapshotAt: timestamp }));
    }
    const list = await listBackups();
    assert.equal(list.length, 2);
    assert.equal(list[0].operationId, b.operationId, 'newest first');
    assert.equal(list[1].operationId, a.operationId);
  });
});

// ─── purgeBackup ───────────────────────────────────────────────────────

test('purgeBackup removes one entry permanently', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite, purgeBackup, listBackups } = await freshBackup();
    const target = join(home, 'a.txt');
    await writeFile(target, 'x', 'utf8');
    const snap = await snapshotBeforeWrite(target);
    await purgeBackup(snap.operationId);
    assert.equal((await listBackups()).length, 0);
  });
});

test('purgeBackup on unknown operationId throws', async () => {
  await withTempMeloHome(async () => {
    const { purgeBackup } = await freshBackup();
    await assert.rejects(purgeBackup('not-real'), /No backup with operationId/);
  });
});

// ─── pruneBackupsHint ──────────────────────────────────────────────────

test('pruneBackupsHint reports nothing fresh', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite, pruneBackupsHint } = await freshBackup();
    const target = join(home, 'a.txt');
    await writeFile(target, 'x', 'utf8');
    await snapshotBeforeWrite(target);
    const { expired } = await pruneBackupsHint();
    assert.deepEqual(expired, []);
  });
});

test('pruneBackupsHint flags entries past 7 days; never deletes them', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite, pruneBackupsHint, listBackups, BACKUP_RETENTION_MS } = await freshBackup();
    const target = join(home, 'a.txt');
    await writeFile(target, 'x', 'utf8');
    const snap = await snapshotBeforeWrite(target);
    const future = new Date(Date.now() + BACKUP_RETENTION_MS + 24 * 60 * 60 * 1000);
    const { expired } = await pruneBackupsHint(future);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].operationId, snap.operationId);
    // Disk state untouched.
    assert.equal((await listBackups()).length, 1);
  });
});
