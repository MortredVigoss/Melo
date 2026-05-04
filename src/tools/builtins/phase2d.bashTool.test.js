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
import { mkdtemp, realpath, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
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

test('bashTool: pwd runs silent (no gate prompt)', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await bashTool.run(
      { command: 'pwd' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 0, 'pwd is allowlisted; must not prompt');
  });
});

test('bashTool: git status NO LONGER silent (Phase 2D #5: git removed from allowlist)', async () => {
  // Phase 2D follow-up #5 (Codex 🔴): git removed from silent
  // allowlist entirely — too many escape options (`--output=`,
  // `--exec`, `--upload-pack`, `--textconv`, `--pager`, etc) to
  // safely enumerate. Every git command now prompts.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    await bashTool.run(
      { command: 'git status' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 1, 'git status now prompts (no longer in silent allowlist)');
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

test('round 13 Phase 2D followup #1: pwd / whoami — allowlisted, silent', async () => {
  // Phase 2D follow-up #6: `date` removed from allowlist (option-
  // embedded paths like `date --file=/abs` / `-r /path`). Only
  // truly no-arg identity probes stay silent.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = () => { promptCount++; };
    for (const cmd of ['pwd', 'whoami']) {
      const r = await bashTool.run(
        { command: cmd },
        { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
      );
      assert.equal(r.ok, true, `${cmd} should succeed`);
    }
    assert.equal(promptCount, 0, 'pwd/whoami are allowlisted');
  });
});

test('round 13 Phase 2D followup #5: git diff / git log / git branch ALL prompt now (git out of allowlist)', async () => {
  // Phase 2D follow-up #5: git entry removed from SILENT_ALLOWLIST
  // entirely — every git invocation prompts.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    for (const cmd of ['git diff', 'git log', 'git branch']) {
      await bashTool.run({ command: cmd }, { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse });
    }
    assert.equal(promptCount, 3, 'every git invocation now prompts');
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

// ─── Phase 2D follow-up #3: cwdOverride + path-arg bypasses ─────────

test('round 13 Phase 2D followup #3: cwdOverride OUTSIDE workspace forces prompt even for allowlisted commands', async () => {
  // Codex 🔴: `ls` is on the silent allowlist, but with
  // cwdOverride: '/etc' it would silently list /etc. Allowlist
  // now requires cwd inside workspacePath; otherwise → prompt.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'deny');
    };
    const result = await bashTool.run(
      { command: 'pwd', cwd: '/etc' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 1, 'cwdOverride outside workspace must prompt');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
  });
});

test('round 13 Phase 2D followup #3: cwdOverride INSIDE workspace stays silent', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    await mkdir(join(ws, 'sub'));
    let promptCount = 0;
    const sse = () => { promptCount++; };
    const r = await bashTool.run(
      { command: 'pwd', cwd: join(ws, 'sub') },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(r.ok, true);
    assert.equal(promptCount, 0);
  });
});

test('round 13 Phase 2D followup #3: ls ~/.ssh — path arg → prompt (not silent)', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'deny');
    };
    const result = await bashTool.run(
      { command: 'ls ~/.ssh' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 1, 'ls with path arg must prompt');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
  });
});

test('round 13 Phase 2D followup #3: git diff --no-index ~/.ssh /tmp — explicit deny-list option blocks silent', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'deny');
    };
    const result = await bashTool.run(
      { command: 'git diff --no-index ~/.ssh/known_hosts /tmp' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 1, 'git diff --no-index must prompt');
    assert.equal(result.ok, false);
  });
});

test('round 13 Phase 2D followup #3: git log -- some/path — positional path arg → prompt', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'deny');
    };
    await bashTool.run(
      { command: 'git log -- some/path' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 1);
  });
});

test('round 13 Phase 2D followup #5: git diff --output=/path BLOCKED — write-bypass via git option closed by removing git from allowlist', async () => {
  // The exact bypass that prompted follow-up #5: `git diff --output=`
  // writes the diff to an arbitrary path. Pre-#5 silent allowlist
  // saw `--output=...` as an option-prefixed arg and let it run
  // unprompted → silent file write outside the workspace gate.
  // Now git is fully out of allowlist → prompt + deny → no file
  // ever created.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const leaked = join(ws, 'leaked-via-git-output.txt');
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'deny');
    };
    const result = await bashTool.run(
      { command: `git diff --output=${leaked}` },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 1, 'git diff --output=... must prompt');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    // The output file must NOT exist — git diff never spawned.
    const fs = await import('node:fs/promises');
    let exists = false;
    try { await fs.stat(leaked); exists = true; } catch {}
    assert.equal(exists, false, 'denied --output write must not create the file');
  });
});

test('round 13 Phase 2D followup #6: ls fully removed from allowlist — both ls -la and ls foo prompt', async () => {
  // Phase 2D follow-up #6: ls removed entirely (any arg form
  // risks shell-expansion / glob / tilde leak before our check).
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let prompts = 0;
    const sse = (event, payload) => {
      prompts++;
      gate.resolveFileSafety(payload.requestId, 'deny');
    };
    await bashTool.run({ command: 'ls -la' }, { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse });
    await bashTool.run({ command: 'ls foo/bar' }, { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse });
    assert.equal(prompts, 2, 'every ls invocation now prompts');
  });
});

test('round 13 Phase 2D followup #3: which ./malicious — path-shaped arg → prompt; which cat → silent', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let pathPrompts = 0;
    await bashTool.run(
      { command: 'which ./malicious' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: (event, payload) => {
        pathPrompts++;
        gate.resolveFileSafety(payload.requestId, 'deny');
      } },
    );
    assert.equal(pathPrompts, 1, 'which with slash → prompt');
    let silentPrompts = 0;
    await bashTool.run(
      { command: 'which cat' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: () => { silentPrompts++; } },
    );
    assert.equal(silentPrompts, 0, 'which <bare-name> → silent');
  });
});

