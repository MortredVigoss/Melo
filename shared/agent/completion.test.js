import test from 'node:test';
import assert from 'node:assert/strict';
import { completionReceipt as receipt, completionSummary } from './completion.js';
const goal = 'Research Sydney brunch';
const source = { id: 'read-1', type: 'source', executed: true, ok: true, url: 'https://fixture.invalid/menu', reading: 'extracted', text: 'Sydney brunch menu with breakfast dishes and observed opening hours for this fixture.' };
const input = { goal, kind: 'research', reply: 'Sydney brunch: https://fixture.invalid/menu', observations: [source] };
test('ordinary answers complete without tools; a missing answer never does', () => {
  assert.equal(receipt({ reply: 'Hello' }).outcome, 'completed');
  assert.equal(receipt({ reply: 'Hello' }).goalState, 'not_applicable');
  assert.equal(receipt({ reply: '' }).outcome, 'blocked');
});
test('tool success, irrelevant queries, snippets and invented citations do not certify research', () => {
  for (const changed of [{ type: 'effect' }, { reading: 'snippet' }, { reading: 'unknown' }, { executed: false }, { ok: false },
    { text: 'Unrelated astronomy observations about distant stars and galaxies.', query: goal, title: goal }, { text: '' }]) {
    assert.notEqual(receipt({ ...input, observations: [{ ...source, ...changed }] }).outcome, 'completed', JSON.stringify(changed));
  }
  assert.equal(receipt({ ...input, reply: 'See https://invented.invalid/menu' }).reason, 'RELEVANT_READ_SOURCE_MISSING');
  assert.equal(receipt({ ...input, observations: [] }).outcome, 'blocked');
});
test('actual relevant read and citation support delivery without claiming factual verification', () => {
  const result = receipt(input);
  assert.equal(result.outcome, 'completed'); assert.equal(result.goalState, 'supported');
  assert.deepEqual(result.evidenceIds, ['read-1']);
  assert.equal(JSON.stringify(result).includes(source.text), false, 'page bodies are not persisted in the receipt');
  assert.match(completionSummary(result), /not independently verified/);
});
test('explicit page requests require that page, not another successful fetch', () => {
  assert.equal(receipt({ ...input, goal: 'Read https://fixture.invalid/menu' }).outcome, 'completed');
  assert.notEqual(receipt({ ...input, goal: 'Read https://other.invalid/menu' }).outcome, 'completed');
});
test('successful writes and model-authored achieved claims remain unverified', () => {
  const result = receipt({ kind: 'action', goal: 'Create the requested file', reply: 'Done, achieved.', observations: [{ id: 'write-1', type: 'effect', ok: true, executed: true, achieved: true }] });
  assert.equal(result.outcome, 'partial'); assert.equal(result.goalState, 'unverified');
});
test('only a host-verified matching goal closes an action task', () => {
  const action = { type: 'device-visible-facts', checked: true, goal: 'Open Settings', evidenceId: 'screen-check-1' };
  const params = { kind: 'action', goal: action.goal, reply: 'Settings visible', verifiedActions: [action] };
  assert.equal(receipt(params).goalState, 'verified');
  assert.equal(receipt({ ...params, goal: 'Open Calendar' }).outcome, 'blocked');
  assert.equal(receipt({ ...params, verifiedActions: [{ ...action, checked: false }] }).outcome, 'blocked');
});
test('cancellation and budget exhaustion are distinct from successful delivery', () => {
  assert.equal(receipt({ ...input, terminalReason: 'CANCELLED' }).outcome, 'cancelled');
  for (const terminalReason of ['BUDGET_EXHAUSTED', 'DEADLINE_EXCEEDED', 'ROUND_LIMIT']) assert.equal(receipt({ ...input, terminalReason }).outcome, 'budget_exhausted');
  assert.equal(receipt({ ...input, terminalReason: 'NO_PROGRESS' }).outcome, 'partial');
  assert.equal(receipt({ ...input, observations: [], terminalReason: 'NO_PROGRESS' }).outcome, 'blocked');
});
