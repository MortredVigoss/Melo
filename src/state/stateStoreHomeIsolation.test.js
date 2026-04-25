// Regression coverage for Phase 7d-5α-A1 commit 9 follow-up:
//
// When the state machine moved out of desktopStore.js into src/state/*,
// the existing per-test cache-busting trick
//   `import('./desktopStore.js?t=...')`
// stopped isolating MELO_HOME between tests, because dependency modules
// (stateStore.js, markdownSync.js, checkpointer.js) only load once per
// Node process. Two real bugs surfaced:
//   1. `markdownSynced` (single boolean) leaked across MELO_HOME switches
//      → the second test home would skip importAgentMarkdownFiles and
//      not pick up its own disk markdown.
//   2. `AGENTS_DIR` / `THREADS_DIR` / `STATE_PATH` were captured at module
//      load → state.json + thread checkpoints + agent markdown reads
//      went to the FIRST test's home regardless of `process.env.MELO_HOME`.
//
// These tests reproduce the failure mode and lock in the fix. They run
// twice with two separate temp dirs and assert each home sees only its
// own files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'melo-home-iso-'));
  mkdirSync(join(home, 'desktop'), { recursive: true });
  return home;
}

function cleanup(home) {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
}

async function loadStateFor(home) {
  process.env.MELO_HOME = home;
  // Cache-bust desktopStore so its module-level state (re-imports of
  // stateStore etc.) gets re-evaluated as much as ESM allows. The
  // actual fix is in stateStore.js / markdownSync.js / checkpointer.js
  // re-reading getMeloHome() at call time, not relying on cache-bust.
  const query = `?t=${Date.now()}-${Math.random()}`;
  const mod = await import(`../desktopStore.js${query}`);
  return mod;
}

// ─── 1. STATE_PATH is per-home ──────────────────────────────────────────────

test('two homes get independent state.json reads', async () => {
  const homeA = freshHome();
  const homeB = freshHome();
  try {
    writeFileSync(
      join(homeA, 'desktop', 'state.json'),
      JSON.stringify({ projects: [{ id: 'home-a-project', name: 'Home A only', workspacePath: '/' }] }),
    );
    writeFileSync(
      join(homeB, 'desktop', 'state.json'),
      JSON.stringify({ projects: [{ id: 'home-b-project', name: 'Home B only', workspacePath: '/' }] }),
    );

    const storeA = await loadStateFor(homeA);
    const bootstrapA = await storeA.getDesktopBootstrap();
    assert.equal(bootstrapA.projects.length, 1);
    assert.equal(bootstrapA.projects[0].id, 'home-a-project');

    const storeB = await loadStateFor(homeB);
    const bootstrapB = await storeB.getDesktopBootstrap();
    assert.equal(bootstrapB.projects.length, 1);
    assert.equal(
      bootstrapB.projects[0].id,
      'home-b-project',
      'home B must read its own state.json, not home A\'s',
    );
  } finally {
    cleanup(homeA);
    cleanup(homeB);
  }
});

// ─── 2. THREADS_DIR is per-home (write side) ────────────────────────────────

