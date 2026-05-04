/**
 * phase2d.bashTool.test.js — Phase 2D integration tests.
 *
 * Phase 2D wires bashTool through bashRiskParser → requestBashOp.
 * The contract:
 *   - zero-risk commands (ls, git status, npm test, ...) run silent.
 *   - risky commands (write/append/in_place_edit/move/reset_repo/
 *     truncate/overwrite) trigger a single prompt.
 *   - delete-class commands (rm, find -delete, git clean, ...) are
 *     hard-rejected with a hint to use file_delete.
 *   - commands the parser can't tokenize (unbalanced quotes, etc)
 *     get an "unknown" risk added → prompt fires.
 *   - approving the prompt runs the command; denying returns DENIED.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { bashTool } from './bashTool.js';

async function freshGate() {
  const grants = await import('../../safety/chatScopedGrants.js');
  grants.clearChat();
  const gate = await import('../../safety/fileSafetyGate.js');
  gate._clearPendingForTests();
  return gate;
}

async function withTempEnv(fn) {
  const ws = await realpath(await mkdtemp(join(tmpdir(), 'p2d-ws-')));
  try { await fn({ ws }); }
  finally { await rm(ws, { recursive: true, force: true }); }
}

function autoApprove(gate) {
  return (event, payload) => {
    queueMicrotask(() => gate.resolveFileSafety(payload.requestId, 'once'));
  };
}
function autoDeny(gate) {
  return (event, payload) => {
    queueMicrotask(() => gate.resolveFileSafety(payload.requestId, 'deny'));
  };
}

// ─── Zero-risk commands run silent ───────────────────────────────────

test('bashTool: ls runs silent (no gate prompt)', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await bashTool.run(
      { command: 'ls' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 0, 'ls is risk-free; must not prompt');
  });
});

test('bashTool: git status runs silent', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = () => { promptCount++; };
    // git status may exit non-zero in a non-git dir; we only care
    // about prompt behaviour.
    await bashTool.run(
      { command: 'git status' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 0);
  });
});

test('bashTool: echo + pipe + grep runs silent (composition without delete/write)', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = () => { promptCount++; };
    const result = await bashTool.run(
      { command: "echo 'hello world' | grep hello" },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 0);
  });
});

// ─── Delete-class hard-reject ────────────────────────────────────────

test('bashTool: rm -rf is HARD-REJECTED (no UI, no spawn)', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'doomed.txt');
    await writeFile(target, 'still here', 'utf8');
    let promptCount = 0;
    const sse = () => { promptCount++; };
    const result = await bashTool.run(
      { command: `rm -rf ${target}` },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.equal(promptCount, 0, 'delete-class is hard-rejected; no UI prompt');
    assert.match(result.output, /fileDelete|file_delete/, 'must hint to use file_delete tool');
    // The file must still be there (rm never spawned).
    const fs = await import('node:fs/promises');
    const buf = await fs.readFile(target, 'utf8');
    assert.equal(buf, 'still here');
  });
});

test('bashTool: find -delete is HARD-REJECTED', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const result = await bashTool.run(
      { command: 'find . -name "*.tmp" -delete' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: () => {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.match(result.output, /fileDelete|file_delete/);
  });
});

test('bashTool: git clean is HARD-REJECTED', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const result = await bashTool.run(
      { command: 'git clean -fd' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: () => {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.match(result.output, /fileDelete|file_delete/);
  });
});

// ─── Risky-but-not-delete prompts once ───────────────────────────────

test('bashTool: redirect-overwrite (>) prompts once and runs on approve', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const target = join(ws, 'out.txt');
    const result = await bashTool.run(
      { command: `echo wrote > ${target}` },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 1, 'overwrite redirect must prompt');
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(target, 'utf8');
    assert.match(content, /wrote/);
  });
});

test('bashTool: append (>>) prompts and runs on approve', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await bashTool.run(
      { command: `echo line >> ${join(ws, 'log.txt')}` },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 1);
  });
});

test('bashTool: sed -i in-place edit prompts', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'a.txt');
    await writeFile(target, 'hello', 'utf8');
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    await bashTool.run(
      { command: `sed -i.bak s/hello/world/ ${target}` },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 1);
  });
});

test('bashTool: deny on a risky command returns DENIED + does NOT spawn', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'should-not-exist.txt');
    const result = await bashTool.run(
      { command: `echo nope > ${target}` },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoDeny(gate) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    const fs = await import('node:fs/promises');
    let exists = false;
    try { await fs.stat(target); exists = true; } catch {}
    assert.equal(exists, false, 'denied risky command must NOT have run');
  });
});

// ─── Unparseable / unknown ───────────────────────────────────────────

test('bashTool: unbalanced quotes → "unknown" risk → prompt fires', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    let sawUnknownRisk = false;
    const sse = (event, payload) => {
      promptCount++;
      const risks = payload.risks || [];
      if (risks.some(r => r.kind === 'unknown')) sawUnknownRisk = true;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    // Unbalanced single quote — bashRiskParser flags unparseable.
    await bashTool.run(
      { command: "echo 'unterminated" },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 1, 'unparseable command must prompt as "unknown"');
    assert.equal(sawUnknownRisk, true, 'prompt payload must contain unknown risk entry');
  });
});

test('bashTool: empty / non-string command → INVALID_ARGS without prompting', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = () => { promptCount++; };
    const r1 = await bashTool.run({ command: '' }, { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse });
    assert.equal(r1.ok, false);
    assert.equal(r1.error, 'INVALID_ARGS');
    const r2 = await bashTool.run({ command: '   ' }, { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse });
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'INVALID_ARGS');
    assert.equal(promptCount, 0);
  });
});

// ─── Phase 2D contract ───────────────────────────────────────────────

test('Phase 2D contract: bashTool has requiresPermission:false (FileSafetyGate owns approval)', () => {
  // Same contract as Phase 2B read tools — toolId-level prompt
  // would double-prompt with our risk-aware classification.
  assert.equal(bashTool.requiresPermission, false);
});

test('Phase 2D contract: bashTool source imports parseBashRiskyOps + requestBashOp', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./bashTool.js', import.meta.url), 'utf8');
  assert.match(src, /parseBashRiskyOps/, 'bashTool must call parseBashRiskyOps');
  assert.match(src, /requestBashOp/, 'bashTool must call requestBashOp');
});
