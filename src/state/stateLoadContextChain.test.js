// Final integration test for Phase 7d-5α-A1 fix-6 — the StateLoadContext
// thread-through. Codex review of fix-5 (08cfab3) showed that
// readStateSnapshot's load chain still leaked through hydrateChatThreads
// (loadThreadCheckpoint) and persistChatThreads (saveThreadCheckpoint /
// pruneThreadCheckpoints) — both were using lazy `getMeloHome()` reads
// independent of the home captured at the top of the chain.
//
// This test plants a chat checkpoint in home A, kicks off readStateSnapshot,
// flips MELO_HOME to home B before any awaits resolve, and asserts that
// the resulting state object reflects home A's checkpoint AND that home B's
// threads/ directory was never touched. Under fix-5 this would fail because
// loadThreadCheckpoint would read from the home-B path post-flip.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { invalidateThreadCheckpointCache } from '../memory/checkpointer.js';

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'melo-ctx-chain-'));
  mkdirSync(join(home, 'desktop', 'threads'), { recursive: true });
  return home;
}

function cleanup(home) {
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

test('readStateSnapshot: thread checkpoint reads honor the home captured at the top of the load chain', async () => {
  const homeA = freshHome();
  const homeB = freshHome();
  invalidateThreadCheckpointCache(null, { allHomes: true });
  try {
    const CHAT_ID = 'thread-leak-regression';

    // Plant a state.json in home A that references the chat id. The chat
    // entry has no inline messages (legacy schema migrated to checkpoint
    // files), so hydrateChatThreads is the ONLY way the messages will
    // reach the hydrated state.
    writeFileSync(
      join(homeA, 'desktop', 'state.json'),
      JSON.stringify({
        projects: [],
        chats: [{
          id: CHAT_ID,
          title: 'Home A only',
          mode: 'chat',
          projectId: null,
          agentId: 'main',
          messages: [],
        }],
      }),
    );

    // Plant a checkpoint file under home A that hydrateChatThreads will
    // pick up. Distinct content lets the assertion prove this path was
    // taken.
    const homeACheckpoint = {
      version: 1,
      threadId: CHAT_ID,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      messages: [
        { id: 'a-msg-1', role: 'user', content: 'home A ONLY message' },
      ],
      derived: { source: 'home-A-checkpoint' },
    };
    writeFileSync(
      join(homeA, 'desktop', 'threads', `${CHAT_ID}.json`),
      JSON.stringify(homeACheckpoint),
    );

    // Plant a DIFFERENT checkpoint under home B for the SAME thread id.
    // If the load chain leaks home B's path post-flip, the resulting
    // state would contain home-B-checkpoint instead.
    const homeBCheckpoint = {
      ...homeACheckpoint,
      messages: [
        { id: 'b-msg-1', role: 'user', content: 'home B leaked message' },
      ],
      derived: { source: 'home-B-checkpoint' },
    };
    mkdirSync(join(homeB, 'desktop', 'threads'), { recursive: true });
    writeFileSync(
      join(homeB, 'desktop', 'threads', `${CHAT_ID}.json`),
      JSON.stringify(homeBCheckpoint),
    );

    // Cache-bust import so stateStore loads cleanly relative to the test.
    const query = `?t=${Date.now()}-${Math.random()}`;
    process.env.MELO_HOME = homeA;
    const { readStateSnapshot } = await import(`./stateStore.js${query}`);

    // Kick off the load under home A.
    process.env.MELO_HOME = homeA;
    const loadPromise = readStateSnapshot({ persistRepair: false });

    // Flip env to home B BEFORE awaits resolve. With fix-6 the captured
    // ctx.threadsDir is home A's; with the pre-fix-6 lazy resolution
    // hydrateChatThreads would now read from home B.
    process.env.MELO_HOME = homeB;

    const state = await loadPromise;

    // Assert: hydrated state carries home A's checkpoint payload, NOT
    // home B's leaked one.
    const chat = state.chats.find(c => c.id === CHAT_ID);
    assert.ok(chat, 'chat must be present in hydrated state');
    assert.equal(chat.messages.length, 1);
    assert.equal(
      chat.messages[0].content,
      'home A ONLY message',
      'hydrateChatThreads must read the home A checkpoint, not home B (would prove fix-6 captured threadsDir worked)',
    );
  } finally {
    cleanup(homeA);
    cleanup(homeB);
    invalidateThreadCheckpointCache(null, { allHomes: true });
  }
});

test('readStateSnapshot repair-save: memory store writes land in the captured home (fix-7)', async () => {
  // The 7th and final layer Codex caught: even after fix-6 routed
  // state.json + thread checkpoints through ctx, syncMemoryStoreSnapshot
  // still wrote into whatever sqlite handle was cached on memory/store.js.
  // If env flipped during the load chain, the captured home's state would
  // be indexed into the OTHER home's store.sqlite (or worse, into the
  // first home's already-cached handle while the captured home was a
  // different disk).
  //
  // Fix-7: ctx.storePath travels through saveState → persistStateAtomically
  // → syncMemoryStoreSnapshot → replaceMemories({ storePath }), which when
  // the path differs from the cached production handle opens a disposable
  // db handle bound to the captured home. This test verifies the chain
  // end-to-end.
  const homeA = freshHome();
  const homeB = freshHome();
  invalidateThreadCheckpointCache(null, { allHomes: true });
  try {
    const CHAT_ID = 'memory-store-iso-regression';

    // Seed state.json with a chat that has indexable messages — this
    // creates memory entries during repair-save's syncMemoryStoreSnapshot.
    writeFileSync(
      join(homeA, 'desktop', 'state.json'),
      JSON.stringify({
        projects: [],
        chats: [{
          id: CHAT_ID,
          title: 'Memory store fix-7 test',
          mode: 'chat',
          projectId: null,
          agentId: 'main',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
          messages: [
            { id: 'msg-1', role: 'user', content: 'home A captured-load message' },
          ],
        }],
      }),
    );

    // Cache-bust import — fresh stateStore + memory store handles per
    // test home.
    const query = `?t=${Date.now()}-${Math.random()}`;
    const { _resetStoreForTests } = await import('../memory/store.js');
    _resetStoreForTests();

    process.env.MELO_HOME = homeA;
    const { readStateSnapshot } = await import(`./stateStore.js${query}`);
    const loadPromise = readStateSnapshot({ persistRepair: true });

    // Flip env mid-load, before the repair-save's microtasks fire.
    process.env.MELO_HOME = homeB;

    await loadPromise;

    // Wait for any background prime work to settle.
    for (let i = 0; i < 20; i += 1) {
      await new Promise(r => setImmediate(r));
    }

    // Assert: home A's store.sqlite was created (the disposable handle
    // path).
    assert.ok(
      existsSync(join(homeA, 'desktop', 'store.sqlite')),
      `home A's store.sqlite must be present (got home A files: ${readdirSync(join(homeA, 'desktop')).join(', ')})`,
    );
    // fix-8 strengthening: don't just check that the file exists — open it
    // directly and verify the captured chat's message was indexed into the
    // `memories` table. File existence alone could pass even if the
    // disposable handle's schema apply silently failed and replaceMemories
    // never wrote rows.
    const { DatabaseSync } = await import('node:sqlite');
    const inspectDb = new DatabaseSync(join(homeA, 'desktop', 'store.sqlite'));
    try {
      const messageRow = inspectDb.prepare(
        `SELECT id, namespace, text FROM memories WHERE namespace = ? AND id LIKE ?`,
      ).get(`chat:${CHAT_ID}`, `message:chat:${CHAT_ID}:%`);
      assert.ok(
        messageRow,
        `home A's memories table must contain the indexed chat message (got rows: ${JSON.stringify(inspectDb.prepare('SELECT id, namespace FROM memories LIMIT 10').all())})`,
      );
      assert.ok(
        String(messageRow.text || '').includes('home A captured-load message'),
        `indexed memory row text must contain the original message content (got: ${JSON.stringify(messageRow)})`,
      );
    } finally {
      try { inspectDb.close(); } catch {}
    }
    // Assert: home B's store.sqlite was NOT created. If the leak persists,
    // syncMemoryStoreSnapshot would have either created home B's file or
    // written into the cached handle (which by env flip time is bound to
    // home B's path since we _resetStoreForTests'd before starting).
    assert.equal(
      existsSync(join(homeB, 'desktop', 'store.sqlite')),
      false,
      `home B's store.sqlite must NOT be present. If present, fix-7 ctx.storePath threading regressed (home B files: ${existsSync(join(homeB, 'desktop')) ? readdirSync(join(homeB, 'desktop')).join(', ') : '(no desktop/ dir)'})`,
    );
  } finally {
    cleanup(homeA);
    cleanup(homeB);
    invalidateThreadCheckpointCache(null, { allHomes: true });
  }
});

test('readStateSnapshot repair-save: thread checkpoint writes land in the captured home', async () => {
  const homeA = freshHome();
  const homeB = freshHome();
  invalidateThreadCheckpointCache(null, { allHomes: true });
  try {
    const CHAT_ID = 'repair-save-regression';

    // Seed home A with state.json that has a chat WITH messages but no
    // checkpoint file. hydrateChatThreads will detect a hydration repair
    // (legacy messages -> checkpoint format), which triggers the
    // repair-save path through saveState.
    const stateJson = {
      projects: [],
      chats: [{
        id: CHAT_ID,
        title: 'Repair test',
        mode: 'chat',
        projectId: null,
        agentId: 'main',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [
          { id: 'msg-1', role: 'user', content: 'legacy inline message' },
        ],
      }],
    };
    writeFileSync(join(homeA, 'desktop', 'state.json'), JSON.stringify(stateJson));

    // Cache-bust import — the test suite shares this stateStore instance
    // across tests, but the readStateSnapshot capture chain is what we
    // are asserting, not import-time state.
    const query = `?t=${Date.now()}-${Math.random()}`;
    process.env.MELO_HOME = homeA;
    const { readStateSnapshot } = await import(`./stateStore.js${query}`);

    process.env.MELO_HOME = homeA;
    const loadPromise = readStateSnapshot({ persistRepair: true });

    // Flip env mid-load.
    process.env.MELO_HOME = homeB;

    await loadPromise;

    // Assert: the repair-save wrote a checkpoint file into home A, and
    // home B's threads/ directory remains empty.
    const homeAThreads = readdirSync(join(homeA, 'desktop', 'threads'));
    assert.ok(
      homeAThreads.some(name => name.startsWith(CHAT_ID)),
      `home A's threads/ must contain the repair-save'd checkpoint (got: ${homeAThreads.join(', ')})`,
    );

    if (existsSync(join(homeB, 'desktop', 'threads'))) {
      const homeBThreads = readdirSync(join(homeB, 'desktop', 'threads'));
      assert.equal(
        homeBThreads.length,
        0,
        `home B's threads/ must be empty (got: ${homeBThreads.join(', ')}). If non-empty, the repair-save leaked across MELO_HOME flip`,
      );
    }
  } finally {
    cleanup(homeA);
    cleanup(homeB);
    invalidateThreadCheckpointCache(null, { allHomes: true });
  }
});
