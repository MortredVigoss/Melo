// Plan C (2026-11-05): the task-space evaluation snapshot and its normalizer.
// Every B fixture runs through the snapshot so the scene can never show a tier,
// threshold or field state the ledger itself would not support.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { evaluate } from './index.js';
import { TASK_EVALUATION_POLICY, EVALUATION_SNAPSHOT_LIMITS, updateTaskEvaluation, taskEvaluationSummary, taskEvaluationSnapshot, normalizeEvaluationSnapshot } from './taskEvaluation.js';
import { startGoal, goalOperation } from './goal.js';
import { executionScene } from './execution.js';
import { INTERNAL_JOB_ROLES, INTERNAL_JOB_LABELS } from './internalRouting.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/task-evaluation.json', import.meta.url)));
const finalState = fixture => fixture.steps.reduce((state, step) => updateTaskEvaluation(state, step.args, step.context), undefined);
const p = TASK_EVALUATION_POLICY;

for (const fixture of fixtures) test('snapshot mirrors the ledger: ' + fixture.name, () => {
  const state = finalState(fixture), snapshot = taskEvaluationSnapshot(state), summary = taskEvaluationSummary(state);
  assert.deepEqual(taskEvaluationSnapshot(structuredClone(state)), snapshot, 'deterministic');
  assert.deepEqual(normalizeEvaluationSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot, 'a valid snapshot survives JSON and normalization unchanged');
  assert.equal(snapshot.policy.primaryScore, p.primaryScore); assert.equal(snapshot.policy.alternativeScore, p.alternativeScore); assert.equal(snapshot.policy.evidenceScore, p.evidenceScore);
  if (!summary) { assert.equal(snapshot.summary, null); assert.equal(snapshot.contract, null); return; }
  const byTier = tier => snapshot.candidates.filter(row => row.tier === tier).map(row => row.key);
  assert.deepEqual(byTier('primary').sort(), summary.primary.slice().sort(), 'primary tier is exactly the ledger primary list');
  assert.deepEqual(byTier('alternative').sort(), summary.alternativeKeys.slice().sort(), 'alternative tier is exactly the ledger alternatives');
  for (const row of snapshot.candidates) {
    const source = state.items.find(item => item.key === row.key);
    if (['primary', 'alternative', 'eligible'].includes(row.tier)) {
      assert.equal(source.eligible, true, row.key + ' shown as qualified');
      assert.ok(Object.values(row.fields).every(value => value === 'verified'), row.key + ' qualified rows have every required field verified');
    } else assert.notEqual(source.eligible, true, row.key + ' unqualified rows never get a qualified tier');
    if (row.tier === 'primary') assert.ok(row.total >= p.primaryScore && row.evidence >= p.evidenceScore);
    for (const [name, value] of Object.entries(row.fields)) if (value === 'verified' || value === 'failed') assert.equal(source.fields[name]?.verified, true, `${row.key}.${name} needs a cited value`);
    if (source.failed.length) assert.notEqual(row.tier, 'primary');
  }
  assert.equal(snapshot.summary.verified, summary.verified); assert.equal(snapshot.summary.stop, summary.stop);
  assert.deepEqual(snapshot.contract.requiredFields, state.contract.requiredFields.slice(0, EVALUATION_SNAPSHOT_LIMITS.fields));
});

test('hard-gate failures are visible per field and never ranked as recommendations', () => {
  const paid = taskEvaluationSnapshot(finalState(fixtures.find(f => f.name === 'events: paid event fails free constraint')));
  assert.ok(paid.candidates.some(row => Object.values(row.fields).includes('failed') && row.tier === 'excluded'), JSON.stringify(paid.candidates));
  const high = taskEvaluationSnapshot(finalState(fixtures.find(f => f.name === 'mixed: high scores never cover missing field')));
  assert.ok(high.candidates.every(row => row.tier === 'pending' || row.tier === 'excluded' ? true : Object.values(row.fields).every(v => v === 'verified')));
  assert.ok(high.candidates.some(row => Object.values(row.fields).includes('missing') && row.tier === 'pending'));
});

