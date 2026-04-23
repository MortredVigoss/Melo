import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFactsRuleBased } from './extractor.js';

test('extracts user preferences from English', () => {
  const facts = extractFactsRuleBased([
    { role: 'user', content: 'I prefer TypeScript over JavaScript.' },
  ]);
  const pref = facts.find(f => f.category === 'user_preference');
  assert.ok(pref, `expected a user_preference fact, got ${JSON.stringify(facts)}`);
  assert.ok(/TypeScript/i.test(pref.fact));
});

test('extracts user preferences from Chinese', () => {
  const facts = extractFactsRuleBased([
    { role: 'user', content: '我更喜欢用 bun 而不是 npm' },
  ]);
  const pref = facts.find(f => f.category === 'user_preference');
  assert.ok(pref);
});

test('extracts decisions', () => {
  const facts = extractFactsRuleBased([
    { role: 'user', content: 'We decided to use Postgres for the new service.' },
  ]);
  const d = facts.find(f => f.category === 'decision');
  assert.ok(d);
  assert.ok(/Postgres/i.test(d.fact));
});

test('extracts corrections', () => {
  const facts = extractFactsRuleBased([
    { role: 'user', content: 'Actually we are on Node 20 now.' },
  ]);
  const corr = facts.find(f => f.category === 'correction');
  assert.ok(corr);
});

test('extracts technical details from version strings', () => {
  const facts = extractFactsRuleBased([
    { role: 'assistant', content: 'This project uses Node v20.3 and pnpm v9.' },
  ]);
  const tech = facts.filter(f => f.category === 'technical_detail');
  assert.ok(tech.length >= 1);
});

test('extracts technical details from install commands', () => {
  const facts = extractFactsRuleBased([
    { role: 'user', content: 'We ran pnpm add @scope/pkg yesterday.' },
  ]);
  const tech = facts.find(f => f.category === 'technical_detail');
  assert.ok(tech);
  assert.ok(/scope\/pkg/i.test(tech.fact));
});

test('deduplicates identical facts', () => {
  const facts = extractFactsRuleBased([
    { role: 'user', content: 'I prefer TypeScript.' },
    { role: 'user', content: 'I prefer TypeScript.' },
  ]);
  const prefs = facts.filter(f => f.category === 'user_preference');
  assert.equal(prefs.length, 1);
});

test('extracts project_context deadlines', () => {
  const facts = extractFactsRuleBased([
    { role: 'user', content: 'We need this done by Friday.' },
  ]);
  const ctx = facts.find(f => f.category === 'project_context');
  assert.ok(ctx);
});

test('returns empty array for empty messages', () => {
  assert.deepEqual(extractFactsRuleBased([]), []);
  assert.deepEqual(extractFactsRuleBased([{ role: 'system', content: 'ignored' }]), []);
});
