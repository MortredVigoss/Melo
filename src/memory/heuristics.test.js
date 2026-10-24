import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectClarificationFrame,
  extractClarificationOptions,
  isLikelyClarificationPrompt,
  isLikelyContextDependentReply,
} from './heuristics.js';

test('detectClarificationFrame recognizes explicit clarification replies', () => {
  const result = detectClarificationFrame(
    'Do you mean one of these?\n- Product review\n- Pricing update\n- Roadmap recap',
    '第二个',
  );

  assert.equal(result.isFrame, true);
  assert.equal(result.latestReplyLooksContextual, true);
  assert.equal(result.options.length, 3);
  assert.ok(result.confidence >= 0.5);
});

test('extractClarificationOptions collects bullet and bold options once', () => {
  const options = extractClarificationOptions(
    '**Alpha**\n- Beta\n- Beta\nGamma',
  );

  assert.deepEqual(options, ['Alpha', 'Beta', 'Gamma']);
});

test('clarification and contextual reply heuristics stay conservative', () => {
  assert.equal(isLikelyClarificationPrompt('Which one do you mean?'), true);
  assert.equal(isLikelyClarificationPrompt('Here is the final answer.'), false);
  assert.equal(isLikelyContextDependentReply('that one'), true);
  assert.equal(
    isLikelyContextDependentReply('Please summarize the migration plan in detail.'),
    false,
  );
});

test('short requests and plain lists do not masquerade as clarification', () => {
  for (const text of ['2+2','Write a poem','今天天气怎么样','長い説明をお願いします']) assert.equal(isLikelyContextDependentReply(text), false);
  for (const text of ['それ','그거','ese','that one']) assert.equal(isLikelyContextDependentReply(text), true);
  assert.equal(isLikelyClarificationPrompt('- apples\n- oranges'), false);
  for (const text of ['どちらですか？','어느 것이에요?','¿Cuál de estas opciones?']) assert.equal(isLikelyClarificationPrompt(text), true);
});
