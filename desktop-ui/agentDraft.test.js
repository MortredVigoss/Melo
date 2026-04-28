// Contract tests for the Customize → Agents draft pipeline.
//
// Codex 2026-04-28 audit caught that `enabledMcpServerIds` was missing
// from the inline `agentDraftFor` body — the chip-row read undefined,
// no chip was "selected", and a save would silently clear the per-agent
// MCP whitelist. These tests pin the three contract slots:
//
//   1. Existing authorisations survive the profile→draft round-trip.
//   2. A draft taken from a profile and submitted untouched produces
//      the same MCP whitelist (no silent drop on save).
//   3. A globally-disabled but already-authorised server stays
//      "selected" in the draft so the toggle action recognises it as
//      "remove" rather than "add" — that's the stale-revoke path the
//      🔵 fix promised.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentDraftFromProfile,
  normalizeChannelsForDraft,
} from './agentDraft.js';

// ─── Whitelist round-trip ───────────────────────────────────────────────────

test('agentDraftFromProfile carries enabledMcpServerIds verbatim from the profile', () => {
  const profile = {
    id: 'main',
    name: 'main',
    enabledMcpServerIds: ['markdown2pdf', 'antv-chart'],
  };
  const draft = agentDraftFromProfile(profile);
  assert.deepEqual(draft.enabledMcpServerIds, ['markdown2pdf', 'antv-chart']);
});

test('agentDraftFromProfile defaults enabledMcpServerIds to [] when missing (deny-all)', () => {
  // Unlike enabledSkillIds / enabledConnectorIds (which use null = no
  // restriction), MCP defaults to deny-all — matching the server-side
  // normalizeMcpServerWhitelist contract. A missing field must NEVER
  // become "allow everything" because stdio MCPs run arbitrary local
  // processes.
  const draft = agentDraftFromProfile({ id: 'main' });
  assert.deepEqual(draft.enabledMcpServerIds, []);
});

test('agentDraftFromProfile defaults enabledMcpServerIds to [] when value is non-array', () => {
  for (const bogus of [null, undefined, 'antv-chart', 42, { 'antv-chart': true }]) {
    const draft = agentDraftFromProfile({ id: 'x', enabledMcpServerIds: bogus });
    assert.deepEqual(draft.enabledMcpServerIds, [],
      `bogus input ${JSON.stringify(bogus)} must collapse to deny-all`);
  }
});

test('agentDraftFromProfile clones the array (mutating draft does not leak into profile)', () => {
  const profile = { id: 'x', enabledMcpServerIds: ['antv-chart'] };
  const draft = agentDraftFromProfile(profile);
  draft.enabledMcpServerIds.push('rogue');
  assert.deepEqual(profile.enabledMcpServerIds, ['antv-chart'],
    'profile must not be mutated by draft edits');
});

// ─── Save-without-edit (regression for silent drop) ─────────────────────────

