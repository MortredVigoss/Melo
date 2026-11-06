// Plan C (2026-11-05): task-space board projections over recorded scenes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionScene, applyExecutionEvent, finishExecutionScene, MEMBER_ROLES } from './executionScene.js';
import { sceneMembers, sceneStageRail, sceneEvaluation, evaluationChanges, sceneLog, sceneResources, sceneHasBoard, operationVerb, topQualifiedScore, memberRole, MEMBER_ROLE_MODULE, BOARD_LOG_LIMIT } from './executionBoard.js';
import { INTERNAL_JOB_ROLES, INTERNAL_JOB_LABELS } from '../../shared/agent/internalRouting.js';
import { updateTaskEvaluation, taskEvaluationSnapshot } from '../../shared/agent/taskEvaluation.js';

const T0 = Date.parse('2026-11-05T09:00:00.000Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const goal = '墨尔本这个周末有什么适合两个人参加的户外或音乐活动';
const observations = [
  { id: 'job-1:r1', name: 'fetch_url', ok: true, executed: true, reading: 'extracted', url: 'https://a.example/1', text: 'Twilight Sessions. Saturday 8 November 2026 7:00pm. Sidney Myer Music Bowl. Free public entry, all welcome.' },
  { id: 'job-1:r2', name: 'fetch_url', ok: true, executed: true, reading: 'extracted', url: 'https://a.example/2', text: 'Heritage Walk. Sunday 9 November 2026 10:00am. Royal Botanic Gardens. Bookings open to the public.' },
];
const event = (name, startsAt, place, quote, extra = {}) => ({ evidence: [{ id: extra.id || 'job-1:r1', quote }], fields: { name, startsAt, place, participation: 'public' }, match: 34, diversity: 8, reason: 'fits', tags: ['音乐'], ...extra });
function evaluations() {
  const steps = [
    { action: 'contract', data: JSON.stringify({ category: 'events', unit: '活动', coverage: ['音乐', '户外'] }) },
    { action: 'batch', data: JSON.stringify({ items: [event('Twilight Sessions', '2026-11-08T19:00:00+11:00', 'Sidney Myer Music Bowl', 'Saturday 8 November 2026 7:00pm. Sidney Myer Music Bowl. Free public entry'), { fields: { name: 'Laneway Jazz' }, match: 20, diversity: 5, reason: 'title only', tags: [] }], gaps: [] }) },
    { action: 'batch', data: JSON.stringify({ items: [event('Heritage Walk', '2026-11-09T10:00:00+11:00', 'Royal Botanic Gardens', 'Sunday 9 November 2026 10:00am. Royal Botanic Gardens. Bookings open to the public', { id: 'job-1:r2', match: 30, tags: ['户外'] })], gaps: [] }) },
  ];
  let state; const states = [];
  for (const step of steps) { state = updateTaskEvaluation(state, step, { goal, revision: 1, observations, resourceUse: { elapsedMs: 1000, toolCalls: 3, inputTokens: 900 } }); states.push(state); }
  return states;
}
function recorded({ finish = true } = {}) {
  const states = evaluations();
  const scene = createExecutionScene({ runId: 'run', chatId: 'chat', query: goal, startedAt: at(0) });
  const e = (fields, s) => assert.equal(applyExecutionEvent(scene, { ...fields, at: at(s) }), true);
  e({ kind: 'pipeline', id: 'model:1', module: 'create', name: '模型请求', status: 'completed', api: { usage: { input_tokens: 1200, output_tokens: 300 } } }, 1);
  e({ kind: 'pipeline', id: 'task-evaluation:1', module: 'compute', name: '任务评估', output: '发现 0', status: 'completed', evaluation: taskEvaluationSnapshot(states[0]) }, 2);
  e({ kind: 'pipeline', id: 'internal:1', module: 'compute', name: '检索成员', role: 'research', limits: { rounds: 4 }, status: 'running', input: '查周末活动' }, 3);
  e({ kind: 'pipeline', id: 'internal:2', module: 'compute', name: '资料读取成员', status: 'running', input: '读取所在城市' }, 3);
  e({ kind: 'operation', id: 'job-1:s1', module: 'search', name: 'web_search', status: 'running', query: 'Melbourne weekend music' }, 4);
  e({ kind: 'operation', id: 'job-1:s1', module: 'search', name: 'web_search', status: 'completed', resultSummary: '检索返回 4 条来源' }, 5);
  e({ kind: 'operation', id: 'job-1:f1', module: 'search', name: 'fetch_url', status: 'running', input: 'https://a.example/1' }, 6);
  e({ kind: 'operation', id: 'tool-lead', module: 'tools', name: 'location_current', status: 'completed' }, 6);
  return { scene, states, e, finishIt: () => { e({ kind: 'operation', id: 'job-1:f1', module: 'search', name: 'fetch_url', status: 'completed' }, 8);
    e({ kind: 'pipeline', id: 'internal:1', status: 'completed', output: '读到两项' }, 9);
    e({ kind: 'pipeline', id: 'internal:2', status: 'completed', output: '墨尔本' }, 9);
    e({ kind: 'pipeline', id: 'task-evaluation:2', module: 'compute', name: '任务评估', status: 'completed', evaluation: taskEvaluationSnapshot(states[1]) }, 10);
    e({ kind: 'pipeline', id: 'task-evaluation:3', module: 'compute', name: '任务评估', status: 'completed', evaluation: taskEvaluationSnapshot(states[2]) }, 12);
    e({ kind: 'pipeline', id: 'goal-check:4', module: 'compute', messageId: 'stage.delivery', status: 'completed', output: '两项均有原页证据' }, 14);
    if (finish) finishExecutionScene(scene, { status: 'completed', message: { id: 'answer' }, at: at(16) }); } };
}

test('role vocabulary matches the shared router and home modules cover every role', () => {
  assert.deepEqual([...MEMBER_ROLES].sort(), [...INTERNAL_JOB_ROLES].sort());
  for (const [role, label] of Object.entries(INTERNAL_JOB_LABELS)) assert.equal(memberRole({ name: label }), role, 'legacy label fallback for ' + role);
  assert.deepEqual(Object.keys(MEMBER_ROLE_MODULE).sort(), [...INTERNAL_JOB_ROLES].sort());
  assert.equal(memberRole({ role: 'admin', name: '管理员' }), null);
});

test('members are attributed by job prefix; a running member sits on its running call, else its home module', () => {
  const { scene, finishIt } = recorded();
  let [research, lookup] = sceneMembers(scene);
  assert.equal(research.role, 'research'); assert.equal(research.rounds, 4); assert.deepEqual(research.operations, ['job-1:s1', 'job-1:f1']);
  assert.equal(research.activeOperation, 'job-1:f1'); assert.equal(research.currentModule, 'search');
  assert.equal(lookup.role, 'lookup', 'legacy label fallback without role field'); assert.equal(lookup.calls, 0); assert.equal(lookup.currentModule, 'files');
  assert.ok(!sceneMembers(scene).some(member => member.operations.includes('tool-lead')), 'lead calls are not attributed to members');
  finishIt();
  [research, lookup] = sceneMembers(scene);
  assert.equal(research.running, false); assert.equal(research.currentModule, null); assert.equal(research.activeOperation, null);
  assert.equal(research.report, '读到两项');
});

test('stage rail lists only phases that happened, in order, with delivery last', () => {
  const { scene, finishIt } = recorded({ finish: false });
  let rail = sceneStageRail(scene);
  assert.deepEqual(rail.map(row => row.key), ['contract', 'evaluate', 'dispatch']);
  assert.equal(rail.find(row => row.key === 'dispatch').status, 'running'); assert.equal(rail.find(row => row.current).key, 'dispatch');
  assert.ok(!rail.some(row => ['review', 'deliver', 'approval'].includes(row.key)), 'no invented review or delivery');
  finishIt(); rail = sceneStageRail(scene);
  assert.deepEqual(rail.map(row => row.key), ['contract', 'evaluate', 'dispatch', 'review']);
  assert.equal(rail.find(row => row.key === 'evaluate').count, 3); assert.equal(rail.find(row => row.key === 'contract').revision, 1);
  finishExecutionScene(scene, { status: 'completed', at: at(16) });
  rail = sceneStageRail(scene);
  assert.equal(rail.at(-1).key, 'deliver'); assert.equal(rail.at(-1).status, 'completed'); assert.equal(rail.at(-1).current, true);
  assert.deepEqual(sceneStageRail(createExecutionScene({ runId: 'x', chatId: 'c' })), []);
});

test('evaluation prefers the live snapshot, keeps the score series and falls back to the completion receipt', () => {
  const { scene, states, finishIt } = recorded(); finishIt();
  const view = sceneEvaluation(scene);
  assert.equal(view.source, 'live'); assert.equal(view.updates, 3); assert.equal(view.stageId, 'task-evaluation:3');
  assert.deepEqual(view.series.map(row => row.top), [null, topQualifiedScore(taskEvaluationSnapshot(states[1])), topQualifiedScore(taskEvaluationSnapshot(states[2]))]);
  assert.deepEqual(view.series.map(row => row.verified), [0, 1, 2]);
  assert.equal(view.snapshot.summary.verified, 2);
  const old = createExecutionScene({ runId: 'old', chatId: 'c', startedAt: at(0) });
  applyExecutionEvent(old, { kind: 'pipeline', id: 'task-evaluation:1', name: 'Task evaluation', status: 'completed', output: 'Discovered 2', at: at(1) });
  assert.deepEqual(sceneEvaluation(old), { snapshot: null, stageId: 'task-evaluation:1', source: 'text', updates: 1, series: [] });
  finishExecutionScene(old, { status: 'completed', message: { id: 'a', metadata: { completion: { version: 1, outcome: 'completed', task: { evaluation: states[2] } } } }, at: at(3) });
  const fallback = sceneEvaluation(old);
  assert.equal(fallback.source, 'completion'); assert.deepEqual(fallback.snapshot, taskEvaluationSnapshot(states[2]));
  assert.equal(sceneEvaluation(null).snapshot, null);
});

test('snapshots arriving without the reducer (phone records) are still bounded by the projection', () => {
  const scene = createExecutionScene({ runId: 'p', chatId: 'c' });
  scene.pipeline.push({ id: 'task-evaluation:1', status: 'completed', evaluation: { v: 1, candidates: Array(300).fill({ key: 'k', tier: 'boss', total: 1e6 }) } });
  const view = sceneEvaluation(scene);
  assert.equal(view.snapshot.candidates.length, 24); assert.ok(view.snapshot.candidates.every(row => row.tier === 'pending' && row.total === 100));
  scene.pipeline.push({ id: 'task-evaluation:2', status: 'completed', evaluation: 'not an object' });
  assert.equal(sceneEvaluation(scene).stageId, 'task-evaluation:1');
});

test('only new or promoted candidates count as changes', () => {
  const states = evaluations();
  const [a, b, c] = states.map(taskEvaluationSnapshot);
  assert.deepEqual(evaluationChanges(a, b).map(row => [row.name, row.fresh]).sort(), [['Laneway Jazz', true], ['Twilight Sessions', true]]);
  const third = evaluationChanges(b, c);
  assert.ok(third.some(row => row.name === 'Heritage Walk' && row.fresh));
  assert.ok(!third.some(row => row.name === 'Laneway Jazz'), 'unchanged pending candidate does not animate');
  assert.deepEqual(evaluationChanges(c, c), []); assert.deepEqual(evaluationChanges(c, null), []);
});

test('log rows come from records, newest first, with member attribution and no model noise', () => {
  const { scene, finishIt } = recorded(); finishIt();
  const log = sceneLog(scene);
  assert.equal(log[0].verb, 'deliver'); assert.equal(log[0].offsetMs, 16000);
  assert.ok(!log.some(row => row.id.startsWith('model:')), 'model requests stay in delivery records');
  const read = log.find(row => row.id === 'job-1:f1');
  assert.equal(read.verb, 'read'); assert.equal(read.actor.role, 'research'); assert.equal(read.actor.index, 1); assert.equal(read.offsetMs, 6000);
  assert.equal(log.find(row => row.id === 'tool-lead').actor.role, 'lead'); assert.equal(log.find(row => row.id === 'tool-lead').verb, 'lookup');
  assert.equal(log.filter(row => row.id === 'internal:1').map(row => row.verb).sort().join(), 'dispatch,handoff');
  assert.equal(log.find(row => row.verb === 'evaluate' && row.id === 'task-evaluation:3').summary.verified, 2);
  assert.equal(log.find(row => row.verb === 'review').detail, '两项均有原页证据');
  for (let i = 1; i < log.length; i++) assert.ok((Date.parse(log[i - 1].at) || 0) >= (Date.parse(log[i].at) || 0), 'newest first');
  assert.equal(sceneLog(scene, { limit: 3 }).length, 3);
  for (let i = 0; i < 100; i++) applyExecutionEvent(scene, { kind: 'operation', id: 'x' + i, name: 'calculator', status: 'completed', at: at(20) });
  assert.ok(sceneLog(scene).length <= BOARD_LOG_LIMIT);
  assert.equal(operationVerb({ name: 'mcp:melo-xiaohongshu:search_feeds' }), 'search'); assert.equal(operationVerb({ name: 'calendar_create_event' }), 'write'); assert.equal(operationVerb({ name: 'unknown' }), 'call');
});

test('resources report actual usage and the policy checkpoint; the board only exists when routing or evaluation ran', () => {
  const { scene, finishIt } = recorded({ finish: false });
  const live = sceneResources(scene, { now: T0 + 65000 });
  assert.equal(live.toolCalls, 3); assert.equal(live.inputTokens, 1200); assert.equal(live.outputTokens, 300); assert.equal(live.elapsedMs, 65000); assert.equal(live.checkpoint, null);
  finishIt(); finishExecutionScene(scene, { status: 'completed', at: at(16) });
  const done = sceneResources(scene, { now: T0 + 999999, snapshot: sceneEvaluation(scene).snapshot });
  assert.equal(done.elapsedMs, 16000); assert.deepEqual(done.checkpoint, { milliseconds: 180000, calls: 20 }); assert.equal(done.reported.toolCalls, 3);
  assert.equal(sceneHasBoard(scene), true);
  const plain = createExecutionScene({ runId: 'plain', chatId: 'c' });
  applyExecutionEvent(plain, { kind: 'operation', id: 'w', module: 'search', name: 'web_search', status: 'completed' });
  assert.equal(sceneHasBoard(plain), false); assert.equal(sceneHasBoard(null), false);
});

test('a member\'s task reads the same from every host, and an older iPhone record still shows it while running', () => {
  const scene = createExecutionScene({ runId: 'hosts', chatId: 'c' });
  // Desktop and Android (and iPhone from 2026-11-06): the task is input; the report arrives as output.
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'internal:1', name: '检索成员', role: 'research', status: 'running', input: '查找墨尔本本周末的户外音乐活动' });
  // An iPhone record from before: a running member's task was written into output.
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'internal:2', name: '资料读取成员', role: 'lookup', status: 'running', output: '读取两家官方页面' });
  let [first, second] = sceneMembers(scene);
  assert.equal(first.task, '查找墨尔本本周末的户外音乐活动'); assert.equal(first.report, '');
  assert.equal(second.task, '读取两家官方页面', 'the dispatch card is not blank'); assert.equal(second.report, '', 'and the task is not mistaken for a report');
  applyExecutionEvent(scene, { kind: 'pipeline', id: 'internal:1', status: 'completed', output: '读到 2 个官方页面' });
  [first] = sceneMembers(scene);
  assert.equal(first.task, '查找墨尔本本周末的户外音乐活动', 'the report does not erase the task'); assert.equal(first.report, '读到 2 个官方页面');
});
