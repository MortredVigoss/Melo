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

test('a hosted-search job runs on the conversation connection when its role has another one; other jobs keep theirs', async () => {
  const seen = [], events = [];
  const run = async options => { seen.push({ role: options.roleId, model: options.config.model, hosted: options.nativeWebSearch }); return { ok: true, output: 'done', meta: { observations: [], effects: { successful: [], uncertain: [] } } }; };
  const config = { authMode: 'codex', model: 'conversation-model', activeLlmProfileId: 'codex', llmProfiles: { 'chat-only': { authMode: 'api-key', apiProtocol: 'chat-completions', model: 'chat-only-model', baseUrl: 'https://chat.example/v1', apiKey: 'k' } } };
  const hostedResearch = { ...job('research', 'find the hours', 1), tools: ['native_web_search', 'fetch_url'] };
  const plainResearch = { ...job('research', 'read the menu', 2), tools: ['fetch_url'] };
  await runInternalMembers({ jobs: [hostedResearch, plainResearch], goal, run, lanes: 1, config, jobModels: { research: 'chat-only' }, sseEmitter: (type, event) => { if (type === 'execution_event') events.push(event); } });
  assert.deepEqual(seen.find(row => row.role === 'job-1'), { role: 'job-1', model: 'conversation-model', hosted: true }, 'searching on a connection with verified hosted search');
  assert.deepEqual(seen.find(row => row.role === 'job-2'), { role: 'job-2', model: 'chat-only-model', hosted: false }, 'the role connection stays for jobs without hosted search');
  assert.ok(events.some(event => event.id === 'internal:1' && /改用对话连接/.test(event.output || '')), 'the task space says why');
  // Same profile, another model: the verified conversation model stays for hosted search.
  const same = [];
  const overridden = { ...config, model: 'agent-chosen-model', llmProfiles: { codex: { authMode: 'codex', model: 'profile-default-model' } } };
  await runInternalMembers({ jobs: [{ ...job('research', 'find the hours again', 3), tools: ['native_web_search', 'fetch_url'] }, { ...job('research', 'read the menu again', 4), tools: ['fetch_url'] }], goal, lanes: 1, config: overridden, jobModels: { research: 'codex' },
    run: async options => { same.push({ role: options.roleId, model: options.config.model, hosted: options.nativeWebSearch }); return { ok: true, output: 'done', meta: { observations: [], effects: { successful: [], uncertain: [] } } }; } });
  assert.deepEqual(same.find(row => row.role === 'job-3'), { role: 'job-3', model: 'agent-chosen-model', hosted: true }, 'hosted search keeps the verified conversation model');
  assert.deepEqual(same.find(row => row.role === 'job-4'), { role: 'job-4', model: 'profile-default-model', hosted: false });
});

test('a social member reads alongside the research member', async () => {
  let active = 0, peak = 0; const release = [];
  const run = async options => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => release.push(resolve));
    active--;
    return { ok: true, output: 'done', meta: { observations: [], effects: { successful: [], uncertain: [] } } };
  };
  const pending = runInternalMembers({ jobs: [job('research', 'official pages', 1), job('social', 'Xiaohongshu posts', 2)], goal, run, lanes: 2 });
  await settle();
  assert.equal(peak, 2, 'research and social run at the same time');
  release.splice(0).forEach(fn => fn()); await pending;
});

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

// 2026-11-10 latency audit L3: a reading member used to check its own report
// with one more model round before the lead saw it, and the lead's check then
// covered the same observations again. Readers now hand off directly, as the
// iPhone loop does; a job that writes keeps its own check.
test('L3: readers hand off without their own completion check, a writing job keeps it', async () => {
  const seen = {};
  const kinds = {};
  const run = async options => { seen[options.roleId] = options.completionCheck; kinds[options.roleId] = options.receiptKind; return { ok: true, output: 'done', meta: { observations: [], effects: { successful: [], uncertain: [] } } }; };
  const everyTool = ['web_search', 'fetch_url', 'calculator', 'file_read', 'file_write', 'mcp:melo-public-media:search_posts'];
  const all = internalRouteCatalog(goal, everyTool);
  const jobs = ['research', 'social', 'lookup', 'calculate', 'execute'].map((role, index) => ({ ...startInternalJob({ catalog: all, goal, args: { role, task: role + ' step' }, callId: `check-${index}` }), index: index + 1, id: `job-${role}` }));
  assert.equal(jobs.every(entry => !entry.error), true, JSON.stringify(jobs.map(entry => entry.error)));
  await runInternalMembers({ jobs, goal, run, config: { authMode: 'codex', model: 'm' }, approvals: { tool: () => null, check: async () => 'allow', request: async () => ({ decision: 'task' }) } });
  assert.deepEqual(seen, { 'job-research': false, 'job-social': false, 'job-lookup': false, 'job-calculate': false, 'job-execute': true });
  // A retrieval job's receipt needs a read source; a lookup or a calculation needs its reply.
  assert.deepEqual([kinds['job-research'], kinds['job-social'], kinds['job-lookup'], kinds['job-calculate']], ['research', 'research', 'answer', 'answer']);
});

