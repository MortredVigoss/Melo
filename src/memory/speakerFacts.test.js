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
