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

test('bashTool: pipe / grep is NOT in silent allowlist → prompts (Phase 2D #1 default-deny)', async () => {
  // Pre-followup: pipe + grep was treated as zero-risk → silent.
  // Codex 🔴 noted that grep can read sensitive paths and stream
  // them back as stdout. Default-deny model: anything not on the
  // strict allowlist prompts.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await bashTool.run(
      { command: "echo 'hello world' | grep hello" },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 1, 'pipe is metachar → must prompt');
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

// ─── Phase 2D follow-up #1: read-class + nested-shell + substitution ─

test('round 13 Phase 2D followup #1: cat ~/.ssh/id_rsa would-be-silent NOW PROMPTS (read-class default-deny)', async () => {
  // Codex 🔴: read commands like cat / grep / head can stream sensitive
  // file contents back as stdout. They have no write/delete risk so
  // bashRiskParser sees nothing — but they're NOT on the silent
  // allowlist, so the default-deny model prompts. User can deny.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const result = await bashTool.run(
      { command: 'cat ~/.ssh/id_rsa' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: (event, payload) => {
        promptCount++;
        gate.resolveFileSafety(payload.requestId, 'deny');
      } },
    );
    assert.equal(promptCount, 1, 'read-class command MUST prompt (not silent)');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
  });
});

test('round 13 Phase 2D followup #1: bash -c "rm -rf x" — nested-shell PROMPTS, not auto-rejected, deny stops it', async () => {
  // Pre-followup: bashRiskParser only saw `bash` head; the nested
  // `rm` was invisible → command ran silently (or prompted as
  // "default" — but the inner rm was never classified). Now
  // nested_shell is its own risk → prompt fires; user denies.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'survives.txt');
    await writeFile(target, 'still here', 'utf8');
    let promptCount = 0;
    let sawNestedShell = false;
    const result = await bashTool.run(
      { command: `bash -c 'rm -rf ${target}'` },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: (event, payload) => {
        promptCount++;
        if ((payload.risks || []).some(r => r.kind === 'nested_shell')) sawNestedShell = true;
        gate.resolveFileSafety(payload.requestId, 'deny');
      } },
    );
    assert.equal(promptCount, 1);
    assert.equal(sawNestedShell, true, 'risk payload must include nested_shell kind');
    assert.equal(result.ok, false);
    // File MUST still exist — denied bash -c never ran.
    const fs = await import('node:fs/promises');
    assert.equal(await fs.readFile(target, 'utf8'), 'still here');
  });
});

test('round 13 Phase 2D followup #1: eval "rm x" — also nested_shell + deny preserves file', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'eval-target.txt');
    await writeFile(target, 'untouched', 'utf8');
    const result = await bashTool.run(
      { command: `eval 'rm ${target}'` },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoDeny(gate) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    const fs = await import('node:fs/promises');
    assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
  });
});

test('round 13 Phase 2D followup #1: $(rm x) command substitution → prompts as nested_shell', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'subst.txt');
    await writeFile(target, 'still here', 'utf8');
    let sawNestedShell = false;
    const result = await bashTool.run(
      { command: `echo $(rm ${target})` },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: (event, payload) => {
        if ((payload.risks || []).some(r => r.kind === 'nested_shell')) sawNestedShell = true;
        gate.resolveFileSafety(payload.requestId, 'deny');
      } },
    );
    assert.equal(sawNestedShell, true, 'command substitution $() must be flagged');
    assert.equal(result.ok, false);
    const fs = await import('node:fs/promises');
    assert.equal(await fs.readFile(target, 'utf8'), 'still here');
  });
});

test('round 13 Phase 2D followup #1: backtick subshell `rm x` → nested_shell prompts', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let sawNestedShell = false;
    await bashTool.run(
      { command: 'echo `whoami`' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: (event, payload) => {
        if ((payload.risks || []).some(r => r.kind === 'nested_shell')) sawNestedShell = true;
        gate.resolveFileSafety(payload.requestId, 'deny');
      } },
    );
    assert.equal(sawNestedShell, true, 'backtick subshell must be flagged');
  });
});

test('round 13 Phase 2D followup #1: xargs sh -c "..." → nested_shell prompts', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let sawNestedShell = false;
    await bashTool.run(
      { command: 'echo a | xargs sh -c "echo $0"' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: (event, payload) => {
        if ((payload.risks || []).some(r => r.kind === 'nested_shell')) sawNestedShell = true;
        gate.resolveFileSafety(payload.requestId, 'deny');
      } },
    );
    assert.equal(sawNestedShell, true, 'xargs <shell> -c must be flagged');
  });
});

// ─── Allowlist hits — silent ──────────────────────────────────────────

test('round 13 Phase 2D followup #1: pwd / whoami / date — allowlisted, silent', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = () => { promptCount++; };
    for (const cmd of ['pwd', 'whoami', 'date']) {
      const r = await bashTool.run(
        { command: cmd },
        { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
      );
      assert.equal(r.ok, true, `${cmd} should succeed`);
    }
    assert.equal(promptCount, 0, 'pwd/whoami/date are allowlisted');
  });
});

test('round 13 Phase 2D followup #1: git diff / git log / git branch — allowlisted, silent', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = () => { promptCount++; };
    // git may exit non-zero in non-git dir; we only care about prompts.
    for (const cmd of ['git diff', 'git log', 'git branch']) {
      await bashTool.run({ command: cmd }, { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse });
    }
    assert.equal(promptCount, 0);
  });
});

test('round 13 Phase 2D followup #2: npm test / npm run NO LONGER silent (package scripts = arbitrary shell)', async () => {
  // Codex 🟠: npm test / npm run / pnpm run / yarn run all execute
  // package.json scripts which are arbitrary shell. A
  // package.json with `"test": "rm -rf x"` would let `npm test`
  // run rm without ever prompting. Default-deny: every package-
  // manager invocation prompts.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    // Plant a malicious package.json — `npm test` would invoke `rm`.
    const target = join(ws, 'should-not-be-deleted.txt');
    await writeFile(target, 'sentinel', 'utf8');
    await writeFile(join(ws, 'package.json'), JSON.stringify({
      name: 'malicious',
      scripts: { test: `rm -f ${target}` },
    }), 'utf8');

    let promptCount = 0;
    const result = await bashTool.run(
      { command: 'npm test' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: (event, payload) => {
        promptCount++;
        gate.resolveFileSafety(payload.requestId, 'deny');
      } },
    );
    assert.equal(promptCount, 1, 'npm test must prompt');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    // The malicious script must NOT have run.
    const fs = await import('node:fs/promises');
    assert.equal(await fs.readFile(target, 'utf8'), 'sentinel');
  });
});

test('round 13 Phase 2D followup #2: pnpm run / yarn run / npm view also prompt', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'deny');
    };
    for (const cmd of ['pnpm run build', 'yarn run something', 'npm view react']) {
      await bashTool.run({ command: cmd }, { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse });
    }
    assert.equal(promptCount, 3, 'each package-manager invocation must prompt');
  });
});

test('round 13 Phase 2D followup #1: ls with metachars NOT silent (allowlist requires plain args)', async () => {
  // `ls $HOME` has $ → would expand → bypass classification; must prompt.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    await bashTool.run(
      { command: 'ls $HOME' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 1, 'ls with metachars must prompt');
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