test('L3: through the real loop a research member sends no check request and its receipt comes from the page it read', async () => {
  const { registerTool, unregisterTool } = await import('../../../tools/registry.js');
  let reads = 0;
  const tool = { id: 'fetch_url', name: 'Fetch URL', description: 'Read a page', requiresPermission: false, readOnly: true, capability: 'network', parametersSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async () => { reads++; return { ok: true, output: 'Harbour forecast for tomorrow: 15 to 19 C, partly cloudy.\n\n[source: https://fixture.invalid/forecast] [via: direct]', meta: { url: 'https://fixture.invalid/forecast', reading: 'extracted' } }; } };
  const { getTool } = await import('../../../tools/registryCore.js');
  const original = getTool('fetch_url');
  unregisterTool('fetch_url'); registerTool(tool);
  try {
    const run = async completionCheck => {
      const requests = [];
      const replyFn = async options => {
        requests.push(/task completion checker/.test(options.systemPrompt) ? 'check' : 'work');
        if (requests.at(-1) === 'check') return JSON.stringify({ decision: 'complete', evaluationValid: true, needsEvaluation: false, turnKind: 'task', reasonType: 'fulfilled', reason: 'ok', nextStep: '', requirements: [{ text: 'forecast', kind: 'external_fact', status: 'met', evidenceIds: ['read-1:source:0'] }] });
        return requests.filter(kind => kind === 'work').length === 1 ? `<tool_call>${JSON.stringify({ id: 'read-1', name: 'fetch_url', arguments: { url: 'https://fixture.invalid/forecast' } })}</tool_call>`
          : 'Tomorrow: 15 to 19 C, partly cloudy. Source: https://fixture.invalid/forecast';
      };
      const result = await fixtureSubAgent({ task: 'Find tomorrow\'s harbour forecast.', config: { authMode: 'unset', model: 'fixture', replyLanguage: 'en' }, allowedToolIds: ['fetch_url'], replyFn, maxTokens: 200000, ...(completionCheck === undefined ? {} : { completionCheck }) });
      return { requests, result };
    };
    const direct = await run(false);
    assert.deepEqual(direct.requests, ['work', 'work'], 'no completion check request');
    assert.equal(direct.result.ok, true);
    assert.equal(direct.result.meta.completion.outcome, 'completed');
    assert.equal(direct.result.meta.completion.reason, 'RELEVANT_SOURCES_READ', 'the receipt rests on the read page');
    assert.match(direct.result.output, /15 to 19 C/);
    const checked = await run(undefined);
    assert.deepEqual(checked.requests, ['work', 'work', 'check'], 'a delegated member keeps its check by default');
    assert.equal(checked.result.meta.completion.reason, 'GOAL_DELIVERY_SUPPORTED');
    assert.equal(reads, 2);
  } finally { unregisterTool('fetch_url'); if (original) registerTool(original); }
});

test('L3: a source in another language than the assignment still makes the handoff observed; an unread requested URL does not', async () => {
  const { registerTool, unregisterTool } = await import('../../../tools/registry.js');
  const { getTool } = await import('../../../tools/registryCore.js');
  const original = getTool('fetch_url');
  const page = { id: 'fetch_url', name: 'Fetch URL', description: 'Read a page', requiresPermission: false, readOnly: true, capability: 'network', parametersSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async args => ({ ok: true, output: 'Tomorrow in Melbourne: 15 to 19 C, partly cloudy, rain 10 percent.\n\n[source: ' + args.url + '] [via: direct]', meta: { url: args.url, reading: 'extracted' } }) };
  unregisterTool('fetch_url'); registerTool(page);
  try {
    const handoffFor = async task => {
      let turns = 0;
      const replyFn = async () => ++turns === 1 ? `<tool_call>${JSON.stringify({ id: 'read-1', name: 'fetch_url', arguments: { url: 'https://fixture.invalid/melbourne' } })}</tool_call>` : '明天 15 到 19 度，多云，降雨概率 10%。';
      const outcomes = await runInternalMembers({ jobs: [{ ...job('research', task, 21), tools: ['fetch_url'] }], goal, config: { authMode: 'unset', model: 'fixture', replyLanguage: 'zh' }, replyFn, run: options => fixtureSubAgent(options) });
      return JSON.parse(outcomes[0].handoff);
    };
    // A Chinese assignment answered from an English page, without the URL in the report.
    assert.equal((await handoffFor('查一下明天墨尔本的天气')).status, 'observed');
    // The assignment named a URL that was never read.
    assert.equal((await handoffFor('读一下 https://fixture.invalid/other-page 上的明天墨尔本天气')).status, 'partial');
  } finally { unregisterTool('fetch_url'); if (original) registerTool(original); }
});

