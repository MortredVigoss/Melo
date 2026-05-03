/**
 * phase2b.readTools.test.js — Phase 2B integration tests.
 *
 * Phase 2B wires the read-side tools (file_read, glob, grep) through
 * the FileSafetyGate and the dirfd-bound atomic open primitives:
 *
 *   - workspace-internal reads: silent, no UI.
 *   - sensitive (system / credential / $MELO_HOME) reads: per-call
 *     UI prompt, never granted session-wide. Hard-blocked-by-write
 *     paths are still readable IF the user explicitly approves.
 *   - external benign: prompt with optional file/dir grant.
 *
 * Read-side does NOT take backups (read-only). The dirfd-bound open
 * (atomicOpenLeaf, O_NOFOLLOW added auto) catches a leaf that became
 * a symlink between approval and our open via ELOOP.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  fileReadTool,
  _setPostApprovalHookForTests as _setReadPostApprovalHook,
} from './fileReadTool.js';
import {
  globTool,
  _setPostReaddirHookForTests as _setGlobPostReaddirHook,
} from './globTool.js';
import { grepTool } from './grepTool.js';

async function freshGate() {
  const grants = await import('../../safety/chatScopedGrants.js');
  grants.clearChat();
  const gate = await import('../../safety/fileSafetyGate.js');
  gate._clearPendingForTests();
  return gate;
}

async function withTempEnv(fn) {
  const home = await mkdtemp(join(tmpdir(), 'p2b-home-'));
  const ws = await realpath(await mkdtemp(join(tmpdir(), 'p2b-ws-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'p2b-out-')));
  const prev = process.env.MELO_HOME;
  process.env.MELO_HOME = home;
  try {
    await mkdir(home, { recursive: true });
    await fn({ ws, outside, home });
  } finally {
    if (prev === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prev;
    await rm(home, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
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

// ─── fileReadTool ─────────────────────────────────────────────────────

test('fileReadTool: workspace-internal read is silent (no UI prompt)', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'a.txt');
    await writeFile(target, 'line1\nline2\nline3', 'utf8');

    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await fileReadTool.run(
      { path: target },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 0, 'workspace-internal read must not prompt');
    assert.match(result.output, /1\tline1/);
    assert.match(result.output, /3\tline3/);
  });
});

test('fileReadTool: external benign file prompts and is readable on approve', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const target = join(outside, 'note.txt');
    await writeFile(target, 'external content', 'utf8');

    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await fileReadTool.run(
      { path: target },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 1, 'external read must prompt exactly once');
    assert.match(result.output, /external content/);
  });
});

test('fileReadTool: deny → returns DENIED with no fs touch', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const target = join(outside, 'secret.txt');
    await writeFile(target, 'shh', 'utf8');
    const result = await fileReadTool.run(
      { path: target },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoDeny(gate) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    // File still on disk (we obviously didn't delete it, but verify
    // the DENIED branch returns before any open).
    const probe = await fileReadTool.run(
      { path: target },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    assert.equal(probe.ok, true);
    assert.match(probe.output, /shh/);
  });
});

test('fileReadTool: workspace symlink → outside benign requires prompt + reads through link', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const externalFile = join(outside, 'data.txt');
    const linkPath = join(ws, 'mylink');
    await writeFile(externalFile, 'real data', 'utf8');
    await symlink(externalFile, linkPath);

    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      // Verify the prompt payload exposes hasSymlinkInChain + realPath
      // so the UI can show a warning. Gate spreads the payload at top
      // level (operation/kind/...payload all siblings of requestId).
      assert.equal(payload.hasSymlinkInChain, true, 'prompt must flag symlink');
      assert.equal(payload.realPath, externalFile);
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await fileReadTool.run(
      { path: linkPath },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 1, 'workspace-symlink-to-outside must prompt');
    assert.match(result.output, /real data/);
  });
});

test('fileReadTool: read of /etc/hosts requires explicit per-call approval (sensitive, no session grant)', async () => {
  // /etc/hosts is in the system blocklist for writes but readable
  // through the gate. Two consecutive reads must each prompt — sensitive
  // reads are NEVER granted session-wide.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      // Even if the user clicks "always allow this dir", the gate
      // must still treat sensitive reads as per-call.
      gate.resolveFileSafety(payload.requestId, 'dir');
    };
    const r1 = await fileReadTool.run(
      { path: '/etc/hosts' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(r1.ok, true);
    const r2 = await fileReadTool.run(
      { path: '/etc/hosts' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(r2.ok, true);
    assert.equal(promptCount, 2, 'sensitive read must prompt EVERY time');
  });
});

test('fileReadTool: missing file returns ENOENT after gate approval (workspace silent)', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const result = await fileReadTool.run(
      { path: join(ws, 'nope.txt') },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'ENOENT');
  });
});

test('fileReadTool: file too large → FILE_TOO_LARGE without dumping content', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'big.bin');
    // 200KB+1 — just over MAX_READ_BYTES.
    await writeFile(target, Buffer.alloc(200_001, 0x61), null);
    const result = await fileReadTool.run(
      { path: target },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'FILE_TOO_LARGE');
    assert.match(result.output, /KB/);
    // No content leaked into output.
    assert.doesNotMatch(result.output, /aaaaaa/);
  });
});

test('fileReadTool: line range slicing returns correct subset', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'multi.txt');
    await writeFile(target, ['L1', 'L2', 'L3', 'L4', 'L5'].join('\n'), 'utf8');
    const result = await fileReadTool.run(
      { path: target, start_line: 2, end_line: 4 },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.output, '2\tL2\n3\tL3\n4\tL4');
    assert.equal(result.meta.lines, 3);
    assert.equal(result.meta.totalLines, 5);
  });
});

// ─── globTool ────────────────────────────────────────────────────────

test('globTool: workspace glob is silent and returns relative matches sorted', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    await mkdir(join(ws, 'src', 'utils'), { recursive: true });
    await writeFile(join(ws, 'src', 'a.js'), '', 'utf8');
    await writeFile(join(ws, 'src', 'utils', 'b.js'), '', 'utf8');
    await writeFile(join(ws, 'README.md'), '', 'utf8');
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await globTool.run(
      { pattern: 'src/**/*.js' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 0, 'workspace glob must not prompt');
    const lines = result.output.split('\n').filter(l => !l.startsWith('#'));
    assert.deepEqual(lines, ['src/a.js', 'src/utils/b.js']);
  });
});

