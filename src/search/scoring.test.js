import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchSnippet,
  fuzzySearchScore,
  weightedKeywordScore,
} from './scoring.js';

test('fuzzySearchScore handles Chinese queries at token and grapheme level', () => {
  const cityWeather = fuzzySearchScore('北京天气', '今天北京天气很好，适合出门。');
  const onlyWeather = fuzzySearchScore('北京天气', '天气预报说明今天有风。');

  assert.ok(cityWeather > 0);
  assert.ok(cityWeather > onlyWeather);
});

test('buildSearchSnippet keeps CJK text intact around the match window', () => {
  const snippet = buildSearchSnippet(
    '今天北京天气很好，空气清新，适合傍晚散步和拍照。',
    '北京天气',
    10,
  );

  assert.match(snippet, /北京天气/);
  assert.doesNotMatch(snippet, /�/);
});

test('weightedKeywordScore respects weighted aliases', () => {
  const strong = weightedKeywordScore('persona', [
    { keyword: 'agent', weight: 1 },
    { keyword: 'persona', weight: 0.6 },
  ]);
  const none = weightedKeywordScore('calendar', [
    { keyword: 'agent', weight: 1 },
    { keyword: 'persona', weight: 0.6 },
  ]);

  assert.ok(strong > 0);
  assert.equal(none, 0);
});
