import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreTurn } from './sharedAgentCore.js';

test('Node host forwards displayed citations without inventing source execution', () => {
  const turn = createCoreTurn({ allowedTools: ['web_search'], clock: () => 0 });
  const url = 'https://fixture.invalid/menu';
  const receipt = citations => turn.receipt('Research Sydney brunch', 'A cafe serves breakfast.', '', {route: 'http-search'}, citations);
  assert.equal(receipt([{url}]).outcome, 'blocked');
  turn.observeNative({id: 'search', name: 'native_web_search', status: 'completed', sources: [
    {url, reading: 'extracted', text: 'A local cafe serves a morning meal including eggs and pancakes every day.'},
  ]});
  assert.equal(receipt([]).reason, 'RELEVANT_READ_SOURCE_MISSING');
  assert.equal(receipt([{url: 'https://invented.invalid/menu'}]).reason, 'RELEVANT_READ_SOURCE_MISSING');
  assert.equal(receipt([{url}]).outcome, 'completed');
  assert.equal(receipt([{url}]).goalState, 'supported');
});