test('snapshot is bounded: candidates, strings and omitted count', () => {
  const contract = { action: 'contract', data: JSON.stringify({ category: 'other', unit: 'u'.repeat(300), coverage: [] }) };
  let state = updateTaskEvaluation(undefined, contract, { goal: 'find things', revision: 1, observations: [] });
  state = { ...state, items: Array.from({ length: 40 }, (_, i) => ({ key: 'k' + String(i).padStart(2, '0') + 'x'.repeat(200), fields: { name: { value: 'N'.repeat(500), evidence: [], verified: false } },
    match: 10, diversity: 1, reason: 'r'.repeat(900), tags: Array(30).fill('tag'.repeat(30)), conflicts: [], excludeReason: '', missing: ['name'], failed: [], eligible: false, status: 'discovered', score: { total: 11, evidence: 0, match: 10, diversity: 1 } })) };
  const snapshot = taskEvaluationSnapshot(state);
  assert.equal(snapshot.candidates.length, EVALUATION_SNAPSHOT_LIMITS.candidates);
  assert.equal(snapshot.summary.omitted, 40 - EVALUATION_SNAPSHOT_LIMITS.candidates);
  assert.ok(snapshot.candidates.every(row => row.key.length <= 80 && row.name.length <= 80 && row.reason.length <= 120 && row.tags.length <= 4 && row.tags.every(tag => tag.length <= 24)));
  assert.ok(snapshot.contract.unit.length <= 40);
  assert.ok(JSON.stringify(snapshot).length < 16000, 'stays small enough for every SSE update');
});