test('L3: a reader that answers without reading anything is not reported as observed', async () => {
  const replyFn = async () => 'Tomorrow will be 19 C.';
  const outcomes = await runInternalMembers({ jobs: [job('research', 'Find tomorrow\'s harbour forecast', 9)], goal, config: { authMode: 'unset', model: 'fixture', replyLanguage: 'en' }, replyFn, run: options => fixtureSubAgent(options) });
  const handoff = JSON.parse(outcomes[0].handoff);
  assert.equal(handoff.status, 'partial');
  assert.deepEqual(handoff.evidence, []);
});

// 2026-11-10 agent audit. A read-only member has no completion check of its own, so the lead's check
// is the only one. The member's rows used to reach the lead cut for a prompt (3 000 characters after
// one search and one read), and the check could not see a passage beyond the cut.
test('L3: the lead\'s completion check sees the passage a member read, wherever it is on the page', async () => {
  const { registerTool, unregisterTool } = await import('../../../tools/registry.js');
  const { getTool } = await import('../../../tools/registryCore.js');
  const { startGoal, goalCandidate, goalReviewRequest, reviewGoal } = await import('../../../../shared/agent/goal.js');
  const { memberEvidence, MEMBER_EVIDENCE_CHARS } = await import('../../../agents/subAgent.js');
  const filler = index => `<area description="District ${index}"><forecast-period><text type="precis">Sunny.</text><element type="air_temperature_maximum">31</element></forecast-period></area>\n`;
  const melbourne = '<area description="Melbourne"><forecast-period start-time-local="2026-11-11"><element type="air_temperature_minimum">15</element><element type="air_temperature_maximum">19</element><text type="precis">Partly cloudy.</text></forecast-period></area>\n';
  const page = Array.from({ length: 34 }, (_, index) => filler(index)).join('') + melbourne + Array.from({ length: 40 }, (_, index) => filler(100 + index)).join('');
  assert.equal(page.indexOf('Melbourne') > 5000 && page.length > 12000, true, 'the passage really lies beyond the old cut');
  const fetch = { id: 'fetch_url', name: 'Fetch URL', description: 'Read a page', requiresPermission: false, readOnly: true, capability: 'network', parametersSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async () => ({ ok: true, output: page + '\n\n[source: https://fixture.invalid/IDV10450.xml] [via: direct]', meta: { url: 'https://fixture.invalid/IDV10450.xml', reading: 'extracted', windowChars: page.length + 80 } }) };
  const search = { id: 'web_search', name: 'Web search', description: 'Search', requiresPermission: false, readOnly: true, capability: 'network', parametersSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async () => ({ ok: true, output: 'Five results about the Melbourne forecast.', completionSources: Array.from({ length: 5 }, (_, index) => ({ url: `https://result-${index}.invalid/`, reading: 'snippet', content: `Result ${index}: Melbourne forecast overview.` })) }) };
  const originals = ['fetch_url', 'web_search'].map(id => getTool(id));
  for (const id of ['fetch_url', 'web_search']) unregisterTool(id);
  registerTool(fetch); registerTool(search);
  try {
    let work = 0;
    const replyFn = async () => ++work === 1 ? `<tool_call>${JSON.stringify({ id: 'find', name: 'web_search', arguments: { query: 'Melbourne forecast' } })}</tool_call>`
      : work === 2 ? `<tool_call>${JSON.stringify({ id: 'read', name: 'fetch_url', arguments: { url: 'https://fixture.invalid/IDV10450.xml' } })}</tool_call>`
      : 'Melbourne tomorrow: min 15, max 19, partly cloudy. Source: https://fixture.invalid/IDV10450.xml';
    const result = await fixtureSubAgent({ task: 'Find tomorrow\'s Melbourne forecast.', config: { authMode: 'unset', model: 'fixture', replyLanguage: 'en' }, allowedToolIds: ['web_search', 'fetch_url'], replyFn, maxTokens: 200000, completionCheck: false });
    assert.equal(result.ok, true);
    // What the lead loop does with a member's rows (invokeModelNode.js), then the lead's own check.
    const lead = result.meta.observations.map(row => ({ ...row, id: `job-1:${row.id}` }));
    const source = lead.find(row => row.type === 'source' && row.url === 'https://fixture.invalid/IDV10450.xml');
    assert.match(source.text, /air_temperature_maximum">19</, 'the row the lead holds still has the passage');
    const reply = '墨尔本明天最低 15°C，最高 19°C，Partly cloudy。来源：https://fixture.invalid/IDV10450.xml';
    const state = goalCandidate(startGoal('明天墨尔本天气多少'), { reply, observations: lead, tools: ['route_task'], research: true, roundsLeft: 4 });
    const shown = JSON.parse(goalReviewRequest(state, lead).messages[0].content).observations.find(row => row.id === source.id);
    assert.match(shown.text, /Melbourne/); assert.match(shown.text, /air_temperature_minimum">15</); assert.match(shown.text, /Partly cloudy/);
    const decided = reviewGoal(state, JSON.stringify({ decision: 'complete', evaluationValid: true, needsEvaluation: false, turnKind: 'task', reasonType: 'fulfilled', reason: 'ok', nextStep: '',
      requirements: [{ text: '明天墨尔本气温', kind: 'external_fact', status: 'met', evidenceIds: [source.id] }] }), lead);
    assert.equal(decided.decision, 'complete');
  } finally { for (const id of ['fetch_url', 'web_search']) unregisterTool(id); for (const tool of originals) if (tool) registerTool(tool); }
  // The total a member hands back is bounded, and the newest rows are the ones kept whole.
  const rows = Array.from({ length: 30 }, (_, index) => ({ id: 'r' + index, type: 'source', ok: true, executed: true, url: 'https://fixture.invalid/' + index, text: String(index).padStart(2, '0') + 'x'.repeat(19998) }));
  const kept = memberEvidence(rows);
  assert.equal(kept.length, 30);
  assert.equal(kept.reduce((sum, row) => sum + row.text.length, 0) <= MEMBER_EVIDENCE_CHARS, true);
  assert.deepEqual([kept.at(-1).text.length, kept.at(-1).truncated], [20000, undefined]);
  assert.deepEqual([kept[0].text.length <= 160, kept[0].truncated], [true, true]);
  assert.deepEqual(memberEvidence([{ id: 't', type: 'tool', ok: true, executed: true, output: 'kept as output' }]), [{ id: 't', type: 'tool', ok: true, executed: true, output: 'kept as output' }]);
});


// 2026-11-10 audit. The search settings page saves a result count (8 by default) under
// agentRuntime.search, which outranks operationalLimits. The member cap was written only to
// operationalLimits, so it stopped applying once that page had been saved.
test('a saved search result count never lifts the member cap, and a lower one is kept', async () => {
  const { memberConfig, MEMBER_SEARCH_RESULTS, MEMBER_SEARCH_CONTENT_CHARS } = await import('./internalMembers.js');
  const { normalizeSearchLimits } = await import('../../search/searchLimits.js');
  const base = saved => Object.freeze({ model: 'opaque', agentRuntime: Object.freeze({ search: Object.freeze({ backend: 'http', timeoutMs: 20000, ...(saved === undefined ? {} : { maxResults: saved }) }) }), operationalLimits: Object.freeze({ search: Object.freeze({ timeoutMs: 9000 }) }) });
  // saved value, what the member searches with, what the lead keeps
  for (const [saved, expected, lead] of [[8, MEMBER_SEARCH_RESULTS, 8], [3, 3, 3], [undefined, MEMBER_SEARCH_RESULTS, 8], ['many', MEMBER_SEARCH_RESULTS, 8], [0, 1, 1]]) {
    const config = base(saved), member = memberConfig(config);
    const limits = normalizeSearchLimits(member);
    assert.equal(limits.maxResults, expected, `saved ${saved}`);
    assert.equal(limits.contentMaxChars, MEMBER_SEARCH_CONTENT_CHARS);
    // The user's other search settings and the lead's own configuration are untouched.
    assert.equal(member.agentRuntime.search.backend, 'http');
    assert.equal(limits.timeoutMs, 20000);
    assert.equal(config.agentRuntime.search.maxResults, saved);
    assert.equal(normalizeSearchLimits(config).maxResults, lead);
  }
});

// 2026-11-10 agent audit, second pass: three readers starting together were each given a full share of
// the same pool, so together they could spend the reserve kept for the lead's own answer.
test('members that run side by side cannot together take the lead\'s reserve', async () => {
  const budget = reserveDelivery(createRunBudget({ overrides: { maxInputTokens: 400000, deadlineMs: 30 * 60000, maxToolCalls: 200 } }));
  const pool = 400000 - budget.delivery.inputTokens - LEAD_INPUT_RESERVE;
  const shares = [], release = [];
  // Every member holds its lane until all three have started, as three slow readers would.
  const run = async options => { shares.push(options.maxTokens); await new Promise(resolve => release.push(resolve)); return { ok: true, output: 'ok', meta: { observations: [] } }; };
  const jobs = [1, 2, 3].map(index => job('research', 'task ' + index, index));
  const pending = runWithRequestContext(Object.freeze({ budget }), () => runInternalMembers({ jobs, goal, run }));
  for (let waited = 0; shares.length < 3 && waited < 200; waited++) await settle();
  assert.equal(shares.length, 3, 'all three lanes started');
  assert.deepEqual(shares.slice(0, 2), [MEMBER_INPUT_SHARE, MEMBER_INPUT_SHARE]);
  assert.equal(shares[2], pool - 2 * MEMBER_INPUT_SHARE, 'the third reader gets what is left after the two running ones');
  assert.equal(shares.reduce((sum, share) => sum + share, 0) <= pool, true, 'together they stay inside the pool minus the lead reserve');
  release.forEach(resolve => resolve());
  const outcomes = await pending;
  assert.equal(outcomes.every(outcome => outcome.started), true);
  // What a finished member did not use is free again for the next one.
  shares.length = 0;
  await runWithRequestContext(Object.freeze({ budget }), () => runInternalMembers({ jobs: [job('research', 'later', 4)], goal, run: async options => { shares.push(options.maxTokens); return { ok: true, output: 'ok', meta: { observations: [] } }; } }));
  assert.deepEqual(shares, [MEMBER_INPUT_SHARE]);
  // A running member's remaining share counts, not what it has already used.
  const half = { maxInputTokens: 120000, used: { inputTokens: 50000 } };
  assert.equal(memberShare(budget, [half, half]).share, Math.min(MEMBER_INPUT_SHARE, pool - 140000));
  // With too little left the next member is not started at all.
  assert.deepEqual(memberShare(budget, [{ maxInputTokens: pool - MIN_MEMBER_SHARE + 1, used: { inputTokens: 0 } }]), { share: 0, reason: 'LEAD_RESERVE' });
});

test('a member\'s model requests count in the task space token total', async () => {
  // 2026-11-10 agent audit, second pass: tool calls of members were counted, their tokens were not.
  const { createExecutionScene, applyExecutionEvent } = await import('../../../shared/executionScene.js');
  const { sceneResources, usageStages } = await import('../../../shared/executionBoard.js');
  const events = [], forwarded = [];
  const run = async options => {
    for (const usage of [{ input: 700, output: 50, cached: 0, cacheWrite: 0 }, { input: 900, output: 30, cached: 0, cacheWrite: 0 }]) options.onProviderResponse({ requestedModel: 'm', usage });
    return { ok: true, output: 'found', meta: { observations: [] } };
  };
  await runWithRequestContext(Object.freeze({ budget: reserveDelivery(createRunBudget({ overrides: { maxInputTokens: 400000 } })) }), () =>
    runInternalMembers({ jobs: [job('research', 'forecast', 1), job('lookup', 'notes', 2)], goal, run, onProviderResponse: receipt => forwarded.push(receipt), sseEmitter: (type, event) => { if (type === 'execution_event') events.push(event); } }));
  assert.equal(forwarded.length, 4, 'the receipts still reach the turn');
  const finished = events.filter(event => /^internal:/.test(event.id) && event.status !== 'running');
  assert.deepEqual(finished.map(event => event.api?.usage), [{ input: 1600, output: 80 }, { input: 1600, output: 80 }]);
  const scene = createExecutionScene({ runId: 'run', requestId: 'request', chatId: 'chat' });
  for (const event of events) applyExecutionEvent(scene, event);
  const resources = sceneResources(scene);
  assert.equal(resources.inputTokens, 3200); assert.equal(resources.outputTokens, 160);
  assert.equal(usageStages(scene).length, 2, 'one usage record per member, however often its lane was updated');
  // A member without any reported usage adds nothing and reports nothing.
  events.length = 0;
  await runWithRequestContext(Object.freeze({ budget: reserveDelivery(createRunBudget({ overrides: { maxInputTokens: 400000 } })) }), () =>
    runInternalMembers({ jobs: [job('research', 'again', 3)], goal, run: async () => ({ ok: true, output: 'x', meta: { observations: [] } }), sseEmitter: (type, event) => { if (type === 'execution_event') events.push(event); } }));
  assert.equal(events.some(event => event.api), false);
});
