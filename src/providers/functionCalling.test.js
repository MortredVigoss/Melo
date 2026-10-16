import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createCodexResponsesReply, createApiResponsesReply, buildCodexResponsesInput, latestUserMessageHasImage, extractLatestUserTextForIntent } from '../openai.js';
import { readCodexSseResponse } from './streams.js';
import { createFunctionCallingSession } from '../tools/functionCalling.js';
import { createRequestContext } from '../runtime/requestContext.js';
import { runWithRequestContext } from '../runtime/requestScope.js';
import { registerTool, unregisterTool } from '../tools/registryCore.js';
import {runSubAgent} from '../testSupport/directAgentFixture.js';
import {runSkill} from '../testSupport/directAgentFixture.js';

const fn = { type: 'function', name: 'lookup', description: 'Read a fixture', strict: true,
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
const call = (id, query) => ({ type: 'function_call', id: 'item-' + id, call_id: id, name: 'lookup', arguments: JSON.stringify({ query }), status: 'completed' });
const reason = { type: 'reasoning', id: 'rs-1', summary: [], encrypted_content: 'opaque-fixture-reasoning' };
const message = text => ({ type: 'message', role: 'assistant', id: 'message-1', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const eventText = events => events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
const response = events => new Response(eventText(events), { headers: { 'content-type': 'text/event-stream' } });
const complete = output => ({ type: 'response.completed', response: { id: 'r-1', model: 'fixture-model', status: 'completed', output } });

test('tool outputs do not replace the latest actual user image or intent during continuation', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: '编辑这张图' }, { type: 'image_url', image_url: { url: 'https://fixture.invalid/image.png' } }] },
    { role: 'assistant', content: '', responseItems: [call('a', 'x')] },
    { role: 'user', content: '', isToolResult: true, functionCallOutputs: [] }];
  assert.equal(latestUserMessageHasImage(messages), true);
  assert.equal(extractLatestUserTextForIntent(messages), '编辑这张图');
  messages.push({ role: 'user', content: '其他事情' });
  assert.equal(latestUserMessageHasImage(messages), false);
});

test('Responses supports tool-only replies, interleaved argument deltas and terminal canonical items', async () => {
  const events = [
    { type: 'response.output_item.done', output_index: 0, item: reason },
    { type: 'response.output_item.added', output_index: 1, item: { ...call('call-A', ''), arguments: '', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 2, item: { ...call('call-B', ''), arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"query":"中' },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"query":"B"}' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '国"}' },
    { type: 'response.output_item.done', output_index: 2, item: call('call-B', 'B') },
    { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"query":"中国"}' },
    { type: 'response.output_item.done', output_index: 1, item: call('call-A', '中国') },
    complete([reason, call('call-A', '中国'), call('call-B', 'B')]),
  ];
  const bytes = new TextEncoder().encode(eventText(events));
  const stream = new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } });
  const deltas = [];
  const result = await readCodexSseResponse(new Response(stream), { returnToolResponse: true, onDelta: chunk => deltas.push(chunk) });
  assert.equal(result.text, '');
  assert.deepEqual(result.responseItems, [reason, call('call-A', '中国'), call('call-B', 'B')]);
  assert.deepEqual(deltas, [], 'arguments and encrypted reasoning never enter reply text');
});

test('incomplete or failed function streams never release a callable response', async () => {
  for (const events of [
    [{ type: 'response.output_item.done', output_index: 0, item: call('a', 'x') }],
    [{ type: 'response.incomplete', response: { output: [call('a', 'x')], status: 'incomplete' } }],
    [complete([{ ...call('a', 'x'), status: 'in_progress' }])],
    [{ type: 'response.failed', response: { error: { message: 'fixture failure' } } }],
  ]) {
    let released = 0;
    await assert.rejects(async () => { await readCodexSseResponse(response(events), { returnToolResponse: true }); released++; });
    assert.equal(released, 0);
  }
});

test('completed item fallback preserves response order when terminal output is omitted', async () => {
  const result = await readCodexSseResponse(response([
    { type: 'response.output_item.done', output_index: 1, item: call('a', 'x') },
    { type: 'response.output_item.done', output_index: 0, item: reason },
    { type: 'response.completed', response: { status: 'completed' } },
  ]), { returnToolResponse: true });
  assert.deepEqual(result.responseItems, [reason, call('a', 'x')]);
});

