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
