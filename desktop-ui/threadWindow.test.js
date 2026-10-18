/**
 * desktop-ui/threadWindow.test.js
 *
 * Pure-function tests for the long-thread render window (design audit L2).
 * No DOM — same pattern as activeToolCallsStrip.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THREAD_RENDER_WINDOW,
  visibleMessageWindow,
  expandThreadWindow,
  ensureMessageInThreadWindow,
} from './threadWindow.js';

function makeMessages(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index + 1}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `message ${index + 1}`,
  }));
}

test('THREAD_RENDER_WINDOW is 60', () => {
  assert.equal(THREAD_RENDER_WINDOW, 60);
});

test('default: only the last 60 messages are visible, hiddenCount is the rest', () => {
  const messages = makeMessages(1000);
  const win = visibleMessageWindow(messages, { chatId: 'a', state: {} });
  assert.equal(win.messages.length, 60);
  assert.equal(win.hiddenCount, 940);
  assert.equal(win.startIndex, 940);
  assert.equal(win.total, 1000);
  assert.equal(win.messages[0].id, 'm941');
  assert.equal(win.messages.at(-1).id, 'm1000');
});

test('short threads render everything with hiddenCount 0', () => {
  const messages = makeMessages(12);
  const win = visibleMessageWindow(messages, { chatId: 'a', state: {} });
  assert.equal(win.messages.length, 12);
  assert.equal(win.hiddenCount, 0);
  assert.deepEqual(win.messages.map(m => m.id), messages.map(m => m.id));

  const exact = visibleMessageWindow(makeMessages(60), { chatId: 'a', state: {} });
  assert.equal(exact.messages.length, 60);
  assert.equal(exact.hiddenCount, 0);
});

test('tolerates missing state / chatId / non-array messages', () => {
  assert.deepEqual(visibleMessageWindow(null), { messages: [], hiddenCount: 0, startIndex: 0, total: 0 });
  const win = visibleMessageWindow(makeMessages(100));
  assert.equal(win.messages.length, 60);
  assert.equal(win.hiddenCount, 40);
});

test('expandThreadWindow accumulates per chat and widens the window', () => {
  const state = {};
  assert.equal(expandThreadWindow(state, 'a'), 60);
  assert.equal(expandThreadWindow(state, 'a'), 120);
  assert.equal(expandThreadWindow(state, 'a', 10), 130);
  assert.equal(state.a, 130);

  const messages = makeMessages(1000);
  const win = visibleMessageWindow(messages, { chatId: 'a', state });
  assert.equal(win.messages.length, 190);
  assert.equal(win.hiddenCount, 810);
  assert.equal(win.messages[0].id, 'm811');
});

test('expansion never exceeds the thread length', () => {
  const state = {};
  expandThreadWindow(state, 'a', 10_000);
  const win = visibleMessageWindow(makeMessages(200), { chatId: 'a', state });
  assert.equal(win.messages.length, 200);
  assert.equal(win.hiddenCount, 0);
});

test('expansion state is independent per chat', () => {
  const state = {};
  expandThreadWindow(state, 'a');
  expandThreadWindow(state, 'a');

  const a = visibleMessageWindow(makeMessages(500), { chatId: 'a', state });
  const b = visibleMessageWindow(makeMessages(500), { chatId: 'b', state });
  assert.equal(a.messages.length, 180);
  assert.equal(a.hiddenCount, 320);
  assert.equal(b.messages.length, 60);
  assert.equal(b.hiddenCount, 440);
  assert.equal(state.b, undefined);
});

test('highlighted message outside the window pulls the window to include it', () => {
  const messages = makeMessages(1000);
  const win = visibleMessageWindow(messages, {
    chatId: 'a',
    state: {},
    highlightedMessageId: 'm300',
  });
  assert.equal(win.messages[0].id, 'm300');
  assert.equal(win.messages.length, 701);
  assert.equal(win.hiddenCount, 299);
  assert.equal(win.messages.at(-1).id, 'm1000');
});

test('highlighted message already inside the window leaves the window unchanged', () => {
  const win = visibleMessageWindow(makeMessages(1000), {
    chatId: 'a',
    state: {},
    highlightedMessageId: 'm990',
  });
  assert.equal(win.messages.length, 60);
  assert.equal(win.hiddenCount, 940);
});

test('unknown highlighted id does not change the window', () => {
  const win = visibleMessageWindow(makeMessages(1000), {
    chatId: 'a',
    state: {},
    highlightedMessageId: 'nope',
  });
  assert.equal(win.messages.length, 60);
  assert.equal(win.hiddenCount, 940);
});

test('the newest (streaming) message is always inside the window', () => {
  const messages = makeMessages(999);
  messages.push({ id: 'streaming-tail', role: 'assistant', content: 'partial…', streaming: true });

  const plain = visibleMessageWindow(messages, { chatId: 'a', state: {} });
  assert.equal(plain.messages.at(-1).id, 'streaming-tail');

  // Pinning it explicitly (what a caller does for the in-flight reply) is a
  // no-op for the tail, and pins an older id when asked to.
  const pinned = visibleMessageWindow(messages, {
    chatId: 'a',
    state: {},
    pinnedMessageIds: ['streaming-tail'],
  });
  assert.equal(pinned.messages.length, 60);
  assert.equal(pinned.messages.at(-1).id, 'streaming-tail');

  const pinnedOld = visibleMessageWindow(messages, {
    chatId: 'a',
    state: {},
    pinnedMessageIds: ['m500'],
  });
  assert.equal(pinnedOld.messages[0].id, 'm500');
  assert.equal(pinnedOld.messages.at(-1).id, 'streaming-tail');
});

test('ensureMessageInThreadWindow persists just enough expansion into state', () => {
  const state = {};
  const messages = makeMessages(1000);
  assert.equal(ensureMessageInThreadWindow(state, 'a', messages, 'm300'), true);
  assert.equal(state.a, 641); // 1000 - 299 = 701 needed; 701 - 60 = 641 extra

  // Already covered → no further growth.
  assert.equal(ensureMessageInThreadWindow(state, 'a', messages, 'm400'), true);
  assert.equal(state.a, 641);

  // Now the highlight can be cleared and the window stays put.
  const win = visibleMessageWindow(messages, { chatId: 'a', state });
  assert.equal(win.messages[0].id, 'm300');
  assert.equal(win.hiddenCount, 299);

  // Unknown id → false, state untouched.
  assert.equal(ensureMessageInThreadWindow(state, 'a', messages, 'ghost'), false);
  assert.equal(state.a, 641);
  assert.equal(ensureMessageInThreadWindow(state, 'b', messages, null), false);
  assert.equal(state.b, undefined);
});

test('hiddenCount + visible length always equals total', () => {
  const state = {};
  for (const total of [0, 1, 59, 60, 61, 120, 121, 1000]) {
    const messages = makeMessages(total);
    for (const extra of [0, 60, 120]) {
      state.a = extra;
      const win = visibleMessageWindow(messages, { chatId: 'a', state, highlightedMessageId: 'm7' });
      assert.equal(win.hiddenCount + win.messages.length, total);
      assert.equal(win.hiddenCount, win.startIndex);
      // Order and identity preserved.
      assert.deepEqual(win.messages, messages.slice(win.startIndex));
    }
  }
});
