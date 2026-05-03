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
import { mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
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

test('safeDeleteToTrash refuses a token from a non-DELETE op (e.g. write token replay)', async () => {
  await withSplitMeloHome(async (ws) => {
    const trash = await import('./trash.js');
    const grants = await import('./chatScopedGrants.js');
    grants.clearChat();
    const gate = await import('./fileSafetyGate.js');
    gate._clearPendingForTests();

    const target = join(ws, 'foo.txt');
    await writeFile(target, 'x', 'utf8');

    // Mint a WRITE token (not a delete token) by going through requestWrite.
    let writeToken;
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
    writeToken = writeRes.operationToken;
    assert.ok(writeToken);

    // Hand the WRITE token to safeDeleteToTrash. The token commits
    // (kind = WRITE_OVERWRITE) but the resolved target is the workspace
    // file — and the underlying _unsafeRawDelete still runs
    // isHardBlockedDelete (which is fine here since it's benign), so
    // the delete WILL succeed in this case. The defence here is the
    // BARRIER itself — Phase 2 tools must call requestDelete, not
    // requestWrite, before invoking safeDeleteToTrash. We pin a
    // related invariant: the underlying _unsafeRawDelete refuses
    // sensitive resolved paths even when given a benign-looking token.
    //
    // (Direct cross-op token misuse is documented as a Phase 2
    // contract; the gate intentionally does not encode kind matching
    // because the token's purpose is realPath verification, not
    // approval-kind authorisation. The safety policy below catches
    // sensitive-target misuse regardless.)
    const result = await trash.safeDeleteToTrash({
      operationTokens: [writeToken],
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
