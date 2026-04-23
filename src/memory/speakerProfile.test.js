import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEAKER_PROFILE_COMPACT_THRESHOLD,
  buildIdentityLine,
  buildSpeakerProfileBlock,
  buildSpeakerProfileLines,
  shouldCompactSpeakerFacts,
} from './speakerProfile.js';

// Helpers ─────────────────────────────────────────────────────────────────

function fact(category, text, overrides = {}) {
  return { category, text, ...overrides };
}

// Suite ───────────────────────────────────────────────────────────────────

test('shouldCompactSpeakerFacts triggers at the documented threshold', () => {
  assert.equal(shouldCompactSpeakerFacts([]), false);
  assert.equal(shouldCompactSpeakerFacts(new Array(SPEAKER_PROFILE_COMPACT_THRESHOLD - 1).fill({})), false);
  assert.equal(shouldCompactSpeakerFacts(new Array(SPEAKER_PROFILE_COMPACT_THRESHOLD).fill({})), true);
  assert.equal(shouldCompactSpeakerFacts(new Array(SPEAKER_PROFILE_COMPACT_THRESHOLD + 5).fill({})), true);
});

test('shouldCompactSpeakerFacts ignores non-array input', () => {
  assert.equal(shouldCompactSpeakerFacts(null), false);
  assert.equal(shouldCompactSpeakerFacts(undefined), false);
  assert.equal(shouldCompactSpeakerFacts({ length: 50 }), false);
});

test('buildSpeakerProfileLines groups singleton categories and dedupes', () => {
  const lines = buildSpeakerProfileLines([
    fact('name', 'Name: Mortred'),
    fact('role', 'Role: backend engineer'),
    fact('location', 'Location: Shanghai'),
    fact('work', 'Works at: Acme Corp'),
    fact('name', 'Name: Mortred'), // duplicate singleton
  ]);

  assert.deepEqual(lines, [
    'Name: Mortred',
    'Role: backend engineer',
    'Location: Shanghai',
    'Works at/on: Acme Corp',
  ]);
});

test('buildSpeakerProfileLines merges multi-value categories and caps at 6', () => {
  const lines = buildSpeakerProfileLines([
    fact('likes', 'Likes: coffee'),
    fact('likes', 'Likes: tea'),
    fact('likes', 'Likes: coffee'), // duplicate
    fact('likes', 'Likes: vim'),
    fact('likes', 'Likes: emacs'),
    fact('likes', 'Likes: neovim'),
    fact('likes', 'Likes: sublime'),
    fact('likes', 'Likes: jetbrains'), // 7th distinct — should be dropped
    fact('preference', 'Prefers: concise answers'),
    fact('preference', 'Prefers: code examples'),
  ]);

  assert.deepEqual(lines, [
    'Prefers: concise answers, code examples',
    'Likes: coffee, tea, vim, emacs, neovim, sublime',
  ]);
});

test('buildSpeakerProfileLines preserves singleton order and skips missing categories', () => {
  const lines = buildSpeakerProfileLines([
    fact('role', 'Role: data scientist'),
    fact('likes', 'Likes: ramen'),
  ]);

  assert.deepEqual(lines, [
    'Role: data scientist',
    'Likes: ramen',
  ]);
});

test('buildSpeakerProfileLines recognises both "Works at" and "Works on" prefixes', () => {
  const linesAt = buildSpeakerProfileLines([fact('work', 'Works at: Acme')]);
  const linesOn = buildSpeakerProfileLines([fact('work', 'Works on: compilers')]);

  assert.deepEqual(linesAt, ['Works at/on: Acme']);
  assert.deepEqual(linesOn, ['Works at/on: compilers']);
});

