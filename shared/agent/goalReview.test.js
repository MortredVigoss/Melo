// Review 2026-11-07: the delivery check as the task space shows it. A task
// without a contract (a single fact) has no evaluation ledger; the check's
// requirements and cited evidence are its only structured approval record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { evaluate } from './index.js';
import { startGoal, goalCandidate, reviewGoal, goalOperation, GOAL_LIMITS } from './goal.js';
import { completionObservation } from './completion.js';
import { executionScene } from './execution.js';
import { GOAL_REVIEW_LIMITS, normalizeGoalReview, goalReviewOf, goalReviewTally } from './goalReview.js';

const goal = '悉尼明天天气怎么样';
const weather = completionObservation({ id: 'job-1:forecast', name: 'open_url', ok: true, executed: true, output: JSON.stringify({ url: 'https://fixture.invalid/sydney', text: 'Sydney tomorrow: 24 C, light showers in the afternoon.' }) });
const candidate = (state = startGoal(goal)) => goalCandidate(state, { reply: '明天悉尼 24 度，午后有小阵雨。', observations: weather, tools: ['route_task'], research: true, roundsLeft: 6 });
const report = (decision, requirements) => JSON.stringify({ decision, reasonType: decision === 'complete' ? 'fulfilled' : 'lookup_missing', reason: decision === 'complete' ? '预报已读到' : '缺少降雨时段', nextStep: '再读一次逐小时预报', requirements });

test('a passed check is shown with each requirement, its kind, status and cited evidence', () => {
  const checked = reviewGoal(candidate(), report('complete', [
    { text: '明天的气温', kind: 'external_fact', status: 'met', evidenceIds: ['job-1:forecast'] },
    { text: '明天是否下雨', kind: 'external_fact', status: 'met', evidenceIds: ['job-1:forecast'] },
    { text: '用中文简短回答', kind: 'response', status: 'met', evidenceIds: [] },
  ]), weather);
  assert.equal(checked.decision, 'complete');
  const review = goalReviewOf(checked, GOAL_LIMITS.corrections);
  assert.deepEqual(review, { v: 1, decision: 'complete', reason: 'GOAL_DELIVERY_SUPPORTED', corrections: 0, correctionLimit: GOAL_LIMITS.corrections, explanation: '预报已读到',
    requirements: [
      { text: '明天的气温', kind: 'external_fact', status: 'met', evidenceIds: ['job-1:forecast'] },
      { text: '明天是否下雨', kind: 'external_fact', status: 'met', evidenceIds: ['job-1:forecast'] },
      { text: '用中文简短回答', kind: 'response', status: 'met', evidenceIds: [] },
    ], omitted: 0 });
  assert.deepEqual(goalReviewTally(review), { total: 3, met: 3, missing: 0, unavailable: 0, evidence: 1, passed: true });
  assert.deepEqual(normalizeGoalReview(JSON.parse(JSON.stringify(review))), review, 'a valid review survives JSON and normalization unchanged');
});

test('a failed check keeps the missing requirement, so the gate shows why the answer was not approved', () => {
  const checked = reviewGoal(candidate(), report('continue', [
    { text: '明天的气温', kind: 'external_fact', status: 'met', evidenceIds: ['job-1:forecast'] },
    { text: '下雨的具体时段', kind: 'external_fact', status: 'missing', evidenceIds: [] },
  ]), weather);
  assert.equal(checked.decision, 'continue');
  const review = goalOperation({ action: 'reviewSnapshot', state: checked });
  assert.equal(review.decision, 'continue'); assert.equal(review.reason, 'GOAL_INCOMPLETE'); assert.equal(review.corrections, 1);
  assert.deepEqual(review.requirements.map(row => row.status), ['met', 'missing']);
  assert.deepEqual(goalReviewTally(review), { total: 2, met: 1, missing: 1, unavailable: 0, evidence: 1, passed: false });
});

