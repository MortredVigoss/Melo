import test from 'node:test';
import assert from 'node:assert/strict';
import { startGoal, goalCandidate, reviewGoal, goalReviewRequest, goalVerification, amendGoal, goalSnapshot } from './goal.js';

const observations = [{ id: 'page', type: 'source', ok: true, executed: true, reading: 'extracted', url: 'https://example.com/forecast', text: 'Forecast for Tuesday: high 18 C; chance of rain 20 percent.' }];
const candidate = 'Tuesday: 18 C. [UNCERTAIN: chance of rain 20 percent]';
const report = { decision: 'complete', reasonType: 'fulfilled', requirements: [{ text: 'forecast', kind: 'external_fact', status: 'met', evidenceIds: ['page'] }], uncertainty: { claim: 'chance of rain 20 percent', verdict: 'VERIFIED', evidenceId: 'page', evidenceQuote: 'chance of rain 20 percent' } };
test('combined uncertainty verification requires the exact reviewed claim, quote, evidence and revision', () => {
  const state = goalCandidate(startGoal('Check the Tuesday forecast'), { reply: candidate, observations, tools: ['open_url'] });
  assert.equal(JSON.parse(goalReviewRequest(state, observations).messages[0].content).uncertaintyClaim, report.uncertainty.claim);
  const reviewed = reviewGoal(state, JSON.stringify(report), observations);
  assert.equal(goalVerification(reviewed, candidate)?.verdict, 'VERIFIED');
  assert.equal(goalVerification(reviewed, candidate + ' sunny'), null);
  assert.equal(goalVerification(amendGoal(reviewed, 'Wednesday instead'), candidate), null);
  assert.equal(JSON.stringify(goalSnapshot(reviewed)).includes('uncertaintyVerified'), false);
  for (const uncertainty of [undefined, { ...report.uncertainty, claim: 'different' }, { ...report.uncertainty, evidenceId: 'invented' }, { ...report.uncertainty, evidenceQuote: 'sunny' }, { ...report.uncertainty, verdict: 'UNVERIFIED' }]) {
    assert.equal(goalVerification(reviewGoal(state, JSON.stringify({ ...report, uncertainty }), observations), candidate), null);
  }
  assert.equal(goalVerification(reviewGoal(state, JSON.stringify({ ...report, requirements: [] }), observations), candidate), null);
});
test('identical rejected input reuses a checked rejection within the original correction limit; changed input is checked again', () => {
  const initial = goalCandidate(startGoal('Check weather'), { reply: 'Missing forecast', observations, tools: ['open_url'] });
  const missing = { decision: 'continue', reasonType: 'lookup_missing', repair: 'evidence', nextStep: 'Read Wednesday forecast', requirements: [{ text: 'Wednesday forecast', kind: 'external_fact', status: 'missing', evidenceIds: [] }] };
  const repair = reviewGoal(initial, JSON.stringify(missing), observations);
  const repeat = goalCandidate(repair, { reply: initial.candidate, observations, tools: ['open_url'] });
  assert.equal(repeat.phase, 'working'); assert.equal(repeat.reviewReused, true); assert.equal(repeat.corrections, 2);
  const stopped = goalCandidate(repeat, { reply: initial.candidate, observations, tools: ['open_url'] });
  assert.equal(stopped.decision, 'partial'); assert.equal(stopped.reason, 'GOAL_CORRECTION_LIMIT');
  assert.equal(goalVerification(stopped, initial.candidate), null);
  for (const change of [{reply:'Honest updated limitation'}, {observations:[...observations,{...observations[0],id:'new'}]}, {tools:['open_url','file_read']}, {context:{messages:[{role:'user',content:'Updated context'}]}}]) {
    assert.equal(goalCandidate(repair, {reply:initial.candidate,observations,tools:['open_url'],...change}).phase, 'checking');
  }
  assert.equal(goalCandidate(amendGoal(repair,'Wednesday instead'),{reply:initial.candidate,observations,tools:['open_url']}).phase,'checking');
  assert.equal(JSON.stringify(goalSnapshot(repair)).includes('repairReview'),false);
});
test('explaining a search algorithm still runs semantic review but does not require a real-world search receipt', () => {
  const state = goalCandidate(startGoal('用三句话解释二分查找。'), { reply: '有序列表。比较中点。每次减半。', research: true, tools: ['open_url'] });
  assert.equal(state.phase, 'checking'); assert.equal(state.evidenceRequired, false);
  const reviewed = reviewGoal(state, JSON.stringify({ decision: 'complete', reasonType: 'self_contained', turnKind: 'answer', requirements: [{ text: '解释', kind: 'response', status: 'met', evidenceIds: [] }] }));
  assert.equal(reviewed.decision, 'deliver');
  for (const goal of ['查一下明天天气', '请查找今天墨尔本活动', 'Search current weather']) {
    assert.equal(goalCandidate(startGoal(goal), { reply: 'Sunny', research: true, tools: ['open_url'] }).evidenceRequired, true);
  }
});
