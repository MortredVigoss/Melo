'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { watchOwnerPipe } = require('../owner-pipe.cjs');

test('without the flag stdin is left alone', () => {
  const stdin = new PassThrough();
  let closed = 0;
  assert.equal(watchOwnerPipe(stdin, {}, () => { closed++; }), false);
  stdin.end();
  assert.equal(closed, 0);
  assert.equal(watchOwnerPipe(null, { MELO_PET_OWNER_PIPE: '1' }, () => { closed++; }), false);
});

test('EOF on the owner pipe stops the pet exactly once, whatever else the stream reports', async () => {
  const stdin = new PassThrough();
  let closed = 0;
  assert.equal(watchOwnerPipe(stdin, { MELO_PET_OWNER_PIPE: '1' }, () => { closed++; }), true);
  stdin.write('ignored');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, 0, 'data alone never stops the pet');
  stdin.end();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, 1);
  stdin.destroy(new Error('late error'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, 1, 'end, close and error collapse into one shutdown');
});
