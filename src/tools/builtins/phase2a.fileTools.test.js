/**
 * phase2a.fileTools.test.js — Phase 2A integration tests.
 *
 * Each of fileWriteTool / fileEditTool / fileDeleteTool / fileMoveTool
 * is now wired through the FileSafetyGate. These tests drive the
 * gate's SSE flow synchronously and assert:
 *   - happy path (auto-approve → file actually changes on disk)
 *   - deny (user clicks Deny → tool returns DENIED, no fs side effect)
 *   - sensitive path (gate hard-rejects /etc/hosts etc — no UI)
 *   - workspace-internal symlink → outside file (delete: link gone,
 *     external file untouched)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, basename } from 'node:path';
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  mkdir,
  symlink,
  stat,
  lstat,
  readlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { fileWriteTool } from './fileWriteTool.js';
import { fileEditTool } from './fileEditTool.js';
import { fileDeleteTool } from './fileDeleteTool.js';
import { fileMoveTool } from './fileMoveTool.js';

async function freshGate() {
  const grants = await import('../../safety/chatScopedGrants.js');
  grants.clearChat();
  const gate = await import('../../safety/fileSafetyGate.js');
  gate._clearPendingForTests();
  return gate;
}

async function withTempEnv(fn) {
  const home = await mkdtemp(join(tmpdir(), 'p2a-home-'));
  const ws = await realpath(await mkdtemp(join(tmpdir(), 'p2a-ws-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'p2a-out-')));
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

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}
async function pathExists(p) {
  try { await lstat(p); return true; } catch { return false; }
}

// SSE that auto-allows every prompt with the supplied scope/confirmInput.
// `decisions` lets a caller customize per-prompt (used for delete's
// two-stage flow).
function autoApprove(gate, decisions = []) {
  let cursor = 0;
  return (event, payload) => {
    const decision = decisions[cursor++] || { scope: 'once' };
    queueMicrotask(() =>
      gate.resolveFileSafety(payload.requestId, decision.scope, {
        confirmInput: decision.confirmInput,
      }),
    );
  };
}

function autoDeny(gate) {
  return (event, payload) => {
    queueMicrotask(() => gate.resolveFileSafety(payload.requestId, 'deny'));
  };
}

// ─── fileWriteTool ─────────────────────────────────────────────────────

test('fileWriteTool: happy path creates a new file via gate approval', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'new.txt');
    const result = await fileWriteTool.run(
      { path: target, content: 'hello world' },
      { workspacePath: ws, sseEmitter: autoApprove(gate), chatId: 'chat-A' },
    );
    assert.equal(result.ok, true);
    assert.equal(await readFile(target, 'utf8'), 'hello world');
    assert.equal(result.meta.wasCreate, true);
    assert.ok(result.meta.backupOperationId, 'backup operationId recorded');
  });
});

test('fileWriteTool: overwrite captures backup snapshot of old content', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'foo.txt');
    await writeFile(target, 'OLD', 'utf8');
    const result = await fileWriteTool.run(
      { path: target, content: 'NEW' },
      { workspacePath: ws, sseEmitter: autoApprove(gate), chatId: 'chat-A' },
    );
    assert.equal(result.ok, true);
    assert.equal(await readFile(target, 'utf8'), 'NEW');
    assert.equal(result.meta.wasCreate, false);
    // Backup folder must contain the OLD content.
    const { listBackups } = await import('../../safety/backup.js');
    const list = await listBackups();
    const backup = list.find(b => b.operationId === result.meta.backupOperationId);
    assert.ok(backup, 'backup entry found');
    const beforeContent = await readFile(
      join(backup.opDir, 'before', 'foo.txt'),
      'utf8',
    );
    assert.equal(beforeContent, 'OLD');
  });
});

test('fileWriteTool: deny → returns DENIED, file unchanged', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'foo.txt');
    await writeFile(target, 'OLD', 'utf8');
    const result = await fileWriteTool.run(
      { path: target, content: 'NEW' },
      { workspacePath: ws, sseEmitter: autoDeny(gate), chatId: 'chat-A' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.equal(await readFile(target, 'utf8'), 'OLD');
  });
});

test('fileWriteTool: sensitive path /etc/hosts → hard-rejected without UI', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    let promptCount = 0;
    const sse = () => { promptCount++; };
    const result = await fileWriteTool.run(
      { path: '/etc/hosts', content: 'evil' },
      { workspacePath: ws, sseEmitter: sse, chatId: 'chat-A' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.equal(promptCount, 0, 'sensitive path must NOT fire any UI prompt');
  });
});

// ─── fileEditTool ──────────────────────────────────────────────────────

test('fileEditTool: replace single occurrence, gate-approved, backup recorded', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'a.js');
    await writeFile(target, 'const x = 1;\n', 'utf8');
    const result = await fileEditTool.run(
      { path: target, old_string: 'const x = 1;', new_string: 'const x = 2;' },
      { workspacePath: ws, sseEmitter: autoApprove(gate), chatId: 'chat-A' },
    );
    assert.equal(result.ok, true);
    assert.equal(await readFile(target, 'utf8'), 'const x = 2;\n');
    assert.equal(result.meta.occurrencesReplaced, 1);
    assert.ok(result.meta.backupOperationId);
  });
});

test('fileEditTool: replace_all replaces every occurrence', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'a.js');
    await writeFile(target, 'foo foo foo', 'utf8');
    const result = await fileEditTool.run(
      { path: target, old_string: 'foo', new_string: 'bar', replace_all: true },
      { workspacePath: ws, sseEmitter: autoApprove(gate), chatId: 'chat-A' },
    );
    assert.equal(result.ok, true);
    assert.equal(await readFile(target, 'utf8'), 'bar bar bar');
    assert.equal(result.meta.occurrencesReplaced, 3);
  });
});

test('fileEditTool: deny → returns DENIED, file unchanged', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'a.js');
    await writeFile(target, 'const x = 1;', 'utf8');
    const result = await fileEditTool.run(
      { path: target, old_string: 'const x = 1;', new_string: 'const x = 2;' },
      { workspacePath: ws, sseEmitter: autoDeny(gate), chatId: 'chat-A' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.equal(await readFile(target, 'utf8'), 'const x = 1;');
  });
});

// ─── fileDeleteTool ────────────────────────────────────────────────────

test('fileDeleteTool: happy path moves file to trash with two-stage approval', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'doomed.txt');
    await writeFile(target, 'x', 'utf8');
    const result = await fileDeleteTool.run(
      { paths: [target] },
      {
        workspacePath: ws,
        chatId: 'chat-A',
        sseEmitter: autoApprove(gate, [
          { scope: 'once' }, // stage-1 intent
          { scope: 'once', confirmInput: 'doomed.txt' }, // stage-2 filename check
        ]),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(await fileExists(target), false, 'target removed');
    // Trash entry exists with the file backed up.
    const { listTrash } = await import('../../safety/trash.js');
    const list = await listTrash();
    assert.equal(list.length, 1);
    assert.equal(list[0].operationId, result.meta.operationId);
  });
});

test('fileDeleteTool: wrong filename in stage-2 → rejected, file untouched', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'doomed.txt');
    await writeFile(target, 'x', 'utf8');
    const result = await fileDeleteTool.run(
      { paths: [target] },
      {
        workspacePath: ws,
        chatId: 'chat-A',
        sseEmitter: autoApprove(gate, [
          { scope: 'once' },
          { scope: 'once', confirmInput: 'wrong-name.txt' },
        ]),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.equal(await fileExists(target), true, 'target untouched on confirmation failure');
  });
});

test('fileDeleteTool: workspace symlink → outside file deletes the link, leaves the target', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const externalFile = join(outside, 'precious.txt');
    const link = join(ws, 'mylink');
    await writeFile(externalFile, 'precious', 'utf8');
    await symlink(externalFile, link);

    const result = await fileDeleteTool.run(
      { paths: [link] },
      {
        workspacePath: ws,
        chatId: 'chat-A',
        sseEmitter: autoApprove(gate, [
          { scope: 'once' },
          { scope: 'once', confirmInput: 'mylink' },
        ]),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(await pathExists(link), false, 'link removed');
    assert.equal(
      await fileExists(externalFile), true,
      'external file MUST still exist',
    );
    assert.equal(await readFile(externalFile, 'utf8'), 'precious');
  });
});

test('fileDeleteTool: sensitive symlink → /etc/hosts hard-rejected without UI', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const link = join(ws, 'sneaky');
    await symlink('/etc/hosts', link);

    let promptCount = 0;
    const sse = () => { promptCount++; };
    const result = await fileDeleteTool.run(
      { paths: [link] },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.equal(promptCount, 0, 'no UI prompt for hard-rejected sensitive symlink target');
    assert.equal(await pathExists(link), true, 'link unchanged');
  });
});

test('fileDeleteTool: invalid args (empty paths array) → INVALID_PATHS', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const result = await fileDeleteTool.run(
      { paths: [] },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_PATHS');
  });
});

// ─── Codex D round 1 (Phase 2A): sensitive zero-side-effect contract ──

test('fileWriteTool sensitive: NO .melo-backups entry created on hard-rejection', async () => {
  await withTempEnv(async ({ ws, home }) => {
    const gate = await freshGate();
    const result = await fileWriteTool.run(
      { path: '/etc/hosts', content: 'evil' },
      { workspacePath: ws, sseEmitter: () => {}, chatId: 'chat-A' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    // .melo-backups must be empty — the snapshot was correctly
    // deferred to after the (rejected) approval.
    const { listBackups } = await import('../../safety/backup.js');
    const list = await listBackups();
    assert.equal(list.length, 0, '.melo-backups must be empty after sensitive rejection');
  });
});

test('fileEditTool sensitive: NO read happens, returns DENIED (not NOT_FOUND/AMBIGUOUS)', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    // Try to probe /etc/hosts for whether it contains "127.0.0.1".
    // If the tool reads first, the error tells the attacker whether
    // the string is present (NOT_FOUND vs success/AMBIGUOUS). Pre-
    // check must short-circuit so the error is uniformly DENIED.
    const result = await fileEditTool.run(
      { path: '/etc/hosts', old_string: '127.0.0.1', new_string: 'X' },
      { workspacePath: ws, sseEmitter: () => {}, chatId: 'chat-A' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.notEqual(result.error, 'NOT_FOUND');
    assert.notEqual(result.error, 'AMBIGUOUS');
    // No backups either.
    const { listBackups } = await import('../../safety/backup.js');
    assert.equal((await listBackups()).length, 0);
  });
});

test('fileWriteTool deny: NO .melo-backups entry left over (snapshot is post-approval)', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'foo.txt');
    await writeFile(target, 'OLD', 'utf8');
    const result = await fileWriteTool.run(
      { path: target, content: 'NEW' },
      { workspacePath: ws, sseEmitter: autoDeny(gate), chatId: 'chat-A' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.equal(await readFile(target, 'utf8'), 'OLD');
    // Codex D round 1: snapshot is NOW after approval — deny path
    // must leave .melo-backups untouched.
    const { listBackups } = await import('../../safety/backup.js');
    const list = await listBackups();
    assert.equal(list.length, 0, 'no backup must be created on deny');
  });
});

test('fileEditTool deny: NO .melo-backups entry left over', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'foo.txt');
    await writeFile(target, 'foo', 'utf8');
    const result = await fileEditTool.run(
      { path: target, old_string: 'foo', new_string: 'bar' },
      { workspacePath: ws, sseEmitter: autoDeny(gate), chatId: 'chat-A' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    const { listBackups } = await import('../../safety/backup.js');
    assert.equal((await listBackups()).length, 0);
  });
});

test('fileWriteTool: workspace symlink → /etc/hosts hard-rejected with zero side effect', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const link = join(ws, 'sneaky');
    await symlink('/etc/hosts', link);
    let promptCount = 0;
    const sse = () => { promptCount++; };
    const result = await fileWriteTool.run(
      { path: link, content: 'evil' },
      { workspacePath: ws, sseEmitter: sse, chatId: 'chat-A' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.equal(promptCount, 0);
    // Link itself untouched — no rewrite via symlink-follow.
    assert.equal(await readlink(link), '/etc/hosts');
    const { listBackups } = await import('../../safety/backup.js');
    assert.equal((await listBackups()).length, 0);
  });
});

test('fileEditTool: workspace symlink → /etc/hosts hard-rejected, no probe of /etc/hosts content', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const link = join(ws, 'sneaky');
    await symlink('/etc/hosts', link);
    let promptCount = 0;
    const sse = () => { promptCount++; };
    const result = await fileEditTool.run(
      { path: link, old_string: '127.0.0.1', new_string: 'X' },
      { workspacePath: ws, sseEmitter: sse, chatId: 'chat-A' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.equal(promptCount, 0);
    assert.equal(await readlink(link), '/etc/hosts');
  });
});

// ─── Codex D round 2 (Phase 2A): resolved-target-bound snapshot ───────

test('fileWriteTool via workspace symlink → outside benign file: backup binds to RESOLVED target, not lexical link', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const externalFile = join(outside, 'real.txt');
    const link = join(ws, 'mylink');
    await writeFile(externalFile, 'ORIG', 'utf8');
    await symlink(externalFile, link);

    const result = await fileWriteTool.run(
      { path: link, content: 'NEW' },
      { workspacePath: ws, sseEmitter: autoApprove(gate), chatId: 'chat-A' },
    );
    assert.equal(result.ok, true);
    // Following the link reaches the (now-changed) external file:
    assert.equal(await readFile(link, 'utf8'), 'NEW');
    assert.equal(await readFile(externalFile, 'utf8'), 'NEW');
    // Link itself untouched:
    assert.equal(await readlink(link), externalFile);

    // The backup MUST have been bound to the resolved external file,
    // not the lexical link, so a post-commit symlink swap could not
    // have poisoned the snapshot.
    const { listBackups } = await import('../../safety/backup.js');
    const list = await listBackups();
    assert.equal(list.length, 1);
    const manifest = list[0];
    assert.equal(
      manifest.originalPath, externalFile,
      'manifest.originalPath = commit-resolved real path (defence against commit→snapshot race)',
    );
    assert.equal(
      manifest.lexicalPath, link,
      'manifest.lexicalPath = user-supplied input (UI display)',
    );
    // The actual backed-up bytes match what was at the resolved target
    // BEFORE the write (i.e. ORIG, not NEW).
    const beforePath = join(manifest.opDir, 'before', basename(externalFile));
    assert.equal(await readFile(beforePath, 'utf8'), 'ORIG');
  });
});

test('fileEditTool via workspace symlink → outside benign file: backup binds to RESOLVED target', async () => {
  await withTempEnv(async ({ ws, outside }) => {
    const gate = await freshGate();
    const externalFile = join(outside, 'real.txt');
    const link = join(ws, 'mylink');
    await writeFile(externalFile, 'foo bar', 'utf8');
    await symlink(externalFile, link);

    const result = await fileEditTool.run(
      { path: link, old_string: 'foo', new_string: 'baz' },
      { workspacePath: ws, sseEmitter: autoApprove(gate), chatId: 'chat-A' },
    );
    assert.equal(result.ok, true);
    assert.equal(await readFile(externalFile, 'utf8'), 'baz bar');
    assert.equal(await readlink(link), externalFile);

    const { listBackups } = await import('../../safety/backup.js');
    const list = await listBackups();
    assert.equal(list[0].originalPath, externalFile);
    assert.equal(list[0].lexicalPath, link);
  });
});

test('non-symlink write: lexicalPath === originalPath in the manifest (back-compat sanity)', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const target = join(ws, 'plain.txt');
    await writeFile(target, 'OLD', 'utf8');
    await fileWriteTool.run(
      { path: target, content: 'NEW' },
      { workspacePath: ws, sseEmitter: autoApprove(gate), chatId: 'chat-A' },
    );
    const { listBackups } = await import('../../safety/backup.js');
    const list = await listBackups();
    assert.equal(list[0].originalPath, target);
    assert.equal(list[0].lexicalPath, target);
  });
});

// ─── fileMoveTool ──────────────────────────────────────────────────────

test('fileMoveTool: rename within workspace, gate-approved', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const src = join(ws, 'a.txt');
    const dst = join(ws, 'b.txt');
    await writeFile(src, 'x', 'utf8');
    const result = await fileMoveTool.run(
      { src, dst },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoApprove(gate) },
    );
    assert.equal(result.ok, true);
    assert.equal(await fileExists(src), false);
    assert.equal(await fileExists(dst), true);
    assert.equal(await readFile(dst, 'utf8'), 'x');
  });
});

test('fileMoveTool: destination /etc/hosts hard-rejected', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const src = join(ws, 'a.txt');
    await writeFile(src, 'x', 'utf8');
    let promptCount = 0;
    const sse = () => { promptCount++; };
    const result = await fileMoveTool.run(
      { src, dst: '/etc/hosts' },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: sse },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.equal(promptCount, 0);
    assert.equal(await fileExists(src), true);
  });
});

test('fileMoveTool: deny → returns DENIED, src untouched', async () => {
  await withTempEnv(async ({ ws }) => {
    const gate = await freshGate();
    const src = join(ws, 'a.txt');
    const dst = join(ws, 'b.txt');
    await writeFile(src, 'x', 'utf8');
    const result = await fileMoveTool.run(
      { src, dst },
      { workspacePath: ws, chatId: 'chat-A', sseEmitter: autoDeny(gate) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.equal(await fileExists(src), true);
    assert.equal(await fileExists(dst), false);
  });
});
