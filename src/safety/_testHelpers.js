/**
 * _testHelpers.js — shared test fixture helpers for the safety suite.
 *
 * The underscore-prefix is a convention; this file is imported only
 * by *.test.js. Codex C round 5 (2026-05-03) closed the prior
 * `_unsafeSafeDeleteToTrashRaw` export so tests can no longer go
 * around the gate. They now build trash fixtures via the same public
 * flow Phase 2 tools will use:
 *   gate.requestDelete(...)  →  safeDeleteToTrash({ operationTokens })
 */

import { basename } from 'node:path';

// Drive requestDelete's two-stage UI synchronously: stage-1 "once",
// stage-2 "once" with the basename (single delete) or 'DELETE' (multi).
function _autoResolveDelete(gate, paths) {
  const expected = paths.length === 1 ? basename(paths[0]) : 'DELETE';
  let stage = 0;
  return (event, payload) => {
    const decision = stage === 0
      ? { scope: 'once' }
      : { scope: 'once', confirmInput: expected };
    stage++;
    queueMicrotask(() => {
      gate.resolveFileSafety(payload.requestId, decision.scope, {
        confirmInput: decision.confirmInput,
      });
    });
  };
}

// Build a trash entry by going through the public token-bound flow.
// Returns the same shape as the underlying `safeDeleteToTrash`:
//   { operationId, folderName, opDir, manifestPath, removed[], failed[] }.
//
// The `chatId` defaults to 'test-chat' so callers don't have to pass
// one for setup-only deletions; tests that exercise per-chat behaviour
// pass their own.
export async function deleteToTrash(gate, trash, paths, ctx = {}) {
  const arr = Array.isArray(paths) ? paths : [paths];
  const sse = _autoResolveDelete(gate, arr);
  const approved = await gate.requestDelete({
    paths: arr,
    chatId: ctx.chatId || 'test-chat',
    sseEmitter: sse,
    workspacePath: ctx.workspacePath,
  });
  return trash.safeDeleteToTrash({
    operationTokens: approved.operationTokens,
    ctx,
  });
}
