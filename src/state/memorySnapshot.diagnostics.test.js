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

test('MELO_DEBUG_MEMORY=1 + no ctx.storePath → diagnostic prints resolved path with (default) tag', async () => {
  // Codex follow-up (Phase E 🟡 P2 2026-05-05): the original placeholder
  // "(default MELO_HOME)" hid exactly the problem this diagnostic
  // exists to surface (multiple MELO_HOMEs reading/writing different
  // store files). Pin the resolved path so a regression to the
  // placeholder lights up red.
  await withTempEnv(async (dir) => {
    process.env.MELO_DEBUG_MEMORY = '1';
    const { syncMemoryStoreSnapshot } = await import(`./memorySnapshot.js?cb=${Date.now()}-h1`);
    const lines = captureConsoleLog(() => {
      syncMemoryStoreSnapshot({ chats: [] });
    });
    const log = lines.find(l => l.includes('[memory.snapshot]'));
    assert.ok(log);
    // Path must be present + carry the (default) tag so the operator
    // knows this is the env-resolved path, not a ctx override.
    assert.match(log, /storePath=.+\/desktop\/store\.sqlite \(default\)/,
      'diagnostic must show the actual resolved store path with (default) tag');
    // The path must specifically resolve through the test's MELO_HOME.
    assert.ok(log.includes(dir),
      'resolved path must reflect the current MELO_HOME, not a stale value');
  });
});

test('MELO_DEBUG_MEMORY=1 + ctx.storePath provided → diagnostic prints (ctx) tag', async () => {
  await withTempEnv(async (dir) => {
    process.env.MELO_DEBUG_MEMORY = '1';
    const { syncMemoryStoreSnapshot } = await import(`./memorySnapshot.js?cb=${Date.now()}-h2`);
    const explicit = `${dir}/some/other/store.sqlite`;
    const lines = captureConsoleLog(() => {
      syncMemoryStoreSnapshot({ chats: [] }, { ctx: { storePath: explicit } });
    });
    const log = lines.find(l => l.includes('[memory.snapshot]'));
    assert.ok(log);
    assert.ok(log.includes(`storePath=${explicit} (ctx)`),
      'diagnostic must mark caller-supplied storePath with (ctx) tag');
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

test('buildMemoryStoreEntries does not index assistant diagnostics as prompt memory', async () => {
  const { buildMemoryStoreEntries } = await import(`./memorySnapshot.js?cb=${Date.now()}-filter`);
  const entries = buildMemoryStoreEntries({
    settings: { promptHistory: [] },
    chats: [
      {
        id: 'chat-filter',
        title: 'Filter diagnostics',
        messages: [
          {
            id: 'u1',
            role: 'user',
            content: '重新看这个抖音链接',
            createdAt: '2026-05-01T00:00:00Z',
          },
          {
            id: 'a1',
            role: 'assistant',
            content: 'Codex blocked this request because the current thread context looked cybersecurity-sensitive.',
            createdAt: '2026-05-01T00:00:01Z',
          },
          {
            id: 'a2',
            role: 'assistant',
            content: '这个结果提示需要 fresh cookies 和临时访问凭证。',
            createdAt: '2026-05-01T00:00:02Z',
          },
        ],
      },
    ],
  });

  const text = entries.map(entry => entry.text).join('\n');
  assert.match(text, /重新看这个抖音链接/);
  assert.doesNotMatch(text, /cybersecurity/i);
  assert.doesNotMatch(text, /fresh cookies/i);
  assert.doesNotMatch(text, /临时访问凭证/);
});

test('buildMemoryStoreEntries preserves normal assistant cookie explanations', async () => {
  // Negative case: technical answers about cookies (the web concept) must
  // still be indexed into long-term memory; the filter is for social-link
  // extractor diagnostics only.
  const { buildMemoryStoreEntries } = await import(`./memorySnapshot.js?cb=${Date.now()}-filter-neg`);
  const entries = buildMemoryStoreEntries({
    settings: { promptHistory: [] },
    chats: [
      {
        id: 'chat-cookie-edu',
        title: 'How cookies work',
        messages: [
          {
            id: 'u1',
            role: 'user',
            content: '帮我讲一下 session cookies 跟 persistent cookies 的区别',
            createdAt: '2026-05-01T00:00:00Z',
          },
          {
            id: 'a1',
            role: 'assistant',
            content:
              'Session cookies 在浏览器关闭时被清空，persistent cookies 有 ' +
              'Expires 或 Max-Age 字段，会保留到指定时间。两者都是通过 Set-Cookie ' +
              'header 由服务器写入。',
            createdAt: '2026-05-01T00:00:01Z',
          },
          {
            id: 'u2',
            role: 'user',
            content: 'browser cookies 默认会跟着所有请求发送吗',
            createdAt: '2026-05-01T00:00:02Z',
          },
        ],
      },
    ],
  });

  const text = entries.map(entry => entry.text).join('\n');
  assert.match(text, /Session cookies 在浏览器关闭时被清空/);
  assert.match(text, /persistent cookies 有/);
  assert.match(text, /browser cookies 默认会跟着所有请求发送吗/);
});
