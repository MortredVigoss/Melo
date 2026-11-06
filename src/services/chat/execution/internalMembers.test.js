import test from 'node:test';
import assert from 'node:assert/strict';
import { runInternalMembers, memberShare, MEMBER_INPUT_SHARE, LEAD_INPUT_RESERVE, MIN_MEMBER_SHARE, ROUTING_EXTENSION_CAP } from './internalMembers.js';
import { internalRouteCatalog, startInternalJob } from '../../../../shared/agent/internalRouting.js';
import { currentRequestContext, runWithRequestContext } from '../../../runtime/requestScope.js';
import { createRunBudget, recordUsage, reserveDelivery, narrowBudget } from '../../../runtime/runBudget.js';
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
  // Plan C: every member stage names its stable role and round limit, so the
  // task space attributes it without matching display labels.
  for (const [index, role] of [[1, 'research'], [2, 'lookup'], [3, 'execute'], [4, 'research']]) {
    const stages = emitted.filter(event => event.id === `internal:${index}`);
    assert.ok(stages.length >= 2 && stages.every(event => event.role === role && event.limits?.rounds === jobs[index - 1].roundLimit), JSON.stringify(stages));
  }
  assert.ok(emitted.filter(event => String(event.id).startsWith('job-')).every(event => event.role === undefined), 'member sub-events keep their own shape');
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
  // Once the per-turn extension cap is spent (B1), the lead reserve is what stops new members.
  const nearlySpent = reserveDelivery(createRunBudget({ overrides: { maxInputTokens: 400000 } }));
  nearlySpent.routingExtension = ROUTING_EXTENSION_CAP; nearlySpent.routingDeadlineExtension = 20 * 60000;
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
  assert.ok(events.every(event => String(event.id).startsWith('internal:1') || String(event.id).startsWith('job-1:') || String(event.id).startsWith('routing:budget:')), JSON.stringify(events.map(e => e.id)));
});
test('B evaluation: every member draws from the original root pool, nested pools never widen, and members search narrower', async () => {
  const { ROUTING_EXTENSION_CAP, MEMBER_SEARCH_RESULTS, MEMBER_SEARCH_CONTENT_CHARS } = await import('./internalMembers.js');
  const budget = reserveDelivery(createRunBudget({ overrides: { maxInputTokens: 400000, deadlineMs: 30 * 60000, maxToolCalls: 200 } }));
  const configs = []; const events = [];
  const run = async options => { configs.push(options.config); return { ok: true, output: 'ok', meta: { observations: [] } }; };
  const jobs = Array.from({ length: 6 }, (_, i) => job('research', 'task ' + i, i + 1));
  await runWithRequestContext(Object.freeze({ budget, config: { operationalLimits: { search: { maxResults: 8, contentMaxChars: 6000 } } } }), () =>
    runInternalMembers({ jobs, goal, run, lanes: 1, config: { operationalLimits: { search: { maxResults: 8, contentMaxChars: 6000, timeoutMs: 9000 } } }, sseEmitter: (type, event) => { if (type === 'execution_event') events.push(event); } }));
  assert.equal(budget.maxInputTokens, 400000 + ROUTING_EXTENSION_CAP, 'extension capped at four shares');
  assert.equal(budget.routingExtension || 0, 0);
  assert.equal(budget.maxToolCalls, 200);
  assert.equal(budget.deadlineAt, budget.startedAt + 30 * 60000, 'members cannot extend the root deadline');
  assert.equal(events.filter(e => /^routing:budget:/.test(e.id)).length, 0, 'no automatic budget extension events');
  assert.deepEqual(configs[0].operationalLimits.search, { maxResults: MEMBER_SEARCH_RESULTS, contentMaxChars: MEMBER_SEARCH_CONTENT_CHARS, timeoutMs: 9000 });
  const child = narrowBudget(budget, { maxInputTokens: 200000 });
  const before = child.maxInputTokens;
  await runWithRequestContext(Object.freeze({ budget: child }), () => runInternalMembers({ jobs: [job('lookup', 'nested', 9)], goal, run }));
  assert.equal(child.maxInputTokens, before, 'a nested pool is never extended');
});
test('A4-1: a member with gated tools asks once on a task-scope card before starting, and runs whatever the answer is', async () => {
  const tools = ['web_search', 'fetch_url', 'calculator', 'file_read', 'file_write', 'reminders_create', 'clipboard'];
  const catalog = internalRouteCatalog(goal, tools);
  const exec = (task, index) => ({ ...startInternalJob({ catalog, goal, args: { role: 'execute', task }, callId: `exec-${index}` }), index, id: `job-${index}` });
  const requests = []; let runs = 0; const events = [];
  const approvals = {
    tool: id => ({ reminders_create: { requiresPermission: true }, file_write: { requiresPermission: true, permissionGate: 'file-safety' }, clipboard: { requiresPermission: true } })[id] || { requiresPermission: false },
    check: async id => (id === 'clipboard' ? 'allow' : 'ask'),
    request: async ({ toolIds, task }) => { requests.push({ toolIds, task }); return { decision: requests.length === 1 ? 'task' : 'denied', toolIds }; },
  };
  const run = async () => { runs++; return { ok: true, output: 'done', meta: { observations: [] } }; };
  const outcomes = await runInternalMembers({ jobs: [exec('save the note', 1), exec('save the other note', 2)], goal, run, approvals, lanes: 1, sseEmitter: (type, event) => { if (type === 'execution_event') events.push(event); } });
  assert.equal(runs, 2, 'approved and denied members both run');
  assert.deepEqual(requests.map(r => r.toolIds), [['reminders_create'], ['reminders_create']], 'file-safety tools and already-allowed tools are not on the card');
  assert.deepEqual(events.filter(e => /^routing:approval:/.test(e.id)).map(e => e.status), ['completed', 'failed']);
  assert.ok(outcomes.every(o => o.started));
  const research = await runInternalMembers({ jobs: [job('research', 'look', 3)], goal, run, approvals: { ...approvals, request: async () => { throw new Error('must not ask'); } } });
  assert.ok(research[0].started, 'a member without gated tools asks nothing');
});
test('A5-1: a job runs on its configured connection, otherwise on the conversation connection', async () => {
  const { jobConnectionConfig } = await import('./internalMembers.js');
  const config = { authMode: 'codex', baseUrl: 'https://chatgpt.com/backend-api', model: 'gpt-6.1-sol', apiKey: '', apiProtocol: 'responses',
    llmProfiles: { fast: { id: 'fast', authMode: 'api-key', baseUrl: 'https://openrouter.ai/api/v1', model: 'fast-model', apiKey: 'sk-fast', apiProtocol: 'chat-completions' }, empty: { id: 'empty', authMode: 'api-key', model: '' } } };
  assert.equal(jobConnectionConfig(config, { research: 'fast' }, 'research').model, 'fast-model');
  assert.equal(jobConnectionConfig(config, { research: 'fast' }, 'research').apiKey, 'sk-fast');
  assert.equal(jobConnectionConfig(config, { research: 'fast' }, 'lookup').model, 'gpt-6.1-sol', 'other jobs follow the conversation');
  assert.throws(()=>jobConnectionConfig(config, { research: 'missing' }, 'research'),{code:'JOB_CONNECTION_UNAVAILABLE'});
  assert.throws(()=>jobConnectionConfig(config, { research: 'empty' }, 'research'),{code:'JOB_CONNECTION_UNAVAILABLE'});
  assert.equal(jobConnectionConfig(config, null, 'research'), config);
  const seen = []; const events = [];
  await runInternalMembers({ jobs: [job('research', 'look', 1), job('calculate', 'sum', 2)], goal, config, jobModels: { research: 'fast' }, lanes: 1,
    run: async options => { seen.push(options.config.model); return { ok: true, output: 'ok', meta: { observations: [] } }; }, sseEmitter: (type, event) => { if (type === 'execution_event') events.push(event); } });
  assert.deepEqual(seen, ['fast-model', 'gpt-6.1-sol']);
  assert.equal(events.find(e => e.id === 'internal:1' && e.status === 'running').model, 'fast-model', 'the scene shows which model the member ran on');
});

