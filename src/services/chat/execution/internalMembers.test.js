import test from 'node:test';
import assert from 'node:assert/strict';
import { runInternalMembers, memberShare, MEMBER_INPUT_SHARE, LEAD_INPUT_RESERVE, MIN_MEMBER_SHARE } from './internalMembers.js';
import { internalRouteCatalog, startInternalJob } from '../../../../shared/agent/internalRouting.js';
import { currentRequestContext, runWithRequestContext } from '../../../runtime/requestScope.js';
import { createRunBudget, recordUsage, reserveDelivery } from '../../../runtime/runBudget.js';

const goal = 'Find the venue forecast and the event list, then save a note';
const tools = ['web_search', 'fetch_url', 'calculator', 'file_read', 'file_write'];
const catalog = internalRouteCatalog(goal, tools);
const job = (role, task, index) => ({ ...startInternalJob({ catalog, goal, args: { role, task }, callId: `call-${index}` }), index, id: `job-${index}` });
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('read-only jobs run in parallel lanes and execute jobs wait for them, one at a time', async () => {
  let active = 0, peak = 0; const order = [];
  const release = [];
  const run = async options => {
    active++; peak = Math.max(peak, active); order.push(`start:${options.roleId}`);
    await new Promise(resolve => release.push(resolve));
    active--; order.push(`end:${options.roleId}`);
    return { ok: true, output: `done ${options.roleId}`, meta: { observations: [{ id: 'o', type: 'tool', name: options.allowedToolIds[0], ok: true, executed: true, output: 'x' }], effects: { successful: [], uncertain: [] } } };
  };
  const jobs = [job('research', 'forecast', 1), job('lookup', 'read notes', 2), job('execute', 'write the note', 3), job('research', 'events', 4)];
  const pending = runInternalMembers({ jobs, goal, run, lanes: 2 });
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
});

test('a member gets its own budget share and the lead reserve stops new members; failures and cancellation become partial handoffs without throwing', async () => {
  const seen = [];
  const run = async options => { seen.push(currentRequestContext().budget); return { ok: true, output: 'ok', meta: { observations: [], effects: { successful: ['fp-1'], uncertain: [] } } }; };
  const budget = reserveDelivery(createRunBudget({ overrides: { maxInputTokens: 400000 } }));
  const context = Object.freeze({ budget });
  const sharedTurn = await runWithRequestContext(context, () => runInternalMembers({ jobs: [job('research', 'forecast', 1)], goal, run }));
  assert.equal(seen[0].maxInputTokens, MEMBER_INPUT_SHARE, 'member share capped');
  assert.notEqual(seen[0], budget, 'member runs on a child pool');
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