test('buildSpeakerProfileLines reads category from metadata fallback', () => {
  const lines = buildSpeakerProfileLines([
    // recallMemories path emits { text, metadata: { category } } rather than a
    // top-level category — make sure we still group correctly.
    { text: 'Location: Tokyo', metadata: { category: 'location' } },
    { text: 'Likes: sushi', metadata: { category: 'likes' } },
  ]);

  assert.deepEqual(lines, [
    'Location: Tokyo',
    'Likes: sushi',
  ]);
});

test('buildSpeakerProfileLines ignores unknown or empty categories', () => {
  const lines = buildSpeakerProfileLines([
    fact('random', 'Random: noise'),
    fact('', 'No category here'),
    fact('likes', ''),
    fact('likes', 'Likes: tea'),
  ]);

  assert.deepEqual(lines, ['Likes: tea']);
});

test('buildSpeakerProfileBlock renders header + bullets when lines exist', () => {
  const facts = [
    fact('name', 'Name: Mortred'),
    fact('role', 'Role: engineer'),
    fact('likes', 'Likes: coffee'),
    fact('likes', 'Likes: tea'),
    fact('preference', 'Prefers: dark mode'),
    fact('preference', 'Prefers: concise answers'),
  ];

  const block = buildSpeakerProfileBlock(facts, { label: 'Alice' });

  assert.ok(block.startsWith('Speaker profile (Alice) — condensed from 6 fact nodes:'));
  assert.ok(block.includes('\n- Name: Mortred'));
  assert.ok(block.includes('\n- Role: engineer'));
  assert.ok(block.includes('\n- Prefers: dark mode, concise answers'));
  assert.ok(block.includes('\n- Likes: coffee, tea'));
});

test('buildSpeakerProfileBlock returns empty string when no usable lines', () => {
  assert.equal(buildSpeakerProfileBlock([]), '');
  assert.equal(buildSpeakerProfileBlock([fact('unknown', 'nope')]), '');
  assert.equal(buildSpeakerProfileBlock([fact('likes', '')]), '');
});

test('buildSpeakerProfileBlock omits label parenthetical when label is missing', () => {
  const block = buildSpeakerProfileBlock([fact('name', 'Name: Anon')]);
  assert.ok(block.startsWith('Speaker profile — condensed from 1 fact nodes:'));
  assert.ok(block.includes('\n- Name: Anon'));
});

test('buildIdentityLine joins singleton values with separators', () => {
  const line = buildIdentityLine([
    fact('name', 'Name: Alice'),
    fact('role', 'Role: data scientist'),
    fact('location', 'Location: Shanghai'),
    fact('work', 'Works at: Acme'),
    fact('likes', 'Likes: coffee'), // ignored — not a singleton
  ], { label: 'alice' });

  assert.equal(line, 'alice — Alice · data scientist · Shanghai · Acme');
});

test('buildIdentityLine omits label when not provided and skips empty singletons', () => {
  const line = buildIdentityLine([
    fact('role', 'Role: engineer'),
    fact('location', 'Location: Tokyo'),
  ]);

  assert.equal(line, 'engineer · Tokyo');
});

test('buildIdentityLine returns empty string when no singleton fact is known', () => {
  assert.equal(buildIdentityLine([]), '');
  assert.equal(buildIdentityLine([fact('likes', 'Likes: tea')]), '');
});

test('buildIdentityLine keeps the first value when singletons conflict', () => {
  const line = buildIdentityLine([
    fact('name', 'Name: Alice'),
    fact('name', 'Name: Bob'),
  ]);

  assert.equal(line, 'Alice');
});

test('buildSpeakerProfileLines is case-insensitive when deduplicating multi-values', () => {
  const lines = buildSpeakerProfileLines([
    fact('likes', 'Likes: Coffee'),
    fact('likes', 'Likes: coffee'),
    fact('likes', 'Likes: COFFEE'),
    fact('likes', 'Likes: tea'),
  ]);

  // First variant wins, duplicates collapsed regardless of case.
  assert.deepEqual(lines, ['Likes: Coffee, tea']);
});
