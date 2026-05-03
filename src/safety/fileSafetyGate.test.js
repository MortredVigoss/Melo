/**
 * fileSafetyGate.test.js — pin the orchestrator's decisions:
 *   - hard-block fast-path (no UI for sensitive paths)
 *   - workspace-internal silent allow
 *   - per-chat grant short-circuit
 *   - prompt + resolve roundtrip for read / write / edit / move /
 *     delete (two-stage) / bash
 *
 * Test pattern: requestX is awaited; the moment its sseEmitter fires,
 * we capture the requestId and call resolveFileSafety on the next
 * microtask. The original promise then resolves (allow) or rejects
 * (deny / mismatch).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const HOME = homedir();

async function freshGate() {
  // ESM transitive imports (e.g. fileSafetyGate.js → './chatScopedGrants.js')
  // are cached by URL, so a `?tc=` cache-bust on the gate import would NOT
  // produce a fresh grants singleton inside the gate. Instead we use the
  // canonical singleton everywhere and reset its internal state at the
  // top of each test — same shape both tests see, no leakage.
  const grantsMod = await import('./chatScopedGrants.js');
  grantsMod.clearChat();
  const gateMod = await import('./fileSafetyGate.js');
  gateMod._clearPendingForTests();
  return { gate: gateMod, grants: grantsMod };
}

async function withTempMeloHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'melo-fsg-'));
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

// Build an sseEmitter that, the first time it fires, schedules
// resolveFileSafety on the next microtask with the chosen scope.
// Captures a sequence of all SSE events for assertion.
function makeAutoResolver(gate, decisions) {
  // decisions: array of { scope, confirmInput? } applied in order;
  // each prompt consumes one entry. Defaults to { scope: 'once' } if
  // the array runs out (so multi-stage delete tests can pass once
  // for stage 1 and once for stage 2 with the right confirmInput).
  const events = [];
  let cursor = 0;
  const sse = (event, payload) => {
    events.push({ event, payload });
    const decision = decisions[cursor++] || { scope: 'once' };
    queueMicrotask(() => {
      gate.resolveFileSafety(payload.requestId, decision.scope, {
        confirmInput: decision.confirmInput,
      });
    });
  };
  return { sse, events };
}

// ─── Hard-block fast-path ──────────────────────────────────────────────

test('requestWrite to /etc/hosts hard-rejects (no UI)', async () => {
  const { gate } = await freshGate();
  const events = [];
  const sse = (e, p) => events.push({ e, p });
  await assert.rejects(
    gate.requestWrite({
      path: '/etc/hosts',
      chatId: 'chat-A',
      sseEmitter: sse,
    }),
    /blocked by safety policy/i,
  );
  assert.equal(events.length, 0, 'no SSE event should fire for hard-blocked write');
});

test('requestDelete on ~/.ssh/id_rsa hard-rejects (no UI)', async () => {
  const { gate } = await freshGate();
  const events = [];
  const sse = (e, p) => events.push({ e, p });
  await assert.rejects(
    gate.requestDelete({
      paths: [join(HOME, '.ssh/id_rsa')],
      chatId: 'chat-A',
      sseEmitter: sse,
    }),
    /blocked by safety policy/i,
  );
  assert.equal(events.length, 0);
});

test('requestWrite to MELO_HOME hard-rejects', async () => {
  await withTempMeloHome(async (dir) => {
    const { gate } = await freshGate();
    await assert.rejects(
      gate.requestWrite({
        path: join(dir, 'config.json'),
        chatId: 'chat-A',
        sseEmitter: () => {},
      }),
      /blocked by safety policy/i,
    );
  });
});

// ─── Workspace silent allow ────────────────────────────────────────────

test('requestRead inside workspace silently allows (no SSE event)', async () => {
  const { gate } = await freshGate();
  const events = [];
  const sse = (e, p) => events.push({ e, p });
  await gate.requestRead({
    path: '/tmp/ws/foo.txt',
    chatId: 'chat-A',
    sseEmitter: sse,
    workspacePath: '/tmp/ws',
  });
  assert.equal(events.length, 0);
});

test('requestRead OUTSIDE workspace prompts the user', async () => {
  const { gate } = await freshGate();
  const { sse, events } = makeAutoResolver(gate, [{ scope: 'once' }]);
  await gate.requestRead({
    path: '/tmp/elsewhere/foo.txt',
    chatId: 'chat-A',
    sseEmitter: sse,
    workspacePath: '/tmp/ws',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'tool_permission');
  assert.equal(events[0].payload.kind, 'file_safety');
  assert.equal(events[0].payload.operation, 'read');
});

test('requestRead of credential file ALWAYS prompts even inside workspace', async () => {
  // Sensitive paths bypass the workspace short-circuit.
  const { gate } = await freshGate();
  const { sse, events } = makeAutoResolver(gate, [{ scope: 'once' }]);
  await gate.requestRead({
    path: join(HOME, '.ssh/id_rsa'),
    chatId: 'chat-A',
    sseEmitter: sse,
    workspacePath: HOME, // workspace contains the credential dir
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.sensitive, true);
});

// ─── Per-chat grant short-circuit ──────────────────────────────────────

test('after Allow this file in chat, second read of same file does NOT prompt', async () => {
  const { gate } = await freshGate();
  const { sse: sse1, events: e1 } = makeAutoResolver(gate, [{ scope: 'file' }]);
  await gate.requestRead({
    path: '/tmp/elsewhere/foo.txt',
    chatId: 'chat-A',
    sseEmitter: sse1,
    workspacePath: '/tmp/ws',
  });
  assert.equal(e1.length, 1);

  // Second call: silent allow.
  const e2 = [];
  await gate.requestRead({
    path: '/tmp/elsewhere/foo.txt',
    chatId: 'chat-A',
    sseEmitter: (e, p) => e2.push({ e, p }),
    workspacePath: '/tmp/ws',
  });
  assert.equal(e2.length, 0);
});

test('after Allow this folder in chat, sibling files in same folder do NOT prompt', async () => {
  const { gate } = await freshGate();
  const { sse: sse1 } = makeAutoResolver(gate, [{ scope: 'dir' }]);
  await gate.requestRead({
    path: '/tmp/proj/a.txt',
    chatId: 'chat-A',
    sseEmitter: sse1,
    workspacePath: '/tmp/ws',
  });

  const e2 = [];
  await gate.requestRead({
    path: '/tmp/proj/b.txt',
    chatId: 'chat-A',
    sseEmitter: (e, p) => e2.push({ e, p }),
    workspacePath: '/tmp/ws',
  });
  assert.equal(e2.length, 0);
});

test('grant from chat-A does NOT silently authorize chat-B', async () => {
  const { gate } = await freshGate();
  const { sse: sse1 } = makeAutoResolver(gate, [{ scope: 'file' }]);
  await gate.requestRead({
    path: '/tmp/elsewhere/foo.txt',
    chatId: 'chat-A',
    sseEmitter: sse1,
    workspacePath: '/tmp/ws',
  });

  // chat-B must still prompt.
  const { sse: sse2, events: e2 } = makeAutoResolver(gate, [{ scope: 'once' }]);
  await gate.requestRead({
    path: '/tmp/elsewhere/foo.txt',
    chatId: 'chat-B',
    sseEmitter: sse2,
    workspacePath: '/tmp/ws',
  });
  assert.equal(e2.length, 1);
});

test('read-grant does NOT silently authorize write of same file', async () => {
  const { gate } = await freshGate();
  const { sse: sse1 } = makeAutoResolver(gate, [{ scope: 'file' }]);
  await gate.requestRead({
    path: '/tmp/elsewhere/foo.txt',
    chatId: 'chat-A',
    sseEmitter: sse1,
    workspacePath: '/tmp/ws',
  });

  const { sse: sse2, events: e2 } = makeAutoResolver(gate, [{ scope: 'once' }]);
  await gate.requestWrite({
    path: '/tmp/elsewhere/foo.txt',
    chatId: 'chat-A',
    sseEmitter: sse2,
    workspacePath: '/tmp/ws',
  });
  assert.equal(e2.length, 1, 'write of read-granted file must re-prompt');
});

test('write-grant covers later edits of the same file (write ⊇ edit)', async () => {
  const { gate } = await freshGate();
  const { sse: sse1 } = makeAutoResolver(gate, [{ scope: 'file' }]);
  await gate.requestWrite({
    path: '/tmp/elsewhere/foo.txt',
    chatId: 'chat-A',
    sseEmitter: sse1,
    workspacePath: '/tmp/ws',
  });

  const e2 = [];
  await gate.requestEdit({
    path: '/tmp/elsewhere/foo.txt',
    chatId: 'chat-A',
    sseEmitter: (e, p) => e2.push({ e, p }),
    workspacePath: '/tmp/ws',
  });
  assert.equal(e2.length, 0, 'edit must be silent under prior write grant');
});

// ─── Deny / abort / timeout ────────────────────────────────────────────

test('user clicking Deny rejects with FILE_SAFETY_DENIED', async () => {
  const { gate } = await freshGate();
  const { sse } = makeAutoResolver(gate, [{ scope: 'deny' }]);
  await assert.rejects(
    gate.requestWrite({
      path: '/tmp/elsewhere/foo.txt',
      chatId: 'chat-A',
      sseEmitter: sse,
      workspacePath: '/tmp/ws',
    }),
    (err) => err.code === 'FILE_SAFETY_DENIED',
  );
});

test('AbortSignal cancels an in-flight prompt', async () => {
  const { gate } = await freshGate();
  const ctrl = new AbortController();
  const events = [];
  const sse = (e, p) => {
    events.push({ e, p });
    queueMicrotask(() => ctrl.abort());
  };
  await assert.rejects(
    gate.requestWrite({
      path: '/tmp/elsewhere/foo.txt',
      chatId: 'chat-A',
      sseEmitter: sse,
      signal: ctrl.signal,
      workspacePath: '/tmp/ws',
    }),
    (err) => err.code === 'FILE_SAFETY_DENIED' && /aborted/i.test(err.message),
  );
});

// ─── Delete two-stage ──────────────────────────────────────────────────

test('requestDelete: stage 1 + stage 2 with correct filename → resolves', async () => {
  const { gate } = await freshGate();
  const { sse, events } = makeAutoResolver(gate, [
    { scope: 'once' },                     // stage 1
    { scope: 'once', confirmInput: 'foo.txt' }, // stage 2 — single file: must type basename
  ]);
  const result = await gate.requestDelete({
    paths: ['/tmp/elsewhere/foo.txt'],
    chatId: 'chat-A',
    sseEmitter: sse,
    workspacePath: '/tmp/ws',
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].payload.stage, 'intent');
  assert.equal(events[1].payload.stage, 'confirm');
  assert.deepEqual(result.confirmedPaths, ['/tmp/elsewhere/foo.txt']);
  assert.equal(result.expectedConfirmation, 'foo.txt');
});

test('requestDelete: stage 2 with WRONG confirm string → rejects', async () => {
  const { gate } = await freshGate();
  const { sse } = makeAutoResolver(gate, [
    { scope: 'once' },
    { scope: 'once', confirmInput: 'wrong-name.txt' },
  ]);
  await assert.rejects(
    gate.requestDelete({
      paths: ['/tmp/elsewhere/foo.txt'],
      chatId: 'chat-A',
      sseEmitter: sse,
    }),
    /Confirmation string did not match/i,
  );
});

test('requestDelete multi-file: confirmation token is "DELETE" not a filename', async () => {
  const { gate } = await freshGate();
  const { sse } = makeAutoResolver(gate, [
    { scope: 'once' },
    { scope: 'once', confirmInput: 'DELETE' },
  ]);
  const result = await gate.requestDelete({
    paths: ['/tmp/x/a.txt', '/tmp/x/b.txt'],
    chatId: 'chat-A',
    sseEmitter: sse,
  });
  assert.equal(result.expectedConfirmation, 'DELETE');
});

test('requestDelete: any sensitive path in batch → entire batch hard-rejected', async () => {
  const { gate } = await freshGate();
  await assert.rejects(
    gate.requestDelete({
      paths: ['/tmp/safe.txt', join(HOME, '.ssh/id_rsa')],
      chatId: 'chat-A',
      sseEmitter: () => {},
    }),
    /blocked by safety policy/i,
  );
});

// ─── Move ──────────────────────────────────────────────────────────────

test('requestMove prompts (no session grant), allowed once → resolves', async () => {
  const { gate } = await freshGate();
  const { sse, events } = makeAutoResolver(gate, [{ scope: 'once' }]);
  await gate.requestMove({
    src: '/tmp/a.txt',
    dst: '/tmp/b.txt',
    chatId: 'chat-A',
    sseEmitter: sse,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.operation, 'move');
});

test('requestMove with destination in /etc → hard-rejects', async () => {
  const { gate } = await freshGate();
  await assert.rejects(
    gate.requestMove({
      src: '/tmp/a.txt',
      dst: '/etc/a.txt',
      chatId: 'chat-A',
      sseEmitter: () => {},
    }),
    /blocked by safety policy/i,
  );
});

// ─── Bash ──────────────────────────────────────────────────────────────

test('requestBashOp with no risks → silent allow', async () => {
  const { gate } = await freshGate();
  const events = [];
  const sse = (e, p) => events.push({ e, p });
  await gate.requestBashOp({
    command: 'ls /tmp',
    risks: [],
    chatId: 'chat-A',
    sseEmitter: sse,
  });
  assert.equal(events.length, 0);
});

test('requestBashOp with delete-class risk → hard-refuses with redirect message', async () => {
  const { gate } = await freshGate();
  await assert.rejects(
    gate.requestBashOp({
      command: 'rm -rf /tmp/junk',
      risks: [{ kind: 'delete', pattern: 'rm -rf' }],
      chatId: 'chat-A',
      sseEmitter: () => {},
    }),
    /destructive delete pattern.*fileDelete tool/is,
  );
});

test('requestBashOp with overwrite-class risk → prompts for approval', async () => {
  const { gate } = await freshGate();
  const { sse, events } = makeAutoResolver(gate, [{ scope: 'once' }]);
  await gate.requestBashOp({
    command: 'echo hi > /tmp/foo',
    risks: [{ kind: 'overwrite', pattern: '> redirect' }],
    chatId: 'chat-A',
    sseEmitter: sse,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.operation, 'bash');
});

// ─── Batch read ────────────────────────────────────────────────────────

test('requestReadBatch prompts with summary metadata, never auto-allowed', async () => {
  const { gate } = await freshGate();
  const { sse, events } = makeAutoResolver(gate, [{ scope: 'once' }]);
  await gate.requestReadBatch({
    summary: {
      dir: '/tmp/proj',
      fileCount: 42,
      extensions: ['.js', '.ts'],
      byteRange: { min: 100, max: 50_000, total: 1_000_000 },
    },
    chatId: 'chat-A',
    sseEmitter: sse,
    workspacePath: '/tmp/ws',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.operation, 'read_batch');
  assert.equal(events[0].payload.fileCount, 42);
  assert.deepEqual(events[0].payload.extensions, ['.js', '.ts']);
});

// ─── resolveFileSafety direct API ──────────────────────────────────────

test('resolveFileSafety with unknown requestId returns ok:false', async () => {
  const { gate } = await freshGate();
  const result = gate.resolveFileSafety('non-existent-id', 'once');
  assert.equal(result.ok, false);
  assert.match(result.reason || '', /Unknown or expired/);
});

test('resolveFileSafety with bogus scope rejects the in-flight prompt', async () => {
  const { gate } = await freshGate();
  let capturedRequestId;
  const sse = (_e, p) => {
    capturedRequestId = p.requestId;
    queueMicrotask(() => gate.resolveFileSafety(capturedRequestId, 'something_made_up'));
  };
  await assert.rejects(
    gate.requestWrite({
      path: '/tmp/foo.txt',
      chatId: 'chat-A',
      sseEmitter: sse,
      workspacePath: '/tmp/ws',
    }),
    (err) => err.code === 'FILE_SAFETY_DENIED',
  );
});

// ─── stat best-effort ──────────────────────────────────────────────────

test('requestRead on a missing file still prompts (no fs throw)', async () => {
  const { gate } = await freshGate();
  const { sse, events } = makeAutoResolver(gate, [{ scope: 'once' }]);
  await gate.requestRead({
    path: '/tmp/__nope__/never-existed.txt',
    chatId: 'chat-A',
    sseEmitter: sse,
    workspacePath: '/tmp/ws',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.size, null);
});
