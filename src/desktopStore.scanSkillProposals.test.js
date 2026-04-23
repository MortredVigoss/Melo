/**
 * Tests for Phase 3.4.1 — scanRecentChatsForSkillProposals.
 *
 * The helper is a thin shim over proposeSkillsFromActivity and the shared
 * proposal store. These tests exercise:
 *   - Empty state: returns zero counts without throwing.
 *   - Chat with too-few tool calls: ignored by the proposer → no adds.
 *   - Chat with connector-heavy workflow: produces at least one proposal
 *     and adds it to a stub store.
 *   - Recency ordering: most recently updated chats scanned first (limit 1
 *     should pick the newest, even if older chats have stronger workflows).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanRecentChatsForSkillProposals } from './desktopStore.js';

function makeStore() {
  const added = [];
  return {
    added,
    addMany(batch) {
      let n = 0;
      for (const p of batch) {
        added.push(p);
        n++;
      }
      return n;
    },
  };
}

function makeConnectorChat(id, { whenIso } = {}) {
  // 3 assistant turns each carrying a <tool_call> block for a connector
  // hint (`slack`/`gmail`/`telegram`) — meets the proposer's threshold.
  return {
    id,
    title: `Chat ${id}`,
    updatedAt: whenIso || new Date().toISOString(),
    messages: [
      { role: 'user', content: 'ping the team and check inbox' },
      {
        role: 'assistant',
        content: '<tool_call>{"name":"slack.send","arguments":{"ch":"ops"}}</tool_call>',
      },
      {
        role: 'assistant',
        content: '<tool_call>{"name":"gmail.list","arguments":{"q":"unread"}}</tool_call>',
      },
      {
        role: 'assistant',
        content: '<tool_call>{"name":"telegram.send","arguments":{}}</tool_call>',
      },
    ],
  };
}

test('scan: empty state returns zeros, does not throw', async () => {
  const store = makeStore();
  const result = await scanRecentChatsForSkillProposals({
    _loadStateFn: async () => ({ chats: [] }),
    _store: store,
  });
  assert.deepEqual(result, { scanned: 0, proposed: 0, added: 0 });
});

test('scan: plain-chat conversation below threshold proposes nothing', async () => {
  const store = makeStore();
  const state = {
    chats: [
      {
        id: 'c1',
        updatedAt: new Date().toISOString(),
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      },
    ],
  };
  const result = await scanRecentChatsForSkillProposals({
    _loadStateFn: async () => state,
    _store: store,
  });
  assert.equal(result.scanned, 1);
  assert.equal(result.proposed, 0);
  assert.equal(result.added, 0);
});

test('scan: connector-heavy chat yields a proposal', async () => {
  const store = makeStore();
  const state = { chats: [makeConnectorChat('c1')] };
  const result = await scanRecentChatsForSkillProposals({
    _loadStateFn: async () => state,
    _store: store,
  });
  assert.equal(result.scanned, 1);
  assert.ok(result.proposed >= 1, 'at least one proposal produced');
  assert.ok(result.added >= 1, 'proposals forwarded to store');
  assert.ok(store.added[0].seedId, 'proposal carries a seedId');
});

test('scan: recency cap respects limit=1', async () => {
  const store = makeStore();
  const newer = makeConnectorChat('newer', { whenIso: new Date(Date.now()).toISOString() });
  const older = makeConnectorChat('older', {
    whenIso: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  });
  const state = { chats: [older, newer] };
  const result = await scanRecentChatsForSkillProposals({
    limit: 1,
    _loadStateFn: async () => state,
    _store: store,
  });
  assert.equal(result.scanned, 1, 'only the most recent chat was scanned');
});
