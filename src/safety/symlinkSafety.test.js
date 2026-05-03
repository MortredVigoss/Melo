/**
 * symlinkSafety.test.js — Codex C round 1 (2026-05-03) regressions.
 *
 * The earlier gate trusted the lexical path. A symlink inside the
 * workspace pointing at ~/.ssh / /etc / a tempdir-outside-workspace
 * could bypass the sensitivity gate or the workspace silent-allow
 * short-circuit. Each test below pins one bypass shape closed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
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

const HOME = homedir();

async function freshGate() {
  const grantsMod = await import('./chatScopedGrants.js');
  grantsMod.clearChat();
  const gateMod = await import('./fileSafetyGate.js');
  gateMod._clearPendingForTests();
  return { gate: gateMod, grants: grantsMod };
}

async function tempWorkspace() {
  // realpath() so /tmp -> /private/tmp on macOS doesn't trip the gate's
  // own (correct) "lexical inside ws but real outside" rule.
  return realpath(await mkdtemp(join(tmpdir(), 'fsg-symlink-')));
}

function makeAutoResolver(gate, decisions) {
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

// ─── Workspace symlink → sensitive (read) ──────────────────────────────

test('READ: workspace symlink → ~/.ssh classifies as sensitive (no silent allow)', async () => {
  const ws = await tempWorkspace();
  try {
    // Skip cleanly if ~/.ssh doesn't exist on the test box.
    let sshTarget;
    try {
      sshTarget = await realpath(join(HOME, '.ssh'));
    } catch {
      // Create a stand-in credential dir we still classify as such.
      // Falls back to a known credential path: ~/.aws (any credential
      // dir works since the gate categorises the realpath, not the
      // intermediate symlink).
      try { sshTarget = await realpath(join(HOME, '.aws')); } catch { return; }
    }
    const linkInWs = join(ws, 'badlink');
    await symlink(sshTarget, linkInWs);

    const { gate } = await freshGate();
    const { sse, events } = makeAutoResolver(gate, [{ scope: 'once' }]);
    await gate.requestRead({
      path: linkInWs,
      chatId: 'chat-A',
      sseEmitter: sse,
      workspacePath: ws,
    });
    assert.equal(events.length, 1, 'sensitive symlink target must force a prompt');
    assert.equal(events[0].payload.sensitive, true);
    assert.equal(events[0].payload.hasSymlinkInChain, true);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ─── Q1A: workspace symlink → outside workspace (benign) ───────────────

test('Q1A — READ: workspace symlink → outside workspace (benign) forces a prompt', async () => {
  const ws = await tempWorkspace();
  const outsideDir = await tempWorkspace(); // unrelated tempdir
  try {
    const outsideFile = join(outsideDir, 'data.txt');
    await writeFile(outsideFile, 'hi', 'utf8');

    const linkInWs = join(ws, 'externallink');
    await symlink(outsideFile, linkInWs);

    const { gate } = await freshGate();
    const { sse, events } = makeAutoResolver(gate, [{ scope: 'once' }]);
    await gate.requestRead({
      path: linkInWs,
      chatId: 'chat-A',
      sseEmitter: sse,
      workspacePath: ws,
    });
    assert.equal(events.length, 1, 'workspace silent-allow must NOT cover symlinks pointing outside');
    assert.equal(events[0].payload.sensitive, false);
    assert.equal(events[0].payload.hasSymlinkInChain, true);
    assert.equal(events[0].payload.withinWorkspace, false);
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

// ─── Workspace symlink → sensitive (write) ─────────────────────────────

test('WRITE: workspace symlink → /etc/hosts is HARD-rejected (no UI)', async () => {
  const ws = await tempWorkspace();
  try {
    const linkInWs = join(ws, 'hosts-shortcut');
    await symlink('/etc/hosts', linkInWs);

    const { gate } = await freshGate();
    const events = [];
    const sse = (e, p) => events.push({ e, p });
    await assert.rejects(
      gate.requestWrite({
        path: linkInWs,
        chatId: 'chat-A',
        sseEmitter: sse,
        workspacePath: ws,
      }),
      /blocked by safety policy.*real target/is,
    );
    assert.equal(events.length, 0, 'no UI fired for hard-blocked symlink target');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ─── Q2B: write through a benign symlink prompts with explicit warning ──

test('Q2B — WRITE: workspace symlink → benign external file prompts with hasSymlinkInChain=true + realPath', async () => {
  const ws = await tempWorkspace();
  const outsideDir = await tempWorkspace();
  try {
    const outsideFile = join(outsideDir, 'target.txt');
    await writeFile(outsideFile, 'old', 'utf8');

    const linkInWs = join(ws, 'mylink');
    await symlink(outsideFile, linkInWs);

    const { gate } = await freshGate();
    const { sse, events } = makeAutoResolver(gate, [{ scope: 'once' }]);
    await gate.requestWrite({
      path: linkInWs,
      chatId: 'chat-A',
      sseEmitter: sse,
      workspacePath: ws,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.hasSymlinkInChain, true);
    assert.equal(events[0].payload.realPath, outsideFile);
    assert.equal(events[0].payload.withinWorkspace, false);
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

// ─── Symlinked parent directory (create new file) ──────────────────────

test('CREATE write under a symlinked dir resolves the parent and rejects sensitive targets', async () => {
  // workspace/foo -> /etc; then `workspace/foo/newfile` should hard-reject
  const ws = await tempWorkspace();
  try {
    await symlink('/etc', join(ws, 'foo'));
    const { gate } = await freshGate();
    await assert.rejects(
      gate.requestWrite({
        path: join(ws, 'foo', 'newfile'),
        chatId: 'chat-A',
        sseEmitter: () => {},
        workspacePath: ws,
        isCreate: true,
      }),
      /blocked by safety policy/i,
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ─── Delete via symlink to sensitive ───────────────────────────────────

test('DELETE: symlink → ~/.ssh/id_rsa is HARD-rejected', async () => {
  const ws = await tempWorkspace();
  try {
    let sshFile;
    try { sshFile = await realpath(join(HOME, '.ssh')); } catch { return; }
    const linkInWs = join(ws, 'creds-link');
    await symlink(sshFile, linkInWs);
    const { gate } = await freshGate();
    await assert.rejects(
      gate.requestDelete({
        paths: [linkInWs],
        chatId: 'chat-A',
        sseEmitter: () => {},
        workspacePath: ws,
      }),
      /blocked by safety policy/i,
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ─── Per-chat grant keyed on realPath, not lexical ─────────────────────

test('grant via lexical-A applies if a different lexical-B resolves to the SAME realPath', async () => {
  const ws = await tempWorkspace();
  const outsideDir = await tempWorkspace();
  try {
    const outsideFile = join(outsideDir, 'shared.txt');
    await writeFile(outsideFile, 'x', 'utf8');
    const linkA = join(ws, 'aaa');
    const linkB = join(ws, 'bbb');
    await symlink(outsideFile, linkA);
    await symlink(outsideFile, linkB);

    const { gate } = await freshGate();
    // Approve via linkA with file-scope grant.
    const { sse: sse1 } = makeAutoResolver(gate, [{ scope: 'file' }]);
    await gate.requestRead({
      path: linkA,
      chatId: 'chat-A',
      sseEmitter: sse1,
      workspacePath: ws,
    });

    // Now reach the same realPath via linkB — should be silent.
    const e2 = [];
    await gate.requestRead({
      path: linkB,
      chatId: 'chat-A',
      sseEmitter: (e, p) => e2.push({ e, p }),
      workspacePath: ws,
    });
    assert.equal(e2.length, 0, 'realPath-keyed grant must cover any alias');
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
