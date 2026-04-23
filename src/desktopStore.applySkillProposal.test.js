/**
 * Tests for applySkillProposal — the apply path of Phase 3.4.2 upgrade
 * proposals. Uses dependency injection on the exported function (the
 * `_store`, `_loadStateFn`, `_saveStateFn`, `_writeFileFn`, `_mkdirFn`
 * options) so we don't touch real disk or state files.
 *
 * Covers:
 *   - rejects non-upgrade proposals (kind:'create')
 *   - rejects a missing seedId / unknown proposal
 *   - rejects built-in skill targets
 *   - rejects bundled (source:'melo-bundle') skill targets — the user
 *     explicitly asked for this in 3.4.2: bundle skills are read-only
 *     to the proposal flow
 *   - merges triggersToAdd into skill.triggers (dedup, case-insensitive)
 *   - appends systemPromptAppendix when not already present
 *   - writes reference file to <diskPath>/references/<date>.md
 *   - dismisses the proposal after applying
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applySkillProposal } from './desktopStore.js';
import { createSkillProposalStore } from './agents/skillProposals.js';

// Test harness for a single apply call. Returns { result, state, writes, mkdirs }.
async function runApply(proposal, skillBefore, {
  preloadProposal = true,
  extraState = {},
} = {}) {
  const store = (proposal.kind !== undefined)
    ? createSkillProposalStore()
    : createSkillProposalStore();
  if (preloadProposal) {
    // addMany runs our real dedup/dismiss logic.
    store.addMany([proposal]);
  }
  const state = {
    settings: {
      customSkills: skillBefore ? [{ ...skillBefore }] : [],
      ...extraState,
    },
  };
  let saved = null;
  const writes = [];
  const mkdirs = [];
  const result = await applySkillProposal(proposal.seedId, {
    _store: store,
    _loadStateFn: async () => state,
    _saveStateFn: async (s) => { saved = s; },
    _writeFileFn: async (path, content) => {
      writes.push({ path, content });
    },
    _mkdirFn: async (path, options) => {
      mkdirs.push({ path, options });
    },
    _diskRoot: '/tmp/melo-test-skills',
    nowFn: () => Date.UTC(2026, 3, 18, 12, 0, 0),
  });
  return { result, state: saved || state, writes, mkdirs, store };
}

// ─── rejection paths ────────────────────────────────────────────────────────

test('applySkillProposal: rejects missing seedId', async () => {
  const out = await applySkillProposal('', {
    _store: createSkillProposalStore(),
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'BAD_SEED_ID');
});

test('applySkillProposal: 404 when proposal not in store', async () => {
  const out = await applySkillProposal('nope', {
    _store: createSkillProposalStore(),
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'NOT_FOUND');
});

test('applySkillProposal: rejects create-kind proposals', async () => {
  const proposal = {
    seedId: 'p1',
    kind: 'create',
    summary: 'create new',
    createdAt: 1,
  };
  const store = createSkillProposalStore();
  store.addMany([proposal]);
  const out = await applySkillProposal('p1', { _store: store });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'UNSUPPORTED_KIND');
});

test('applySkillProposal: rejects built-in targets', async () => {
  const proposal = {
    seedId: 'up-builtin',
    kind: 'upgrade',
    targetSkillId: 'skill-creator', // built-in id
    triggersToAdd: ['foo'],
    systemPromptAppendix: '## test',
    referenceFileName: '2026-04-18.md',
    referenceDraft: '# ref',
    createdAt: 1,
  };
  const { result } = await runApply(proposal, null);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'BUILTIN_TARGET');
});

test('applySkillProposal: 404 when target skill missing from customSkills', async () => {
  const proposal = {
    seedId: 'up-missing',
    kind: 'upgrade',
    targetSkillId: 'ghost',
    triggersToAdd: [],
    systemPromptAppendix: '',
    referenceFileName: '2026-04-18.md',
    referenceDraft: '',
    createdAt: 1,
  };
  const { result } = await runApply(proposal, null);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'TARGET_MISSING');
});

test('applySkillProposal: refuses to mutate melo-bundle skills', async () => {
  const proposal = {
    seedId: 'up-bundled',
    kind: 'upgrade',
    targetSkillId: 'pdf-bundle',
    triggersToAdd: ['merge'],
    systemPromptAppendix: '## appendix',
    referenceFileName: '2026-04-18.md',
    referenceDraft: '# ref',
    createdAt: 1,
  };
  const bundledSkill = {
    id: 'pdf-bundle',
    name: 'pdf-bundle',
    triggers: ['pdf'],
    systemPrompt: 'Work with PDFs',
    source: 'melo-bundle', // ← protected
    origin: 'disk',
    diskPath: '/tmp/melo-test-skills/pdf-bundle',
  };
  const { result, writes, mkdirs } = await runApply(proposal, bundledSkill);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'BUNDLED_TARGET');
  // Nothing should have been written to disk either.
  assert.equal(writes.length, 0);
  assert.equal(mkdirs.length, 0);
});

// ─── happy path ─────────────────────────────────────────────────────────────

test('applySkillProposal: merges triggers, appends prompt, writes reference', async () => {
  const proposal = {
    seedId: 'up-happy',
    kind: 'upgrade',
    targetSkillId: 'my-skill',
    triggersToAdd: ['deploy', 'ship', 'deploy' /* dup */, 'DEPLOY' /* case dup */],
    systemPromptAppendix: '## Recent pattern\n- deploy',
    referenceFileName: '2026-04-18.md',
    referenceDraft: '# evidence\n\n- telegram_send',
    createdAt: 1,
  };
  const skillBefore = {
    id: 'my-skill',
    name: 'My Skill',
    triggers: ['existing-trigger'],
    systemPrompt: 'base prompt',
    origin: 'disk',
    diskPath: '/tmp/melo-test-skills/my-skill',
    source: null,
  };
  const { result, state, writes, mkdirs } = await runApply(proposal, skillBefore);

  assert.equal(result.ok, true);
  assert.equal(result.skillId, 'my-skill');
  // 2 unique new triggers: 'deploy' and 'ship'.
  assert.equal(result.triggersAdded, 2);
  assert.equal(result.promptAppended, true);

  // In-memory merge
  const after = state.settings.customSkills.find(s => s.id === 'my-skill');
  assert.ok(after, 'updated skill is still in customSkills');
  assert.deepEqual(
    after.triggers.sort(),
    ['deploy', 'existing-trigger', 'ship'].sort(),
  );
  assert.ok(after.systemPrompt.includes('## Recent pattern'));
  assert.ok(after.systemPrompt.startsWith('base prompt'));

  // Reference write
  assert.equal(mkdirs.length, 1);
  assert.match(mkdirs[0].path, /references$/);
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /2026-04-18\.md$/);
  assert.ok(writes[0].content.includes('# evidence'));
});

