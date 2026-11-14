import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSpeakerFacts,
  getSpeakerFactStorageKey,
} from './speakerFacts.js';

test('extractSpeakerFacts keeps stable English self facts', () => {
  const facts = extractSpeakerFacts(
    'My name is Alice.\nI live in Singapore.\nI prefer concise answers.',
  );

  assert.deepEqual(
    facts.map(fact => fact.text),
    [
      'Name: Alice',
      'Location: Singapore',
      'Prefers: concise answers',
    ],
  );
});

test('extractSpeakerFacts handles Chinese self statements conservatively', () => {
  const facts = extractSpeakerFacts('我叫小明。我喜欢抹茶。我在上海');

  assert.deepEqual(
    facts.map(fact => fact.text),
    [
      'Name: 小明',
      'Likes: 抹茶',
      'Location: 上海',
    ],
  );
});

test('extractSpeakerFacts ignores non-profile requests', () => {
  const facts = extractSpeakerFacts(
    'Can you help me debug the Telegram image flow? Please summarize the fix.',
  );

  assert.deepEqual(facts, []);
});

test('getSpeakerFactStorageKey overwrites single-value facts but keeps list-like ones distinct', () => {
  assert.equal(
    getSpeakerFactStorageKey({ category: 'location', text: 'Location: Singapore' }),
    'location',
  );
  assert.equal(
    getSpeakerFactStorageKey({ category: 'location', text: 'Location: Melbourne' }),
    'location',
  );
  assert.equal(
    getSpeakerFactStorageKey({ category: 'likes', text: 'Likes: matcha' }),
    'likes:likes matcha',
  );
  assert.equal(
    getSpeakerFactStorageKey({ category: 'likes', text: 'Likes: coffee' }),
    'likes:likes coffee',
  );
});

// 2026-11-14: the location rule `我在…` sat above the work rule `我在…工作`
// and took its sentences.
test('where someone works is a work fact, not a location that ends in 工作', () => {
  const facts = text => extractSpeakerFacts(text).map(fact => `${fact.category}|${fact.text}`);
  assert.deepEqual(facts('我在腾讯工作'), ['work|Works at: 腾讯']);
  assert.deepEqual(facts('我在一家做地图的公司上班。'), ['work|Works at: 一家做地图的公司']);
  assert.deepEqual(facts('我在北京'), ['location|Location: 北京']);
  assert.deepEqual(facts('我住在杭州'), ['location|Location: 杭州']);
  assert.deepEqual(facts('I work at Acme'), ['work|Works at: Acme']);
  assert.deepEqual(facts('我在北京。我在腾讯工作。'), ['location|Location: 北京', 'work|Works at: 腾讯']);
});

