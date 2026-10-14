import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoriesFtsQuery } from './store.js';
test('FTS query deduplicates repeated terms and bounds both ends of long input', () => {
  assert.equal(buildMemoriesFtsQuery('历史 检索 历史 检索 '.repeat(500)), '"历史" OR "检索"');
  const result = buildMemoriesFtsQuery(Array.from({length:1000},(_,i)=>`token${i}`).join(' '));
  assert.equal(result.split(' OR ').length,128);
  assert.match(result,/"token0"/);
  assert.match(result,/"token999"/);
});
