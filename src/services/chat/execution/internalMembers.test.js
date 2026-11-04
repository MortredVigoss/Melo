import test from 'node:test';
import assert from 'node:assert/strict';
import { runInternalMembers, memberShare, MEMBER_INPUT_SHARE, LEAD_INPUT_RESERVE, MIN_MEMBER_SHARE } from './internalMembers.js';
import { internalRouteCatalog, startInternalJob } from '../../../../shared/agent/internalRouting.js';
import { currentRequestContext, runWithRequestContext } from '../../../runtime/requestScope.js';
import { createRunBudget, recordUsage, reserveDelivery } from '../../../runtime/runBudget.js';
import { runSubAgent as fixtureSubAgent } from '../../../testSupport/directAgentFixture.js';

const goal = 'Find the venue forecast and the event list, then save a note';
const tools = ['web_search', 'fetch_url', 'calculator', 'file_read', 'file_write'];
const catalog = internalRouteCatalog(goal, tools);
const job = (role, task, index) => ({ ...startInternalJob({ catalog, goal, args: { role, task }, callId: `call-${index}` }), index, id: `job-${index}` });
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('read-only jobs run in parallel lanes and execute jobs wait for them, one at a time', async () => {
  let active = 0, peak = 0; const order = [];
  const release = [];
  const emitted = [];
  const run = async options => {
    options.sseEmitter('execution_event', { kind: 'pipeline', id: 'model:1', status: 'running' });
    active++; peak = Math.max(peak, active); order.push(`start:${options.roleId}`);
    await new Promise(resolve => release.push(resolve));
    active--; order.push(`end:${options.roleId}`);
    return { ok: true, output: `done ${options.roleId}`, meta: { observations: [{ id: 'o', type: 'tool', name: options.allowedToolIds[0], ok: true, executed: true, output: 'x' }], effects: { successful: [], uncertain: [] } } };
  };
  const jobs = [job('research', 'forecast', 1), job('lookup', 'read notes', 2), job('execute', 'write the note', 3), job('research', 'events', 4)];
  const pending = runInternalMembers({ jobs, goal, run, lanes: 2, sseEmitter: (type, event) => { if (type === 'execution_event') emitted.push(event); } });
  await settle();
  assert.equal(peak, 2, 'two reader lanes');
  assert.ok(!order.includes('start:job-3'), 'the execute job has not started while readers run');
  release.splice(0).forEach(fn => fn()); await settle();
  release.splice(0).forEach(fn => fn()); await settle();
  assert.deepEqual(order.filter(entry => entry.startsWith('start')).slice(-1), ['start:job-3']);
  release.splice(0).forEach(fn => fn());
  const outcomes = await pending;
  assert.equal(outcomes.length, 4);
  assert.ok(outcomes.every(outcome => outcome.started && JSON.parse(outcome.handoff).status === 'observed'));
  assert.equal(order.indexOf('start:job-3') > order.indexOf('end:job-4'), true, 'execute starts only after every reader ended');
  const prefixed = emitted.filter(event => event.id === 'job-1:model:1');
  assert.equal(prefixed.length, 1, 'member stage ids are prefixed with the job id');
  assert.equal(prefixed[0].actorName, '检索成员');
  assert.ok(emitted.some(event => event.id === 'internal:1' && event.status === 'running') && emitted.some(event => event.id === 'internal:1' && event.status === 'completed'));
});

