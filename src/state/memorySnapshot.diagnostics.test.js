// memorySnapshot.diagnostics.test.js — Phase E diagnostics gate.
//
// Pins the MELO_DEBUG_MEMORY=1 logging contract so a future refactor
// of syncMemoryStoreSnapshot can't silently lose the per-saveState
// audit line. Without this log it took weeks to notice that the
// production memory store had 0 frame/scene rows even though the
// Phase 7d-5α-A1 wiring was in place — the data flow itself was the
// problem (state.chats stayed empty), not the wiring.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withTempEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'melo-mem-diag-'));
  const prevHome = process.env.MELO_HOME;
  const prevDebug = process.env.MELO_DEBUG_MEMORY;
  process.env.MELO_HOME = dir;
  try {
    await fn(dir);
  } finally {
    if (prevHome === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prevHome;
    if (prevDebug === undefined) delete process.env.MELO_DEBUG_MEMORY;
    else process.env.MELO_DEBUG_MEMORY = prevDebug;
    await rm(dir, { recursive: true, force: true });
  }
}

function captureConsoleLog(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('MELO_DEBUG_MEMORY unset → no log lines emitted', async () => {
  await withTempEnv(async () => {
    delete process.env.MELO_DEBUG_MEMORY;
    const { syncMemoryStoreSnapshot } = await import(`./memorySnapshot.js?cb=${Date.now()}-a`);
    const lines = captureConsoleLog(() => {
      syncMemoryStoreSnapshot({ chats: [] });
    });
    assert.equal(
      lines.filter(l => l.includes('[memory.snapshot]')).length,
      0,
      'no memory.snapshot log when debug flag is unset',
    );
  });
});

test('MELO_DEBUG_MEMORY=1 + empty chats → log shows chats=0 entries>=0', async () => {
  await withTempEnv(async () => {
    process.env.MELO_DEBUG_MEMORY = '1';
    const { syncMemoryStoreSnapshot } = await import(`./memorySnapshot.js?cb=${Date.now()}-b`);
    const lines = captureConsoleLog(() => {
      syncMemoryStoreSnapshot({ chats: [] });
    });
    const log = lines.find(l => l.includes('[memory.snapshot]'));
    assert.ok(log, 'expected one memory.snapshot log line');
    assert.match(log, /chats=0/);
    assert.match(log, /eligibleChats=0/);
    assert.match(log, /tiers=N\/A\(no chats\)/);
  });
});

test('MELO_DEBUG_MEMORY=1 + chat with ≥3 messages → log shows frame/scene counted', async () => {
  await withTempEnv(async () => {
    process.env.MELO_DEBUG_MEMORY = '1';
    const { syncMemoryStoreSnapshot } = await import(`./memorySnapshot.js?cb=${Date.now()}-c`);
    const lines = captureConsoleLog(() => {
      // Messages MUST have createdAt — frame.startAt is built from it,
      // and groupIntoScenes filters out frames lacking startAt. Without
      // timestamps you get frames but no scenes, which is itself a real
      // production gotcha worth pinning.
      syncMemoryStoreSnapshot({
        chats: [
          {
            id: 'c1',
            messages: [
              { id: 'm1', role: 'user',      content: 'one',   createdAt: '2026-05-01T00:00:00Z' },
              { id: 'm2', role: 'assistant', content: 'two',   createdAt: '2026-05-01T00:00:01Z' },
              { id: 'm3', role: 'user',      content: 'three', createdAt: '2026-05-01T00:00:10Z' },
              { id: 'm4', role: 'assistant', content: 'four',  createdAt: '2026-05-01T00:00:11Z' },
            ],
          },
        ],
      });
    });
    const log = lines.find(l => l.includes('[memory.snapshot]'));
    assert.ok(log);
    assert.match(log, /chats=1/);
    assert.match(log, /eligibleChats=1/);
    // The whole point of the audit: frame + scene must show up in the
    // by-kind breakdown when the wiring works.
    assert.match(log, /frame=\d+/, 'frame entries must be counted in the diagnostic');
    assert.match(log, /scene=\d+/, 'scene entries must be counted in the diagnostic');
    assert.match(log, /tiers=[\w,]+/);
  });
});

test('MELO_DEBUG_MEMORY=1 + chat with <3 messages → eligibleChats=0 and no frame/scene', async () => {
  await withTempEnv(async () => {
    process.env.MELO_DEBUG_MEMORY = '1';
    const { syncMemoryStoreSnapshot } = await import(`./memorySnapshot.js?cb=${Date.now()}-d`);
    const lines = captureConsoleLog(() => {
      syncMemoryStoreSnapshot({
        chats: [
          { id: 'c1', messages: [{ id: 'm1', role: 'user', content: 'hi' }] },
        ],
      });
    });
    const log = lines.find(l => l.includes('[memory.snapshot]'));
    assert.ok(log);
    assert.match(log, /chats=1/);
    assert.match(log, /eligibleChats=0/);
    // Frame/scene should NOT appear in the kind list.
    assert.equal(/\bframe=/.test(log), false, 'frame must not be counted when eligible chats = 0');
    assert.equal(/\bscene=/.test(log), false, 'scene must not be counted when eligible chats = 0');
  });
});
