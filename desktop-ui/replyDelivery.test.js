import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplyDelivery, receiveReplyDelivery } from './replyDelivery.js';

test('draft and legacy reply_text cannot reach speech before final verification', () => {
  const state = createReplyDelivery();
  assert.deepEqual(receiveReplyDelivery(state, 'delta', { delta: 'Wrong claim.' }), {});
  assert.deepEqual(receiveReplyDelivery(state, 'reply_text', { text: 'Wrong claim.' }), {});
  assert.deepEqual(receiveReplyDelivery(state, 'reply_text', { text: 'Correct claim.', final: true }), { finalSpeechText: 'Correct claim.' });
  assert.deepEqual(receiveReplyDelivery(state, 'reply_text', { text: 'Correct claim.', final: true }), {});
});

test('safe greetings can stream once; unexpected tool use closes the speech gate', () => {
  const state = createReplyDelivery();
  receiveReplyDelivery(state, 'speech_policy', { allowLiveSpeech: true });
  assert.deepEqual(receiveReplyDelivery(state, 'delta', { delta: 'Hello.' }), { speechDelta: 'Hello.' });
  assert.deepEqual(receiveReplyDelivery(state, 'reply_text', { text: 'Hello.', final: true }), {});
  const other = createReplyDelivery();
  receiveReplyDelivery(other, 'speech_policy', { allowLiveSpeech: true });
  receiveReplyDelivery(other, 'tool_calls_start');
  assert.deepEqual(receiveReplyDelivery(other, 'delta', { delta: 'Tool draft' }), {});
  assert.deepEqual(receiveReplyDelivery(other, 'reply_text', { text: 'Tool final', final: true }), { finalSpeechText: 'Tool final' });
});
