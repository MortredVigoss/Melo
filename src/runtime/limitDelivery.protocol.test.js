import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubAgent, withLegacyAgentFixture } from '../testSupport/directAgentFixture.js';
import { registerTool, unregisterTool } from '../tools/registry.js';
import { createRunBudget, reserveDelivery } from './runBudget.js';
import { createRequestContext } from './requestContext.js';
import { runLimitDelivery } from './limitDelivery.js';
import { startGoal } from '../../shared/agent/goal.js';

// 2026-11-10 latency audit L1: a member (or the lead) that reaches a limit asks
// the model for one tool-free delivery and one tool-free check. Both requests
// used to leave the host with an empty tool list and no protocol, which the
// provider dispatcher reads as "OpenAI Responses". Every connection that is not
// a Responses connection answered with an error in a few hundred milliseconds,
// so the member's work was replaced by the host fallback text. These tests send
// the real requests through the real dispatcher to a local server and count
// which endpoint each one reached.

const DELIVERY = 'Confirmed: the harbour forecast is 19 C. Unverified: the wind. Next: read the wind page.';
const CHECK = JSON.stringify({ decision: 'partial', evaluationValid: true, needsEvaluation: false, turnKind: 'task', reasonType: 'unavailable', reason: 'wind missing', nextStep: '',
  requirements: [{ text: 'wind speed', kind: 'external_fact', status: 'missing', evidenceIds: [] }] });
const kindOf = systemText => /execution allowance is ending/.test(systemText) ? 'delivery' : /task completion checker/.test(systemText) ? 'check' : 'work';

