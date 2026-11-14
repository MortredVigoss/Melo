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

// 2026-11-14: the English rules ended in `[.!?$]`, where `$` is a literal
// dollar sign. splitSentences removes `!`, `?` and line breaks, so only a
// sentence that kept an ASCII full stop could match.
test('English statements are extracted whether they end in a full stop, another mark, a line break or nothing', () => {
  const fact = (content, category) => extractFactsRuleBased([{ role: 'user', content }]).find(f => f.category === category)?.fact;
  for (const ending of ['', '.', '!', '?', '\nsecond line']) {
    assert.equal(fact(`We decided to use Postgres for the project${ending}`, 'decision'), 'Decision: to use Postgres for the project', JSON.stringify(ending));
    assert.equal(fact(`Let's go with the blue theme${ending}`, 'decision'), 'Decision: the blue theme', JSON.stringify(ending));
    assert.equal(fact(`Actually we are on Node 20 now${ending}`, 'correction'), 'Correction: we are on Node 20 now', JSON.stringify(ending));
    assert.equal(fact(`not staging, it's production${ending}`, 'correction'), 'Correction: not staging, it is production', JSON.stringify(ending));
    assert.equal(fact(`I prefer tabs over spaces${ending}`, 'user_preference'), 'User prefer tabs over spaces', JSON.stringify(ending));
  }
});

test('the person rule takes a name, not a pronoun or a question word, with or without a full stop', () => {
  const context = content => extractFactsRuleBased([{ role: 'user', content }]).filter(f => f.category === 'project_context').map(f => f.fact);
  assert.deepEqual(context('Alice will review the migration'), ['Alice review the migration']);
  assert.deepEqual(context('Alice will review the migration.'), ['Alice review the migration']);
  for (const sentence of ['What is the plan here', 'This is going to be hard.', 'There is a problem with the build', 'Who owns the release', 'Everything is fine now.', 'That will break the tests']) {
    assert.deepEqual(context(sentence), [], sentence);
  }
});
