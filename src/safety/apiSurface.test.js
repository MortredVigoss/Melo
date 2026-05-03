/**
 * apiSurface.test.js — Codex C round 5 (2026-05-03) regressions
 * pinning the closed-export contracts:
 *   - gate's `_issueOperationToken` is module-private (no export)
 *   - trash's raw delete worker is module-private (no export)
 *   - the only callable delete path is requestDelete → safeDeleteToTrash
 *   - safeDeleteToTrash refuses any token whose resolved target is
 *     sensitive (defence-in-depth even if a future gate refactor leaks)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, realpath, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

async function withSplitMeloHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'melo-api-home-'));
  const ws = await realpath(await mkdtemp(join(tmpdir(), 'melo-api-ws-')));
  const prev = process.env.MELO_HOME;
  process.env.MELO_HOME = home;
  try {
    await mkdir(home, { recursive: true });
    await fn(ws);
  } finally {
    if (prev === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prev;
    await rm(home, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  }
}

// ─── exports surface contract ─────────────────────────────────────────

test('gate does NOT export _issueOperationToken (must remain module-private)', async () => {
  const gate = await import('./fileSafetyGate.js');
  assert.equal(
    typeof gate._issueOperationToken,
    'undefined',
    '_issueOperationToken must NOT be exported — that would let any production caller mint tokens and bypass requestDelete two-stage approval',
  );
});

test('trash does NOT export _unsafeRawDelete / _unsafeSafeDeleteToTrashRaw', async () => {
  const trash = await import('./trash.js');
  assert.equal(typeof trash._unsafeRawDelete, 'undefined');
  assert.equal(typeof trash._unsafeSafeDeleteToTrashRaw, 'undefined');
});

test('the only public delete entrypoint is safeDeleteToTrash (token-bound)', async () => {
  const trash = await import('./trash.js');
  assert.equal(typeof trash.safeDeleteToTrash, 'function');
  // Also verify it requires the new shape — bare paths reject.
  await assert.rejects(
    trash.safeDeleteToTrash(['/tmp/foo']),
    /requires a non-empty operationTokens/i,
  );
});

// ─── forged token rejection ───────────────────────────────────────────

test('safeDeleteToTrash refuses a forged (random-uuid-shaped) token', async () => {
  await withSplitMeloHome(async () => {
    const trash = await import('./trash.js');
    await assert.rejects(
      trash.safeDeleteToTrash({
        operationTokens: ['00000000-0000-4000-8000-000000000000'],
      }),
      (err) =>
        err.code === 'FILE_SAFETY_DENIED' &&
        /unknown or already consumed/i.test(err.message),
    );
  });
});

test('safeDeleteToTrash REJECTS a non-DELETE token (Codex D round 6 — kind enforcement)', async () => {
  // Earlier rounds left this as a documented "we don't enforce kind
  // matching" trade-off. Codex round 6 flagged that as a real hole:
  // a write/edit/move token from the same chat would skip
  // requestDelete's two-stage filename confirmation. The gate now
  // enforces expectedKind at commit time, and safeDeleteToTrash
  // passes expectedKind: OP_KIND.DELETE — so any other token shape
  // is rejected with FILE_SAFETY_DENIED before any disk touch.
  await withSplitMeloHome(async (ws) => {
    const trash = await import('./trash.js');
    const grants = await import('./chatScopedGrants.js');
    grants.clearChat();
    const gate = await import('./fileSafetyGate.js');
    gate._clearPendingForTests();

    const target = join(ws, 'foo.txt');
    await writeFile(target, 'x', 'utf8');

    const sse = (event, payload) => {
      queueMicrotask(() =>
        gate.resolveFileSafety(payload.requestId, 'once'),
      );
    };
    const writeRes = await gate.requestWrite({
      path: target,
      chatId: 'chat-X',
      sseEmitter: sse,
      workspacePath: ws,
    });
    assert.ok(writeRes.operationToken);

    await assert.rejects(
      trash.safeDeleteToTrash({ operationTokens: [writeRes.operationToken] }),
      (err) =>
        err.code === 'FILE_SAFETY_DENIED' &&
        /kind mismatch.*token is for "write_overwrite".*expected one of \[delete\]/i.test(err.message),
    );

    // Crucially, the original file MUST NOT have been moved to trash
    // — the kind check fires before any fs op.
    const stillThere = await readFile(target, 'utf8');
    assert.equal(stillThere, 'x', 'target file must be untouched after kind-mismatch rejection');
    const list = await trash.listTrash();
    assert.equal(list.length, 0, 'no trash manifest must be created');
  });
});

test('kind-mismatch matrix: read / write / edit / move tokens are ALL rejected by safeDeleteToTrash', async () => {
  await withSplitMeloHome(async (ws) => {
    const trash = await import('./trash.js');
    const grants = await import('./chatScopedGrants.js');
    grants.clearChat();
    const gate = await import('./fileSafetyGate.js');
    gate._clearPendingForTests();

    const a = join(ws, 'a.txt');
    const b = join(ws, 'b.txt');
    await writeFile(a, 'A', 'utf8');
    await writeFile(b, 'B', 'utf8');

    const auto = (event, payload) =>
      queueMicrotask(() =>
        gate.resolveFileSafety(payload.requestId, 'once'),
      );

    // requestRead returns NO operationToken (read is idempotent — gate
    // does not mint delete-class tokens for it). Verify that.
    const readRes = await gate.requestRead({
      path: a,
      chatId: 'chat-X',
      sseEmitter: auto,
      workspacePath: ws,
    });
    assert.equal(readRes.operationToken, undefined, 'read does not mint a token');

    const writeRes = await gate.requestWrite({
      path: a,
      chatId: 'chat-X',
      sseEmitter: auto,
      workspacePath: ws,
    });
    const editRes = await gate.requestEdit({
      path: a,
      chatId: 'chat-X',
      sseEmitter: auto,
      workspacePath: ws,
    });
    const moveRes = await gate.requestMove({
      src: a,
      dst: b,
      chatId: 'chat-X',
      sseEmitter: auto,
      workspacePath: ws,
    });

    for (const tok of [writeRes.operationToken, editRes.operationToken, moveRes.operationToken]) {
      await assert.rejects(
        trash.safeDeleteToTrash({ operationTokens: [tok] }),
        (err) =>
          err.code === 'FILE_SAFETY_DENIED' &&
          /kind mismatch.*expected one of \[delete\]/i.test(err.message),
      );
    }
    // Files unchanged across the whole matrix.
    assert.equal(await readFile(a, 'utf8'), 'A');
    assert.equal(await readFile(b, 'utf8'), 'B');
    assert.equal((await trash.listTrash()).length, 0);
  });
});

test('positive: legitimate DELETE token is accepted (kind enforcement does not break the happy path)', async () => {
  await withSplitMeloHome(async (ws) => {
    const trash = await import('./trash.js');
    const grants = await import('./chatScopedGrants.js');
    grants.clearChat();
    const gate = await import('./fileSafetyGate.js');
    gate._clearPendingForTests();

    const target = join(ws, 'foo.txt');
    await writeFile(target, 'x', 'utf8');

    let stage = 0;
    const sse = (event, payload) => {
      const decision = stage === 0
        ? { scope: 'once' }
        : { scope: 'once', confirmInput: 'foo.txt' };
      stage++;
      queueMicrotask(() =>
        gate.resolveFileSafety(payload.requestId, decision.scope, {
          confirmInput: decision.confirmInput,
        }),
      );
    };
    const approved = await gate.requestDelete({
      paths: [target],
      chatId: 'chat-X',
      sseEmitter: sse,
      workspacePath: ws,
    });
    const result = await trash.safeDeleteToTrash({
      operationTokens: approved.operationTokens,
    });
    assert.equal(result.removed[0], target);
  });
});

// ─── sensitive resolved path defence (Phase 2 contract) ───────────────

test('safeDeleteToTrash refuses a token whose resolved target is sensitive (defence-in-depth)', async () => {
  // Even if a future gate change accidentally let a sensitive path
  // through requestDelete, the wrapper here re-runs isHardBlockedDelete
  // on lexical AND resolved before hitting _unsafeRawDelete.
  //
  // We simulate the "leaked sensitive token" by:
  //   1. requestDelete a benign path (gets token bound to benign realpath)
  //   2. re-link the lexical to point at /etc/hosts AFTER approval
  //   3. safeDeleteToTrash should detect the swap via commitOperation
  //      and throw "Path mapping changed" (the actual defence)
  await withSplitMeloHome(async (ws) => {
    const trash = await import('./trash.js');
    const grants = await import('./chatScopedGrants.js');
    grants.clearChat();
    const gate = await import('./fileSafetyGate.js');
    gate._clearPendingForTests();

    const benign = join(ws, 'b.txt');
    await writeFile(benign, 'x', 'utf8');

    let stage = 0;
    const sse = (event, payload) => {
      const decision = stage === 0
        ? { scope: 'once' }
        : { scope: 'once', confirmInput: 'b.txt' };
      stage++;
      queueMicrotask(() =>
        gate.resolveFileSafety(payload.requestId, decision.scope, {
          confirmInput: decision.confirmInput,
        }),
      );
    };
    const approved = await gate.requestDelete({
      paths: [benign],
      chatId: 'chat-X',
      sseEmitter: sse,
      workspacePath: ws,
    });

    // Swap: replace the file with a symlink to /etc/hosts.
    await rm(benign, { force: true });
    const { symlink } = await import('node:fs/promises');
    await symlink('/etc/hosts', benign);

    await assert.rejects(
      trash.safeDeleteToTrash({
        operationTokens: approved.operationTokens,
      }),
      (err) =>
        err.code === 'FILE_SAFETY_DENIED' &&
        /Path mapping changed/i.test(err.message),
    );
  });
});
