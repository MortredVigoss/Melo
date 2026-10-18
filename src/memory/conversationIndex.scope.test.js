import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 2026-10-17 audit P0-3: search_history must not cross audiences or projects.
async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'melo-convidx-scope-'));
  const previous = process.env.MELO_HOME;
  process.env.MELO_HOME = home;
  const mod = await import('./conversationIndex.js');
  mod._resetConversationIndexForTests();
  try { await fn(mod); }
  finally {
    mod._resetConversationIndexForTests();
    if (previous === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

const message = (id, content) => ({ id, role: 'user', content, createdAt: '2026-10-17T00:00:00.000Z' });

test('remote audiences only see their own channel; the desktop owner sees desktop rows and legacy rows', async () => {
  await withHome(({ indexMessage, searchHistory }) => {
    indexMessage('desk-1', 'Desktop private', message('d1', 'deploy secret plan alpha'), { audience: 'desktop', projectId: '' });
    indexMessage('tg-1', 'Telegram group', message('t1', 'deploy plan alpha from telegram'), { audience: 'telegram', projectId: '' });
    indexMessage('legacy-1', 'Old chat', message('l1', 'deploy plan alpha legacy'));   // no explicit scope → desktop-owned
    const telegram = searchHistory('alpha', { audience: 'telegram' });
    assert.deepEqual(telegram.map(r => r.chatId), ['tg-1']);
    const desktop = searchHistory('alpha', { audience: 'desktop' }).map(r => r.chatId).sort();
    assert.deepEqual(desktop, ['desk-1', 'legacy-1']);
    assert.ok(!desktop.includes('tg-1'), 'desktop default scope excludes remote channel rows too');
    // Unscoped (legacy caller) still searches everything — the tool never calls it this way.
    assert.equal(searchHistory('alpha').length, 3);
  });
});

test('projects are isolated by default and the desktop owner can opt into all projects', async () => {
  await withHome(({ indexMessage, searchHistory, tagChatScope }) => {
    indexMessage('p1-chat', 'Project one', message('a', 'budget decision beta'), { audience: 'desktop', projectId: 'p1' });
    indexMessage('p2-chat', 'Project two', message('b', 'budget decision beta'), { audience: 'desktop', projectId: 'p2' });
    indexMessage('free-chat', 'No project', message('c', 'budget decision beta'), { audience: 'desktop', projectId: '' });
    assert.deepEqual(searchHistory('beta', { audience: 'desktop', projectId: 'p1' }).map(r => r.chatId), ['p1-chat']);
    assert.deepEqual(searchHistory('beta', { audience: 'desktop', projectId: '' }).map(r => r.chatId), ['free-chat']);
    assert.equal(searchHistory('beta', { audience: 'desktop', projectId: 'p1', allProjects: true }).length, 3);
    // A remote audience cannot widen scope.
    indexMessage('dc-chat', 'Discord', message('d', 'budget decision beta'), { audience: 'discord', projectId: 'p1' });
    assert.deepEqual(searchHistory('beta', { audience: 'discord', projectId: 'p1', allProjects: true }).map(r => r.chatId), ['dc-chat']);
    // Backfilling scope moves legacy rows into their chat's audience/project.
    indexMessage('legacy', 'Legacy', message('e', 'budget decision beta'));
    tagChatScope('legacy', { audience: 'telegram', projectId: '' });
    assert.ok(searchHistory('beta', { audience: 'telegram', projectId: '' }).some(r => r.chatId === 'legacy'));
    assert.ok(!searchHistory('beta', { audience: 'desktop', projectId: '' }).some(r => r.chatId === 'legacy'));
  });
});

test('the search_history tool derives scope from the execution context, not from the model', async () => {
  await withHome(async ({ indexMessage }) => {
    const { searchHistoryTool } = await import('../tools/builtins/searchHistoryTool.js');
    indexMessage('desk', 'Desktop', message('x', 'gamma roadmap'), { audience: 'desktop', projectId: '' });
    indexMessage('tg', 'Telegram', message('y', 'gamma roadmap'), { audience: 'telegram', projectId: '' });
    const remote = await searchHistoryTool.run({ query: 'gamma', scope: 'all' }, { chatSource: 'telegram', projectId: '' });
    assert.equal(remote.meta.resultCount, 1);
    assert.equal(remote.meta.results[0].chatId, 'tg');
    const desktop = await searchHistoryTool.run({ query: 'gamma' }, { chatSource: 'desktop', projectId: '' });
    assert.deepEqual(desktop.meta.results.map(r => r.chatId), ['desk']);
  });
});

// ─── 2026-10-18 bug audit (section 2) ────────────────────────────────────────

test('L19: a message whose text changed after indexing (mid-turn supplement) is re-indexed by id, unchanged ones are not duplicated', async () => {
  await withHome(({ indexMessage, searchHistory }) => {
    indexMessage('c1', 'Chat', message('q1', 'write a poem about autumn'), { audience: 'desktop', projectId: '' });
    indexMessage('c1', 'Chat', message('q1', 'write a poem about autumn'), { audience: 'desktop', projectId: '' });
    assert.equal(searchHistory('autumn', { audience: 'desktop' }).length, 1, 'same text indexes once');
    assert.equal(searchHistory('pentameter', { audience: 'desktop' }).length, 0);
    indexMessage('c1', 'Chat', message('q1', 'write a poem about autumn\n\n补充：use iambic pentameter'), { audience: 'desktop', projectId: '' });
    const hits = searchHistory('pentameter', { audience: 'desktop' });
    assert.equal(hits.length, 1, 'the amended text is searchable');
    assert.equal(hits[0].messageId || hits[0].id, 'q1');
    assert.equal(searchHistory('autumn', { audience: 'desktop' }).length, 1, 'still one row for the message');
  });
});
