/**
 * Tests for Phase 3.4.2 — skill self-upgrade primitives.
 *
 * Covers:
 *   - computeSkillCandidateSimilarity weights triggers highest
 *   - computeSkillCandidateSimilarity returns 0 when candidate is empty
 *   - buildUpgradeProposal returns null without a target skill id
 *   - buildUpgradeProposal extracts trigger candidates from high-freq tokens
 *   - buildUpgradeProposal skips stopword-ish tokens
 *   - buildUpgradeProposal skips tokens already present in skill.triggers
 *   - buildUpgradeProposal builds a reference markdown with samples
 *   - proposeSkillsFromActivity emits kind:'upgrade' when a skill matches,
 *     and kind:'create' otherwise
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSkillCandidateSimilarity,
  buildUpgradeProposal,
  UPGRADE_SIMILARITY_THRESHOLD,
} from './skillUpgrade.js';
import { proposeSkillsFromActivity } from './skillProposals.js';

// ─── Similarity ─────────────────────────────────────────────────────────────

test('computeSkillCandidateSimilarity: triggers dominate the score', () => {
  const skill = {
    id: 'daily-report',
    name: 'Daily Report',
    triggers: ['daily report', 'standup'],
    description: '',
    systemPrompt: '',
    toolWhitelist: [],
  };
  const candidate = {
    sampleMessages: [
      { role: 'user', content: 'generate a daily report for the team standup' },
    ],
    toolCalls: [],
  };
  const score = computeSkillCandidateSimilarity(skill, candidate);
  // Both triggers matched → trigger score = 1.0, weight 0.45 → floor 0.45.
  assert.ok(score >= 0.45, `expected >=0.45, got ${score}`);
});

test('computeSkillCandidateSimilarity: zero when candidate text is empty', () => {
  const skill = { id: 's', triggers: ['anything'], description: '', systemPrompt: '' };
  const candidate = { sampleMessages: [{ role: 'user', content: '' }], toolCalls: [] };
  assert.equal(computeSkillCandidateSimilarity(skill, candidate), 0);
});

test('computeSkillCandidateSimilarity: tool overlap boosts the score', () => {
  const skill = {
    id: 's',
    triggers: [],
    description: 'Send updates via Telegram',
    systemPrompt: '',
    toolWhitelist: ['telegram_send', 'web_search'],
  };
  const candidate = {
    sampleMessages: [{ role: 'user', content: 'do the thing' }],
    toolCalls: [
      { toolId: 'telegram_send' },
      { toolId: 'telegram_send' },
      { toolId: 'web_search' },
    ],
  };
  const score = computeSkillCandidateSimilarity(skill, candidate);
  // Tool overlap = 2/2 = 1.0 → 0.35 from tool signal alone.
  assert.ok(score >= 0.30, `expected >=0.30, got ${score}`);
});

test('computeSkillCandidateSimilarity: returns 0 for null skill', () => {
  assert.equal(computeSkillCandidateSimilarity(null, {}), 0);
});

// ─── buildUpgradeProposal ───────────────────────────────────────────────────

test('buildUpgradeProposal: returns null without a skill id', () => {
  assert.equal(buildUpgradeProposal(null, {}), null);
  assert.equal(buildUpgradeProposal({}, {}), null);
});

test('buildUpgradeProposal: extracts new triggers from repeated user tokens', () => {
  const skill = { id: 'daily', name: 'Daily', triggers: ['daily'] };
  const candidate = {
    chatId: 'c1',
    toolCalls: [{ toolId: 'telegram_send' }, { toolId: 'web_search' }],
    samples: [{
      messages: [
        // 'deployment' appears 3 times; should rise to the top.
        { role: 'user', content: 'run the deployment report' },
        { role: 'user', content: 'another deployment today' },
        { role: 'user', content: 'deployment reminder please' },
      ],
    }],
  };
  const up = buildUpgradeProposal(skill, candidate, { nowFn: () => 1700000000000 });
  assert.ok(up);
  assert.equal(up.kind, 'upgrade');
  assert.equal(up.targetSkillId, 'daily');
  assert.ok(up.triggersToAdd.includes('deployment'), `got ${JSON.stringify(up.triggersToAdd)}`);
  // 'daily' was already a trigger → must NOT be re-added.
  assert.ok(!up.triggersToAdd.includes('daily'));
});

test('buildUpgradeProposal: filters stopword-ish tokens', () => {
  const skill = { id: 's', name: 'S', triggers: [] };
  const candidate = {
    chatId: 'c1',
    toolCalls: [{ toolId: 'x' }],
    samples: [{
      messages: [
        { role: 'user', content: 'the and the and the and' },
        { role: 'user', content: 'the and the and the and' },
      ],
    }],
  };
  const up = buildUpgradeProposal(skill, candidate);
  assert.ok(up);
  // 'the' and 'and' are stopword-ish — should not be proposed as triggers.
  assert.ok(!up.triggersToAdd.includes('the'));
  assert.ok(!up.triggersToAdd.includes('and'));
});

test('buildUpgradeProposal: systemPromptAppendix includes date, chat, tool list', () => {
  const skill = { id: 's', name: 'S', triggers: [] };
  const candidate = {
    chatId: 'chat-xyz',
    toolCalls: [{ toolId: 'telegram_send' }, { toolId: 'save_workspace_file' }],
    samples: [{ messages: [{ role: 'user', content: 'run the workflow' }] }],
  };
  const up = buildUpgradeProposal(skill, candidate, { nowFn: () => Date.UTC(2026, 3, 18) });
  assert.ok(up.systemPromptAppendix.includes('2026-04-18'));
  assert.ok(up.systemPromptAppendix.includes('chat-xyz'));
  assert.ok(up.systemPromptAppendix.includes('telegram_send'));
});

test('buildUpgradeProposal: reference draft embeds sample messages', () => {
  const skill = { id: 's', name: 'S', triggers: [] };
  const candidate = {
    chatId: 'chat-xyz',
    toolCalls: [{ toolId: 'telegram_send' }],
    samples: [{
      messages: [
        { role: 'user', content: 'hello world' },
        { role: 'assistant', content: 'sure thing' },
      ],
    }],
  };
  const up = buildUpgradeProposal(skill, candidate);
  assert.ok(up.referenceDraft.includes('hello world'));
  assert.ok(up.referenceDraft.includes('telegram_send'));
  assert.match(up.referenceFileName, /^\d{4}-\d{2}-\d{2}\.md$/);
});

// ─── Proposer integration: emits upgrade vs create ──────────────────────────

function ttoolCalls(msgs) {
  return msgs.map(toolName => ({ role: 'tool', toolName }));
}

test('proposeSkillsFromActivity: emits upgrade proposal when skill matches', () => {
  const existingSkill = {
    id: 'telegram-blast',
    name: 'Telegram Blast',
    // Very generous triggers so the candidate text matches.
    triggers: ['blast', 'broadcast', 'send'],
    description: 'Broadcast a message via telegram',
    systemPrompt: 'When the user wants to blast a telegram message, send it.',
    toolWhitelist: ['telegram_send'],
  };

  const activities = [{
    chatId: 'c1',
    messages: [
      { role: 'user', content: 'blast broadcast send the team a notice' },
      ...ttoolCalls(['telegram_send', 'telegram_send', 'telegram_send']),
    ],
  }];

  const out = proposeSkillsFromActivity(activities, {
    existingSkills: [existingSkill],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'upgrade');
  assert.equal(out[0].targetSkillId, 'telegram-blast');
  assert.ok(out[0].similarityScore >= UPGRADE_SIMILARITY_THRESHOLD);
});

test('proposeSkillsFromActivity: emits create proposal when no skill matches', () => {
  const existingSkill = {
    id: 'unrelated',
    name: 'Unrelated',
    triggers: ['foo', 'bar'],
    description: 'Nothing to do with messaging',
    systemPrompt: 'Do unrelated stuff.',
    toolWhitelist: ['foo_tool'],
  };
  const activities = [{
    chatId: 'c1',
    messages: ttoolCalls(['telegram_send', 'telegram_send', 'telegram_send']),
  }];
  const out = proposeSkillsFromActivity(activities, { existingSkills: [existingSkill] });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'create');
});

test('proposeSkillsFromActivity: falls back to create when existingSkills empty', () => {
  const activities = [{
    chatId: 'c1',
    messages: ttoolCalls(['telegram_send', 'telegram_send', 'telegram_send']),
  }];
  const out = proposeSkillsFromActivity(activities);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'create');
});

// ─── Bundle protection ──────────────────────────────────────────────────────
//
// Melo-bundled skills (source: 'melo-bundle') must never be mutated by the
// user-activity upgrade flow. When a user's pattern strongly resembles a
// bundled skill, the proposer should emit a create proposal instead — so the
// evolution lands on a new user-owned skill, leaving the bundle intact.

test('proposeSkillsFromActivity: bundled skill match falls through to create', () => {
  const bundled = {
    id: 'pdf',
    name: 'pdf',
    triggers: ['pdf', 'extract', 'merge'],
    description: 'PDF toolkit',
    systemPrompt: 'Work with PDFs',
    toolWhitelist: ['pdf_extract', 'pdf_merge'],
    source: 'melo-bundle', // ← protected
  };
  const activities = [{
    chatId: 'c1',
    messages: [
      { role: 'user', content: 'please extract and merge the pdf files' },
      ...ttoolCalls(['pdf_extract', 'pdf_extract', 'pdf_merge']),
    ],
  }];
  const out = proposeSkillsFromActivity(activities, { existingSkills: [bundled] });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'create',
    `expected create (bundled skill is protected), got ${out[0].kind}`);
});

test('proposeSkillsFromActivity: prefers user-owned skill over bundled one when both match', () => {
  const bundled = {
    id: 'pdf',
    name: 'pdf',
    triggers: ['pdf', 'extract', 'merge'],
    description: 'PDF toolkit',
    systemPrompt: 'Work with PDFs',
    toolWhitelist: ['pdf_extract', 'pdf_merge'],
    source: 'melo-bundle',
  };
  const userOwned = {
    id: 'my-pdf-flow',
    name: 'My PDF flow',
    triggers: ['pdf', 'extract', 'merge'],
    description: 'Personal pdf extraction flow',
    systemPrompt: 'Run my PDF extraction',
    toolWhitelist: ['pdf_extract', 'pdf_merge'],
    // no source stamp → upgradable
  };
  const activities = [{
    chatId: 'c1',
    messages: [
      { role: 'user', content: 'extract and merge the pdf files' },
      ...ttoolCalls(['pdf_extract', 'pdf_extract', 'pdf_merge']),
    ],
  }];
  const out = proposeSkillsFromActivity(activities, {
    existingSkills: [bundled, userOwned],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'upgrade');
  assert.equal(out[0].targetSkillId, 'my-pdf-flow',
    'upgrade must target the user-owned skill, never the bundled one');
});

test('proposeSkillsFromActivity: built-in origin skills are not upgrade targets', () => {
  const builtin = {
    id: 'skill-creator',
    name: 'Skill creator',
    triggers: ['skill', 'create', 'meta'],
    description: 'Meta-skill for creating skills',
    systemPrompt: 'Meta',
    // Use telegram_send here so the candidate clears the "external effect"
    // gate (CONNECTOR_TOOL_HINTS). We're testing that origin:'built-in'
    // blocks the upgrade match, not the gate itself.
    toolWhitelist: ['telegram_send'],
    origin: 'built-in', // ← not upgradable via user activity
  };
  const activities = [{
    chatId: 'c1',
    messages: [
      { role: 'user', content: 'create a new skill with meta tools' },
      ...ttoolCalls(['telegram_send', 'telegram_send', 'telegram_send']),
    ],
  }];
  const out = proposeSkillsFromActivity(activities, { existingSkills: [builtin] });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'create');
});
