import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentLimit, needsTransferCopy, transferDimensions, transferType, makeTransferCopy, MB } from './transferCopy.js';

test('photos up to 100 MB are accepted; other attachments keep 20 MB', () => {
  assert.equal(attachmentLimit('image'), 100 * MB);
  assert.equal(attachmentLimit('audio'), 20 * MB);
});

test('only large or oversized photos get a bounded copy, keeping aspect and transparency', () => {
  assert.equal(needsTransferCopy({ size: 2 * MB, width: 4000, height: 3000 }), false);
  assert.equal(needsTransferCopy({ size: 30 * MB, width: 4000, height: 3000 }), true);
  assert.equal(needsTransferCopy({ size: 2 * MB, width: 8000, height: 6000 }), true);
  assert.deepEqual(transferDimensions(8000, 6000), { width: 4096, height: 3072 });
  assert.deepEqual(transferDimensions(1000, 500), { width: 1000, height: 500 });
  assert.equal(transferType('image/png'), 'image/png');
  assert.equal(transferType('image/heic'), 'image/jpeg');
});

test('the browser copy is drawn at the bounded size and the original is not sent', async () => {
  const drawn = [];
  const env = {
    createImageBitmap: async () => ({ width: 8000, height: 6000, close() {} }),
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: (_b, x, y, w, h) => drawn.push([w, h]) }), toDataURL: (type, q) => `data:${type};q=${q}` }) },
  };
  const copy = await makeTransferCopy({ size: 40 * MB, type: 'image/jpeg' }, env);
  assert.deepEqual(drawn, [[4096, 3072]]);
  assert.equal(copy.url, 'data:image/jpeg;q=0.92');
  const small = await makeTransferCopy({ size: 1 * MB, type: 'image/jpeg' }, { ...env, createImageBitmap: async () => ({ width: 800, height: 600, close() {} }) });
  assert.equal(small, null);
});
