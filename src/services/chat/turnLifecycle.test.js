import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendChatMessage } from './sendChatMessage.js';
import { updateStateAtomically, loadState } from '../../state/stateStore.js';
import { registerPlugin, unregisterPlugin } from '../../plugins/hooks.js';

const home = await mkdtemp(join(tmpdir(), 'melo-turn-lifecycle-'));
process.env.MELO_HOME = home;
process.env.MELO_TEST_MODE = '1';
process.env.MELO_MOCK_RESPONSE = 'Hello from the captured configuration.';
const deferred = () => {
  let resolve;
  return { promise: new Promise(r => { resolve = r; }), resolve: (...v) => resolve(...v) };
};
test.after(async () => {
  unregisterPlugin('lifecycle-test');
  await rm(home, { recursive: true, force: true });
});

test('concurrent send, bystander append and retry preserve one ordered turn and captured home', async () => {
  await updateStateAtomically(s => {
    s.chats = [{ id: 'one', title: 'One', mode: 'chat', messages: [] }];
  });
  const gate = deferred();
  const entered = deferred();
  const executed = [];
  registerPlugin('lifecycle-test', { 'chat:message:before': async ({ message }) => {
    executed.push(message.content);
    if (message.content === 'hello') { entered.resolve(); await gate.promise; }
  } });
  const first = sendChatMessage({ chatId: 'one', content: 'hello', requestId: 'first', skipBootstrap: true });
  await entered.promise;
  const retry = sendChatMessage({ chatId: 'one', content: 'hello', requestId: 'first', skipBootstrap: true });
  const second = sendChatMessage({ chatId: 'one', content: 'hi', requestId: 'second', skipBootstrap: true });
  await updateStateAtomically(s => {
    s.settings.concurrentEdit = 'kept';
    s.chats[0].messages.push({ id: 'bystander', role: 'user', content: 'a remote observation', createdAt: new Date().toISOString() });
  });
  process.env.MELO_HOME = join(home, 'wrong-home');
  process.env.MELO_MOCK_RESPONSE = 'wrong configuration';
  gate.resolve();
  const [a, b, c] = await Promise.all([first, retry, second]);
  assert.equal(a.assistantMessage.id, b.assistantMessage.id);
  assert.equal(a.runId, b.runId);
  assert.equal(b.replayed, true);
  assert.deepEqual(executed, ['hello', 'hi']);
  const state = await loadState({ home });
  assert.equal(state.settings.concurrentEdit, 'kept');
  assert.equal(state.chats[0].messages.filter(m => m.content === 'hello').length, 1);
  assert.ok(state.chats[0].messages.some(m => m.id === 'bystander'));
  assert.equal(state.chats[0].messages.filter(m => m.role === 'assistant').length, 2);
  assert.match(c.assistantMessage.content, /captured configuration/);
  await assert.rejects(access(join(home, 'wrong-home/desktop/state.json')), { code: 'ENOENT' });
  process.env.MELO_HOME = home;
  process.env.MELO_MOCK_RESPONSE = 'Hello from the captured configuration.';
  await assert.rejects(async () => sendChatMessage({ chatId: 'one', content: 'different', requestId: 'first' }), { code: 'REQUEST_ID_CONFLICT' });
});

test('cancelled request is not automatically replayed; a new request can proceed without duplicate append', async () => {
  const gate = deferred();
  const entered = deferred();
  const abort = new AbortController();
  registerPlugin('lifecycle-test', { 'chat:message:before': async ({ message }) => {
    if (message.content === 'cancel me') { entered.resolve(); await gate.promise; }
  } });
  const first = sendChatMessage({ chatId: 'one', content: 'cancel me', requestId: 'cancelled', signal: abort.signal, skipBootstrap: true });
  await entered.promise;
  const rejection = assert.rejects(first, { name: 'AbortError' });
  abort.abort();
  await rejection;
  const retry = sendChatMessage({ chatId: 'one', content: 'cancel me', requestId: 'cancelled', skipBootstrap: true });
  const retryRejected = assert.rejects(retry, { code: 'REQUEST_INTERRUPTED' });
  gate.resolve();
  await retryRejected;
  await sendChatMessage({ chatId: 'one', content: 'thanks', requestId: 'new-after-cancel', skipBootstrap: true });
  const state = await loadState();
  assert.equal(state.chats[0].messages.filter(m => m.content === 'cancel me').length, 1);
  assert.equal(state.chatRuns.find(r => r.requestId === 'cancelled').status, 'cancelled');
  assert.equal(state.chatRuns.find(r => r.requestId === 'new-after-cancel').status, 'completed');
});
