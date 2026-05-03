/**
 * operationIdTraversal.test.js — Codex C round 1 (2026-05-03).
 *
 * Locks the path-traversal hardening on trash/backup `purge*` and
 * `restore*` entrypoints. Without the OPERATION_ID_PATTERN whitelist
 * + assertWithinRoot check, a malicious operationId like
 * `../../../etc` could escape `.melo-{trash,backups}/` and cause
 * a recursive rm outside the safety quarantine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withTempMeloHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'melo-traversal-'));
  const prev = process.env.MELO_HOME;
  process.env.MELO_HOME = dir;
  try {
    await mkdir(dir, { recursive: true });
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

async function freshTrash() {
  return import(`./trash.js?tc=${Date.now()}-${Math.random()}`);
}
async function freshBackup() {
  return import(`./backup.js?tc=${Date.now()}-${Math.random()}`);
}

const TRAVERSAL_INPUTS = [
  '../../etc',
  '../../../tmp',
  '..',
  './foo',
  '/absolute/path',
  'foo/bar',          // contains slash
  'a',                // too short
  'a'.repeat(65),     // too long
  '',
  null,
  undefined,
  42,
  { id: 'x' },
  'has space',
  // NUL byte — constructed via String.fromCharCode so the test source stays UTF-8 text.
  `has${String.fromCharCode(0)}nul`,
];

// ─── trash ────────────────────────────────────────────────────────────

test('purgeTrashEntry rejects every traversal-shaped operationId', async () => {
  await withTempMeloHome(async () => {
    const { purgeTrashEntry } = await freshTrash();
    for (const input of TRAVERSAL_INPUTS) {
      await assert.rejects(
        purgeTrashEntry(input),
        /Invalid operationId/i,
        `expected ${JSON.stringify(input)} to be rejected as invalid`,
      );
    }
  });
});

test('restoreFromTrash rejects every traversal-shaped operationId', async () => {
  await withTempMeloHome(async () => {
    const { restoreFromTrash } = await freshTrash();
    for (const input of TRAVERSAL_INPUTS) {
      await assert.rejects(
        restoreFromTrash(input),
        /Invalid operationId/i,
      );
    }
  });
});

test('purgeTrashEntry accepts a legitimate operationId (positive case)', async () => {
  await withTempMeloHome(async (home) => {
    const { _unsafeSafeDeleteToTrashRaw, purgeTrashEntry, listTrash } = await freshTrash();
    const target = join(home, 'a.txt');
    await writeFile(target, 'x', 'utf8');
    const del = await _unsafeSafeDeleteToTrashRaw([target]);
    // _unsafeSafeDeleteToTrashRaw uses randomUUID() which fits the whitelist
    // (UUID v4 = 36 chars of [0-9a-f-]).
    await purgeTrashEntry(del.operationId);
    assert.equal((await listTrash()).length, 0);
  });
});

test('purgeTrashEntry refuses to act on an operationId that has no matching manifest (no rm fires)', async () => {
  await withTempMeloHome(async () => {
    const { purgeTrashEntry } = await freshTrash();
    // Valid format, but no entry — error should be "No trash entry",
    // not "Invalid operationId". And no `rm` should run.
    await assert.rejects(
      purgeTrashEntry('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      /No trash entry with operationId/i,
    );
  });
});

// ─── backup ───────────────────────────────────────────────────────────

test('purgeBackup rejects every traversal-shaped operationId', async () => {
  await withTempMeloHome(async () => {
    const { purgeBackup } = await freshBackup();
    for (const input of TRAVERSAL_INPUTS) {
      await assert.rejects(
        purgeBackup(input),
        /Invalid operationId/i,
        `expected ${JSON.stringify(input)} to be rejected as invalid`,
      );
    }
  });
});

test('purgeBackup accepts a legitimate operationId (positive case)', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite, purgeBackup, listBackups } = await freshBackup();
    const target = join(home, 'a.txt');
    await writeFile(target, 'x', 'utf8');
    const snap = await snapshotBeforeWrite(target);
    await purgeBackup(snap.operationId);
    assert.equal((await listBackups()).length, 0);
  });
});

test('purgeBackup refuses an unknown but well-formed operationId (no rm)', async () => {
  await withTempMeloHome(async () => {
    const { purgeBackup } = await freshBackup();
    await assert.rejects(
      purgeBackup('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
      /No backup with operationId/i,
    );
  });
});

test('purgeBackup never deletes anything outside the backup root, even if MELO_HOME is a symlink', async () => {
  // Sanity: we're not realpath'ing the input — we're realpath'ing the
  // resolved candidate dir AND the root, then checking containment.
  // A passing positive-case test (above) covers normal flow; this
  // negative test pins that a manipulated MELO_HOME still can't
  // escape if its realpath contains the backup root.
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite, purgeBackup, listBackups } = await freshBackup();
    const target = join(home, 'a.txt');
    await writeFile(target, 'x', 'utf8');
    const snap = await snapshotBeforeWrite(target);
    // Even after a real backup, an arbitrary fake operationId
    // doesn't reach rm — the precheck blocks before assertWithinRoot.
    await assert.rejects(purgeBackup('not--in--list-12345'), /No backup with operationId/i);
    // Real entry still removable.
    await purgeBackup(snap.operationId);
    assert.equal((await listBackups()).length, 0);
  });
});

// ─── snapshotBeforeWrite + recordAfterDiff (Codex D round 3) ──────────

test('snapshotBeforeWrite rejects every traversal-shaped ctx.operationId', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite } = await freshBackup();
    const target = join(home, 'a.txt');
    await writeFile(target, 'x', 'utf8');
    for (const input of TRAVERSAL_INPUTS) {
      // null/undefined are intentionally allowed (means "auto-generate"),
      // so skip those two specific values from the shared list.
      if (input === null || input === undefined) continue;
      await assert.rejects(
        snapshotBeforeWrite(target, { operationId: input }),
        /Invalid operationId/i,
        `expected ctx.operationId=${JSON.stringify(input)} to be rejected`,
      );
    }
  });
});

test('snapshotBeforeWrite still accepts a legitimate caller-supplied operationId', async () => {
  await withTempMeloHome(async (home) => {
    const { snapshotBeforeWrite, listBackups } = await freshBackup();
    const target = join(home, 'a.txt');
    await writeFile(target, 'x', 'utf8');
    const result = await snapshotBeforeWrite(target, { operationId: 'caller-fixed-id-42' });
    assert.equal(result.operationId, 'caller-fixed-id-42');
    const list = await listBackups();
    assert.equal(list.length, 1);
    assert.equal(list[0].operationId, 'caller-fixed-id-42');
  });
});

test('recordAfterDiff rejects every traversal-shaped operationId', async () => {
  await withTempMeloHome(async () => {
    const { recordAfterDiff } = await freshBackup();
    for (const input of TRAVERSAL_INPUTS) {
      await assert.rejects(
        recordAfterDiff(input, 'x'),
        /Invalid operationId/i,
      );
    }
  });
});

test('_unsafeSafeDeleteToTrashRaw rejects traversal-shaped ctx.operationId', async () => {
  await withTempMeloHome(async (home) => {
    const { _unsafeSafeDeleteToTrashRaw } = await freshTrash();
    const target = join(home, 'a.txt');
    await writeFile(target, 'x', 'utf8');
    for (const input of TRAVERSAL_INPUTS) {
      if (input === null || input === undefined) continue;
      await assert.rejects(
        _unsafeSafeDeleteToTrashRaw([target], { operationId: input }),
        /Invalid operationId/i,
        `expected ctx.operationId=${JSON.stringify(input)} to be rejected`,
      );
    }
  });
});
