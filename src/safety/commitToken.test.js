/**
 * commitToken.test.js — Codex C round 2 (2026-05-03) regression suite
 * for the Q1C operation-token contract.
 *
 * The gate now hands callers an operationToken alongside every
 * approved write/edit/move/delete. Phase 2 tools may call
 * commitOperation(token) right before the actual fs op to atomically
 * verify the lexical→real mapping has not been swapped since
 * approval (TOCTOU defence). This file pins:
 *   - happy path (token resolves to the same realPath)
 *   - symlink swap detection (real target changes between approve + commit)
 *   - expired token (TTL elapsed)
 *   - single-use replay (commit twice → second throws)
 *   - unknown token
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  unlink,
  symlink,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';

async function freshGate() {
  const grantsMod = await import('./chatScopedGrants.js');
  grantsMod.clearChat();
  const gateMod = await import('./fileSafetyGate.js');
  gateMod._clearPendingForTests();
  return gateMod;
}

async function tempDir(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
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

// ─── happy path ────────────────────────────────────────────────────────

test('commitOperation returns same resolvedTarget when nothing changed', async () => {
  const gate = await freshGate();
  const ws = await tempDir('fsg-token-');
  try {
    const target = join(ws, 'foo.txt');
    await writeFile(target, 'hi', 'utf8');
    const sse = makeAutoResolver(gate, [{ scope: 'once' }]);
    const result = await gate.requestWrite({
      path: target,
      chatId: 'chat-A',
      sseEmitter: sse,
      workspacePath: ws,
    });
    assert.equal(result.resolvedTarget, target);
    assert.ok(result.operationToken, 'must hand back a token');

    const committed = await gate.commitOperation(result.operationToken);
    assert.equal(committed.resolvedTarget, target);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ─── symlink swap between approval and commit ──────────────────────────

test('commitOperation throws when the symlink got re-pointed after approval', async () => {
  const gate = await freshGate();
  const ws = await tempDir('fsg-token-');
  const outside1 = await tempDir('fsg-token-out1-');
  const outside2 = await tempDir('fsg-token-out2-');
  try {
    const fileA = join(outside1, 'a.txt');
    const fileB = join(outside2, 'b.txt');
    await writeFile(fileA, 'A', 'utf8');
    await writeFile(fileB, 'B', 'utf8');

    const link = join(ws, 'mylink');
    await symlink(fileA, link);

    const sse = makeAutoResolver(gate, [{ scope: 'once' }]);
    const approved = await gate.requestWrite({
      path: link,
      chatId: 'chat-A',
      sseEmitter: sse,
      workspacePath: ws,
    });
    assert.equal(approved.resolvedTarget, fileA);

    // Attacker / racing process re-points the symlink.
    await unlink(link);
    await symlink(fileB, link);

    await assert.rejects(
      gate.commitOperation(approved.operationToken),
      (err) =>
        err.code === 'FILE_SAFETY_DENIED' &&
        /Path mapping changed/i.test(err.message),
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(outside1, { recursive: true, force: true });
    await rm(outside2, { recursive: true, force: true });
  }
});

// ─── expired token ─────────────────────────────────────────────────────

test('commitOperation throws when the operationId TTL has elapsed', async () => {
  // We don't wait 5 minutes — instead we mutate the issuedAt field
  // by swapping in a fake Date.now temporarily. Easiest: re-import
  // gate fresh and use the real TTL with a Math hack via setTimeout
  // on a 0ms timer? Too racy. Instead: hand-roll by reaching into
  // the gate's timer behavior — we call commitOperation after wait,
  // but manually adjust by patching Date.now.
  const gate = await freshGate();
  const ws = await tempDir('fsg-token-');
  try {
    const target = join(ws, 'foo.txt');
    await writeFile(target, 'x', 'utf8');
    const sse = makeAutoResolver(gate, [{ scope: 'once' }]);
    const approved = await gate.requestWrite({
      path: target,
      chatId: 'chat-A',
      sseEmitter: sse,
      workspacePath: ws,
    });

    // Skew Date.now by 6 minutes — past the 5-minute TTL.
    const realNow = Date.now;
    const SKEW_MS = 6 * 60 * 1000;
    Date.now = () => realNow() + SKEW_MS;
    try {
      await assert.rejects(
        gate.commitOperation(approved.operationToken),
        (err) =>
          err.code === 'FILE_SAFETY_DENIED' && /expired/i.test(err.message),
      );
    } finally {
      Date.now = realNow;
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ─── single-use ────────────────────────────────────────────────────────

test('commitOperation can be called only once (replay rejected)', async () => {
  const gate = await freshGate();
  const ws = await tempDir('fsg-token-');
  try {
    const target = join(ws, 'foo.txt');
    await writeFile(target, 'x', 'utf8');
    const sse = makeAutoResolver(gate, [{ scope: 'once' }]);
    const approved = await gate.requestWrite({
      path: target,
      chatId: 'chat-A',
      sseEmitter: sse,
      workspacePath: ws,
    });
    await gate.commitOperation(approved.operationToken);
    await assert.rejects(
      gate.commitOperation(approved.operationToken),
      (err) =>
        err.code === 'FILE_SAFETY_DENIED' &&
        /unknown or already consumed/i.test(err.message),
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ─── unknown token ─────────────────────────────────────────────────────

test('commitOperation rejects an unknown token', async () => {
  const gate = await freshGate();
  await assert.rejects(
    gate.commitOperation('not-a-real-token'),
    (err) => err.code === 'FILE_SAFETY_DENIED',
  );
});

// ─── return shape contract ─────────────────────────────────────────────

test('every approved request* returns resolvedTarget (and write/edit/move/delete also return operationToken)', async () => {
  const gate = await freshGate();
  const ws = await tempDir('fsg-token-');
  try {
    const file1 = join(ws, 'r.txt');
    const file2 = join(ws, 'w.txt');
    const file3 = join(ws, 'e.txt');
    await writeFile(file1, '1', 'utf8');
    await writeFile(file3, '3', 'utf8');

    // requestRead: resolvedTarget only (no token — read is idempotent)
    const sse1 = makeAutoResolver(gate, [{ scope: 'once' }]);
    const r1 = await gate.requestRead({
      path: file1,
      chatId: 'chat-A',
      sseEmitter: sse1,
      workspacePath: '/some/other/ws',  // force prompt
    });
    assert.equal(r1.resolvedTarget, file1);

    // requestWrite: token + target
    const sse2 = makeAutoResolver(gate, [{ scope: 'once' }]);
    const r2 = await gate.requestWrite({
      path: file2,
      chatId: 'chat-A',
      sseEmitter: sse2,
      workspacePath: '/some/other/ws',
    });
    assert.equal(r2.resolvedTarget, file2);
    assert.ok(r2.operationToken);

    // requestEdit: token + target
    const sse3 = makeAutoResolver(gate, [{ scope: 'once' }]);
    const r3 = await gate.requestEdit({
      path: file3,
      chatId: 'chat-A',
      sseEmitter: sse3,
      workspacePath: '/some/other/ws',
    });
    assert.equal(r3.resolvedTarget, file3);
    assert.ok(r3.operationToken);

    // requestDelete: per-path tokens + confirmedRealPaths
    const sse4 = makeAutoResolver(gate, [
      { scope: 'once' },
      { scope: 'once', confirmInput: 'r.txt' },
    ]);
    const r4 = await gate.requestDelete({
      paths: [file1],
      chatId: 'chat-A',
      sseEmitter: sse4,
      workspacePath: '/some/other/ws',
    });
    assert.deepEqual(r4.confirmedRealPaths, [file1]);
    assert.equal(r4.operationTokens.length, 1);
    assert.ok(r4.operationTokens[0]);

    // requestMove: token + resolvedSrc/Dst
    const sse5 = makeAutoResolver(gate, [{ scope: 'once' }]);
    const movedTo = join(ws, 'moved.txt');
    const r5 = await gate.requestMove({
      src: file3,
      dst: movedTo,
      chatId: 'chat-A',
      sseEmitter: sse5,
    });
    assert.equal(r5.resolvedSrc, file3);
    assert.ok(r5.operationToken);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ─── grant short-circuit also issues a token ───────────────────────────

test('a grant-covered write still returns a fresh operationToken', async () => {
  // The grant short-circuits the prompt UI but the token contract
  // must still hold — Phase 2 callers depend on it unconditionally.
  const gate = await freshGate();
  const ws = await tempDir('fsg-token-');
  try {
    const target = join(ws, 'foo.txt');
    await writeFile(target, 'x', 'utf8');

    // First write: get FILE-scope grant.
    const sse1 = makeAutoResolver(gate, [{ scope: 'file' }]);
    const r1 = await gate.requestWrite({
      path: target,
      chatId: 'chat-A',
      sseEmitter: sse1,
      workspacePath: '/somewhere/else',
    });
    assert.ok(r1.operationToken);

    // Second write: grant short-circuits, still must yield a token.
    const noopSse = () => {};
    const r2 = await gate.requestWrite({
      path: target,
      chatId: 'chat-A',
      sseEmitter: noopSse,
      workspacePath: '/somewhere/else',
    });
    assert.equal(r2.resolvedTarget, target);
    assert.ok(r2.operationToken, 'grant short-circuit must still issue a token');
    assert.notEqual(r1.operationToken, r2.operationToken);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
