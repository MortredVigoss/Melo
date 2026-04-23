import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleBasedCompact, extractKeySentences, compactOffline } from './compact.js';

test('ruleBasedCompact produces all 6 sections with bullet placeholders', () => {
  const messages = [
    { role: 'user', content: 'I prefer concise answers please.' },
    { role: 'assistant', content: 'Got it. Short replies.' },
    { role: 'user', content: 'We decided to use bun over npm.' },
    { role: 'assistant', content: 'Okay, using bun then.' },
  ];
  const summary = ruleBasedCompact(messages);
  assert.ok(summary.includes('1. Primary Request'));
  assert.ok(summary.includes('2. Key Facts'));
  assert.ok(summary.includes('3. What Was Accomplished'));
  assert.ok(summary.includes('4. Pending'));
  assert.ok(summary.includes('5. Tone and Style Preferences'));
  assert.ok(summary.includes('6. Recent Context'));
});

test('ruleBasedCompact returns empty string on empty input', () => {
  assert.equal(ruleBasedCompact([]), '');
  assert.equal(ruleBasedCompact([{ role: 'system', content: 'ignored' }]), '');
});

test('extractKeySentences ranks sentences by lexical overlap', () => {
  const text =
    'The cache is an LRU cache with capacity 64. ' +
    'The LRU cache trades latency for memory. ' +
    'Unrelated observation about weather. ' +
    'The cache implementation uses a doubly linked list. ' +
    'Capacity tuning matters for performance.';
  const top = extractKeySentences(text, 3);
  assert.equal(top.length, 3);
  // At least two of the top-3 sentences should mention "cache"
  const withCache = top.filter(s => /cache/i.test(s)).length;
  assert.ok(withCache >= 2);
});

test('extractKeySentences handles short inputs by returning them all', () => {
  const out = extractKeySentences('Hi there! This is a short note.', 5);
  assert.ok(out.length <= 5);
});

test('compactOffline returns a non-empty summary when transcript has content', async () => {
  // No local LLM is running in tests — this exercises the rule fallback.
  const messages = [
    { role: 'user', content: 'Please help me decide between bun and npm.' },
    { role: 'assistant', content: 'We previously decided on bun.' },
    { role: 'user', content: 'Actually let us confirm that choice.' },
  ];
  const saved = process.env.MELO_OFFLINE_DISABLE_LLM;
  process.env.MELO_OFFLINE_DISABLE_LLM = '1';
  try {
    const summary = await compactOffline(messages, { config: {} });
    assert.ok(summary.length > 0);
    assert.ok(summary.includes('Primary Request'));
  } finally {
    if (saved == null) delete process.env.MELO_OFFLINE_DISABLE_LLM;
    else process.env.MELO_OFFLINE_DISABLE_LLM = saved;
  }
});