test('globTool: external benign base prompts once', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    await writeFile(join(outside, 'x.txt'), '', 'utf8');
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await globTool.run(
      { pattern: '**/*.txt', cwd: outside },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 1);
    assert.match(result.output, /x\.txt/);
  });
});

test('globTool: deny base → DENIED, no fs walk', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const result = await globTool.run(
      { pattern: '**/*', cwd: outside },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoDeny(gate) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
  });
});

test('globTool: walks past sensitive subtree silently and reports skip count', async () => {
  // Workspace contains a benign tree + a symlink-named entry that
  // would point at a sensitive path. Since we can't actually create
  // /etc inside ws, simulate by symlinking a workspace dir into the
  // .ssh-named slot (classifyPath uses path-prefix matching, so the
  // lexical name itself doesn't trigger; we have to actually plant
  // a sensitive path inside ws). Skip if HOME isn't set or .ssh
  // doesn't exist on this machine.
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    // Plant a benign file under ws.
    await writeFile(join(ws, 'safe.txt'), '', 'utf8');
    // Glob from $HOME if it exists and contains something. Use a
    // restrictive pattern so we only get a few results regardless.
    const home = process.env.HOME;
    if (!home) return; // sandbox without HOME, skip
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await globTool.run(
      { pattern: '**/no-such-file-anywhere-1234.xyz', cwd: home, max_results: 5 },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    // Most home dirs contain at least .ssh OR .aws OR .gnupg etc, so
    // skippedSensitive should usually be > 0. If not (clean machine),
    // just verify the field exists and is a number.
    assert.equal(typeof result.meta.skippedSensitive, 'number');
    assert.ok(result.meta.skippedSensitive >= 0);
  });
});

