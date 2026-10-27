import test from 'node:test';
import assert from 'node:assert/strict';
import { runSubAgent, runSkill, withLegacyAgentFixture } from '../testSupport/directAgentFixture.js';
import { registerTool, unregisterTool } from '../tools/registry.js';
import { createRunBudget, reserveDelivery, recordUsage } from '../runtime/runBudget.js';
import { currentRequestContext } from '../runtime/requestScope.js';
import { createRequestContext } from '../runtime/requestContext.js';
import { createHandoff } from './handoff.js';
const config = { authMode: 'unset', model: 'fixture', replyLanguage: 'zh' };
for (const member of [true, false]) for (const limit of ['rounds', 'calls', 'time', 'tokens', 'cancel']) test(`${member ? 'member' : 'skill'} delivers findings once at ${limit}; no forbidden effects`, async t => {
  let effects = 0, work = 0, deliveries = 0, checks = 0, now = 1000;
  const controller = new AbortController();
  const budget = reserveDelivery(createRunBudget({ now: () => now }));
  const tool = { id: 'child_delivery_read', name: 'read', description: 'Read the isolated activity source', requiresPermission: false, readOnly: true,
    parametersSchema: { type: 'object', properties: {} }, run: async (_args, ctx) => {
      effects++;
      if (limit === 'calls') recordUsage(budget, { toolCalls: budget.maxToolCalls - budget.used.toolCalls });
      if (limit === 'time') now = budget.deadlineAt - 120000;
      if (limit === 'tokens') { const pool = currentRequestContext().budget; recordUsage(pool, { inputTokens: pool.maxInputTokens - pool.delivery.inputTokens - pool.used.inputTokens }); }
      return { ok: true, output: 'Concert is in Sydney. Harbour Halloween activity confirmed; ticket availability is still unknown.', completionSources: [{url:'https://fixture.invalid/activity', reading:'extracted', content:'Harbour Halloween activity 18:00'}] };
    } };
  registerTool(tool); t.after(() => unregisterTool(tool.id));
  const replyFn = async request => {
    if (request.purpose === 'limit-delivery') {
      deliveries++; assert.equal(request.maxTokens, 8192); assert.equal(request.workspacePath, null);
      assert.equal(request.nativeWebSearchEnabled, false); assert.equal(request.nativeImageGenerationEnabled, false);
      assert.deepEqual(request.tools, []); assert.match(JSON.stringify(request.messages), /Harbour Halloween/);
      return '已确认：Sydney Harbour Halloween 18:00。未核实：票量。下一步：查票。';
    }
    if (request.purpose === 'limit-check') {
      checks++; assert.deepEqual(request.tools, []);
      return JSON.stringify({ decision:'partial', reasonType:'unavailable', requirements:[{text:'ticket availability',status:'missing',evidenceIds:[]}] });
    }
    work++; return `<tool_call>${JSON.stringify({id:'read-'+work,name:tool.id,arguments:{}})}</tool_call>`;
  };
  const options = { config, replyFn, sseEmitter: kind => { if (limit === 'cancel' && kind === 'tool_calls_done') controller.abort(new Error('user stop')); }, signal: controller.signal, allowedToolIds: [tool.id], task: 'Find the concert city and same-day activities and verify tickets.' };
  const context = createRequestContext({ config, signal:controller.signal });
  const invoke = () => member ? runSubAgent({ ...options, maxTokens: 200000, maxIterations: limit === 'rounds' ? 1 : 20 })
    : runSkill({ ...options, skill:{id:'delivery-fixture',name:'fixture',type:'executable',systemPrompt:'Read and verify activities',maxIterations:limit === 'rounds' ? 1 : 12,toolWhitelist:[tool.id]} });
  const result = await withLegacyAgentFixture(invoke, {...context,budget});
  assert.equal(effects, 1); assert.equal(work, 1);
  if (limit === 'cancel') { assert.equal(deliveries, 0); assert.equal(checks, 0); assert.match(result.output, /Harbour Halloween/); return; }
  assert.equal(deliveries, 1); assert.equal(checks, 1); assert.equal(result.error, 'GOAL_INCOMPLETE');
  assert.equal(result.meta.completion.reason, 'LIMIT_DELIVERED'); assert.equal(result.meta.completion.outcome, 'partial');
  assert.match(result.output, /Harbour Halloween/); assert.match(result.output, /ticket availability/);
  assert.match(result.output, /继续/); assert.equal(result.ok, false);
  const handoff = createHandoff(options.task, result, {});
  assert.equal(handoff.completion.outcome, 'partial'); assert.match(handoff.conclusion, /Harbour Halloween/);
});
