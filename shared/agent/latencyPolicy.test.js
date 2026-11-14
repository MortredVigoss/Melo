import test from 'node:test';
import assert from 'node:assert/strict';
import { startGoal, goalCandidate, reviewGoal, amendGoal, goalSnapshot, goalOperation, GOAL_LIMITS } from './goal.js';

// From codex/reply-latency-20261109 (merged 2026-11-14). That branch also judged the claim an answer flags
// as uncertain inside the completion check; master does this with `claimReview`, tested in goalEvidence.test.js.

const observations = [{ id: 'page', type: 'source', ok: true, executed: true, reading: 'extracted', url: 'https://example.com/forecast', text: 'Forecast for Tuesday: high 18 C; chance of rain 20 percent.' }];
const missing = { decision: 'continue', reasonType: 'lookup_missing', nextStep: 'Read Wednesday forecast', requirements: [{ text: 'Wednesday forecast', kind: 'external_fact', status: 'missing', evidenceIds: [] }] };
const first = () => goalCandidate(startGoal('Check weather'), { reply: 'Missing forecast', observations, tools: ['open_url'] });

test('an answer that was sent back and comes in again unchanged gets the same verdict without another check', () => {
  const initial = first();
  assert.equal(initial.phase, 'checking');
  const sentBack = reviewGoal(initial, JSON.stringify(missing), observations);
  assert.equal(sentBack.phase, 'working'); assert.equal(sentBack.corrections, 1);

  const again = goalCandidate(sentBack, { reply: initial.candidate, observations, tools: ['open_url'] });
  assert.equal(again.phase, 'working', 'no check is requested for it');
  assert.equal(again.reviewReused, true);
  assert.equal(again.decision, 'continue');
  assert.equal(again.corrections, 2, 'the reused verdict counts against the correction allowance');
  assert.match(again.feedback, /Read Wednesday forecast/);
  assert.equal(again.corrections, GOAL_LIMITS.corrections, 'this test relies on an allowance of two');

  const third = goalCandidate(again, { reply: initial.candidate, observations, tools: ['open_url'] });
  assert.equal(third.phase, 'finished'); assert.equal(third.decision, 'partial'); assert.equal(third.reason, 'GOAL_CORRECTION_LIMIT');
  assert.equal(goalOperation({ action: 'candidate', state: sentBack, candidate: { reply: initial.candidate, tools: ['open_url'] }, observations }).reviewReused, true, 'the hosts reach it through the same operation');
});

// The iPhone keeps the goal state and the observations in dictionaries, which have no key order: what comes
// back to the core is the same data with its keys in another order, and with null where a value was absent.
// The first version compared the two as text and so never matched on the iPhone.
test('the comparison does not depend on the order of keys a host hands back', () => {
  const shuffled = value => Array.isArray(value) ? value.map(shuffled)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, shuffled(value[key])]))
    : value;
  const context = { messages: [{ role: 'user', content: 'Check weather' }], capabilities: ['open_url'], skills: [{ id: 's', name: 'Skill', goalTemplate: '' }] };
  const initial = goalCandidate(startGoal('Check weather'), { reply: 'Missing forecast', observations, tools: ['open_url'], context });
  const sentBack = reviewGoal(shuffled(initial), JSON.stringify(missing), shuffled(observations));
  assert.equal(sentBack.corrections, 1);
  const again = goalCandidate({ ...shuffled(sentBack), evaluation: null }, { reply: 'Missing forecast', observations: shuffled(shuffled(observations)), tools: ['open_url'], context: shuffled(context) });
  assert.equal(again.reviewReused, true);
  assert.equal(again.corrections, 2);
  // A different list of observations is another input.
  assert.equal(goalCandidate(sentBack, { reply: 'Missing forecast', observations: [...observations, { ...observations[0], id: 'b' }].reverse(), tools: ['open_url'], context }).phase, 'checking');
});

