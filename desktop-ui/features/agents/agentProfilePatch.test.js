import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentProfilePatch, unsavedCapabilityEdits } from './agentProfilePatch.js';

// An Agent whose old permissions are not migrated saves its capability,
// collaboration and context settings only with the migration confirmation
// ticked. Without the tick those edits were left out of the save and nothing
// said so (settings audit 2026-11-10).
const form = { elements: { namedItem: () => null } };
const legacy = (confirmed = false) => {
  const data = new FormData();
  data.set('capabilityVersion', '1'); data.set('capabilityMigrationExpected', 'fingerprint'); data.set('name', 'Research');
  data.set('maxIterations', '9'); data.set('context_memory', 'on');
  if (confirmed) data.set('confirmCapabilityMigration', 'on');
  return data;
};

test('edits to an unmigrated Agent\'s capability section are reported when the save leaves them out', () => {
  const unconfirmed = legacy();
  const patch = buildAgentProfilePatch(form, unconfirmed);
  assert.equal(patch.name, 'Research');
  assert.equal('collaboration' in patch || 'capabilities' in patch || 'contextSources' in patch, false, 'the section is not part of this save');
  for (const key of ['maxIterations', 'maxTokens', 'timeoutMs', 'maxDelegationDepth', 'maxTaskIterations', 'delegateTargets', 'cap_network', 'context_memory', 'jobModel_research']) {
    assert.equal(unsavedCapabilityEdits(form, unconfirmed, { name: 'Research', [key]: '9' }), true, key);
  }
  // Nothing in that section was edited: the save lost nothing, so nothing is reported.
  assert.equal(unsavedCapabilityEdits(form, unconfirmed, { name: 'Research', instructions: 'x', replyLanguage: 'ja', capabilities: null, collaboration: {} }), false);
  assert.equal(unsavedCapabilityEdits(form, unconfirmed, null), false);
});

test('a confirmed migration and a migrated Agent save the section, so nothing is reported', () => {
  const confirmed = legacy(true);
  assert.equal(buildAgentProfilePatch(form, confirmed).collaboration.maxIterations, 9);
  assert.equal(unsavedCapabilityEdits(form, confirmed, { maxIterations: '9' }), false);
  const migrated = new FormData(); migrated.set('capabilityVersion', '1'); migrated.set('maxIterations', '9');
  assert.equal(buildAgentProfilePatch(form, migrated).collaboration.maxIterations, 9);
  assert.equal(unsavedCapabilityEdits(form, migrated, { maxIterations: '9' }), false);
  // A form without the capability section at all (a narrow form) is never reported.
  const narrow = new FormData(); narrow.set('name', 'x');
  assert.equal(unsavedCapabilityEdits(form, narrow, { maxIterations: '9' }), false);
});