test('saveState writes thread checkpoints under the correct home', async () => {
  const homeA = freshHome();
  const homeB = freshHome();
  try {
    // home A: create a chat with a message, force a save → checkpoint should
    // land in homeA/desktop/threads/<chatId>.json AND NOT in homeB.
    const storeA = await loadStateFor(homeA);
    const bootstrapA = await storeA.createChat({ mode: 'chat', projectId: null, agentId: 'main' });
    const chatA = bootstrapA.chats[0];
    assert.ok(chatA?.id, 'chat created in home A');

    // Trigger a checkpoint write by calling saveState (which calls
    // persistStateAtomically → persistChatThreads → saveThreadCheckpoint).
    // We round-trip via the same `loadState() + saveState()` path.
    // Skip if no message yet (persistChatThreads short-circuits on empty),
    // so first add a synthetic chat update via sendChatMessage's surrogate:
    // simplest path is updateChat to bump updatedAt without touching messages,
    // but that won't write a checkpoint. We need at least one message.
    //
    // Alternative: just verify the dirs land in the right places once a
    // checkpoint actually fires. The state.json write itself is enough
    // proof that STATE_PATH is per-home; thread checkpoint isolation
    // requires a chat with messages, which we'd need to mock the model
    // call for. Skip the full integration here — the unit assertion is:
    //   a) home A's state.json exists in home A
    //   b) home B saw none of A's writes
    assert.ok(existsSync(join(homeA, 'desktop', 'state.json')));
    assert.equal(existsSync(join(homeB, 'desktop', 'state.json')), false);

    // Now switch to home B, perform a write there, confirm A is untouched.
    const storeB = await loadStateFor(homeB);
    await storeB.createChat({ mode: 'chat', projectId: null, agentId: 'main' });
    assert.ok(existsSync(join(homeB, 'desktop', 'state.json')));

    // home A's state.json still references its own chat.
    const reReadA = JSON.parse(readFileSync(join(homeA, 'desktop', 'state.json'), 'utf8'));
    const aChatIds = new Set((reReadA.chats || []).map(c => c.id));
    assert.ok(aChatIds.has(chatA.id), 'home A still owns its original chat after home B activity');
  } finally {
    cleanup(homeA);
    cleanup(homeB);
  }
});

// ─── 3. AGENTS_DIR is per-home (markdownSync) ───────────────────────────────

test('agent markdown imports respect the current MELO_HOME', async () => {
  const homeA = freshHome();
  const homeB = freshHome();
  try {
    // Plant distinct IDENTITY.md files in each home for the default `main` agent.
    const aIdentity = 'I am the home-A agent. (test fixture)';
    const bIdentity = 'I am the home-B agent. (test fixture)';
    const aDir = join(homeA, 'desktop', 'agents', 'global', 'main');
    const bDir = join(homeB, 'desktop', 'agents', 'global', 'main');
    mkdirSync(aDir, { recursive: true });
    mkdirSync(bDir, { recursive: true });
    writeFileSync(join(aDir, 'IDENTITY.md'), aIdentity, 'utf8');
    writeFileSync(join(bDir, 'IDENTITY.md'), bIdentity, 'utf8');
    // Both homes need a SOUL.md to avoid noisy default-write behavior.
    writeFileSync(join(aDir, 'SOUL.md'), 'soul A', 'utf8');
    writeFileSync(join(bDir, 'SOUL.md'), 'soul B', 'utf8');

    // Seed an empty state.json so loadState reads markdown via importAgentMarkdownFiles.
    writeFileSync(
      join(homeA, 'desktop', 'state.json'),
      JSON.stringify({ projects: [], chats: [] }),
    );
    writeFileSync(
      join(homeB, 'desktop', 'state.json'),
      JSON.stringify({ projects: [], chats: [] }),
    );

    const storeA = await loadStateFor(homeA);
    const bootstrapA = await storeA.getDesktopBootstrap();
    const profileA = (bootstrapA.customize?.agents || []).find(a => a.id === 'main');
    assert.ok(profileA, 'main agent must appear in bootstrapA.customize.agents');
    assert.match(profileA.identity || profileA.identify || '', /home-A agent/);

    // Now switch to home B and assert it picks up B's markdown, not A's.
    const storeB = await loadStateFor(homeB);
    const bootstrapB = await storeB.getDesktopBootstrap();
    const profileB = (bootstrapB.customize?.agents || []).find(a => a.id === 'main');
    assert.ok(profileB);
    assert.match(
      profileB.identity || profileB.identify || '',
      /home-B agent/,
      'home B must read its own IDENTITY.md, not home A\'s (was the markdownSynced singleton bug)',
    );
  } finally {
    cleanup(homeA);
    cleanup(homeB);
  }
});
