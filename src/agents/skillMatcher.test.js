/**
 * Tests for Phase 3.2.2 — rule-based skill pre-filter.
 *
 * Covers:
 *   - skills with no triggers/tags pass through unconditionally
 *   - built-in skills are not filtered regardless of message
 *   - custom skills with triggers are dropped when no trigger matches
 *   - custom skills with triggers are kept when a trigger matches
 *   - `always-on` tag overrides everything
 *   - empty user message = no filtering
 *   - CJK tokens are matched
 *   - safety net: minKeep threshold falls back to original list
 *   - ordering: matched skills sorted by score desc; passthrough first
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchSkillsForMessage,
  scoreSkill,
  tokenizeForMatch,
  classifySkillTier,
  recencyBonusFor,
  buildSkillIndex,
  createSkillMatchCache,
} from './skillMatcher.js';
import { candidateSkillIdsFor } from './skillIndex.js';

function skill(id, extras = {}) {
  return {
    id,
    name: extras.name || id,
    description: extras.description || '',
    tags: extras.tags || [],
    triggers: extras.triggers || [],
    source: extras.source || 'custom',
  };
}

test('no triggers or tags → skill passes through', () => {
  const a = skill('a');
  const out = matchSkillsForMessage([a], 'hello world');
  assert.deepEqual(out.map(s => s.id), ['a']);
});

test('built-in skill is always kept even if message is irrelevant', () => {
  const a = skill('a', { source: 'built-in', triggers: ['python'] });
  const out = matchSkillsForMessage([a], 'tell me a joke');
  assert.deepEqual(out.map(s => s.id), ['a']);
});

test('custom skill with non-matching trigger is dropped (when safety net lets it)', () => {
  const a = skill('a', { triggers: ['python'] });
  const b = skill('b'); // passthrough
  const c = skill('c'); // passthrough
  const out = matchSkillsForMessage([a, b, c], 'what is JavaScript');
  assert.ok(!out.map(s => s.id).includes('a'));
  assert.ok(out.map(s => s.id).includes('b'));
  assert.ok(out.map(s => s.id).includes('c'));
});

test('custom skill with matching trigger is kept', () => {
  const a = skill('a', { triggers: ['python'] });
  const out = matchSkillsForMessage([a], 'write me a python script');
  assert.deepEqual(out.map(s => s.id), ['a']);
});

test('always-on tag overrides everything', () => {
  const a = skill('a', { tags: ['always-on'] });
  const out = matchSkillsForMessage([a], 'totally unrelated message');
  assert.deepEqual(out.map(s => s.id), ['a']);
});

test('empty user message → no filtering applied', () => {
  const a = skill('a', { triggers: ['python'] });
  const out = matchSkillsForMessage([a], '');
  assert.deepEqual(out.map(s => s.id), ['a']);
});

test('CJK tokens match', () => {
  const a = skill('a', { triggers: ['会议'] });
  const out = matchSkillsForMessage([a], '帮我安排一个会议');
  assert.deepEqual(out.map(s => s.id), ['a']);
});

test('word-boundary: "ship" does not match "shipping"', () => {
  const a = skill('a', { triggers: ['ship'] });
  const out = matchSkillsForMessage([a], 'international shipping rates');
  assert.ok(!out.map(s => s.id).includes('a'));
});

test('safety net: if match leaves < minKeep, return original list', () => {
  const a = skill('a', { triggers: ['python'] });
  const b = skill('b', { triggers: ['rust'] });
  const c = skill('c', { triggers: ['go'] });
  // No matches — minKeep=2 triggers fallback.
  const out = matchSkillsForMessage([a, b, c], 'hello');
  assert.equal(out.length, 3);
});

test('matched skills sort by score desc', () => {
  const strong = skill('strong', { triggers: ['python', 'script'] });
  const weak = skill('weak', { triggers: ['python'] });
  // passthrough skill comes first (no metadata → infinite score → top)
  const pass = skill('pass');
  const out = matchSkillsForMessage([weak, strong, pass], 'write a python script');
  // Passthrough first, then strong (score 6), then weak (score 3).
  assert.deepEqual(out.map(s => s.id), ['pass', 'strong', 'weak']);
});

test('skill name appearing in message boosts score', () => {
  const s = skill('pdf-maker', { name: 'pdf-maker', triggers: [] });
  // No triggers but name mentioned — still needs triggers/tags to enter
  // scoring path. Let's give it a tag so it's in the scored bucket.
  const s2 = skill('pdf-maker', { name: 'pdf-maker', tags: ['documents'] });
  assert.ok(scoreSkill(s2, 'use pdf-maker please') > 0);
});

test('tokenizeForMatch drops short tokens and keeps CJK', () => {
  const toks = tokenizeForMatch('hi there 一起 go');
  assert.ok(toks.includes('there'));
  assert.ok(toks.includes('一起'));
  // 'hi' and 'go' are both length 2 — dropped under default MIN_WORD_LEN=3.
  assert.ok(!toks.includes('hi'));
  assert.ok(!toks.includes('go'));
});

test('maxKeep caps output', () => {
  const many = Array.from({ length: 30 }, (_, i) => skill(`s${i}`, { triggers: ['python'] }));
  const out = matchSkillsForMessage(many, 'python', { maxKeep: 5 });
  assert.equal(out.length, 5);
});

// ─── Phase 4 — multi-turn context ───────────────────────────────────────────

test('multi-turn: previous user message boosts a short follow-up', () => {
  const s = skill('a', { triggers: ['word'] });
  // Latest message alone wouldn't match, but previous turn mentioned word.
  const messages = [
    { role: 'user', content: '帮我导出这份分析成 word 文档' },
    { role: 'assistant', content: 'Done, saved to docs.' },
    { role: 'user', content: '另外也存成 pdf' },
  ];
  // cache: false so each assertion runs independent scoring.
  const out = matchSkillsForMessage([s, skill('b', { triggers: ['excel'] })], messages, {
    cache: false,
  });
  assert.ok(out.map(x => x.id).includes('a'));
});

test('multi-turn: assistant messages contribute at reduced weight', () => {
  const s = skill('deploy', { triggers: ['deploy'] });
  const messages = [
    { role: 'assistant', content: 'I can help you deploy when you\'re ready' },
    { role: 'user', content: 'ok' },
  ];
  // Assistant piece is at weight 0.6 × 0.5 = 0.3 (previous slot × role
  // attenuation). 3 × 0.3 = 0.9 > 0 so the skill matches.
  const score = scoreSkill(s, messages, {
    applyTierBonus: false,
    recencyByIdMap: null,
  });
  assert.ok(score > 0, 'assistant turn still contributes');
});

test('multi-turn: string input still works (backwards compat)', () => {
  const s = skill('a', { triggers: ['python'] });
  const out = matchSkillsForMessage([s], 'write a python script', { cache: false });
  assert.deepEqual(out.map(x => x.id), ['a']);
});

// ─── Phase 4 — protected passthrough (bundle + built-in) ─────────────────────

test('bundle-source skill is treated as protected', () => {
  const a = skill('a', { triggers: ['python'], source: 'melo-bundle' });
  const out = matchSkillsForMessage([a], 'tell me a joke about cats', { cache: false });
  // Protected passthrough keeps it in.
  assert.deepEqual(out.map(x => x.id), ['a']);
});

test('keepProtected=false opts OUT of bundle/built-in passthrough', () => {
  const a = skill('a', { triggers: ['python'], source: 'melo-bundle' });
  const b = skill('b', { triggers: ['rust'], source: 'built-in' });
  const filler = skill('c'); // passthrough (no metadata)
  const out = matchSkillsForMessage(
    [a, b, filler],
    'hello',
    { keepProtected: false, minKeep: 1, cache: false },
  );
  // Protected skills should be dropped; no-metadata filler stays.
  assert.ok(!out.map(x => x.id).includes('a'));
  assert.ok(!out.map(x => x.id).includes('b'));
  assert.ok(out.map(x => x.id).includes('c'));
});

// ─── Phase 4 — recency boost ────────────────────────────────────────────────

test('recency: last run within 24h adds +3 to score', () => {
  const now = Date.UTC(2026, 3, 18);
  const s = skill('a', { triggers: ['python'] });
  const base = scoreSkill(s, 'python', {
    applyTierBonus: false,
    now,
  });
  const boosted = scoreSkill(s, 'python', {
    applyTierBonus: false,
    recencyByIdMap: { a: now - 60 * 60 * 1000 }, // 1h ago
    now,
  });
  assert.equal(boosted - base, 3);
});

test('recency: between 24h and 7d adds +2', () => {
  const now = Date.UTC(2026, 3, 18);
  const s = skill('a', { triggers: ['python'] });
  const base = scoreSkill(s, 'python', {
    applyTierBonus: false,
    now,
  });
  const boosted = scoreSkill(s, 'python', {
    applyTierBonus: false,
    recencyByIdMap: { a: now - 3 * 24 * 60 * 60 * 1000 }, // 3d ago
    now,
  });
  assert.equal(boosted - base, 2);
});

test('recency: older than 7d adds nothing', () => {
  const now = Date.UTC(2026, 3, 18);
  const s = skill('a', { triggers: ['python'] });
  const base = scoreSkill(s, 'python', {
    applyTierBonus: false,
    now,
  });
  const boosted = scoreSkill(s, 'python', {
    applyTierBonus: false,
    recencyByIdMap: { a: now - 30 * 24 * 60 * 60 * 1000 }, // 30d ago
    now,
  });
  assert.equal(boosted, base);
});

test('recency: irrelevant skill does NOT get resurrected by recency alone', () => {
  const now = Date.UTC(2026, 3, 18);
  const s = skill('a', { triggers: ['python'] });
  const score = scoreSkill(s, 'totally different topic', {
    applyTierBonus: false,
    recencyByIdMap: { a: now - 60 * 1000 }, // 1min ago
    now,
  });
  assert.equal(score, 0);
});

test('recencyBonusFor: supports Map and plain object', () => {
  const now = Date.UTC(2026, 3, 18);
  const obj = { a: now - 60 * 1000 };
  const map = new Map([['a', now - 60 * 1000]]);
  assert.equal(recencyBonusFor('a', obj, now), 3);
  assert.equal(recencyBonusFor('a', map, now), 3);
  assert.equal(recencyBonusFor('missing', obj, now), 0);
  assert.equal(recencyBonusFor('a', null, now), 0);
});

// ─── Phase 4 — priority tier ────────────────────────────────────────────────

test('classifySkillTier: bundle = 0', () => {
  assert.equal(classifySkillTier({ source: 'melo-bundle' }), 0);
});

test('classifySkillTier: built-in origin = 1', () => {
  assert.equal(classifySkillTier({ origin: 'built-in' }), 1);
});

test('classifySkillTier: plain user skill = 1', () => {
  assert.equal(classifySkillTier({ source: 'custom', origin: 'json', systemPrompt: 'plain' }), 1);
});

test('classifySkillTier: evolved skill (with pattern block) = 2', () => {
  assert.equal(
    classifySkillTier({
      source: 'custom',
      origin: 'disk',
      systemPrompt: 'base\n\n## Recent pattern\n- x',
    }),
    2,
  );
});

test('classifySkillTier: evolved skill (with references flag) = 2', () => {
  assert.equal(
    classifySkillTier({
      source: 'custom',
      origin: 'disk',
      hasReferences: true,
    }),
    2,
  );
});

test('tier: evolved user skill sorts ahead of a bundled match on the same triggers', () => {
  const bundled = skill('bundled', { triggers: ['python'], source: 'melo-bundle' });
  const evolved = {
    id: 'evolved',
    name: 'evolved',
    description: '',
    tags: [],
    triggers: ['python'],
    source: 'custom',
    origin: 'disk',
    systemPrompt: 'base\n\n## Recent pattern\n- python scripting',
  };
  const out = matchSkillsForMessage([bundled, evolved], 'python', {
    cache: false,
    // Both are kept (bundled via passthrough, evolved via score).
    // We expect the evolved skill to appear in the scored group and
    // passthroughs first. Let's disable protected passthrough so both
    // score through the normal path.
    keepProtected: false,
    minKeep: 1,
  });
  // With keepProtected off, bundled gets tier 0, evolved tier 2. Score
  // diff of 2 should put evolved ahead.
  assert.deepEqual(out.map(x => x.id), ['evolved', 'bundled']);
});

// ─── Phase 4 — inverted index ───────────────────────────────────────────────

test('buildSkillIndex / candidateSkillIdsFor basic lookup', () => {
  const skills = [
    skill('py', { triggers: ['python', 'script'] }),
    skill('go', { triggers: ['golang', 'concurrency'] }),
    skill('rs', { triggers: ['rust'] }),
  ];
  const idx = buildSkillIndex(skills);
  const cands = candidateSkillIdsFor('please write me a python script', idx);
  assert.ok(cands.has('py'));
  assert.ok(!cands.has('go'));
  assert.ok(!cands.has('rs'));
});

test('index narrowing: matcher skips scoring for non-candidates', () => {
  const many = [
    skill('py', { triggers: ['python'] }),
    skill('go', { triggers: ['golang'] }),
    skill('rs', { triggers: ['rust'] }),
  ];
  const idx = buildSkillIndex(many);
  const out = matchSkillsForMessage(many, 'please write me python', {
    skillIndex: idx,
    cache: false,
    minKeep: 1,
  });
  assert.deepEqual(out.map(x => x.id), ['py']);
});

test('index: protected skills bypass index narrowing', () => {
  const bundled = skill('bundled', { triggers: ['unrelated'], source: 'melo-bundle' });
  const regular = skill('py', { triggers: ['python'] });
  const idx = buildSkillIndex([bundled, regular]);
  const out = matchSkillsForMessage([bundled, regular], 'please write me python', {
    skillIndex: idx,
    cache: false,
  });
  // Bundled passes through protected-passthrough; regular via score.
  assert.ok(out.map(x => x.id).includes('bundled'));
  assert.ok(out.map(x => x.id).includes('py'));
});

// ─── Phase 4 — LRU cache ────────────────────────────────────────────────────

test('LRU cache: second identical call returns cached result', () => {
  const cache = createSkillMatchCache({ capacity: 4 });
  const skills = [skill('a', { triggers: ['python'] })];
  const first = matchSkillsForMessage(skills, 'write python', { cache });
  const second = matchSkillsForMessage(skills, 'write python', { cache });
  assert.deepEqual(first.map(s => s.id), second.map(s => s.id));
  assert.equal(cache.size, 1);
});

test('LRU cache: different message = different key', () => {
  const cache = createSkillMatchCache({ capacity: 4 });
  const skills = [skill('a', { triggers: ['python'] })];
  matchSkillsForMessage(skills, 'write python', { cache });
  matchSkillsForMessage(skills, 'write rust', { cache });
  assert.equal(cache.size, 2);
});

test('LRU cache: skill list change invalidates cache entry', () => {
  const cache = createSkillMatchCache({ capacity: 4 });
  const a = skill('a', { triggers: ['python'] });
  const b = skill('b', { triggers: ['rust'] });
  matchSkillsForMessage([a], 'write python', { cache });
  matchSkillsForMessage([a, b], 'write python', { cache });
  // Different fingerprint → different key, so two entries.
  assert.equal(cache.size, 2);
});

test('LRU cache: capacity evicts oldest entry', () => {
  const cache = createSkillMatchCache({ capacity: 2 });
  const s = [skill('a', { triggers: ['python'] })];
  matchSkillsForMessage(s, 'one', { cache });
  matchSkillsForMessage(s, 'two', { cache });
  matchSkillsForMessage(s, 'three', { cache });
  assert.equal(cache.size, 2);
});

test('LRU cache: defensive copy — caller mutation does not corrupt cache', () => {
  const cache = createSkillMatchCache({ capacity: 4 });
  const skills = [skill('a', { triggers: ['python'] })];
  const first = matchSkillsForMessage(skills, 'python', { cache });
  first.length = 0; // mutate returned array
  const second = matchSkillsForMessage(skills, 'python', { cache });
  assert.equal(second.length, 1);
  assert.equal(second[0].id, 'a');
});

test('LRU cache: cache=false disables memoization entirely', () => {
  const cache = createSkillMatchCache({ capacity: 4 });
  const skills = [skill('a', { triggers: ['python'] })];
  matchSkillsForMessage(skills, 'python', { cache: false });
  matchSkillsForMessage(skills, 'python', { cache: false });
  assert.equal(cache.size, 0);
});