test('OAuth and public API payloads send native function definitions and replay call outputs unchanged', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-functions-payload-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const context = createRequestContext({ home, env: { MELO_MOCK_RESPONSE: '', MELO_DIAGNOSTICS_RECORD: '0' } });
  const messages = [{ role: 'user', content: 'Read fixture' },
    { role: 'assistant', content: '', responseItems: [reason, call('a', 'x')] },
    { role: 'user', content: '', isToolResult: true, functionCallOutputs: [{ type: 'function_call_output', call_id: 'a', output: '{"ok":true,"output":"value"}' }] }];
  await runWithRequestContext(context, async () => {
    for (const invoke of [createCodexResponsesReply, createApiResponsesReply]) {
      let body, url;
      const reply = await invoke({ model: 'gpt-6.1-sol', apiKey: 'fixture-key', baseUrl: invoke === createApiResponsesReply ? 'https://api.openai.com/v1' : 'https://chatgpt.com/backend-api',
        systemPrompt: 'fixture', messages, functionTools: [fn], nativeWebSearchEnabled: false,
        _credentialProvider: async () => ({ loggedIn: true, accountId: 'fixture-account', accessToken: 'fixture-token' }),
        _fetchImpl: async (target, options) => { url = target; body = JSON.parse(options.body); return response([complete([message('done')])]); } });
      assert.equal(reply.text, 'done');
      assert.equal(body.store, false);
      assert.deepEqual(body.tools, [fn]);
      assert.deepEqual(body.input.slice(1), [reason, call('a', 'x'), ...messages[2].functionCallOutputs]);
      assert.ok(body.include.includes('reasoning.encrypted_content'));
      assert.ok(url.endsWith('/responses'));
    }
  });
  assert.deepEqual((await buildCodexResponsesInput(messages)).slice(1), [reason, call('a', 'x'), ...messages[2].functionCallOutputs]);
});

test('sub-agent and skill execute native same-tool batches through real local HTTP and retain every continuation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-functions-loop-'));
  let requests = [], executions = [], toolName = 'fixture_lookup';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ url: req.url, body });
    const round = requests.length;
    const output = round === 1 ? [reason, { ...call('a', 'A'), name: toolName }, { ...call('b', 'B'), name: toolName }]
      : round === 2 ? [{ ...reason, id: 'rs-2' }, { ...call('c', 'C'), name: toolName }] : [message('done')];
    res.setHeader('content-type', 'text/event-stream'); res.end(eventText([complete(output)]));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  registerTool({ id: toolName, name: 'Fixture', description: 'Read a fixture entry', parametersSchema: fn.parameters,
    requiresPermission: false, isConcurrencySafe: true, run: async args => { executions.push(args.query); return { ok: true, output: args.query }; } });
  t.after(async () => { unregisterTool(toolName); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const config = { authMode: 'api-key', apiProtocol: 'responses', apiKey: 'fixture-key', model: 'fixture-model',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, activeLlmProfileId: 'fixture' };
  const context = createRequestContext({ home, config, env: { MELO_MOCK_RESPONSE: '', MELO_DIAGNOSTICS_RECORD: '0' } });
  await runWithRequestContext(context, async () => {
    for (const invoke of [runSubAgent, runSkill]) {
      requests = []; executions = [];
      const result = await invoke({ task: 'Look up three fixture entries', config, allowedToolIds: [toolName],
        skill: { id: 'fixture', name: 'Fixture', type: 'executable', maxIterations: 4, toolWhitelist: [toolName] } });
      assert.equal(result.output, 'done'); assert.equal(result.ok, true);
      assert.deepEqual(executions, ['A', 'B', 'C']);
      assert.ok(requests.every(r => r.url === '/v1/responses'));
      assert.ok(requests.every(r => r.body.tools.length === 1 && r.body.tools[0].name === toolName));
      const input = requests[2].body.input;
      assert.deepEqual(input.filter(i => i.type === 'function_call_output').map(i => i.call_id), ['a', 'b', 'c']);
      assert.deepEqual(input.filter(i => i.type === 'reasoning').map(i => i.id), ['rs-1', 'rs-2']);
      assert.equal(JSON.stringify(requests).includes('<tool_result'), false);
    }
  });
});