test('snapshot totals stay exact past its row caps: excluded candidates and gaps', () => {
  // The rows a snapshot carries are capped; the numbers shown from it must not
  // be. Excluded rows sort last, so they are the first to fall past the cap.
  const contract = { action: 'contract', data: JSON.stringify({ category: 'other', unit: 'u', coverage: Array.from({ length: 9 }, (_, i) => 'tag' + i) }) };
  let state = updateTaskEvaluation(undefined, contract, { goal: 'find things', revision: 1, observations: [] });
  const row = (i, status) => ({ key: 'k' + String(i).padStart(2, '0'), fields: { name: { value: 'N' + i, evidence: [], verified: false } }, match: 10, diversity: 1, reason: '', tags: [], conflicts: [],
    excludeReason: status === 'excluded' ? 'out of range' : '', missing: ['name'], failed: [], eligible: false, status, score: { total: 11, evidence: 0, match: 10, diversity: 1 } });
  state = { ...state, items: [...Array.from({ length: 30 }, (_, i) => row(i, 'discovered')), ...Array.from({ length: 10 }, (_, i) => row(30 + i, 'excluded'))] };
  const snapshot = taskEvaluationSnapshot(state), summary = taskEvaluationSummary(state);
  assert.equal(snapshot.candidates.length, EVALUATION_SNAPSHOT_LIMITS.candidates);
  assert.equal(snapshot.candidates.filter(r => r.tier === 'excluded').length, 0, 'every excluded row fell past the cap');
  assert.equal(snapshot.summary.excluded, 10, 'the total still counts them');
  assert.ok(summary.gaps.length > EVALUATION_SNAPSHOT_LIMITS.gaps, 'nine uncovered tags make more gaps than the list carries');
  assert.equal(snapshot.summary.gaps.length, EVALUATION_SNAPSHOT_LIMITS.gaps);
  assert.equal(snapshot.summary.gapCount, summary.gaps.length);
  assert.deepEqual(normalizeEvaluationSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
  const older = structuredClone(snapshot); delete older.summary.excluded; delete older.summary.gapCount;
  assert.deepEqual(normalizeEvaluationSnapshot(older), older, 'a record from before these totals stays without them');
});

test('two long candidate keys sharing a prefix stay two candidates, and older colliding records are told apart', () => {
  const contract = { action: 'contract', data: JSON.stringify({ category: 'other', unit: 'u', coverage: [] }) };
  let state = updateTaskEvaluation(undefined, contract, { goal: 'find things', revision: 1, observations: [] });
  const prefix = 'https://example.org/events/' + 'melbourne-weekend-outdoor-music-'.repeat(4);
  const row = suffix => ({ key: prefix + suffix, fields: { name: { value: 'Same display name', evidence: [], verified: false } }, match: 10, diversity: 1, reason: '', tags: [], conflicts: [], excludeReason: '', missing: ['name'], failed: [], eligible: false, status: 'discovered', score: { total: 11, evidence: 0, match: 10, diversity: 1 } });
  state = { ...state, items: [row('saturday'), row('sunday'), { ...row(''), key: 'short-key' }] };
  const snapshot = taskEvaluationSnapshot(state), keys = snapshot.candidates.map(r => r.key);
  assert.equal(new Set(keys).size, 3, 'no two candidates share an identity');
  assert.ok(keys.every(key => key.length <= 80));
  assert.ok(keys.includes('short-key'), 'a key that fits is kept as it is');
  assert.deepEqual(taskEvaluationSnapshot(structuredClone(state)).candidates.map(r => r.key), keys, 'the same key always maps to the same identity');
  assert.deepEqual(normalizeEvaluationSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot, 'unique keys survive normalization unchanged');
  // An older record cut both keys to the same 80 characters: the normalizer keeps both rows, apart.
  const older = structuredClone(snapshot); older.candidates[0].key = older.candidates[1].key = prefix.slice(0, 80);
  const repaired = normalizeEvaluationSnapshot(older).candidates.map(r => r.key);
  assert.equal(repaired.length, 3); assert.equal(new Set(repaired).size, 3); assert.ok(repaired.every(key => key.length <= 80));
});

test('normalizer drops hostile or malformed input without throwing', () => {
  for (const bad of [null, undefined, 1, 'x', [], {}, { v: 2 }, { v: '1' }]) assert.equal(normalizeEvaluationSnapshot(bad), null);
  const hostile = normalizeEvaluationSnapshot({ v: 1, update: 1e12, policy: { primaryScore: 9999, alternativeScore: -5, evidenceScore: 'x' },
    contract: { category: 'weapons', mode: 'turbo', requiredFields: ['name', 'startsAt', ...Array(40).fill('f')], constraints: Array(50).fill({ field: 'a', op: 'drop', value: { nested: true }, quote: 'q'.repeat(500) }), coverage: [{ tag: 'a', covered: 'yes' }, 'raw', null] },
    summary: { discovered: -3, stop: 'launch', gaps: Array(50).fill('g'.repeat(900)), excluded: 1e12, gapCount: 'many' },
    candidates: [...Array(500).fill({ key: 'k', tier: 'god', status: 'won', total: 1e9, fields: { name: 'exploded', startsAt: 'verified' } }), null, 'x'], resource: { elapsedMs: -1 } });
  assert.equal(hostile.update, 1000); assert.equal(hostile.policy.primaryScore, 100); assert.equal(hostile.policy.alternativeScore, 0); assert.equal(hostile.policy.evidenceScore, p.evidenceScore);
  assert.equal(hostile.contract.category, 'other'); assert.equal(hostile.contract.mode, 'standard'); assert.equal(hostile.contract.requiredFields.length, EVALUATION_SNAPSHOT_LIMITS.fields);
  assert.equal(hostile.contract.constraints.length, EVALUATION_SNAPSHOT_LIMITS.constraints); assert.ok(hostile.contract.constraints.every(rule => rule.op === 'eq' && rule.value === '' && rule.quote.length <= 80));
  assert.deepEqual(hostile.contract.coverage, [{ tag: 'a', covered: false }]);
  assert.equal(hostile.summary.discovered, 0); assert.equal(hostile.summary.stop, 'continue'); assert.equal(hostile.summary.gaps.length, EVALUATION_SNAPSHOT_LIMITS.gaps);
  assert.equal(hostile.summary.excluded, p.maxCandidates); assert.equal(hostile.summary.gapCount, 0);
  assert.equal(hostile.candidates.length, EVALUATION_SNAPSHOT_LIMITS.candidates);
  assert.ok(hostile.candidates.every(row => row.tier === 'pending' && row.status === 'discovered' && row.total === 100 && row.fields.name === 'missing' && row.fields.startsAt === 'verified'));
  assert.equal(hostile.resource.elapsedMs, 0);
  const trap = { v: 1, get contract() { throw new Error('getter trap'); } };
  assert.equal(normalizeEvaluationSnapshot(trap), null);
});

test('progressSnapshot is read-only and matches the packaged phone core', () => {
  const fixture = fixtures.find(f => f.name === 'events: qualified public events');
  const goal = { ...startGoal(fixture.steps[0].context.goal), evaluation: finalState(fixture) };
  const before = JSON.stringify(goal);
  const snapshot = goalOperation({ action: 'progressSnapshot', state: goal });
  assert.equal(JSON.stringify(goal), before);
  assert.deepEqual(snapshot, taskEvaluationSnapshot(goal.evaluation));
  const node = evaluate({ version: 1, op: 'goal', action: 'progressSnapshot', state: goal });
  assert.equal(node.ok, true); assert.deepEqual(node.value, snapshot);
  const viaEvaluation = evaluate({ version: 1, op: 'taskEvaluation', action: 'snapshot', state: goal.evaluation });
  assert.deepEqual(viaEvaluation.value, snapshot);
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(readFileSync(new URL('./dist/agent-core.js', import.meta.url), 'utf8'), context);
  context.input = JSON.stringify({ version: 1, op: 'goal', action: 'progressSnapshot', state: goal });
  assert.deepEqual(JSON.parse(vm.runInContext('MeloAgent.evaluate(input)', context)).value, snapshot, 'Node and packaged phone core must match');
});

test('portable scene reducer keeps role, round limit and a normalized snapshot on pipeline stages only', () => {
  const fixture = fixtures.find(f => f.name === 'events: qualified public events');
  const snapshot = taskEvaluationSnapshot(finalState(fixture));
  let scene = executionScene({ action: 'create', runId: 'r', chatId: 'c', query: 'q', at: 't0' });
  scene = executionScene({ action: 'event', scene, at: 't1', event: { id: 'internal:1', name: '检索成员', kind: 'pipeline', status: 'running', role: 'research', limits: { rounds: 4 } } });
  scene = executionScene({ action: 'event', scene, at: 't2', event: { id: 'internal:2', name: 'x', kind: 'pipeline', status: 'running', role: 'admin', limits: { rounds: 4.5 } } });
  scene = executionScene({ action: 'event', scene, at: 't3', event: { id: 'task-evaluation:3', name: 'Task evaluation', kind: 'pipeline', status: 'completed', evaluation: { ...snapshot, candidates: [...snapshot.candidates, ...Array(80).fill(snapshot.candidates[0])] } } });
  scene = executionScene({ action: 'event', scene, at: 't4', event: { id: 'task-evaluation:4', name: 'Task evaluation', kind: 'pipeline', status: 'completed', evaluation: { v: 9 } } });
  scene = executionScene({ action: 'event', scene, at: 't5', event: { id: 'job-1:c1', name: 'web_search', kind: 'operation', status: 'running', role: 'research', evaluation: snapshot } });
  const stage = id => scene.pipeline.find(row => row.id === id);
  assert.equal(stage('internal:1').role, 'research'); assert.deepEqual(stage('internal:1').limits, { rounds: 4 });
  assert.equal(stage('internal:2').role, undefined); assert.equal(stage('internal:2').limits, undefined);
  assert.equal(stage('task-evaluation:3').evaluation.candidates.length, EVALUATION_SNAPSHOT_LIMITS.candidates);
  assert.equal(stage('task-evaluation:4').evaluation, undefined);
  const op = scene.operations.find(row => row.id === 'job-1:c1'); assert.equal(op.role, undefined); assert.equal(op.evaluation, undefined);
  assert.ok(JSON.stringify(scene).length < 60000);
});

test('internal role IDs are the stable vocabulary the task space attributes', () => {
  assert.deepEqual([...INTERNAL_JOB_ROLES].sort(), ['calculate', 'execute', 'lookup', 'research']);
  assert.deepEqual(INTERNAL_JOB_LABELS, { research: '检索成员', calculate: '计算成员', lookup: '资料读取成员', execute: '执行成员' });
});
