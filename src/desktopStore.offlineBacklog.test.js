// Unit tests for the offline-backlog filter (Telegram + Discord polling).
//
// Context: when the desktop runtime has been offline and reconnects, the
// polling fetch returns every message since our last acknowledged update_id.
// Without the filter, the bot would spam every missed group message with a
// late reply. The filter only lets through @mentions, replies-to-bot, or
// messages that look like a continuation of recent bot conversation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __offlineBacklogTesting } from './desktopStore.js';

const {
  isBacklogPollCycle,
  recentChatHasBotContext,
  passesOfflineBacklogFilter,
  OFFLINE_BACKLOG_THRESHOLD_MS,
} = __offlineBacklogTesting;

// ─── isBacklogPollCycle ──────────────────────────────────────────────────────

test('isBacklogPollCycle: never-polled channel treated as backlog', () => {
  assert.equal(isBacklogPollCycle({}), true);
  assert.equal(isBacklogPollCycle({ lastPolledAt: '' }), true);
  assert.equal(isBacklogPollCycle({ lastPolledAt: null }), true);
});

test('isBacklogPollCycle: recent poll (< threshold) is not backlog', () => {
  const recent = new Date(Date.now() - 5_000).toISOString();
  assert.equal(isBacklogPollCycle({ lastPolledAt: recent }), false);
});

test('isBacklogPollCycle: older than threshold is backlog', () => {
  const old = new Date(Date.now() - (OFFLINE_BACKLOG_THRESHOLD_MS + 5_000)).toISOString();
  assert.equal(isBacklogPollCycle({ lastPolledAt: old }), true);
});

test('isBacklogPollCycle: malformed timestamp treated as backlog', () => {
  assert.equal(isBacklogPollCycle({ lastPolledAt: 'not-a-date' }), true);
});

// ─── recentChatHasBotContext ─────────────────────────────────────────────────

test('recentChatHasBotContext: empty chat → no context', () => {
  assert.equal(recentChatHasBotContext({ messages: [] }), false);
  assert.equal(recentChatHasBotContext({}), false);
  assert.equal(recentChatHasBotContext(null), false);
});

test('recentChatHasBotContext: assistant reply in window → context present', () => {
  const chat = {
    messages: [
      { role: 'user', meta: { bystanderMessage: true } },
      { role: 'user', meta: { bystanderMessage: true } },
      { role: 'assistant' },
      { role: 'user', meta: { bystanderMessage: true } },
    ],
  };
  assert.equal(recentChatHasBotContext(chat), true);
});

test('recentChatHasBotContext: user message addressed to bot → context present', () => {
  // Message stored WITHOUT bystanderMessage flag → bot replied to it.
  const chat = {
    messages: [
      { role: 'user' }, // addressed-to-bot (no bystander flag)
      { role: 'user', meta: { bystanderMessage: true } },
    ],
  };
  assert.equal(recentChatHasBotContext(chat), true);
});

test('recentChatHasBotContext: only bystander messages → no context', () => {
  const chat = {
    messages: [
      { role: 'user', meta: { bystanderMessage: true } },
      { role: 'user', meta: { bystanderMessage: true } },
      { role: 'user', meta: { bystanderMessage: true } },
      { role: 'user', meta: { bystanderMessage: true } },
      { role: 'user', meta: { bystanderMessage: true } },
    ],
  };
  assert.equal(recentChatHasBotContext(chat), false);
});

test('recentChatHasBotContext: old bot reply outside 5-msg window → no context', () => {
  const chat = {
    messages: [
      { role: 'assistant' },                              // too old — out of last 5
      { role: 'user', meta: { bystanderMessage: true } }, // 1
      { role: 'user', meta: { bystanderMessage: true } }, // 2
      { role: 'user', meta: { bystanderMessage: true } }, // 3
      { role: 'user', meta: { bystanderMessage: true } }, // 4
      { role: 'user', meta: { bystanderMessage: true } }, // 5
    ],
  };
  assert.equal(recentChatHasBotContext(chat), false);
});

// ─── passesOfflineBacklogFilter ──────────────────────────────────────────────