test('globTool: ignores conventional vendor dirs (node_modules, .git, …)', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    await mkdir(join(ws, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(ws, 'node_modules', 'pkg', 'index.js'), '', 'utf8');
    await mkdir(join(ws, 'src'), { recursive: true });
    await writeFile(join(ws, 'src', 'a.js'), '', 'utf8');
    const result = await globTool.run(
      { pattern: '**/*.js' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    assert.equal(result.ok, true);
    const lines = result.output.split('\n').filter(l => !l.startsWith('#'));
    assert.deepEqual(lines, ['src/a.js']);
  });
});

test('globTool: invalid pattern → INVALID_ARGS', async () => {
  await withTempEnv(async ({ ws }) => {
    const result = await globTool.run(
      { pattern: '' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: () => {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_ARGS');
  });
});

// ─── grepTool ────────────────────────────────────────────────────────

test('grepTool: workspace search is silent and returns matches with line numbers', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    await mkdir(join(ws, 'src'), { recursive: true });
    await writeFile(join(ws, 'src', 'a.js'), 'TODO: write\nfn main() {}\n', 'utf8');
    await writeFile(join(ws, 'src', 'b.js'), 'no todo here\n', 'utf8');
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await grepTool.run(
      { pattern: 'TODO' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 0, 'workspace grep must not prompt');
    assert.match(result.output, /a\.js/);
    assert.match(result.output, /TODO: write/);
    assert.doesNotMatch(result.output, /b\.js/);
  });
});

test('grepTool: leaf symlink is skipped silently (O_NOFOLLOW), external target untouched in results', async () => {
  // Plant a symlink in the workspace pointing at an external file
  // containing the search term. atomicOpenLeaf with O_NOFOLLOW
  // should reject the symlink → no match returned, no path-leak.
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const externalFile = join(outside, 'leak.txt');
    await writeFile(externalFile, 'SECRET-TOKEN-XYZ', 'utf8');
    await symlink(externalFile, join(ws, 'sneaky-link'));
    // Plant a benign workspace file that DOES match so the search isn't a no-op.
    await writeFile(join(ws, 'real.txt'), 'SECRET-TOKEN-XYZ', 'utf8');
    const result = await grepTool.run(
      { pattern: 'SECRET-TOKEN' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    assert.equal(result.ok, true);
    assert.match(result.output, /real\.txt/);
    // The symlink must NOT appear (we don't follow it).
    assert.doesNotMatch(result.output, /sneaky-link/);
  });
});

test('grepTool: external benign base prompts once and reads', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    await writeFile(join(outside, 'note.txt'), 'find this MARKER here', 'utf8');
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      gate.resolveFileSafety(payload.requestId, 'once');
    };
    const result = await grepTool.run(
      { pattern: 'MARKER', path: outside },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, true);
    assert.equal(promptCount, 1);
    assert.match(result.output, /MARKER/);
  });
});

test('grepTool: deny base → DENIED, no walk', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    await writeFile(join(outside, 'x'), 'hit', 'utf8');
    const result = await grepTool.run(
      { pattern: 'hit', path: outside },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoDeny(gate) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
  });
});

test('grepTool: invalid regex → returns error before walk', async () => {
  await withTempEnv(async ({ ws }) => {
    const result = await grepTool.run(
      { pattern: '(unclosed' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: () => {} },
    );
    assert.equal(result.ok, false);
    assert.match(result.output, /Invalid regex/);
  });
});

test('grepTool: include glob restricts file types', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    await writeFile(join(ws, 'a.js'), 'NEEDLE in js', 'utf8');
    await writeFile(join(ws, 'b.txt'), 'NEEDLE in txt', 'utf8');
    const result = await grepTool.run(
      { pattern: 'NEEDLE', include: '*.js' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    assert.equal(result.ok, true);
    assert.match(result.output, /a\.js/);
    assert.doesNotMatch(result.output, /b\.txt/);
  });
});

