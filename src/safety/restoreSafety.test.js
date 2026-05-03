/**
 * restoreSafety.test.js — Codex C round 2 (2026-05-03) Q2C regression.
 *
 * Pins the new double-layer defence on restoreFromBackup +
 * restoreFromTrash:
 *   (a) operationId is whitelisted; opDir is asserted within root
 *   (b) target.originalPath is safeResolvePath'd at restore time AND
 *       classified against BOTH lexical + real; sensitive → throw
 *   (c) when sseEmitter + chatId are passed, the restore drives the
 *       gate's requestWrite for benign paths
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';

async function freshTrash() {
  return import(`./trash.js?tc=${Date.now()}-${Math.random()}`);
}
async function freshBackup() {
  return import(`./backup.js?tc=${Date.now()}-${Math.random()}`);
}
async function freshGate() {
  const grantsMod = await import('./chatScopedGrants.js');
  grantsMod.clearChat();
  const gateMod = await import('./fileSafetyGate.js');
  gateMod._clearPendingForTests();
  return gateMod;
}

async function withSplitHomeAndWorkspace(fn) {
  const home = await mkdtemp(join(tmpdir(), 'melo-restore-home-'));
  const ws = await realpath(await mkdtemp(join(tmpdir(), 'melo-restore-ws-')));
  const prev = process.env.MELO_HOME;
  process.env.MELO_HOME = home;
  try {
    await mkdir(home, { recursive: true });
    await fn(ws, home);
  } finally {
    if (prev === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prev;
    await rm(home, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  }
}

function makeAutoResolver(gate, decisions) {
  let cursor = 0;
  return (event, payload) => {
    const decision = decisions[cursor++] || { scope: 'once' };
    queueMicrotask(() => {
      gate.resolveFileSafety(payload.requestId, decision.scope, {
        confirmInput: decision.confirmInput,
      });
    });
  };
}

// ─── tampered manifest → sensitive originalPath ────────────────────────

test('restoreFromBackup with a tampered manifest pointing at /etc/hosts is rejected', async () => {
  await withSplitHomeAndWorkspace(async (ws, home) => {
    const { snapshotBeforeWrite, restoreFromBackup } = await freshBackup();
    const benignTarget = join(ws, 'foo.txt');
    await writeFile(benignTarget, 'old', 'utf8');
    const snap = await snapshotBeforeWrite(benignTarget);

    // Attacker tampers the manifest to point at /etc/hosts.
    const manifest = JSON.parse(await readFile(snap.manifestPath, 'utf8'));
    manifest.originalPath = '/etc/hosts';
    await writeFile(snap.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    await assert.rejects(
      restoreFromBackup(snap.operationId),
      /Refusing to restore.*manifest target classified/i,
    );
  });
});

test('restoreFromBackup with a tampered manifest pointing at ~/.ssh is rejected', async () => {
  await withSplitHomeAndWorkspace(async (ws) => {
    const { snapshotBeforeWrite, restoreFromBackup } = await freshBackup();
    const benignTarget = join(ws, 'foo.txt');
    await writeFile(benignTarget, 'old', 'utf8');
    const snap = await snapshotBeforeWrite(benignTarget);

    const manifest = JSON.parse(await readFile(snap.manifestPath, 'utf8'));
    const HOME = (await import('node:os')).homedir();
    manifest.originalPath = join(HOME, '.ssh', 'evil_added_key');
    await writeFile(snap.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    await assert.rejects(
      restoreFromBackup(snap.operationId),
      /Refusing to restore.*manifest target classified.*credential/i,
    );
  });
});

test('restoreFromBackup with a manifest pointing at a symlink → /etc/hosts is rejected', async () => {
  await withSplitHomeAndWorkspace(async (ws) => {
    const { snapshotBeforeWrite, restoreFromBackup } = await freshBackup();
    const benign = join(ws, 'foo.txt');
    await writeFile(benign, 'old', 'utf8');
    const snap = await snapshotBeforeWrite(benign);

    // Replace the manifest's originalPath with a symlink pointing at /etc/hosts.
    const linkInWs = join(ws, 'sneaky');
    await symlink('/etc/hosts', linkInWs);

    const manifest = JSON.parse(await readFile(snap.manifestPath, 'utf8'));
    manifest.originalPath = linkInWs;
    await writeFile(snap.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    await assert.rejects(
      restoreFromBackup(snap.operationId),
      /Refusing to restore.*real target.*\/etc\/hosts/is,
    );
  });
});

// ─── trash side ────────────────────────────────────────────────────────

test('restoreFromTrash with a tampered manifest entry pointing at /etc rejects (no copyFile)', async () => {
  await withSplitHomeAndWorkspace(async (ws, home) => {
    const { safeDeleteToTrash, restoreFromTrash } = await freshTrash();
    const target = join(ws, 'foo.txt');
    await writeFile(target, 'x', 'utf8');
    const del = await safeDeleteToTrash([target]);

    // Tamper the manifest's first file entry's originalPath.
    const manifestPath = del.manifestPath;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files[0].originalPath = '/etc/sneaky';
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    await assert.rejects(
      restoreFromTrash(del.operationId),
      /Refusing to restore.*manifest target classified/i,
    );
  });
});

// ─── happy path with sseEmitter (UI approval layer) ────────────────────

test('restoreFromBackup with sseEmitter+chatId routes through gate.requestWrite (Q2C layer c)', async () => {
  await withSplitHomeAndWorkspace(async (ws) => {
    const { snapshotBeforeWrite, restoreFromBackup } = await freshBackup();
    const gate = await freshGate();
    const target = join(ws, 'foo.txt');
    await writeFile(target, 'orig', 'utf8');
    const snap = await snapshotBeforeWrite(target);
    // Mutate the live file so restore actually changes content.
    await writeFile(target, 'mutated', 'utf8');

    const events = [];
    const sse = (event, payload) => {
      events.push({ event, payload });
      queueMicrotask(() =>
        gate.resolveFileSafety(payload.requestId, 'once'),
      );
    };

    const result = await restoreFromBackup(snap.operationId, {
      sseEmitter: sse,
      chatId: 'chat-A',
      workspacePath: ws,
    });

    assert.equal(result.restored, target);
    assert.equal(events.length, 1, 'restore must trigger one write approval');
    assert.equal(events[0].payload.kind, 'file_safety');
    assert.equal(
      events[0].payload.operation,
      'write_overwrite',
      'restore is an overwrite over the user’s current file',
    );
    assert.equal(await readFile(target, 'utf8'), 'orig');
  });
});

test('restoreFromTrash with sseEmitter+chatId fires one approval per file', async () => {
  await withSplitHomeAndWorkspace(async (ws) => {
    const { safeDeleteToTrash, restoreFromTrash } = await freshTrash();
    const gate = await freshGate();

    const a = join(ws, 'a.txt');
    const b = join(ws, 'b.txt');
    await writeFile(a, 'A', 'utf8');
    await writeFile(b, 'B', 'utf8');
    const del = await safeDeleteToTrash([a, b]);

    const events = [];
    const sse = (event, payload) => {
      events.push({ event, payload });
      queueMicrotask(() =>
        gate.resolveFileSafety(payload.requestId, 'once'),
      );
    };

    const result = await restoreFromTrash(del.operationId, {
      sseEmitter: sse,
      chatId: 'chat-A',
      workspacePath: ws,
    });

    assert.equal(result.restored.length, 2);
    assert.equal(events.length, 2, 'one write approval per restored file');
    for (const e of events) {
      assert.equal(e.payload.kind, 'file_safety');
    }
  });
});

// ─── operationId whitelist on restore (layer a) ────────────────────────

test('restoreFromBackup rejects a malformed operationId without any disk access', async () => {
  await withSplitHomeAndWorkspace(async () => {
    const { restoreFromBackup } = await freshBackup();
    for (const bad of ['../etc', 'foo bar', '', 'a', 'x'.repeat(80)]) {
      await assert.rejects(
        restoreFromBackup(bad),
        /Invalid operationId/i,
        `expected "${bad}" to be rejected`,
      );
    }
  });
});