test('passesOfflineBacklogFilter: private DMs always pass', () => {
  assert.equal(
    passesOfflineBacklogFilter({
      incoming: { chatType: 'private', text: 'hello' },
      recentChat: { messages: [] },
      mentionPredicate: () => false,
    }),
    true,
  );
});

test('passesOfflineBacklogFilter: explicit @mention passes in group', () => {
  const incoming = { chatType: 'group', text: '@melobot hi', isReplyToBot: false };
  const passes = passesOfflineBacklogFilter({
    incoming,
    recentChat: { messages: [] },
    mentionPredicate: msg => String(msg.text || '').toLowerCase().includes('@melobot'),
  });
  assert.equal(passes, true);
});

test('passesOfflineBacklogFilter: reply-to-bot passes in group', () => {
  const passes = passesOfflineBacklogFilter({
    incoming: { chatType: 'group', text: 'thanks', isReplyToBot: true },
    recentChat: { messages: [] },
    mentionPredicate: () => false,
  });
  assert.equal(passes, true);
});

test('passesOfflineBacklogFilter: random group msg with no context gets skipped', () => {
  const passes = passesOfflineBacklogFilter({
    incoming: { chatType: 'group', text: 'lunch plans?', isReplyToBot: false },
    recentChat: { messages: [] },
    mentionPredicate: () => false,
  });
  assert.equal(passes, false);
});

test('passesOfflineBacklogFilter: follow-up with recent bot activity passes', () => {
  // No @mention, not a reply-to-bot — but the last 5 messages include a bot
  // reply, so this is likely a continuation and should be allowed through.
  const passes = passesOfflineBacklogFilter({
    incoming: { chatType: 'group', text: 'what about option B?', isReplyToBot: false },
    recentChat: {
      messages: [
        { role: 'user' },
        { role: 'assistant' },
        { role: 'user', meta: { bystanderMessage: true } },
      ],
    },
    mentionPredicate: () => false,
  });
  assert.equal(passes, true);
});

test('passesOfflineBacklogFilter: group chat where bot never spoke → skip', () => {
  // All prior messages are bystander-tagged — bot has never replied here, so
  // a fresh unsolicited message during catch-up should NOT be answered.
  const passes = passesOfflineBacklogFilter({
    incoming: { chatType: 'group', text: 'any thoughts?', isReplyToBot: false },
    recentChat: {
      messages: [
        { role: 'user', meta: { bystanderMessage: true } },
        { role: 'user', meta: { bystanderMessage: true } },
      ],
    },
    mentionPredicate: () => false,
  });
  assert.equal(passes, false);
});

test('passesOfflineBacklogFilter: discord-style mentionIds predicate works', () => {
  const botUserId = '999000';
  const predicate = msg => {
    const ids = Array.isArray(msg?.mentionIds) ? msg.mentionIds : [];
    return ids.includes(botUserId);
  };

  const passes = passesOfflineBacklogFilter({
    incoming: { chatType: 'group', text: 'hey', mentionIds: ['999000'], isReplyToBot: false },
    recentChat: { messages: [] },
    mentionPredicate: predicate,
  });
  assert.equal(passes, true);

  const blocked = passesOfflineBacklogFilter({
    incoming: { chatType: 'group', text: 'hey', mentionIds: ['other-id'], isReplyToBot: false },
    recentChat: { messages: [] },
    mentionPredicate: predicate,
  });
  assert.equal(blocked, false);
});

test('passesOfflineBacklogFilter: missing/invalid mentionPredicate tolerated', () => {
  // If mentionPredicate is omitted or not a function, it should simply not
  // contribute — the filter still falls through to isReplyToBot / context
  // checks without throwing.
  assert.doesNotThrow(() => {
    passesOfflineBacklogFilter({
      incoming: { chatType: 'group', text: 'hi', isReplyToBot: true },
      recentChat: { messages: [] },
    });
  });
  assert.doesNotThrow(() => {
    passesOfflineBacklogFilter({
      incoming: { chatType: 'group', text: 'hi', isReplyToBot: false },
      recentChat: { messages: [] },
      mentionPredicate: null,
    });
  });
});