// ─── Phase 2D follow-up #4: realpath-based cwd check + version-probe lockdown ──

test('round 13 Phase 2D followup #4: cwdOverride "$WS/../sibling" lexical escape → prompt', async () => {
  // String prefix would let `$WS/../sibling` slip through if the
  // sibling string starts with `$WS/`. realpath check rejects it.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    // Create a sibling dir outside the workspace.
    const wsParent = await realpath(join(ws, '..'));
    const siblingName = 'sibling-escape-' + Date.now().toString(36);
    const sibling = join(wsParent, siblingName);
    await mkdir(sibling);
    try {
      let promptCount = 0;
      const sse = (event, payload) => {
        promptCount++;
        gate.resolveFileSafety(payload.requestId, 'deny');
      };
      // ws/../sibling resolves OUTSIDE ws — must prompt.
      const result = await bashTool.run(
        { command: 'ls', cwd: join(ws, '..', siblingName) },
        { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
      );
      assert.equal(promptCount, 1, 'lexical escape via .. must prompt');
      assert.equal(result.ok, false);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });
});

test('round 13 Phase 2D followup #4: cwdOverride to workspace symlink → outside dir → prompt (realpath check)', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    // Create an outside dir, then a symlink inside the workspace
    // pointing at it.
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'p2d-out-')));
    const linkPath = join(ws, 'symlink-to-outside');
    await symlink(outside, linkPath);
    try {
      let promptCount = 0;
      const sse = (event, payload) => {
        promptCount++;
        gate.resolveFileSafety(payload.requestId, 'deny');
      };
      // The symlink path is INSIDE ws lexically, but realpath
      // resolves it to the outside dir → must prompt.
      const result = await bashTool.run(
        { command: 'ls', cwd: linkPath },
        { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
      );
      assert.equal(promptCount, 1, 'symlink escape must be caught by realpath');
      assert.equal(result.ok, false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('round 13 Phase 2D followup #4: node --require attack → prompt (extra args break version exact-match)', async () => {
  // Codex 🔴: pre-#4 allowlist let `node ... --version ...` through,
  // so `node --require /tmp/evil.js --version` would load the JS
  // BEFORE printing version. New rule: args must be exactly
  // `[]` / ['-v'] / ['--version'] — anything else prompts.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'deny');
    };
    const r1 = await bashTool.run(
      { command: 'node --require /tmp/evil.js --version' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 1, 'node with --require must prompt');
    assert.equal(r1.ok, false);

    // Reset gate state for next sub-call.
    gate._clearPendingForTests();

    // Also: node -e '...' which can run arbitrary code.
    promptCount = 0;
    await bashTool.run(
      { command: "node -e console.log('attack')" },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: (event, payload) => {
        promptCount++;
        gate.resolveFileSafety(payload.requestId, 'deny');
      } },
    );
    assert.equal(promptCount, 1, 'node -e <code> must prompt');
  });
});

test('round 13 Phase 2D followup #4: node --version (exact) and python3 --version still silent', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = () => { promptCount++; };
    for (const cmd of ['node --version', 'node -v', 'python3 --version']) {
      await bashTool.run({ command: cmd }, { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse });
    }
    assert.equal(promptCount, 0, 'pure version probes still silent');
  });
});

// ─── Phase 2D follow-up #6: date/echo/ls removed + cwd payload ───

test('round 13 Phase 2D followup #6: date --file=/etc/hosts BLOCKED (date removed from allowlist)', async () => {
  // Codex 🔴: `date --file=/abs` reads the file as a list of date
  // strings, leaking the file's content via timestamps in stderr/
  // exit-code paths. Pre-#6 was silent (--file= starts with `-`).
  // Now date is fully out → prompt.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'deny');
    };
    const result = await bashTool.run(
      { command: 'date --file=/etc/hosts' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(promptCount, 1, 'date --file= must prompt');
    assert.equal(result.ok, false);
  });
});

test('round 13 Phase 2D followup #6: echo /etc/* BLOCKED (echo removed from allowlist — shell glob expansion)', async () => {
  // Codex 🔴: `echo /etc/*` expands the glob BEFORE our check
  // sees it, listing /etc's contents. Removing echo from allowlist
  // means it always prompts.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'deny');
    };
    const result = await bashTool.run(
      { command: 'echo /etc/*' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    // `*` is a metachar — already triggers metachar-reject in
    // isInAllowlist. With echo also removed, even plain
    // `echo hello` prompts. Both paths exit on prompt.
    assert.equal(promptCount, 1);
    assert.equal(result.ok, false);
  });
});

test('round 13 Phase 2D followup #6: bash gate prompt payload exposes effectiveCwd / realCwd / cwdInsideWorkspace', async () => {
  // Codex 🟠: prompt UI needs to see whether cwdOverride points
  // outside the workspace so the user can spot a sensitive
  // execution context. Round 6 adds the fields to the payload.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let captured = null;
    const sse = (event, payload) => {
      captured = payload;
      gate.resolveFileSafety(payload.requestId, 'deny');
    };
    await bashTool.run(
      { command: 'pwd', cwd: '/etc' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.ok(captured, 'must have captured a prompt payload');
    assert.equal(captured.effectiveCwd, '/etc', 'effectiveCwd must reflect cwdOverride');
    assert.equal(captured.cwdInsideWorkspace, false, 'cwdInsideWorkspace must be false for /etc');
    assert.equal(typeof captured.realCwd, 'string', 'realCwd should be the realpath of effectiveCwd');
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