async function startProvider(t) {
  const hits = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/messages')) {
      const kind = kindOf(JSON.stringify(body.system || ''));
      hits.push({ endpoint: 'messages', kind, tools: Array.isArray(body.tools) ? body.tools.length : null, keys: Object.keys(body).sort() });
      const content = kind === 'work' ? [{ type: 'tool_use', id: 'toolu_' + hits.length, name: body.tools[0].name, input: {} }]
        : [{ type: 'text', text: kind === 'delivery' ? DELIVERY : CHECK }];
      res.end(JSON.stringify({ id: 'msg_' + hits.length, model: body.model, content, stop_reason: kind === 'work' ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }));
      return;
    }
    if (req.url.endsWith('/chat/completions')) {
      const kind = kindOf(String(body.messages?.[0]?.content || ''));
      hits.push({ endpoint: 'chat', kind, tools: Array.isArray(body.tools) ? body.tools.length : null, keys: Object.keys(body).sort() });
      const native = Array.isArray(body.tools) && body.tools.length > 0;
      const message = kind !== 'work' ? { role: 'assistant', content: kind === 'delivery' ? DELIVERY : CHECK }
        : native ? { role: 'assistant', content: '', tool_calls: [{ id: 'call_' + hits.length, type: 'function', function: { name: body.tools[0].function.name, arguments: '{}' } }] }
        : { role: 'assistant', content: `<tool_call>${JSON.stringify({ id: 'call_' + hits.length, name: 'limit_protocol_read', arguments: {} })}</tool_call>` };
      res.end(JSON.stringify({ id: 'cmpl_' + hits.length, model: body.model, choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
      return;
    }
    hits.push({ endpoint: req.url.endsWith('/responses') ? 'responses' : 'other:' + req.url, kind: 'unexpected', keys: Object.keys(body).sort() });
    res.writeHead(404); res.end(JSON.stringify({ error: { message: 'This fixture does not serve ' + req.url } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { hits, base: `http://127.0.0.1:${server.address().port}/v1` };
}

const connections = {
  anthropic: { apiProtocol: 'anthropic', endpoint: 'messages' },
  'chat-completions with native tools': { apiProtocol: 'chat-completions', toolCalling: 'native', endpoint: 'chat' },
  'chat-completions with text tool calls': { apiProtocol: 'chat-completions', toolCalling: 'legacy', endpoint: 'chat' },
};

for (const [name, connection] of Object.entries(connections)) test(`a member at its round limit delivers its findings on a ${name} connection`, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-limit-protocol-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { hits, base } = await startProvider(t);
  let reads = 0;
  const tool = { id: 'limit_protocol_read', name: 'read', description: 'Read the fixture forecast', requiresPermission: false, readOnly: true,
    parametersSchema: { type: 'object', properties: {} },
    run: async () => { reads++; return { ok: true, output: 'Harbour forecast for tomorrow: 19 C.', completionSources: [{ url: 'https://fixture.invalid/forecast', reading: 'extracted', content: 'Harbour forecast for tomorrow: 19 C.' }] }; } };
  registerTool(tool); t.after(() => unregisterTool(tool.id));
  const config = { authMode: 'api-key', apiProtocol: connection.apiProtocol, apiKey: 'fixture-key', baseUrl: base, model: 'fixture-model', replyLanguage: 'en',
    modelResolvedForTurn: true, ...(connection.toolCalling ? { toolCalling: connection.toolCalling } : {}) };
  const budget = reserveDelivery(createRunBudget());
  const context = createRequestContext({ home, config, env: { MELO_MOCK_RESPONSE: '', NODE_TEST_CONTEXT: '', MELO_FUNCTION_CALLING: '', MELO_CHAT_TOOLS: '' } });
  const result = await withLegacyAgentFixture(() => runSubAgent({ config, allowedToolIds: [tool.id], maxIterations: 1, maxTokens: 200000,
    task: 'Find tomorrow\'s harbour forecast and the wind speed.' }), { ...context, budget });

  assert.equal(reads, 1, 'the tool ran once');
  assert.deepEqual(hits.filter(hit => hit.endpoint !== connection.endpoint), [], 'every request stays on the connection\'s own endpoint');
  assert.deepEqual(hits.map(hit => hit.kind), ['work', 'delivery', 'check']);
  // The delivery and its check carry no tool definitions on any protocol.
  for (const hit of hits.slice(1)) assert.equal(hit.tools, null, JSON.stringify(hit));
  assert.equal(result.meta.completion.reason, 'LIMIT_DELIVERED');
  assert.match(result.output, /harbour forecast is 19 C/);
  assert.doesNotMatch(result.output, /LOOP_STOPPED/);
});

test('the delivery request names the protocol of its connection', async () => {
  const seen = [];
  const createReply = async options => { seen.push({ toolProtocol: options.toolProtocol, functionTools: options.functionTools, tools: options.tools }); return DELIVERY; };
  const observations = [{ id: 'a', type: 'source', name: 'fetch_url', ok: true, executed: true, text: 'Forecast: 19 C' }];
  const run = options => runLimitDelivery({ task: startGoal('Find the forecast', 'run'), observations, reason: 'ROUND_LIMIT', fallback: 'fallback', createReply, options, budget: reserveDelivery(createRunBudget()), locale: 'en' });
  await run({ authMode: 'api-key', apiProtocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm' });
  await run({ authMode: 'codex', model: 'm' });
  await run({ authMode: 'api-key', apiProtocol: 'chat-completions', baseUrl: 'https://example.invalid/v1', model: 'm', toolCalling: 'native' });
  await run({ authMode: 'api-key', apiProtocol: 'chat-completions', baseUrl: 'https://example.invalid/v1', model: 'm', toolCalling: 'legacy' });
  assert.deepEqual(seen.map(row => row.toolProtocol), ['anthropic', 'anthropic', 'responses', 'responses', 'chat-completions', 'chat-completions', undefined, undefined]);
  // A text-protocol connection sends no native tool list at all; the others send an empty one.
  assert.deepEqual(seen.map(row => Array.isArray(row.functionTools)), [true, true, true, true, true, true, false, false]);
  for (const row of seen) assert.deepEqual(row.tools, []);
});