test('reviewSnapshot is read-only, empty before any check, and matches the packaged phone core', () => {
  assert.equal(goalOperation({ action: 'reviewSnapshot', state: startGoal(goal) }), null, 'no check yet: nothing to show');
  const checked = reviewGoal(candidate(), report('complete', [{ text: '明天的气温', kind: 'external_fact', status: 'met', evidenceIds: ['job-1:forecast'] }]), weather);
  const before = JSON.stringify(checked);
  const review = goalOperation({ action: 'reviewSnapshot', state: checked });
  assert.equal(JSON.stringify(checked), before, 'the goal state is unchanged');
  const node = evaluate({ version: 1, op: 'goal', action: 'reviewSnapshot', state: checked });
  assert.equal(node.ok, true); assert.deepEqual(node.value, review);
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(readFileSync(new URL('./dist/agent-core.js', import.meta.url), 'utf8'), context);
  context.input = JSON.stringify({ version: 1, op: 'goal', action: 'reviewSnapshot', state: checked });
  assert.deepEqual(JSON.parse(vm.runInContext('MeloAgent.evaluate(input)', context)).value, review, 'Node and packaged phone core must match');
});

test('the normalizer bounds every field and turns malformed records into null without throwing', () => {
  const L = GOAL_REVIEW_LIMITS;
  const many = Array.from({ length: L.requirements + 3 }, (_, i) => ({ text: `要求 ${i} ` + 'x'.repeat(400), kind: i === 0 ? 'invented' : 'context', status: i === 0 ? 'done' : 'met',
    evidenceIds: Array.from({ length: L.evidence + 4 }, (_, j) => `id-${j}-` + 'y'.repeat(200)) }));
  const review = normalizeGoalReview({ v: 1, decision: 'partial', reason: 'not a code', corrections: 5, correctionLimit: 2, explanation: 'z'.repeat(1000), requirements: [...many, null, 'text', { text: '   ' }] });
  assert.equal(review.requirements.length, L.requirements);
  assert.equal(review.omitted, 3 + 3, 'rows beyond the limit are counted, not shown');
  assert.equal(review.requirements[0].kind, 'external_fact'); assert.equal(review.requirements[0].status, 'missing', 'unknown values never read as met');
  assert.ok(review.requirements.every(row => row.text.length <= L.text && row.evidenceIds.length === L.evidence && row.evidenceIds.every(id => id.length <= L.id)));
  assert.equal(review.reason, ''); assert.equal(review.explanation.length, L.explanation);
  for (const raw of [null, [], 'x', { v: 2, decision: 'complete' }, { v: 1, decision: 'approved' }, { v: 1, decision: 'complete', requirements: 'none' }]) {
    const value = normalizeGoalReview(raw);
    assert.ok(value === null || value.requirements.length === 0, JSON.stringify(raw));
  }
  const trap = { v: 1, decision: 'complete', get requirements() { throw new Error('getter trap'); } };
  assert.doesNotThrow(() => normalizeGoalReview(trap));
  assert.equal(normalizeGoalReview(trap), null);
});

test('the portable scene reducer keeps a normalized review on pipeline stages only', () => {
  const review = { v: 1, decision: 'complete', reason: 'GOAL_DELIVERY_SUPPORTED', requirements: [{ text: '明天的气温', kind: 'external_fact', status: 'met', evidenceIds: ['job-1:forecast'] }] };
  let scene = executionScene({ action: 'create', runId: 'r', chatId: 'c', query: 'q', at: 't0' });
  scene = executionScene({ action: 'event', scene, at: 't1', event: { id: 'goal-check:3', name: '核对任务交付', kind: 'pipeline', status: 'completed', output: '预报已读到', goalReview: review } });
  scene = executionScene({ action: 'event', scene, at: 't2', event: { id: 'job-1:forecast', name: 'open_url', kind: 'operation', status: 'completed', goalReview: review } });
  assert.deepEqual(scene.pipeline.find(row => row.id === 'goal-check:3').goalReview, normalizeGoalReview(review));
  assert.equal(scene.operations[0].goalReview, undefined, 'operations never carry a review');
  scene = executionScene({ action: 'event', scene, at: 't3', event: { id: 'goal-check:4', name: '核对任务交付', kind: 'pipeline', status: 'failed', goalReview: { v: 1, decision: 'approved' } } });
  assert.equal(scene.pipeline.find(row => row.id === 'goal-check:4').goalReview, undefined, 'a malformed review is dropped, the stage stays');
});
