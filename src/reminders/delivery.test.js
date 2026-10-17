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

test('archived Telegram keeps the local reminder and permanently stops remote delivery', async () => {
  const { delivery, calls, chat } = fixture('telegram');
  let sends = 0;
  await assert.rejects(delivery({ id: 'r1', chatId: 'origin', text: 'Coffee' }, {
    beforeExternalSend: async () => { sends++; },
  }), error => error.code === 'CHANNEL_ARCHIVED' && error.permanent === true);
  assert.equal(calls.length, 0);
  assert.equal(sends, 0);
  assert.match(chat.messages[0].content, /Coffee/);
});

test('archived Discord keeps the local reminder and permanently stops remote delivery', async () => {
  // 2026-10-17: Discord archived alongside Telegram. The local reminder message
  // is still appended; the outgoing send is intercepted before any network
  // call and marked permanent so the scheduler stops retrying.
  const { delivery, calls, chat } = fixture('discord');
  let sends = 0;
  await assert.rejects(delivery({ id: 'r1', chatId: 'origin', text: '@everyone Coffee' }, {
    beforeExternalSend: async () => { sends++; },
  }), error => error.code === 'CHANNEL_ARCHIVED' && error.permanent === true);
  assert.equal(calls.length, 0);
  assert.equal(sends, 0);
  assert.match(chat.messages[0].content, /Coffee/);
});

test('missing chats fail instead of silently losing the reminder', async () => {
  const { delivery } = fixture('discord');
  await assert.rejects(delivery({ id: 'r1', chatId: 'missing', text: 'Coffee' }), /no longer exists/);
});

test('desktop reminders never consult the archive policy or remote senders', async () => {
  // Guard against the archive check leaking into local-only delivery.
  const { delivery, chat, calls } = fixture('desktop');
  await delivery({ id: 'r2', chatId: 'origin', text: 'Local only' });
  assert.equal(chat.messages.length, 1);
  assert.equal(calls.length, 0);
});