test('applySkillProposal: idempotent — re-applying appendix does not duplicate it', async () => {
  const appendix = '## Recent pattern\n- x';
  const proposal = {
    seedId: 'up-idem',
    kind: 'upgrade',
    targetSkillId: 'my-skill',
    triggersToAdd: ['one'],
    systemPromptAppendix: appendix,
    referenceFileName: '2026-04-18.md',
    referenceDraft: '# ref',
    createdAt: 1,
  };
  const skillBefore = {
    id: 'my-skill',
    name: 'My Skill',
    triggers: [],
    systemPrompt: 'base\n\n' + appendix,
    origin: 'json',
    source: null,
  };
  const { result, state } = await runApply(proposal, skillBefore);
  assert.equal(result.ok, true);
  assert.equal(result.promptAppended, false, 'appendix already in prompt');
  const after = state.settings.customSkills.find(s => s.id === 'my-skill');
  // Appendix should appear exactly once.
  const occurrences = after.systemPrompt.split('## Recent pattern').length - 1;
  assert.equal(occurrences, 1);
});

test('applySkillProposal: dismisses the proposal after successful apply', async () => {
  const proposal = {
    seedId: 'up-dismiss',
    kind: 'upgrade',
    targetSkillId: 'my-skill',
    triggersToAdd: ['x'],
    systemPromptAppendix: '',
    referenceFileName: '2026-04-18.md',
    referenceDraft: '',
    createdAt: 1,
  };
  const skillBefore = {
    id: 'my-skill',
    name: 'My Skill',
    triggers: [],
    systemPrompt: '',
    origin: 'json',
    source: null,
  };
  const { result, store } = await runApply(proposal, skillBefore);
  assert.equal(result.ok, true);
  assert.equal(store.get('up-dismiss'), null, 'proposal removed from store');
  assert.equal(store.isDismissed('up-dismiss'), true);
});