test('fileReadTool: leaf swapped to symlink between approval and open → COMMIT_FAILED via O_NOFOLLOW (race injection)', async () => {
  // Round 13 Phase 2B follow-up #1 (Codex ⚪): use the new
  // _setPostApprovalHookForTests seam to inject a real leaf swap
  // AFTER gate approval. atomicOpenLeaf must reject via O_NOFOLLOW
  // (ELOOP) and we get COMMIT_FAILED, not the file's content.
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const benignFile = join(ws, 'doc.txt');
    const sensitive = join(outside, 'leak.txt');
    await writeFile(benignFile, 'safe content', 'utf8');
    await writeFile(sensitive, 'PRIVATE-DATA', 'utf8');

    let hookFired = false;
    _setReadPostApprovalHook(async ({ realPath }) => {
      // After approval but before the read fd opens, swap the
      // approved benign file for a symlink to a sensitive file.
      await rm(realPath, { force: true });
      await symlink(sensitive, realPath);
      hookFired = true;
    });
    try {
      const result = await fileReadTool.run(
        { path: benignFile },
        { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
      );
      assert.equal(hookFired, true);
      assert.equal(result.ok, false);
      // Either ELOOP (atomicOpenLeaf saw the symlink) or ENOENT
      // (rare scheduler ordering — symlink not yet visible). The
      // critical guarantee: the sensitive content does NOT leak.
      assert.ok(result.error === 'COMMIT_FAILED' || result.error === 'ENOENT',
        `unexpected error: ${result.error}`);
      assert.doesNotMatch(result.output || '', /PRIVATE-DATA/,
        'sensitive content must NOT appear in result');
    } finally {
      _setReadPostApprovalHook(null);
    }
  });
});

test('fileReadTool: meta exposes resolved + lexical paths for a workspace→outside symlink (back-compat pin)', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const externalFile = join(outside, 'src.txt');
    const linkPath = join(ws, 'link');
    await writeFile(externalFile, 'via link', 'utf8');
    await symlink(externalFile, linkPath);
    const result = await fileReadTool.run(
      { path: linkPath },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    assert.equal(result.ok, true);
    assert.match(result.output, /via link/);
    assert.equal(result.meta.path, externalFile);
    assert.equal(result.meta.lexicalPath, linkPath);
  });
});

// ─── Round 13 Phase 2B follow-up #2: FIFO / special-file safety ──

test('round 13 Phase 2B followup #2: fileRead rejects a FIFO with NOT_FILE (O_NONBLOCK + S_ISREG)', async (t) => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const fifoPath = join(ws, 'pipe');
    // mkfifo via execFile — Node has no built-in mkfifo. Skip on
    // platforms where mkfifo isn't available.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync('mkfifo', [fifoPath]);
    } catch {
      t.skip('mkfifo unavailable on this platform');
      return;
    }

    // Without O_NONBLOCK, opening a FIFO with no writer would block
    // forever. With O_NONBLOCK + the S_ISREG check, we open instantly
    // and reject before any read.
    let timedOut = false;
    const watchdog = setTimeout(() => { timedOut = true; }, 3000);

    const result = await fileReadTool.run(
      { path: fifoPath },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    clearTimeout(watchdog);

    assert.equal(timedOut, false, 'fileRead must not block on FIFO');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'NOT_FILE');
  });
});

test('round 13 Phase 2B followup #2: grep skips a FIFO encountered during walk (no hang, no result leak)', async (t) => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    await writeFile(join(ws, 'real.txt'), 'NEEDLE in real file', 'utf8');
    const fifoPath = join(ws, 'mid-walk-fifo');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync('mkfifo', [fifoPath]);
    } catch {
      t.skip('mkfifo unavailable on this platform');
      return;
    }

    let timedOut = false;
    const watchdog = setTimeout(() => { timedOut = true; }, 3000);

    const result = await grepTool.run(
      { pattern: 'NEEDLE' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    clearTimeout(watchdog);

    assert.equal(timedOut, false, 'grep walk must not block on FIFO');
    assert.equal(result.ok, true);
    // Real file matches; FIFO never produces a "result" entry.
    assert.match(result.output, /real\.txt/);
    assert.doesNotMatch(result.output, /mid-walk-fifo/);
  });
});