test('anything the check reads that changed sends the answer to a real check again', () => {
  const initial = first();
  const sentBack = reviewGoal(initial, JSON.stringify(missing), observations);
  const same = { reply: initial.candidate, observations, tools: ['open_url'] };
  const changes = {
    answer: { reply: 'Honest updated limitation' },
    observations: { observations: [...observations, { ...observations[0], id: 'new' }] },
    tools: { tools: ['open_url', 'file_read'] },
    conversation: { context: { messages: [{ role: 'user', content: 'Updated context' }] } },
    research: { research: true },
    'flagged claim': { uncertainClaim: 'chance of rain 20 percent' },
  };
  for (const [name, change] of Object.entries(changes)) {
    const next = goalCandidate(sentBack, { ...same, ...change });
    assert.equal(next.phase, 'checking', name);
    assert.equal(next.reviewReused, undefined, name);
    assert.equal(next.corrections, 1, name);
  }
  assert.equal(goalCandidate(amendGoal(sentBack, 'Wednesday instead'), same).phase, 'checking', 'an amended goal');
  // A check input above the size that is compared in full is checked again.
  const large = [{ ...observations[0], text: 'x'.repeat(130000) }];
  const big = reviewGoal(goalCandidate(startGoal('Check weather'), { reply: 'Missing forecast', observations: large, tools: ['open_url'] }), JSON.stringify(missing), large);
  assert.equal(big.sentBack, undefined);
  assert.equal(goalCandidate(big, { reply: 'Missing forecast', observations: large, tools: ['open_url'] }).phase, 'checking');
});

test('only a verdict that sent the answer back is kept, and none of it is saved with the receipt', () => {
  const initial = first();
  const passed = reviewGoal(initial, JSON.stringify({ decision: 'complete', reasonType: 'fulfilled', requirements: [{ text: 'forecast', kind: 'external_fact', status: 'met', evidenceIds: ['page'] }] }), observations);
  assert.equal(passed.decision, 'complete'); assert.equal(passed.sentBack, undefined);
  assert.equal(goalCandidate(passed, { reply: initial.candidate, observations, tools: ['open_url'] }).phase, 'checking', 'a passed answer is never passed again from memory');

  const sentBack = reviewGoal(initial, JSON.stringify({ ...missing, extra: 'x'.repeat(5000) }), observations);
  assert.equal(sentBack.sentBack.verdict.includes('extra'), false, 'only the fields of a verdict are kept');
  const again = goalCandidate(sentBack, { reply: initial.candidate, observations, tools: ['open_url'] });
  for (const state of [sentBack, again]) {
    const saved = JSON.stringify(goalSnapshot(state));
    assert.equal(saved.includes('sentBack'), false); assert.equal(saved.includes('reviewReused'), false);
  }
  // The next answer starts clean: the mark of a reused verdict does not stay on the state.
  assert.equal(goalCandidate(again, { reply: 'A different answer', observations, tools: ['open_url'] }).reviewReused, undefined);
});

test('explaining a search algorithm is checked as an answer and needs no executed lookup', () => {
  const state = goalCandidate(startGoal('用三句话解释二分查找。'), { reply: '有序列表。比较中点。每次减半。', research: true, tools: ['open_url'] });
  assert.equal(state.phase, 'checking'); assert.equal(state.evidenceRequired, false);
  const reviewed = reviewGoal(state, JSON.stringify({ decision: 'complete', reasonType: 'self_contained', turnKind: 'answer', requirements: [{ text: '解释', kind: 'response', status: 'met', evidenceIds: [] }] }));
  assert.equal(reviewed.decision, 'deliver');
  assert.equal(goalCandidate(startGoal('Explain how binary search works.'), { reply: 'Halve the range each step.', research: true, tools: ['open_url'] }).evidenceRequired, false);
  for (const goal of ['查一下明天天气', '请查找今天墨尔本活动', '帮我查找附近的咖啡店', 'Search current weather', 'please search the opening hours']) {
    assert.equal(goalCandidate(startGoal(goal), { reply: 'Sunny', research: true, tools: ['open_url'] }).evidenceRequired, true, goal);
  }
});
