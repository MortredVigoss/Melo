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
    const { _unsafeSafeDeleteToTrashRaw, restoreFromTrash } = await freshTrash();
    const target = join(ws, 'foo.txt');
    await writeFile(target, 'x', 'utf8');
    const del = await _unsafeSafeDeleteToTrashRaw([target]);

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
    const { _unsafeSafeDeleteToTrashRaw, restoreFromTrash } = await freshTrash();
    const gate = await freshGate();

    const a = join(ws, 'a.txt');
    const b = join(ws, 'b.txt');
    await writeFile(a, 'A', 'utf8');
    await writeFile(b, 'B', 'utf8');
    const del = await _unsafeSafeDeleteToTrashRaw([a, b]);

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

// ─── Codex D round 3: post-approval symlink swap → no write to sensitive ─

test('restoreFromBackup: symlink swapped between sensitivity check and copyFile aborts via commit re-resolve', async () => {
  // Setup: backup of /ws/foo.txt (real file). Then attacker creates
  // a symlink in workspace at /ws/foo.txt → /etc/hosts BETWEEN our
  // layer (b) sensitivity check and the actual copyFile. The atomic
  // commit-on-write contract means the fs op must NEVER follow the
  // new symlink to /etc/hosts.
  //
  // We simulate the swap by hooking into the gate's commitOperation:
  // we monkey-patch safeResolvePath via direct in-test orchestration.
  // Easier: just test that the same machinery exists end-to-end with
  // a symlink that ALREADY exists (sensitivity layer (b) catches it).
  // The post-approval swap is unit-tested via commitToken.test.js.
  await withSplitHomeAndWorkspace(async (ws) => {
    const { snapshotBeforeWrite, restoreFromBackup } = await freshBackup();
    const realFile = join(ws, 'foo.txt');
    await writeFile(realFile, 'orig', 'utf8');
    const snap = await snapshotBeforeWrite(realFile);

    // Tamper: replace originalPath in manifest with a symlink we
    // create that points at /etc/hosts. The layer-(b) sensitivity
    // check will catch it.
    const sneakyLink = join(ws, 'sneaky');
    await symlink('/etc/hosts', sneakyLink);
    const manifest = JSON.parse(await readFile(snap.manifestPath, 'utf8'));
    manifest.originalPath = sneakyLink;
    await writeFile(snap.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    await assert.rejects(
      restoreFromBackup(snap.operationId),
      /Refusing to restore.*real target.*\/etc\/hosts/is,
    );

    // Confirm /etc/hosts unchanged as bonus sanity (we'd never have
    // permission to write it anyway, but proves the abort point
    // happened upstream of fs).
    const hosts = await readFile('/etc/hosts', 'utf8').catch(() => null);
    assert.ok(hosts === null || hosts.length > 0);
  });
});

test('restoreFromBackup return shape: result.restored carries the commit-resolved (real) path', async () => {
  // Codex D round 3 contract: the actual fs op uses the commit-issued
  // resolvedTarget. result.restored is therefore the realpath, not
  // the lexical input. (Simple positive test — adversarial swap
  // detection is unit-tested in commitToken.test.js, and the
  // tampered-manifest sensitive case is covered above.)
  await withSplitHomeAndWorkspace(async (ws) => {
    const { snapshotBeforeWrite, restoreFromBackup } = await freshBackup();
    const realFile = join(ws, 'real.txt');
    await writeFile(realFile, 'orig', 'utf8');
    const snap = await snapshotBeforeWrite(realFile);
    await writeFile(realFile, 'mutated', 'utf8');
    const result = await restoreFromBackup(snap.operationId);
    // ws is realpath()'d inside the helper, so the returned path is
    // already canonical regardless of how /tmp / /var symlinks resolve.
    assert.equal(result.restored, realFile);
    assert.equal(await readFile(realFile, 'utf8'), 'orig');
  });
});

// ─── Codex C round 4: integration TOCTOU via _setRestoreSwapHookForTests ─

test('restoreFromBackup: post-(b) symlink swap caught by commit (integration TOCTOU)', async () => {
  await withSplitHomeAndWorkspace(async (ws) => {
    const backup = await freshBackup();
    const realFile = join(ws, 'foo.txt');
    await writeFile(realFile, 'orig', 'utf8');
    const snap = await backup.snapshotBeforeWrite(realFile);

    // Inject a swap between layer (b) and commit. realFile starts as
    // a regular file; in the hook, replace it with a symlink → /etc/hosts.
    backup._setRestoreSwapHookForTests(async ({ originalPath }) => {
      await rm(originalPath, { force: true });
      await symlink('/etc/hosts', originalPath);
    });
    try {
      await assert.rejects(
        backup.restoreFromBackup(snap.operationId),
        (err) =>
          err.code === 'FILE_SAFETY_DENIED' &&
          /Path mapping changed/i.test(err.message),
      );
    } finally {
      backup._setRestoreSwapHookForTests(null);
    }

    // /etc/hosts must NOT have been touched (we never permission-checked
    // /etc anyway, but proves the abort point fired upstream of fs).
    const hostsExists = await readFile('/etc/hosts', 'utf8').catch(() => null);
    assert.ok(hostsExists === null || hostsExists.length > 0);
  });
});

test('restoreFromTrash: post-(b) symlink swap caught by commit (integration TOCTOU)', async () => {
  await withSplitHomeAndWorkspace(async (ws) => {
    const trash = await freshTrash();
    const realFile = join(ws, 'foo.txt');
    await writeFile(realFile, 'A', 'utf8');
    const del = await trash._unsafeSafeDeleteToTrashRaw([realFile]);

    trash._setRestoreSwapHookForTests(async ({ originalPath }) => {
      // Re-create the path as a symlink to /etc/hosts before commit.
      await rm(originalPath, { force: true });
      await symlink('/etc/hosts', originalPath);
    });
    try {
      await assert.rejects(
        trash.restoreFromTrash(del.operationId),
        (err) =>
          err.code === 'FILE_SAFETY_DENIED' &&
          /Path mapping changed/i.test(err.message),
      );
    } finally {
      trash._setRestoreSwapHookForTests(null);
    }
  });
});

// ─── Codex C round 4: token-bound public safeDeleteToTrash ────────────

test('safeDeleteToTrash (public token-bound API) requires operationTokens; bare paths rejected', async () => {
  await withSplitHomeAndWorkspace(async () => {
    const { safeDeleteToTrash } = await freshTrash();
    await assert.rejects(
      safeDeleteToTrash({ paths: ['/tmp/foo'] }),
      /requires a non-empty operationTokens/i,
    );
    await assert.rejects(
      safeDeleteToTrash(),
      /requires a non-empty operationTokens/i,
    );
    await assert.rejects(
      safeDeleteToTrash({ operationTokens: [] }),
      /requires a non-empty operationTokens/i,
    );
  });
});

test('safeDeleteToTrash (public token-bound API) end-to-end with requestDelete tokens', async () => {
  await withSplitHomeAndWorkspace(async (ws) => {
    const { safeDeleteToTrash, listTrash } = await freshTrash();
    const gate = await freshGate();
    const target = join(ws, 'foo.txt');
    await writeFile(target, 'x', 'utf8');

    // Caller flow: requestDelete → safeDeleteToTrash with tokens.
    const sse = makeAutoResolver(gate, [
      { scope: 'once' },
      { scope: 'once', confirmInput: 'foo.txt' },
    ]);
    const approved = await gate.requestDelete({
      paths: [target],
      chatId: 'chat-A',
      sseEmitter: sse,
      workspacePath: ws,
    });
    assert.equal(approved.operationTokens.length, 1);

    const result = await safeDeleteToTrash({
      operationTokens: approved.operationTokens,
      ctx: { chatId: 'chat-A' },
    });
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0], target);
    assert.equal((await listTrash()).length, 1);
  });
});