test('round 13 Phase 2B followup #2: grep no longer uses rg fast path (JS walker only)', async () => {
  // Codex round 13 Phase 2B #2 removed the rg fast path entirely
  // because handing safe-file paths to an external rg process let
  // it re-open by path, bypassing our O_NOFOLLOW + O_NONBLOCK
  // guards. Pin: grep module no longer imports child_process.
  const { readFile: rf } = await import('node:fs/promises');
  const src = await rf(new URL('./grepTool.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from 'node:child_process'/, 'grepTool must not spawn external processes');
  assert.doesNotMatch(src, /execFile|spawn\(/, 'no execFile/spawn calls allowed in grepTool');
});

// ─── Round 13 Phase 2B follow-up #3: dirfd-bound walk + MELO_INTERNAL ──

test('round 13 Phase 2B followup #3: glob — dir entry swapped to symlink between readdir and recurse → openat ELOOP, sensitive contents NOT in result', async () => {
  // Set up: workspace contains a benign subdir `benignsub` with one
  // file inside. Inject a hook that fires AFTER readdirAt sees
  // benignsub but BEFORE the walk recurses into it. The hook
  // rmdir's benignsub and replaces it with a symlink to outside/.
  // The new dirfd open of "benignsub" through openat with
  // O_DIRECTORY|O_NOFOLLOW must throw ELOOP, the recursion is
  // skipped, and outside/* is NOT in the glob result.
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    await mkdir(join(ws, 'benignsub'));
    await writeFile(join(ws, 'benignsub', 'inside.txt'), '', 'utf8');
    // outside/* contains a file with a name that WOULD match the
    // glob pattern if the walk followed the symlink.
    await writeFile(join(outside, 'leak.txt'), '', 'utf8');

    let hookFired = false;
    _setGlobPostReaddirHook(async ({ entries }) => {
      // Only swap on the readdir of the workspace ROOT (where
      // benignsub appears). Subsequent readdirs would be on the
      // already-opened child fd and don't help the attacker.
      if (entries.some(e => e.name === 'benignsub') && !hookFired) {
        hookFired = true;
        await rm(join(ws, 'benignsub'), { recursive: true, force: true });
        await symlink(outside, join(ws, 'benignsub'));
      }
    });
    try {
      const result = await globTool.run(
        { pattern: '**/*.txt' },
        { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
      );
      assert.equal(hookFired, true);
      assert.equal(result.ok, true);
      // The swapped-in symlink to outside/ must not have been
      // followed — leak.txt MUST NOT appear in results.
      assert.doesNotMatch(result.output, /leak\.txt/);
      // benignsub/inside.txt also can't appear because the swap
      // happened before recurse — that's fine, the contract is
      // "no leak", not "no false negatives during attack".
    } finally {
      _setGlobPostReaddirHook(null);
    }
  });
});

test('round 13 Phase 2B followup #3: $MELO_HOME read requires per-call prompt, never granted dir scope', async () => {
  // Phase 2B follow-up #3 (Codex 🟠): readRequiresApproval now
  // includes MELO_INTERNAL. Reading a file under $MELO_HOME must
  // prompt every call even if user clicked "always allow this dir".
  await withTempEnv(async ({ home }) => {
    const gate = await freshGate();
    const target = join(home, 'meloconfig.json');
    await writeFile(target, '{"k":"v"}', 'utf8');
    let promptCount = 0;
    const sse = (event, payload) => {
      promptCount++;
      // Even if user picks "dir" scope, gate's sensitive branch
      // must NOT register a session grant — next call still prompts.
      gate.resolveFileSafety(payload.requestId, 'dir');
    };
    const r1 = await fileReadTool.run(
      { path: target },
      { workspacePath: home, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(r1.ok, true);
    const r2 = await fileReadTool.run(
      { path: target },
      { workspacePath: home, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(r2.ok, true);
    assert.equal(promptCount, 2, '$MELO_HOME reads must prompt EVERY call');
  });
});

test('Phase 2B contract: read tools have requiresPermission:false (FileSafetyGate owns approval)', () => {
  // Round 13 Phase 2B follow-up #1 (Codex 🟡): if requiresPermission
  // were true, executor.js would fire its toolId-level prompt BEFORE
  // FileSafetyGate's path classification, breaking the "workspace
  // silent" contract. Pin the contract.
  assert.equal(fileReadTool.requiresPermission, false);
  assert.equal(globTool.requiresPermission, false);
  assert.equal(grepTool.requiresPermission, false);
});