test('untouched profile→draft→submit roundtrip preserves enabledMcpServerIds', () => {
  // Simulates: user opens an agent's edit form, doesn't touch the MCP
  // chip-row, hits Save. The form's hidden input value is built from
  // draft.enabledMcpServerIds (joined with commas; empty array = empty
  // string). Without the fix, draft.enabledMcpServerIds was undefined,
  // the hidden input rendered as "", split-and-trim made it [], and the
  // server normalised that as deny-all — wiping the agent's prior
  // authorisations.
  const profile = {
    id: 'main',
    name: 'main',
    enabledMcpServerIds: ['markdown2pdf', 'antv-chart'],
  };
  const draft = agentDraftFromProfile(profile);

  // What the form's hidden input would emit:
  const hiddenInputValue = (Array.isArray(draft.enabledMcpServerIds) ? draft.enabledMcpServerIds : [])
    .join(',');
  // What the form-submit handler then parses (mirrors app.js):
  const parsed = String(hiddenInputValue || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  assert.deepEqual(parsed, ['markdown2pdf', 'antv-chart'],
    'submit payload must equal the original whitelist');
});

// ─── Stale revoke path ──────────────────────────────────────────────────────

test('stale (globally-disabled-but-authorised) servers stay in the draft so the chip can revoke', () => {
  // The chip-row decides "this is currently authorised" by asking
  // `whitelist.has(serverId)`, where `whitelist` is built from
  // `draft.enabledMcpServerIds`. If the draft had no entry, the
  // toggle handler would treat a stale chip click as ADD → fall into
  // the "globally disabled" branch → toast "enable in Advanced first"
  // → user can never revoke. Pinning the contract: the draft must
  // surface the prior authorisation regardless of what the global
  // preset flag says.
  const profile = {
    id: 'main',
    name: 'main',
    enabledMcpServerIds: ['antv-chart'], // globally toggled off later
  };
  const draft = agentDraftFromProfile(profile);
  const whitelist = new Set(draft.enabledMcpServerIds);
  assert.equal(whitelist.has('antv-chart'), true,
    'stale authorisation must remain in the whitelist for the revoke click to land');
});

// ─── Other field defaults stay healthy (regression scope check) ─────────────

test('agentDraftFromProfile keeps enabledSkillIds / enabledConnectorIds null when missing', () => {
  // The MCP fix must not accidentally change the connector / skill
  // semantics. Those keep null=no-restriction.
  const draft = agentDraftFromProfile({ id: 'main' });
  assert.equal(draft.enabledSkillIds, null);
  assert.equal(draft.enabledConnectorIds, null);
});

test('agentDraftFromProfile carries name / model / systemPrompt / etc.', () => {
  const draft = agentDraftFromProfile({
    id: 'r',
    name: 'Researcher',
    laneLabel: 'research',
    description: 'desc',
    identity: 'id',
    soulMd: '## soul',
    mood: 'focused',
    model: 'gpt-4.1',
    systemPrompt: 'system',
    voiceReplyMode: 'full',
    edgeTtsVoice: 'zh-CN',
    voicePersonality: 'pers',
    tools: [{ id: 'projects' }, { id: 'artifacts' }],
  });
  assert.equal(draft.name, 'Researcher');
  assert.equal(draft.laneLabel, 'research');
  assert.equal(draft.identity, 'id');
  assert.equal(draft.identify, 'id');
  assert.equal(draft['soul.md'], '## soul');
  assert.equal(draft.mood, 'focused');
  assert.equal(draft.model, 'gpt-4.1');
  assert.equal(draft.systemPrompt, 'system');
  assert.equal(draft.voiceReplyMode, 'full');
  assert.equal(draft.edgeTtsVoice, 'zh-CN');
  assert.equal(draft.voicePersonality, 'pers');
  assert.deepEqual(draft.tools, ['projects', 'artifacts']);
});

test('agentDraftFromProfile gracefully handles null / undefined / empty profile', () => {
  for (const empty of [null, undefined, {}]) {
    const draft = agentDraftFromProfile(empty);
    assert.equal(draft.name, '');
    assert.equal(draft.identity, '');
    assert.deepEqual(draft.enabledMcpServerIds, []);
    assert.deepEqual(draft.tools, []);
    assert.deepEqual(draft.channels, {});
  }
});

// ─── normalizeChannelsForDraft (extracted alongside) ────────────────────────

test('normalizeChannelsForDraft accepts both array and object channel shapes', () => {
  const fromArray = normalizeChannelsForDraft([{ id: 'tg', token: 't' }]);
  const fromObject = normalizeChannelsForDraft({ tg: { id: 'tg', token: 't' } });
  assert.equal(fromArray.tg.token, 't');
  assert.equal(fromObject.tg.token, 't');
});

test('normalizeChannelsForDraft drops malformed entries', () => {
  const out = normalizeChannelsForDraft([
    { id: 'good', token: 'x' },
    { token: 'no-id' },   // missing id field — typeof undefined !== 'string'
    { id: 123 },          // non-string id
    null,
    'not-an-object',
  ]);
  assert.deepEqual(Object.keys(out), ['good']);
});

test('normalizeChannelsForDraft returns {} for null / undefined input', () => {
  assert.deepEqual(normalizeChannelsForDraft(null), {});
  assert.deepEqual(normalizeChannelsForDraft(undefined), {});
});