test('job connection replaces capability/window metadata and smart write jobs retain the strong connection', async () => {
  const { jobConnectionConfig } = await import('./internalMembers.js');
  const { createFunctionCallingSession } = await import('../../../tools/functionCalling.js');
  const config = { id: 'lead', activeLlmProfileId: 'lead', model: 'same-name', authMode: 'api-key', apiKey: 'lead-key', baseUrl: 'https://lead.invalid',
    modelCapabilities: { 'same-name': {tools:true,vision:true} }, routingContextWindow: 200000,
    llmProfiles: { narrow: { model: 'same-name', authMode: 'api-key', apiKey: 'member-key', baseUrl: 'https://member.invalid',
      modelCapabilities: {'same-name':{tools:false,vision:false}}, contextWindows: {'same-name':32000} }, unknown: {model:'opaque',authMode:'local',baseUrl:'http://localhost:1'} } };
  const selected = jobConnectionConfig(config,{research:'narrow'},'research');
  assert.equal(selected.id,'narrow'); assert.equal(selected.routingContextWindow,32000);
  assert.equal(createFunctionCallingSession(selected,[]).native,false,'tools:false really chooses XML fallback');
  const unknown = jobConnectionConfig(config,{research:'unknown'},'research');
  assert.deepEqual(unknown.modelCapabilities,{}); assert.equal(unknown.routingContextWindow,0);
  const requests=[];
  await runInternalMembers({jobs:[job('research','look',1)],goal,config,jobModels:{research:'narrow'},
    run: options=>fixtureSubAgent({...options,replyFn:async request=>{requests.push(request);return 'No evidence available.';}})});
  assert.ok(requests.length); assert.deepEqual(requests[0].modelCapabilities,{tools:false,vision:false});
  assert.equal(requests[0].apiKey,'member-key'); assert.equal(requests[0].baseUrl,'https://member.invalid');
  const models=[];
  await runInternalMembers({jobs:[job('execute','save',2)],goal,config,jobModels:{execute:'narrow'},requireStrongWrites:true,
    run:async options=>{models.push(options.config.apiKey);return {ok:true,output:'done',meta:{}};}});
  assert.deepEqual(models,['lead-key'],'an explicit low job connection cannot bypass the smart write floor');
});

