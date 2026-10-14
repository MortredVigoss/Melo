import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminderDelivery } from './delivery.js';

function fixture(source = 'desktop') {
  const chat = { id: 'origin', source, agentId: 'main', messages: [],
    externalThreadKey: source === 'telegram' ? 'telegram:main:-100123:42' : 'discord:main:dm:456' };
  const state = { chats: [chat], agentProfiles: { main: { channels: {
    [source]: { enabled: true, botToken: 'test-token', chatId: 'wrong-default', channelId: 'wrong-default' },
  } } } };
  const calls = [];
  const delivery = createReminderDelivery({ home: '/captured-home',
    update: async (mutator, options) => { assert.equal(options.home, '/captured-home'); mutator(state); },
    telegram: async (...args) => calls.push(args), discord: async (...args) => calls.push(args) });
  return { delivery, state, calls, chat };
}

test('local delivery appends exactly once in the originating chat without any model call', async () => {
  const { delivery, chat, calls } = fixture();
  await delivery({ id: 'r1', chatId: 'origin', text: 'Coffee time' });
  await delivery({ id: 'r1', chatId: 'origin', text: 'Coffee time' });
  assert.equal(chat.messages.length, 1);
  assert.match(chat.messages[0].content, /Coffee time/);
  assert.equal(calls.length, 0);
});

test('Telegram reminders use the original remote chat and forum topic, not channel defaults', async () => {
  const { delivery, calls } = fixture('telegram');
  await delivery({ id: 'r1', chatId: 'origin', text: 'Coffee' });
  assert.equal(calls[0][1], 'sendMessage');
  assert.equal(calls[0][2].body.chat_id, '-100123');
  assert.equal(calls[0][2].body.message_thread_id, 42);
});

test('Discord reminders preserve the originating channel and cannot mass-mention users', async () => {
  const { delivery, calls } = fixture('discord');
  await delivery({ id: 'r1', chatId: 'origin', text: '@everyone Coffee' });
  assert.equal(calls[0][1], '/channels/456/messages');
  assert.deepEqual(calls[0][2].body.allowed_mentions, { parse: [] });
});

test('missing chats and disconnected channels fail instead of silently losing the reminder', async () => {
  const { delivery, state } = fixture('telegram');
  await assert.rejects(delivery({ id: 'r1', chatId: 'missing', text: 'Coffee' }), /no longer exists/);
  state.agentProfiles.main.channels.telegram.enabled = false;
  await assert.rejects(delivery({ id: 'r1', chatId: 'origin', text: 'Coffee' }), /disconnected/);
});
