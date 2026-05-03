/**
 * symlinkDelete.test.js — Codex D round 7 (2026-05-03) regression.
 *
 * Pins the unix unlink() semantics for delete-via-symlink:
 *   1. workspace/link → outside/benign-file: delete LINK only;
 *      the external file MUST stay.
 *   2. workspace/link → /etc/hosts (sensitive): hard-rejected at
 *      the safeDeleteToTrash gate. The link stays, /etc/hosts
 *      obviously stays.
 *   3. workspace/link → outside/file with a swap injected after
 *      approval: commit catches the swap, abort, BOTH the
 *      original target and the new target are untouched.
 *   4. workspace/dir-link → outside/dir: delete LINK only; the
 *      external directory survives.
 *   5. End-to-end round trip: trash a symlink, restore from trash,
 *      assert the link points at the same target string.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, basename } from 'node:path';
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  mkdir,
  symlink,
  readlink,
  lstat,
  stat,
  unlink,
} from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { deleteToTrash } from './_testHelpers.js';

const HOME = homedir();

async function withSplitMeloHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'melo-symdel-home-'));
  const ws = await realpath(await mkdtemp(join(tmpdir(), 'melo-symdel-ws-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'melo-symdel-out-')));
  const prev = process.env.MELO_HOME;
  process.env.MELO_HOME = home;
  try {
    await mkdir(home, { recursive: true });
    await fn(ws, outside, home);
  } finally {
    if (prev === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prev;
    await rm(home, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

async function freshTrash() {
  return import(`./trash.js?tc=${Date.now()}-${Math.random()}`);
}
async function freshGate() {
  const grants = await import('./chatScopedGrants.js');
  grants.clearChat();
  const gate = await import('./fileSafetyGate.js');
  gate._clearPendingForTests();
  return gate;
}
async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}
async function pathExists(p) {
  try { await lstat(p); return true; } catch { return false; }
}

// ─── 1. benign external target — delete LINK, keep target ─────────────

test('delete workspace symlink → outside benign file: removes the link, leaves the external file intact', async () => {
  await withSplitMeloHome(async (ws, outside) => {
    const trash = await freshTrash();
    const gate = await freshGate();
    const externalFile = join(outside, 'target.txt');
    const link = join(ws, 'link');
    await writeFile(externalFile, 'precious', 'utf8');
    await symlink(externalFile, link);

    const result = await deleteToTrash(gate, trash, [link], { workspacePath: ws });
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0], link, 'removed[] reports the link path, not the target');
    // The link itself is gone:
    assert.equal(await pathExists(link), false, 'link removed');
    // The external file MUST still exist:
    assert.equal(await fileExists(externalFile), true, 'external target file MUST be untouched');
    assert.equal(await readFile(externalFile, 'utf8'), 'precious');
  });
});

// ─── 2. sensitive target — hard-rejected ──────────────────────────────

test('delete workspace symlink → /etc/hosts: hard-rejected; link stays', async () => {
  await withSplitMeloHome(async (ws) => {
    const trash = await freshTrash();
    const gate = await freshGate();
    const link = join(ws, 'sneaky');
    await symlink('/etc/hosts', link);

    await assert.rejects(
      deleteToTrash(gate, trash, [link], { workspacePath: ws }),
      /blocked by safety policy/i,
    );
    assert.equal(await pathExists(link), true, 'link must still be present after refusal');
    assert.equal(await readlink(link), '/etc/hosts');
  });
});

// ─── 3. post-approval swap → commit catches; nothing deleted ──────────

test('symlink delete with post-approval swap: commit aborts, both targets untouched', async () => {
  // Setup: ws/link → outside/A. Approve via requestDelete. Before
  // safeDeleteToTrash runs, swap link to point at outside/B. The
  // commit must detect the realpath mismatch and abort. After
  // abort: link still on disk (we may or may not have rewritten it
  // — the test verifies the swap-injected dst is untouched, and the
  // original A target is also untouched).
  await withSplitMeloHome(async (ws, outside) => {
    const trash = await freshTrash();
    const gate = await freshGate();
    const fileA = join(outside, 'a.txt');
    const fileB = join(outside, 'b.txt');
    await writeFile(fileA, 'A', 'utf8');
    await writeFile(fileB, 'B', 'utf8');
    const link = join(ws, 'mylink');
    await symlink(fileA, link);

    let stage = 0;
    const sse = (event, payload) => {
      const decision = stage === 0
        ? { scope: 'once' }
        : { scope: 'once', confirmInput: 'mylink' };
      stage++;
      queueMicrotask(() =>
        gate.resolveFileSafety(payload.requestId, decision.scope, {
          confirmInput: decision.confirmInput,
        }),
      );
    };

    const approved = await gate.requestDelete({
      paths: [link],
      chatId: 'chat-X',
      sseEmitter: sse,
      workspacePath: ws,
    });

    // Attacker race: swap the link target before safeDeleteToTrash
    // gets to commit.
    await unlink(link);
    await symlink(fileB, link);

    await assert.rejects(
      trash.safeDeleteToTrash({ operationTokens: approved.operationTokens }),
      (err) =>
        err.code === 'FILE_SAFETY_DENIED' &&
        /Path mapping changed/i.test(err.message),
    );

    // Both external files untouched:
    assert.equal(await readFile(fileA, 'utf8'), 'A');
    assert.equal(await readFile(fileB, 'utf8'), 'B');
    assert.equal((await trash.listTrash()).length, 0);
  });
});

// ─── 4. directory symlink — delete the LINK, not the dir ──────────────

test('delete workspace symlink → outside/dir: removes the link, leaves the directory intact', async () => {
  await withSplitMeloHome(async (ws, outside) => {
    const trash = await freshTrash();
    const gate = await freshGate();
    const externalDir = join(outside, 'mydir');
    await mkdir(externalDir, { recursive: true });
    await writeFile(join(externalDir, 'inside.txt'), 'kept', 'utf8');
    const link = join(ws, 'dirlink');
    await symlink(externalDir, link);

    const result = await deleteToTrash(gate, trash, [link], { workspacePath: ws });
    assert.equal(result.removed[0], link, 'removed[] is the link path');
    assert.equal(await pathExists(link), false, 'link gone');
    // External directory + contents intact:
    assert.equal(await fileExists(externalDir), true);
    assert.equal(await readFile(join(externalDir, 'inside.txt'), 'utf8'), 'kept');
  });
});

// ─── 5. round-trip: trash a symlink → restore → link points at same target ─

test('round-trip: trash a benign symlink, then restore, link target string preserved', async () => {
  await withSplitMeloHome(async (ws, outside) => {
    const trash = await freshTrash();
    const gate = await freshGate();
    const externalFile = join(outside, 'target.txt');
    const link = join(ws, 'mylink');
    await writeFile(externalFile, 'data', 'utf8');
    await symlink(externalFile, link);

    const del = await deleteToTrash(gate, trash, [link], { workspacePath: ws });
    assert.equal(await pathExists(link), false);
    assert.equal(await fileExists(externalFile), true);

    const restored = await trash.restoreFromTrash(del.operationId);
    assert.equal(restored.fullyRestored, true);
    assert.equal(restored.restored[0], link);
    // Link recreated with the same target string:
    const lst = await lstat(link);
    assert.equal(lst.isSymbolicLink(), true);
    assert.equal(await readlink(link), externalFile);
    // And following the link still reaches the original file:
    assert.equal(await readFile(link, 'utf8'), 'data');
  });
});

// ─── 6. manifest exposes wasSymlink + symlinkTarget + resolvedPathAtDelete ─

test('trash manifest records wasSymlink + symlinkTarget + resolvedPathAtDelete for symlink entries', async () => {
  await withSplitMeloHome(async (ws, outside) => {
    const trash = await freshTrash();
    const gate = await freshGate();
    const externalFile = join(outside, 'tgt.txt');
    const link = join(ws, 'lnk');
    await writeFile(externalFile, 'x', 'utf8');
    await symlink(externalFile, link);

    const del = await deleteToTrash(gate, trash, [link], { workspacePath: ws });
    const manifest = JSON.parse(await readFile(del.manifestPath, 'utf8'));
    const entry = manifest.files[0];
    assert.equal(entry.wasSymlink, true);
    assert.equal(entry.wasDirectory, false);
    assert.equal(entry.symlinkTarget, externalFile);
    assert.equal(entry.resolvedPathAtDelete, externalFile);
    assert.equal(entry.originalPath, link, 'originalPath is the link, not the target');
  });
});

// ─── 7. regular file delete still records wasSymlink: false ──────────

test('regular-file delete still records wasSymlink:false (back-compat sanity)', async () => {
  await withSplitMeloHome(async (ws) => {
    const trash = await freshTrash();
    const gate = await freshGate();
    const f = join(ws, 'plain.txt');
    await writeFile(f, 'x', 'utf8');
    const del = await deleteToTrash(gate, trash, [f], { workspacePath: ws });
    const manifest = JSON.parse(await readFile(del.manifestPath, 'utf8'));
    assert.equal(manifest.files[0].wasSymlink, false);
    assert.equal(manifest.files[0].symlinkTarget, null);
    assert.equal(manifest.files[0].resolvedPathAtDelete, f);
  });
});
