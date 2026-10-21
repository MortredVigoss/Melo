import test from 'node:test';
import {emptyCapabilities} from '../../domain/agent/capabilities.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runChatAgentExecutionGraph } from './chatExecutionRunner.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { registerTool, unregisterTool, getTool } from '../../tools/registryCore.js';
import { webSearchTool } from '../../tools/builtins/webSearchTool.js';
import { resolvePermission } from '../../tools/permissions.js';
import { beginSupplements, addSupplement, usedSupplements, endSupplements } from './supplements.js';

const fn = (id, query, name = 'fixture_lookup') => ({ type: 'function_call', id: `item-${id}`,
  call_id: id, name, arguments: JSON.stringify({ query }), status: 'completed' });
const reasoning = id => ({ type: 'reasoning', id, summary: [], encrypted_content: 'opaque-fixture' });
const done = output => `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'fixture-response', model: 'fixture-model', status: 'completed', output } })}\n\n`;
const message = { type: 'message', role: 'assistant', id: 'answer', status: 'completed', content: [{ type: 'output_text', text: '核对完成。', annotations: [] }] };

async function harness(t, respond, options={}) {
  const home = await mkdtemp(join(tmpdir(), 'melo-main-functions-'));
  const requests = [], events = [], executions = [], permissions = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ path: req.url, body });
    res.setHeader('content-type', 'text/event-stream');
    res.end(await respond(requests.length, body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  registerTool({ id: 'fixture_lookup', name: 'Fixture lookup', description: 'Read the requested fixture entry.',
    parametersSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    requiresPermission: true, isConcurrencySafe: true,
    run: async args => { executions.push(args.query); return options.toolResult?.(args) ?? options.outcome ?? { ok: true, output: `found ${args.query}` }; } });
  t.after(async () => { unregisterTool('fixture_lookup'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const config = { authMode: 'api-key', apiProtocol: 'responses', apiKey: 'fixture-key', model: 'fixture-model',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, activeLlmProfileId: 'fixture', conversationModelSelected: true };
  const text = options.text || '请调用工具读取本地代码并核对其中的内容';
  const chat = { id: 'fixture-chat', title: 'Fixture', mode: 'chat', agentId: 'main', projectId: null,
    messages: [{ id: 'user-1', role: 'user', content: text, createdAt: new Date().toISOString() }], sessionMemory: [] };
  const state = { projects: [], chats: [chat], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [],
    agentProfiles: { main: { id: 'main', name: 'Fixture', model: 'fixture-model', tools: [], skills: [], channels: {}, identity: '', soulMd: '' } },
    projectAgentOverrides: {}, settings: { selectedChatId: chat.id, selectedAgentId: 'main', activeMode: 'chat', promptHistory: [] } };
  if(options.profiles)state.agentProfiles=options.profiles;
  const context = Object.freeze({ ...createRequestContext({ home, chatId: chat.id, config,
    env: { MELO_MOCK_RESPONSE: '', MELO_DIAGNOSTICS_RECORD: '0', MELO_FUNCTION_CALLING: '', MELO_PROMPT_DEBUG: '0' } }),
    turnBinding: { role: 'main', project: null, taskId: null } });
  const run = signal => runWithRequestContext(context, () => runChatAgentExecutionGraph({ context, config, state, chat, signal, teamPlan:options.teamPlan,
    workspace: { rootPath: home, exists: false, entries: [], filePaths: [], fileCount: 0, commandTemplates: [], commandRuns: [] },
    connectors: [], skills: [], latestUserMessage: text, agentId: 'main', _dependencies: { getEmbedding: async () => null, turnTimeoutMs: options.turnTimeoutMs },
    sseEmitter(type, event) {
      events.push({ type, event });
      if (type === 'tool_permission') {
        permissions.push(event);
        void resolvePermission(event.requestId, event.args?.query !== 'B');
      }
    },
  }));
  return { requests, events, executions, permissions, run };
}

test('a real HTTP connectivity reply finishes as an answer with no tools or approvals', async t => {
  const text = '这是更新后的连通性检查。请只回复：更新验证通过。不要调用工具。';
  const h = await harness(t, () => done([{ ...message, content: [
    { type: 'output_text', text: '更新验证通过。', annotations: [] },
  ] }]), { text });
  const { normalizedReply } = await h.run();
  assert.equal(normalizedReply.content, '更新验证通过。');
  assert.equal(normalizedReply.completion.kind, 'answer');
  assert.equal(normalizedReply.completion.outcome, 'completed');
  assert.equal(normalizedReply.completion.summary, '回答已交付');
  assert.equal(h.requests.length, 2, 'one intent classification and one answer; no verification retry');
  assert.equal(h.executions.length, 0);
  assert.equal(h.permissions.length, 0);
});

test('main chat sends native definitions, authorizes valid calls and returns all outputs across three real HTTP turns', async t => {
  const h = await harness(t, round => done(round === 1
    ? [reasoning('rs-1'), fn('a', 'A'), fn('b', 'B'), fn('bad', 9), fn('hidden', 'secret', 'not_in_role')]
    : round === 2 ? [reasoning('rs-2'), fn('c', 'C')] : [message]));
  const result = await h.run();
  assert.equal(result.normalizedReply.content, '核对完成。');
  assert.deepEqual(h.executions, ['A', 'C']);
  assert.equal(h.permissions.length, 3, 'invalid/unknown calls never reach the authorization gate');
  assert.equal(new Set(h.permissions.map(p => p.requestId)).size, 3);
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests.every(r => r.path === '/v1/responses' && r.body.tools.some(t => t.name === 'fixture_lookup' && t.strict)));
  const input = h.requests[2].body.input;
  const outputs = input.filter(i => i.type === 'function_call_output');
  assert.deepEqual(outputs.map(i => i.call_id), ['a', 'b', 'bad', 'hidden', 'c']);
  assert.equal(JSON.parse(outputs[1].output).ok, false);
  assert.equal(JSON.parse(outputs[2].output).error, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(JSON.parse(outputs[3].output).error, 'UNKNOWN_TOOL');
  assert.deepEqual(input.filter(i => i.type === 'reasoning').map(i => i.id), ['rs-1', 'rs-2']);
  assert.equal(JSON.stringify(h.requests).includes('<tool_result'), false);
  assert.ok(h.events.some(e => e.type === 'execution_event' && e.event.status === 'completed' && e.event.name === 'fixture_lookup'));
  assert.equal(result.normalizedReply.content.includes('opaque-fixture'), false);
});

test('natural recommendation reaches API-key search execution and retains returned sources', async t => {
  const original = getTool('web_search');
  let searches = 0;
  unregisterTool('web_search');
  registerTool({ ...webSearchTool, requiresPermission: false, run: async () => {
    searches++;
    return { ok: true, output: 'Verified fixture venue: https://example.com/venue',
      meta: { sources: [{ url: 'https://example.com/venue', title: 'Fixture venue' }] } };
  } });
  t.after(() => { unregisterTool('web_search'); if (original) registerTool(original); });
  const searchCall = { ...fn('search', 'Surry Hills brunch', 'web_search'),
    arguments: JSON.stringify({ query: 'Surry Hills brunch', num_results: null, noCache: null, allowBlockedDomains: null }) };
  const h = await harness(t, round => done(round === 1 ? [searchCall]
    : [{ ...message, content: [{ type: 'output_text', text: '[Fixture venue](https://example.com/venue)', annotations: [] }] }]),
  { text: 'Surry Hills 有什么好吃的饭店？' });
  const result = await h.run();
  assert.equal(searches, 1, JSON.stringify(h.requests.at(-1)?.body.input));
  assert.ok(h.requests[0].body.tools.some(tool => tool.name === 'web_search'));
  assert.match(JSON.stringify(h.requests[0].body), /retrieve public evidence/);
  assert.match(JSON.stringify(h.requests[1].body.input), /https:\/\/example.com\/venue/);
  assert.match(result.normalizedReply.content, /https:\/\/example.com\/venue/);
});

test('network-disabled Agent gets an honest unavailable plan for a natural recommendation', async t => {
  const h = await harness(t, () => done([message]), { text: 'Surry Hills 有什么好吃的饭店？', profiles: {
    main: { id: 'main', name: 'Offline', capabilities: emptyCapabilities(), tools: [], skills: [] },
  } });
  await h.run();
  assert.match(JSON.stringify(h.requests[0].body), /search-unavailable/);
  assert.ok(!h.requests[0].body.tools?.some(tool => tool.name === 'web_search'));
});

test('main chat never executes calls from a truncated stream or a cancelled turn', async t => {
  const h = await harness(t, () => `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: fn('a', 'A') })}\n\n`);
  await assert.rejects(h.run(), /completion|complete/i);
  assert.equal(h.executions.length, 0); assert.equal(h.permissions.length, 0);
  const requests = h.requests.length;
  await assert.rejects(h.run(AbortSignal.abort()), /abort/i);
  assert.equal(h.requests.length, requests, 'cancelled turn performs no model request');
  assert.equal(h.executions.length, 0); assert.equal(h.permissions.length, 0);
});

test('shared Core ends the production loop after repeated permanent failure receipts', async t => {
  const h = await harness(t, round => done([fn('failure-' + round, 'A')]), { outcome: { ok: false, output: 'fixture unavailable', error: 'FIXTURE_UNAVAILABLE' } });
  const result = await h.run();
  assert.equal(h.requests.length, 3);
  assert.equal(h.executions.length, 2, 'existing repeat guard suppresses the third identical failing effect');
  assert.match(result.normalizedReply.content, /REPEATED_TOOL_FAILURE/);
});

test('shared Core ends identical successful reads before the old ten-round cap', async t => {
  const h = await harness(t, round => done([fn('read-' + round, 'A')]));
  const result = await h.run();
  assert.equal(h.requests.length, 6); assert.equal(h.executions.length, 6);
  assert.match(result.normalizedReply.content, /NO_PROGRESS/);
});

test('a turn deadline aborts an in-flight model request without executing a late tool', async t => {
  const h = await harness(t, async () => { await new Promise(resolve => setTimeout(resolve, 150)); return done([fn('late', 'A')]); }, { turnTimeoutMs: 80 });
  await assert.rejects(h.run(), /timeout|abort/i);
  assert.equal(h.executions.length, 0);
  assert.ok(h.requests.length <= 1);
});


test('a supplement typed during a tool step reaches the very next model request, and one typed during the final answer is handed back', async t => {
  const h = await harness(t, round => {
    // The user types while the model request of this round is in flight.
    if (round === 1) addSupplement('fixture-chat', '只核对 C，不要 A');
    if (round === 2) addSupplement('fixture-chat', '最后再写个总结');
    return done(round === 1 ? [fn('a', 'A')] : [message]);
  });
  beginSupplements('fixture-chat');
  t.after(() => endSupplements('fixture-chat'));
  const result = await h.run();
  assert.equal(result.normalizedReply.content, '核对完成。');
  assert.equal(h.requests.length, 2);
  assert.equal(JSON.stringify(h.requests[0].body).includes('只核对 C'), false);
  const next = JSON.stringify(h.requests[1].body.input);
  assert.ok(next.includes('只核对 C，不要 A'), 'the next model request carries the supplement');
  assert.ok(next.includes('found A'), 'the finished tool step is kept');
  assert.deepEqual(h.executions, ['A']);
  assert.ok(h.events.some(e => e.type === 'execution_event' && e.event.id?.startsWith('supplement:') && e.event.output === '只核对 C，不要 A'));
  assert.deepEqual(usedSupplements('fixture-chat').map(e => e.text), ['只核对 C，不要 A']);
  assert.deepEqual(endSupplements('fixture-chat').map(e => e.text), ['最后再写个总结'], 'no further step: returned to be sent next');
});

test('manual chat team reaches real member HTTP requests with own models, persona, handoffs and inherited capabilities',async t=>{
 const cap={...emptyCapabilities(),delegate:true};
 const profiles={main:{id:'main',name:'Main',instructions:'parent',model:'parent',capabilities:cap,collaboration:{canDelegate:true,delegateTargets:['research','reviewer']}},research:{id:'research',name:'Research',instructions:'research persona',model:'research-model',capabilities:emptyCapabilities()},reviewer:{id:'reviewer',name:'Reviewer',instructions:'review persona',model:'review-model',capabilities:emptyCapabilities()}};
 const h=await harness(t,round=>done([{...message,content:[{type:'output_text',text:round<3?JSON.stringify({conclusion:'result '+round,evidence:['fixture source'],changedFiles:[],unfinished:[],review:'approve'}):'lead summary of both members',annotations:[]}]}]),{text:'比较这些选择',profiles,teamPlan:{members:['research','reviewer'],mode:'sequential'}});
 const result=await h.run();
 // Two members, then one summary request written by the lead with its own model and persona.
 assert.equal(h.requests.length,3);
 assert.deepEqual(h.requests.map(r=>r.body.model),['research-model','review-model','parent']);
 assert.match(JSON.stringify(h.requests[2].body),/parent/);
 assert.match(JSON.stringify(h.requests[2].body),/result 1/);
 assert.match(JSON.stringify(h.requests[2].body),/result 2/);
 assert.equal(result.normalizedReply.content,'lead summary of both members');
 assert.match(JSON.stringify(h.requests[0].body),/research persona/);
 assert.match(JSON.stringify(h.requests[1].body),/review persona/);
 assert.match(JSON.stringify(h.requests[1].body),/result 1/);
 assert.ok(h.requests.every(r=>!(r.body.tools||[]).some(t=>t.type==='web_search'||t.type==='image_generation'||t.name==='bash')));
 assert.equal(h.events.filter(e=>e.event.handoff).length,2);
});
test('a team is refused before any member request when the lead has not chosen that member',async t=>{
 const cap={...emptyCapabilities(),delegate:true};
 const profiles={main:{id:'main',name:'Main',model:'parent',capabilities:cap,collaboration:{canDelegate:true,delegateTargets:['research']}},research:{id:'research',name:'Research',model:'research-model',capabilities:emptyCapabilities()},reviewer:{id:'reviewer',name:'Reviewer',model:'review-model',capabilities:emptyCapabilities()}};
 const h=await harness(t,()=>done([message]),{text:'比较这些选择',profiles,teamPlan:{members:['research','reviewer'],mode:'sequential'}});
 await assert.rejects(h.run(),/reviewer/);
 assert.equal(h.requests.length,0);
});
test('a team is refused when the lead has the capability on but the synced delegation flag off',async t=>{
 const cap={...emptyCapabilities(),delegate:true};
 const profiles={main:{id:'main',name:'Main',model:'parent',capabilities:cap,collaboration:{canDelegate:true,delegateTargets:['research']}},research:{id:'research',name:'Research',model:'research-model',capabilities:emptyCapabilities()}};
 const off={...profiles,main:{...profiles.main,collaboration:{canDelegate:false,delegateTargets:['research','reviewer']}}};
 const h2=await harness(t,()=>done([message]),{text:'比较这些选择',profiles:off,teamPlan:{members:['research'],mode:'sequential'}});
 await assert.rejects(h2.run(),/未开启委派/);
 assert.equal(h2.requests.length,0);
});


test('disabled native capabilities are absent from the actual main-turn provider request body',async t=>{
 const profiles={main:{id:'main',name:'Main',instructions:'parent',capabilities:emptyCapabilities()}};
 const h=await harness(t,()=>done([message]),{profiles,text:'请联网搜索并核对本地文件中的结论'});
 await h.run();assert.ok(h.requests.length>0);
 for(const {body} of h.requests)assert.ok(!(body.tools||[]).some(tool=>['web_search','web_search_preview','image_generation'].includes(tool.type)));
 assert.equal(h.executions.length,0);assert.equal(h.permissions.length,0);
});

for (const failing of [false, true]) test(`shared main loop bounds ${failing ? 'permanent failures' : 'unchanged successful reads'} before another model or permission request`, async t => {
  const h = await harness(t, round => done([fn(`repeat-${round}`, 'A')]), failing
    ? { toolResult: () => ({ ok: false, error: 'NOT_FOUND', output: 'missing' }) } : {});
  const result = await h.run();
  assert.equal(h.requests.length, failing ? 3 : 6);
  assert.equal(h.executions.length, failing ? 2 : 6);
  assert.equal(h.permissions.length, failing ? 2 : 6);
  assert.match(result.normalizedReply.content, failing ? /REPEATED_TOOL_FAILURE/ : /NO_PROGRESS/);
  assert.equal(h.events.filter(e => e.type === 'tool_calls_done').length, failing ? 3 : 6, 'all executed and locally refused batches keep receipts');
});

test('shared main loop admits 32 sibling calls', async t => {
  const h = await harness(t, round => done(round === 1 ? Array.from({ length: 32 }, (_, i) => fn(`batch-${i}`, `entry-${i}`)) : [message]));
  await h.run(); assert.equal(h.executions.length, 32);
});

test('shared main loop rejects 33 calls atomically before permission', async t => {
  const bad = await harness(t, () => done(Array.from({ length: 33 }, (_, i) => fn(`bad-${i}`, 'A'))));
  await assert.rejects(bad.run(), /32|batch|limit|calls/i);
  assert.equal(bad.executions.length, 0); assert.equal(bad.permissions.length, 0);
});

for (const evidence of ['read', 'snippet', 'unrelated', 'empty']) test('completion receipt uses actual research bodies: ' + evidence, async t => {
  const original = getTool('web_search'); let searches = 0;
  unregisterTool('web_search');
  registerTool({ ...webSearchTool, requiresPermission: false, run: async () => {
    searches++;
    return { ok: true, output: 'Query Research Sydney brunch; https://fixture.invalid/menu', completionSources: evidence === 'empty' ? [] : [{ url: 'https://fixture.invalid/menu', reading: evidence === 'snippet' ? 'snippet' : 'extracted', content: evidence === 'unrelated' ? 'Distant stars and galaxies have different spectra and their light is redshifted.' : 'Sydney brunch menu with breakfast dishes and observed opening hours for this fixture.' }] };
  } });
  t.after(() => { unregisterTool('web_search'); if (original) registerTool(original); });
  const call = { ...fn('research-read', 'Sydney brunch', 'web_search'), arguments: JSON.stringify({ query: 'Sydney brunch', num_results: null, noCache: null, allowBlockedDomains: null }) };
  let modelTurns = 0;
  const h = await harness(t, (_, body) => {
    if (!body.tools?.length) return done([{ ...message, content: [{ type: 'output_text', text: 'factual', annotations: [] }] }]);
    return done(++modelTurns === 1 ? [call] : [{ ...message, content: [{ type: 'output_text', text: 'Sydney brunch: https://fixture.invalid/menu', annotations: [] }] }]);
  }, { text: 'Research Sydney brunch' });
  const result = await h.run();
  assert.equal(searches, 1); assert.equal(modelTurns, 2, 'no additional judge or action replay');
  assert.equal(result.normalizedReply.completion.outcome, evidence === 'read' ? 'completed' : 'partial');
  assert.equal(result.normalizedReply.completion.goalState, evidence === 'read' ? 'supported' : 'unverified');
  assert.equal(JSON.stringify(result.normalizedReply.completion).includes('breakfast dishes'), false);
});
test('tool ok and final prose are not goal verification', async t => {
  const h = await harness(t, round => done(round === 1 ? [fn('effect', 'A')] : [message]));
  const result = await h.run();
  assert.equal(h.executions.length, 1); assert.equal(h.requests.length, 2);
  assert.equal(result.normalizedReply.completion.outcome, 'partial');
  assert.equal(result.normalizedReply.completion.reason, 'GOAL_TERMINAL_EVIDENCE_MISSING');
});

for (const count of [9, 32]) {
  test(`main chat executes and pairs all ${count} accepted calls before requesting the final answer`, async t => {
    const queries = Array.from({ length: count }, (_, i) => `batch-${i}`);
    const h = await harness(t, round => done(round === 1
      ? queries.map((query, i) => fn(`batch-call-${i}`, query))
      : [message]));
    const result = await h.run();
    assert.equal(result.normalizedReply.content, '核对完成。');
    assert.deepEqual([...h.executions].sort(), [...queries].sort(), 'concurrent tools may execute out of order, but each call must execute exactly once');
    assert.equal(h.permissions.length, count);
    assert.equal(h.requests.length, 2);
    const outputs = h.requests[1].body.input.filter(item => item.type === 'function_call_output');
    assert.deepEqual(outputs.map(item => item.call_id), queries.map((_, i) => `batch-call-${i}`));
    assert.ok(outputs.every(item => JSON.parse(item.output).ok));
  });
}

test('main chat rejects an oversized batch before any authorization or execution', async t => {
  const h = await harness(t, () => done(Array.from({ length: 33 }, (_, i) => fn(`oversized-${i}`, `query-${i}`))));
  await assert.rejects(h.run(), /per-response tool call limit/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.permissions.length, 0);
  assert.equal(h.executions.length, 0);
});
