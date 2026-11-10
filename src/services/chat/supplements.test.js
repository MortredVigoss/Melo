import test from 'node:test';
import assert from 'node:assert/strict';
import { beginSupplements, addSupplement, takeSupplements, usedSupplements, endSupplements, supplementMessage } from './supplements.js';

test('supplements are accepted only while a turn runs and never leak into the next turn', () => {
  assert.equal(addSupplement('chat-a', '改成五言'), null, 'no running turn: rejected (route answers 409)');
  beginSupplements('chat-a');
  assert.equal(addSupplement('chat-a', '   '), null, 'blank text is ignored');
  assert.equal(addSupplement('chat-b', '别的对话'), null, 'another chat has no running turn');
  const first = addSupplement('chat-a', ' 改成五言 ');
  assert.equal(first.text, '改成五言');
  assert.deepEqual(takeSupplements('chat-a').map(e => e.text), ['改成五言']);
  assert.deepEqual(takeSupplements('chat-a'), [], 'taken once');
  addSupplement('chat-a', '再加一个标题');
  assert.deepEqual(usedSupplements('chat-a').map(e => e.text), ['改成五言']);
  assert.deepEqual(endSupplements('chat-a').map(e => e.text), ['再加一个标题'], 'unused ones are handed back');
  assert.deepEqual(usedSupplements('chat-a'), []);
  assert.equal(addSupplement('chat-a', '太晚了'), null, 'turn ended: rejected');
  assert.match(supplementMessage([{ text: 'x' }, { text: 'y' }]), /补充[\s\S]*x\ny$/);
});

test('a second request for the same chat neither wipes the running turn\'s supplements nor loses its own', async () => {
  // 2026-11-10 agent audit, second pass: one slot per chat was reset by every arriving request and deleted by
  // every ending one.
  const { beginSupplements, addSupplement, takeSupplements, usedSupplements, endSupplements } = await import('./supplements.js');
  const chat = 'overlap-' + Date.now();
  const first = beginSupplements(chat);
  assert.ok(addSupplement(chat, 'for the running turn'));
  const second = beginSupplements(chat); // queued behind the first in the chat's lane
  assert.deepEqual(takeSupplements(chat).map(entry => entry.text), ['for the running turn'], 'the running turn still has its supplement');
  assert.deepEqual(usedSupplements(chat).map(entry => entry.text), ['for the running turn']);
  assert.ok(addSupplement(chat, 'typed late'));
  assert.deepEqual(endSupplements(chat, first).map(entry => entry.text), ['typed late'], 'what the first turn never used is handed back to it');
  assert.deepEqual(endSupplements(chat, first), [], 'ending the same turn again changes nothing');
  // The second turn is now the running one and accepts supplements.
  assert.ok(addSupplement(chat, 'for the second turn'), 'the second turn was not left without a run');
  assert.deepEqual(takeSupplements(chat).map(entry => entry.text), ['for the second turn']);
  assert.deepEqual(endSupplements(chat, second), []);
  assert.equal(addSupplement(chat, 'nobody is running'), null);
});