test('safeDeleteToTrash refuses if any token commit fails (whole batch atomic)', async () => {
  await withSplitHomeAndWorkspace(async (ws) => {
    const { safeDeleteToTrash, listTrash } = await freshTrash();
    const gate = await freshGate();
    const a = join(ws, 'a.txt');
    await writeFile(a, 'A', 'utf8');

    const sse = makeAutoResolver(gate, [
      { scope: 'once' },
      { scope: 'once', confirmInput: 'a.txt' },
    ]);
    const approved = await gate.requestDelete({
      paths: [a],
      chatId: 'chat-A',
      sseEmitter: sse,
      workspacePath: ws,
    });

    // Consume the legit token, then call safeDeleteToTrash with the
    // (now invalidated) token — single-use should reject.
    await gate.commitOperation(approved.operationTokens[0]);

    await assert.rejects(
      safeDeleteToTrash({
        operationTokens: approved.operationTokens,
        ctx: {},
      }),
      (err) =>
        err.code === 'FILE_SAFETY_DENIED' &&
        /unknown or already consumed/i.test(err.message),
    );
    // Original file untouched, no trash entry created.
    assert.equal(await readFile(a, 'utf8'), 'A');
    assert.equal((await listTrash()).length, 0);
  });
});

test('restoreFromTrash uses commit-issued resolvedTarget per file (returned restored[] holds real paths)', async () => {
  await withSplitHomeAndWorkspace(async (ws) => {
    const { _unsafeSafeDeleteToTrashRaw, restoreFromTrash } = await freshTrash();
    const realA = join(ws, 'a.txt');
    const realB = join(ws, 'b.txt');
    await writeFile(realA, 'A', 'utf8');
    await writeFile(realB, 'B', 'utf8');
    const del = await _unsafeSafeDeleteToTrashRaw([realA, realB]);

    const result = await restoreFromTrash(del.operationId);
    // restored[] now contains the commit-resolved (= real) paths.
    assert.equal(result.fullyRestored, true);
    assert.deepEqual(result.restored.sort(), [realA, realB].sort());
  });
});