test('a member gets its own budget share and the lead reserve stops new members; failures and cancellation become partial handoffs without throwing', async () => {
  const seen = [];
  const run = async options => { seen.push(currentRequestContext().budget); seen.maxTokens = options.maxTokens; return { ok: true, output: 'ok', meta: { observations: [], effects: { successful: ['fp-1'], uncertain: [] } } }; };
  const budget = reserveDelivery(createRunBudget({ overrides: { maxInputTokens: 400000 } }));
  const context = Object.freeze({ budget });
  const sharedTurn = await runWithRequestContext(context, () => runInternalMembers({ jobs: [job('research', 'forecast', 1)], goal, run }));
  assert.equal(seen[0].maxInputTokens, MEMBER_INPUT_SHARE, 'member share capped');
  assert.notEqual(seen[0], budget, 'member runs on a child pool');
  assert.equal(seen.maxTokens, MEMBER_INPUT_SHARE, 'the sub-agent receives the whole share as its token cap');
  assert.deepEqual(sharedTurn[0].result.meta.effects.successful, ['fp-1']);
  const nearlySpent = reserveDelivery(createRunBudget({ overrides: { maxInputTokens: 400000 } }));
  recordUsage(nearlySpent, { inputTokens: 400000 - LEAD_INPUT_RESERVE - MIN_MEMBER_SHARE + 1 });
  let started = 0;
  const outcomes = await runWithRequestContext(Object.freeze({ budget: nearlySpent }), () => runInternalMembers({ jobs: [job('lookup', 'read', 2)], goal, run: async () => { started++; return { ok: true, output: 'x', meta: {} }; } }));
  assert.equal(started, 0, 'no member starts below the lead reserve');
  assert.equal(JSON.parse(outcomes[0].handoff).status, 'partial');
  assert.equal(outcomes[0].started, false);
  const failed = await runInternalMembers({ jobs: [job('research', 'forecast', 3)], goal, run: async () => { throw new Error('provider down'); } });
  assert.equal(JSON.parse(failed[0].handoff).status, 'partial');
  assert.match(JSON.parse(failed[0].handoff).memberReport, /provider down/);
  const controller = new AbortController();
  let toolRuns = 0;
  const cancelled = runInternalMembers({ jobs: [job('research', 'forecast', 4)], goal, signal: controller.signal, run: async options => {
    controller.abort(new Error('user stop'));
    if (options.signal.aborted) return { ok: false, output: 'Sub-agent aborted.', meta: { aborted: true } };
    toolRuns++; return { ok: true, output: 'should not happen', meta: {} };
  } });
  const [stopped] = await cancelled;
  assert.equal(toolRuns, 0, 'no work after the stop');
  assert.equal(JSON.parse(stopped.handoff).status, 'partial');
});

test('memberShare follows the remaining pool', () => {
  assert.deepEqual(memberShare(null), { share: null, reason: null });
  const budget = reserveDelivery(createRunBudget({ overrides: { maxInputTokens: 400000 } }));
  assert.equal(memberShare(budget).share, MEMBER_INPUT_SHARE);
  recordUsage(budget, { inputTokens: 400000 - (budget.delivery?.inputTokens || 0) - LEAD_INPUT_RESERVE - 30000 });
  assert.equal(memberShare(budget).share, 30000);
  recordUsage(budget, { inputTokens: 20000 });
  assert.deepEqual(memberShare(budget), { share: 0, reason: 'LEAD_RESERVE' });
});

test('through the real sub-agent loop a member keeps its full share, not the 32k delegated-member cap, and its events carry the job prefix', async () => {
  const budget = reserveDelivery(createRunBudget({ overrides: { maxInputTokens: 400000 } }));
  let capSeen = null; const events = []; const requests = [];
  const replyFn = async options => { requests.push(options); capSeen = currentRequestContext().budget.maxInputTokens; return 'The forecast is 20 C.'; };
  const config = { authMode: 'api', apiKey: 'k', baseUrl: 'http://127.0.0.1:1', model: 'm', replyLanguage: 'en' };
  const outcomes = await runWithRequestContext(Object.freeze({ budget }), () => runInternalMembers({ jobs: [job('research', 'forecast', 1)], goal, config, replyFn,
    run: options => fixtureSubAgent(options), sseEmitter: (type, event) => { if (type === 'execution_event') events.push(event); } }));
  assert.ok(capSeen >= MIN_MEMBER_SHARE && capSeen <= MEMBER_INPUT_SHARE, `member cap ${capSeen} is its share, not 32000`);
  assert.ok(capSeen > 32000, 'not the delegated-member default');
  assert.ok(outcomes[0].started);
  // The 10-04 probe showed members starting straight in limit delivery: the first request must be real work.
  assert.ok(requests.length >= 1 && !/limit-delivery/.test(String(requests[0].purpose || '')) && requests[0].budgetPhase !== 'delivery', JSON.stringify({ purpose: requests[0]?.purpose, phase: requests[0]?.budgetPhase }));
  assert.match(String(requests[0].messages?.[0]?.content || ''), /Task:/);
  assert.equal(requests[0].nativeWebSearchEnabled, false, 'members never use provider-hosted search');
  assert.equal(requests[0].nativeImageGenerationEnabled, false);
  assert.ok(events.every(event => String(event.id).startsWith('internal:1') || String(event.id).startsWith('job-1:')), JSON.stringify(events.map(e => e.id)));
});
