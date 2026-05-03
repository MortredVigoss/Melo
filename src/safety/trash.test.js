/**
 * trash.test.js — pin the safe-delete + restore + list + prune
 * lifecycle. All tests run against a fresh MELO_HOME tempdir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, stat, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freshTrash() {
  const mod = await import(`./trash.js?tc=${Date.now()}-${Math.random()}`);
  return mod;
}

// MELO_HOME and the user workspace must be distinct — files inside
// MELO_HOME classify as melo_internal and are hard-blocked on restore.
// Tests mirror the production separation.
async function withTempMeloHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'melo-trash-home-'));
  const ws = await mkdtemp(join(tmpdir(), 'melo-trash-ws-'));
  const prev = process.env.MELO_HOME;
  process.env.MELO_HOME = home;
  try {
    await mkdir(home, { recursive: true });
    await mkdir(ws, { recursive: true });
    // Pass the workspace dir; tests that touch MELO_HOME directly
    // can read process.env.MELO_HOME or accept a 2nd arg.
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

// ─── safeDeleteToTrash ─────────────────────────────────────────────────

test('safeDeleteToTrash moves a single file to trash and unlinks original', async () => {
  await withTempMeloHome(async (home) => {
    const { safeDeleteToTrash } = await freshTrash();
    const target = join(home, 'work', 'a.txt');
    await mkdir(join(home, 'work'), { recursive: true });
    await writeFile(target, 'hello', 'utf8');

    const result = await safeDeleteToTrash([target], {
      reason: 'test',
      requestedBy: 'agent',
      chatId: 'chat-A',
    });

    assert.equal(result.removed.length, 1);
    assert.equal(result.failed.length, 0);
    assert.equal(await fileExists(target), false, 'original should be unlinked');
    assert.equal(await fileExists(result.manifestPath), true, 'manifest exists');

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.requestedBy, 'agent');
    assert.equal(manifest.chatId, 'chat-A');
    assert.equal(manifest.reason, 'test');
    assert.equal(manifest.restorable, true);
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].originalPath, target);
    assert.equal(manifest.files[0].size, 5);
    assert.match(manifest.files[0].sha256 || '', /^[0-9a-f]{64}$/);
    assert.match(manifest.expiresAfter, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('safeDeleteToTrash fails cleanly when source does not exist', async () => {
  await withTempMeloHome(async (home) => {
    const { safeDeleteToTrash } = await freshTrash();
    await assert.rejects(
      safeDeleteToTrash([join(home, 'nope.txt')]),
      /source not found/i,
    );
    // No orphan trash dir left behind
    const trashRoot = join(home, '.melo-trash');
    let entries = [];
    try { entries = await readdir(trashRoot); } catch {}
    assert.deepEqual(entries, [], 'trash root should be empty after a failed delete');
  });
});

test('safeDeleteToTrash handles a directory recursively', async () => {
  await withTempMeloHome(async (home) => {
    const { safeDeleteToTrash } = await freshTrash();
    const dir = join(home, 'work', 'mydir');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'a', 'utf8');
    await writeFile(join(dir, 'sub', 'b.txt'), 'b', 'utf8');

    const result = await safeDeleteToTrash([dir]);
    assert.equal(result.removed[0], dir);
    assert.equal(await fileExists(dir), false);

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.files[0].wasDirectory, true);
    // The recursive copy should have stashed both files under files/<hash>/
    const trashed = join(result.opDir, 'files', manifest.files[0].trashedAs);
    assert.equal(await fileExists(join(trashed, 'a.txt')), true);
    assert.equal(await fileExists(join(trashed, 'sub', 'b.txt')), true);
  });
});

test('safeDeleteToTrash batch: multiple files in one operation = one folder', async () => {
  await withTempMeloHome(async (home) => {
    const { safeDeleteToTrash } = await freshTrash();
    await mkdir(join(home, 'w'), { recursive: true });
    const a = join(home, 'w', 'a.txt');
    const b = join(home, 'w', 'b.txt');
    await writeFile(a, 'A', 'utf8');
    await writeFile(b, 'B', 'utf8');

    const result = await safeDeleteToTrash([a, b]);
    assert.equal(result.removed.length, 2);

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.files.length, 2);
    assert.deepEqual(
      manifest.files.map(f => f.originalPath).sort(),
      [a, b].sort(),
    );
  });
});

test('safeDeleteToTrash: one missing source aborts ALL deletes (no partial damage)', async () => {
  await withTempMeloHome(async (home) => {
    const { safeDeleteToTrash } = await freshTrash();
    await mkdir(join(home, 'w'), { recursive: true });
    const a = join(home, 'w', 'a.txt');
    const ghost = join(home, 'w', 'ghost.txt');
    await writeFile(a, 'A', 'utf8');

    await assert.rejects(safeDeleteToTrash([a, ghost]), /source not found/i);
    // a must still exist — we backed out before any unlink
    assert.equal(await fileExists(a), true, 'real file should not be unlinked when batch fails');
  });
});

// ─── listTrash / restoreFromTrash / purge ──────────────────────────────

test('listTrash returns all entries newest-first', async () => {
  await withTempMeloHome(async (home) => {
    const { safeDeleteToTrash, listTrash } = await freshTrash();
    await mkdir(join(home, 'w'), { recursive: true });
    const a = join(home, 'w', 'a.txt');
    const b = join(home, 'w', 'b.txt');
    await writeFile(a, '1', 'utf8');
    await writeFile(b, '2', 'utf8');
    await safeDeleteToTrash([a]);
    // Sleep 5ms so deletedAt timestamps differ
    await new Promise(r => setTimeout(r, 5));
    await safeDeleteToTrash([b]);
    const list = await listTrash();
    assert.equal(list.length, 2);
    assert.ok(
      list[0].deletedAt >= list[1].deletedAt,
      `newest first; got ${list[0].deletedAt} then ${list[1].deletedAt}`,
    );
  });
});

test('listTrash returns [] when no trash dir exists', async () => {
  await withTempMeloHome(async () => {
    const { listTrash } = await freshTrash();
    const list = await listTrash();
    assert.deepEqual(list, []);
  });
});

test('restoreFromTrash brings files back and (default) cleans the entry', async () => {
  await withTempMeloHome(async (home) => {
    const { safeDeleteToTrash, restoreFromTrash, listTrash } = await freshTrash();
    const target = join(home, 'w', 'a.txt');
    await mkdir(join(home, 'w'), { recursive: true });
    await writeFile(target, 'original', 'utf8');

    const del = await safeDeleteToTrash([target]);
    assert.equal(await fileExists(target), false);

    const result = await restoreFromTrash(del.operationId);
    assert.deepEqual(result.restored, [target]);
    assert.equal(result.fullyRestored, true);
    assert.equal(await fileExists(target), true);
    assert.equal(await readFile(target, 'utf8'), 'original');

    // Trash entry purged after full restore
    const list = await listTrash();
    assert.equal(list.length, 0);
  });
});

test('restoreFromTrash refuses to clobber an existing file (default)', async () => {
  await withTempMeloHome(async (home) => {
    const { safeDeleteToTrash, restoreFromTrash } = await freshTrash();
    const target = join(home, 'w', 'a.txt');
    await mkdir(join(home, 'w'), { recursive: true });
    await writeFile(target, 'original', 'utf8');
    const del = await safeDeleteToTrash([target]);

    // User writes a new file at the same spot before restoring.
    await writeFile(target, 'new content', 'utf8');

    const result = await restoreFromTrash(del.operationId);
    assert.equal(result.fullyRestored, false);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.restored.length, 0);
    // The new content must NOT have been overwritten.
    assert.equal(await readFile(target, 'utf8'), 'new content');
  });
});

test('restoreFromTrash with overwrite:true clobbers existing files', async () => {
  await withTempMeloHome(async (home) => {
    const { safeDeleteToTrash, restoreFromTrash } = await freshTrash();
    const target = join(home, 'w', 'a.txt');
    await mkdir(join(home, 'w'), { recursive: true });
    await writeFile(target, 'original', 'utf8');
    const del = await safeDeleteToTrash([target]);
    await writeFile(target, 'collision', 'utf8');

    const result = await restoreFromTrash(del.operationId, { overwrite: true });
    assert.equal(result.fullyRestored, true);
    assert.equal(await readFile(target, 'utf8'), 'original');
  });
});

test('restoreFromTrash on unknown operationId throws', async () => {
  await withTempMeloHome(async () => {
    const { restoreFromTrash } = await freshTrash();
    await assert.rejects(restoreFromTrash('not-a-real-id'), /No trash entry/);
  });
});

test('purgeTrashEntry removes the entry permanently', async () => {
  await withTempMeloHome(async (home) => {
    const { safeDeleteToTrash, purgeTrashEntry, listTrash } = await freshTrash();
    const target = join(home, 'w', 'a.txt');
    await mkdir(join(home, 'w'), { recursive: true });
    await writeFile(target, 'x', 'utf8');
    const del = await safeDeleteToTrash([target]);

    const result = await purgeTrashEntry(del.operationId);
    assert.equal(result.purged, del.folderName);
    assert.equal((await listTrash()).length, 0);
  });
});

test('purgeTrashEntry on unknown operationId throws', async () => {
  await withTempMeloHome(async () => {
    const { purgeTrashEntry } = await freshTrash();
    await assert.rejects(purgeTrashEntry('not-a-real-id'), /No trash entry/);
  });
});

// ─── pruneTrashHint ────────────────────────────────────────────────────

test('pruneTrashHint reports nothing for fresh entries', async () => {
  await withTempMeloHome(async (home) => {
    const { safeDeleteToTrash, pruneTrashHint } = await freshTrash();
    const target = join(home, 'w', 'a.txt');
    await mkdir(join(home, 'w'), { recursive: true });
    await writeFile(target, 'x', 'utf8');
    await safeDeleteToTrash([target]);

    const { expired } = await pruneTrashHint();
    assert.deepEqual(expired, []);
  });
});

test('pruneTrashHint flags entries past the 7-day retention but does NOT delete them', async () => {
  await withTempMeloHome(async (home) => {
    const { safeDeleteToTrash, pruneTrashHint, listTrash, TRASH_RETENTION_MS } = await freshTrash();
    const target = join(home, 'w', 'a.txt');
    await mkdir(join(home, 'w'), { recursive: true });
    await writeFile(target, 'x', 'utf8');
    const del = await safeDeleteToTrash([target]);

    // Simulate "now" being 8 days later.
    const future = new Date(Date.now() + TRASH_RETENTION_MS + 24 * 60 * 60 * 1000);
    const { expired } = await pruneTrashHint(future);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].operationId, del.operationId);

    // The entry MUST still be on disk — pruneTrashHint never deletes.
    const list = await listTrash();
    assert.equal(list.length, 1, 'pruneTrashHint must never auto-delete');
  });
});

// ─── Folder-name shape ─────────────────────────────────────────────────

test('safeDeleteToTrash folder name has shape YYYY-MM-DD_<12-char-hash>', async () => {
  await withTempMeloHome(async (home) => {
    const { safeDeleteToTrash } = await freshTrash();
    const target = join(home, 'a.txt');
    await writeFile(target, 'x', 'utf8');
    const result = await safeDeleteToTrash([target]);
    assert.match(result.folderName, /^\d{4}-\d{2}-\d{2}_[0-9a-f]{12}$/);
  });
});