test('an unavailable configured connection returns a diagnosable partial handoff without starting a provider',async()=>{
 let calls=0;const events=[];
 const result=await runInternalMembers({jobs:[job('research','look',1)],goal,config:{model:'lead',llmProfiles:{}},jobModels:{research:'gone'},
  run:async()=>{calls++;throw new Error('must not start');},sseEmitter:(type,event)=>events.push(event)});
 assert.equal(calls,0);assert.equal(result[0].started,false);assert.equal(result[0].result.error,'JOB_CONNECTION_UNAVAILABLE');
 assert.equal(JSON.parse(result[0].handoff).status,'partial');assert.ok(events.some(e=>e.status==='failed'&&/connection is unavailable/.test(e.output)));
});

test('C3: a member child budget covers its whole round allowance, not a single 90 s slice', async () => {
  const { memberDeadlineMs, TASK_EVALUATION_POLICY } = await import('../../../../shared/agent/taskEvaluation.js');
  const budget = reserveDelivery(createRunBudget({ overrides: { maxInputTokens: 400000, deadlineMs: 30 * 60000, maxToolCalls: 200 } }));
  const seen = [];
  const run = async () => { const child = currentRequestContext().budget; seen.push({ deadline: child.deadlineAt - child.startedAt, calls: child.maxToolCalls }); return { ok: true, output: 'ok', meta: { observations: [] } }; };
  const first = job('research', 'initial', 1); const resumed = { ...job('research', 'gap', 2), roundLimit: 2 };
  await runWithRequestContext(Object.freeze({ budget }), () => runInternalMembers({ jobs: [first, resumed], goal, run, lanes: 1 }));
  assert.equal(seen[0].deadline, memberDeadlineMs(first.roundLimit));
  assert.equal(seen[1].deadline, memberDeadlineMs(2));
  assert.ok(seen[0].deadline > 90000 + 60000, 'a first assignment gets more than one slice');
  // 2026-11-07 review P1-2: members do the lead's retrieval, so a member gets 16 calls.
  assert.equal(seen[0].calls, TASK_EVALUATION_POLICY.member.calls); assert.equal(seen[0].calls, 16);
});
