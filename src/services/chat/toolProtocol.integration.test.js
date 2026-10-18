// Protocol adapter (design audit E1): one fixture integration test per native
// protocol through the real runner and a real local HTTP server. Each run is
// a tool-call turn followed by a text turn; the assertions pin the request
// body shapes, the second request carrying the tool results in the
// protocol's own shape, and the persisted protocol-neutral tool chain being
// rebuildable for the other protocols.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runChatAgentExecutionGraph } from './chatExecutionRunner.js';
import { buildModelMessagesFromChat } from './messageBuilder.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { registerTool, unregisterTool } from '../../tools/registryCore.js';
import { resolvePermission } from '../../tools/permissions.js';
import { toRequestMessages } from '../../tools/toolProtocol.js';

async function harness(t, { config: configOverrides, respond, env = {}, toolResult = null }) {
  const home = await mkdtemp(join(tmpdir(), 'melo-tool-protocol-'));
  const requests = [], events = [], executions = [], permissions = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ path: req.url, headers: req.headers, body });
    const reply = respond(requests.length, body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  registerTool({ id: 'fixture_lookup', name: 'Fixture lookup', description: 'Read the requested fixture entry.',
    parametersSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
    requiresPermission: true, isConcurrencySafe: true,
    run: async args => { executions.push(args.query); return toolResult ? toolResult(args) : { ok: true, output: `found ${args.query}` }; } });
  t.after(async () => { unregisterTool('fixture_lookup'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const config = { authMode: 'api-key', apiKey: 'fixture-key', model: 'fixture-model',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, activeLlmProfileId: 'fixture', conversationModelSelected: true, ...configOverrides };
  const text = '请调用工具读取本地代码并核对其中的内容';
  const chat = { id: 'protocol-chat', title: 'Fixture', mode: 'chat', agentId: 'main', projectId: null,
    messages: [{ id: 'user-1', role: 'user', content: text, createdAt: new Date().toISOString() }], sessionMemory: [] };
  const state = { projects: [], chats: [chat], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [],
    agentProfiles: { main: { id: 'main', name: 'Fixture', model: 'fixture-model', tools: [], skills: [], channels: {}, identity: '', soulMd: '' } },
    projectAgentOverrides: {}, settings: { selectedChatId: chat.id, selectedAgentId: 'main', activeMode: 'chat', promptHistory: [] } };
  const context = Object.freeze({ ...createRequestContext({ home, chatId: chat.id, config,
    env: { MELO_MOCK_RESPONSE: '', MELO_DIAGNOSTICS_RECORD: '0', MELO_FUNCTION_CALLING: '', MELO_PROMPT_DEBUG: '0', ...env } }),
    turnBinding: { role: 'main', project: null, taskId: null } });
  const run = signal => runWithRequestContext(context, () => runChatAgentExecutionGraph({ context, config, state, chat, signal,
    workspace: { rootPath: home, exists: false, entries: [], filePaths: [], fileCount: 0, commandTemplates: [], commandRuns: [] },
    connectors: [], skills: [], latestUserMessage: text, agentId: 'main', _dependencies: { getEmbedding: async () => null },
    sseEmitter(type, event) {
      events.push({ type, event });
      if (type === 'tool_permission') {
        permissions.push(event);
        void resolvePermission(event.requestId, event.args?.query !== 'B');
      }
    },
  }));
  return { requests, events, executions, permissions, run, chat };
}

// The persisted chain of one protocol must rebuild for the others.
function assertRebuildable(result, chat) {
  const toolChain = result.normalizedReply.toolChain;
  assert.ok(toolChain, 'the reply carries the protocol-neutral tool chain');
  assert.equal(toolChain.version, 1);
  assert.deepEqual(toolChain.turns[0].toolCalls.map(c => c.id), toolChain.turns[0].toolResults.map(r => r.callId));
  assert.ok(toolChain.turns[0].toolResults.every(r => JSON.parse(r.output).ok !== undefined), 'outputs are the envelope JSON');
  const persisted = { ...chat, messages: [...chat.messages,
    { id: 'assistant-1', role: 'assistant', content: result.normalizedReply.content, createdAt: new Date().toISOString(), metadata: { toolChain } },
    { id: 'user-2', role: 'user', content: '继续', createdAt: new Date().toISOString() }] };
  assert.deepEqual(buildModelMessagesFromChat(persisted).map(m => m.role), ['user', 'assistant', 'user'], 'history stays prose-only by default');
  const ids = toolChain.turns[0].toolCalls.map(c => c.id);
  const responses = buildModelMessagesFromChat(persisted, { toolChainProtocol: 'responses' });
  assert.deepEqual(responses[1].responseItems.filter(i => i.type === 'function_call').map(i => i.call_id), ids);
  assert.deepEqual(responses[2].functionCallOutputs.map(o => o.call_id), ids);
  const anthropic = toRequestMessages(buildModelMessagesFromChat(persisted, { toolChainProtocol: 'anthropic' }), 'anthropic');
  assert.deepEqual(anthropic[1].content.filter(b => b.type === 'tool_use').map(b => b.id), ids);
  assert.deepEqual(anthropic[2].content.map(b => b.tool_use_id), ids);
  const chatCompletions = toRequestMessages(buildModelMessagesFromChat(persisted, { toolChainProtocol: 'chat-completions' }), 'chat-completions');
  assert.deepEqual(chatCompletions[1].tool_calls.map(c => c.id), ids);
  assert.deepEqual(chatCompletions.slice(2, 2 + ids.length).map(m => [m.role, m.tool_call_id]), ids.map(id => ['tool', id]));
  const xml = buildModelMessagesFromChat(persisted, { toolChainProtocol: 'xml' });
  assert.match(xml[1].content, /<tool_call>/); assert.match(xml[2].content, /<tool_result id=/);
  // Call ids never leave their chat: another chat's history has none of them.
  const other = buildModelMessagesFromChat({ id: 'other', messages: [{ id: 'x', role: 'user', content: 'hi', createdAt: new Date().toISOString() }] }, { toolChainProtocol: 'responses' });
  assert.equal(JSON.stringify(other).includes(ids[0]), false);
}

test('anthropic: tools with cache_control, tool_use parsed, tool_result sent back, chain persisted', async t => {
  const h = await harness(t, {
    config: { apiProtocol: 'anthropic' },
    respond: round => round === 1
      ? { id: 'msg-1', model: 'claude-fixture', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, content: [
        { type: 'text', text: '我先读取。' },
        { type: 'tool_use', id: 'toolu_a', name: 'fixture_lookup', input: { query: 'A' } },
        { type: 'tool_use', id: 'toolu_b', name: 'fixture_lookup', input: { query: 'B' } },
        { type: 'tool_use', id: 'toolu_bad', name: 'fixture_lookup', input: { query: 9 } },
        { type: 'tool_use', id: 'toolu_hidden', name: 'not_in_role', input: { query: 'secret' } },
      ] }
      : { id: 'msg-2', model: 'claude-fixture', stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 12 }, content: [{ type: 'text', text: '核对完成。' }] },
  });
  const result = await h.run();
  assert.equal(result.normalizedReply.content, '核对完成。');
  assert.deepEqual(h.executions, ['A']);
  assert.equal(h.permissions.length, 2, 'invalid/unknown calls never reach the authorization gate');
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(r => r.path === '/v1/messages' && r.headers['x-api-key'] === 'fixture-key'));
  const first = h.requests[0].body;
  assert.deepEqual(first.tools.map(t => [t.name, Object.keys(t).sort().join(',')]), [['fixture_lookup', 'cache_control,description,input_schema,name']]);
  assert.deepEqual(first.tools.at(-1).cache_control, { type: 'ephemeral' });
  assert.deepEqual(first.tools[0].input_schema, { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] });
  assert.deepEqual(first.tool_choice, { type: 'auto' });
  assert.deepEqual(first.system.at(-1).cache_control, { type: 'ephemeral' });
  // The tools section rides in the turn context of the latest user message.
  assert.match(JSON.stringify(first.messages), /tool_result blocks/);
  assert.doesNotMatch(JSON.stringify(first), /<tool_call>/);
  assert.equal(first.stream, false);
  const second = h.requests[1].body;
  assert.deepEqual(second.tools, first.tools, 'tool definitions are stable across the turn');
  const assistant = second.messages.at(-2), results = second.messages.at(-1);
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.content[0], { type: 'text', text: '我先读取。' });
  assert.deepEqual(assistant.content.filter(b => b.type === 'tool_use').map(b => [b.id, b.name, b.input]),
    [['toolu_a', 'fixture_lookup', { query: 'A' }], ['toolu_b', 'fixture_lookup', { query: 'B' }], ['toolu_bad', 'fixture_lookup', { query: 9 }], ['toolu_hidden', 'not_in_role', { query: 'secret' }]]);
  assert.deepEqual(assistant.content.at(-1).cache_control, { type: 'ephemeral' }, 'history breakpoint sits on the last assistant block');
  assert.equal(results.role, 'user');
  assert.deepEqual(results.content.map(b => [b.type, b.tool_use_id]), [['tool_result', 'toolu_a'], ['tool_result', 'toolu_b'], ['tool_result', 'toolu_bad'], ['tool_result', 'toolu_hidden']]);
  const outputs = results.content.map(b => JSON.parse(b.content));
  assert.equal(outputs[0].ok, true); assert.equal(outputs[0].output, 'found A');
  assert.equal(outputs[1].ok, false);
  assert.equal(outputs[2].error, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(outputs[3].error, 'UNKNOWN_TOOL');
  assert.equal(JSON.stringify(h.requests).includes('<tool_result'), false);
  assert.equal(JSON.stringify(h.requests).includes('function_call_output'), false);
  assert.ok(h.events.some(e => e.type === 'execution_event' && e.event.status === 'completed' && e.event.name === 'fixture_lookup'));
  assert.equal(result.normalizedReply.toolChain.protocol, 'anthropic');
  assertRebuildable(result, h.chat);
});

test('chat-completions (opt-in): tools/tool_choice, tool_calls echoed back, tool-role results, chain persisted', async t => {
  const toolCalls = [
    { id: 'call_a', type: 'function', function: { name: 'fixture_lookup', arguments: '{"query":"A"}' } },
    { id: 'call_b', type: 'function', function: { name: 'fixture_lookup', arguments: '{"query":"B"}' } },
    { id: 'call_bad', type: 'function', function: { name: 'fixture_lookup', arguments: '{"query":' } },
    { id: 'call_hidden', type: 'function', function: { name: 'not_in_role', arguments: '{}' } },
  ];
  const h = await harness(t, {
    config: { apiProtocol: 'chat-completions', toolCalling: 'native' },
    respond: round => round === 1
      ? { id: 'cmpl-1', model: 'deepseek-fixture', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: toolCalls } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
      : { id: 'cmpl-2', model: 'deepseek-fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '核对完成。' } }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
  });
  const result = await h.run();
  assert.equal(result.normalizedReply.content, '核对完成。');
  assert.deepEqual(h.executions, ['A']);
  assert.equal(h.permissions.length, 2);
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(r => r.path === '/v1/chat/completions' && r.headers.authorization === 'Bearer fixture-key'));
  const first = h.requests[0].body;
  assert.deepEqual(first.tools, [{ type: 'function', function: { name: 'fixture_lookup', description: 'Read the requested fixture entry.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } } }]);
  assert.equal(first.tool_choice, 'auto');
  assert.equal(first.messages[0].role, 'system');
  assert.match(JSON.stringify(first.messages), /tool-role messages/);
  assert.doesNotMatch(JSON.stringify(first), /<tool_call>/);
  const second = h.requests[1].body;
  assert.deepEqual(second.tools, first.tools);
  const assistantIndex = second.messages.findIndex(m => m.role === 'assistant' && m.tool_calls);
  assert.ok(assistantIndex > 0);
  assert.deepEqual(second.messages[assistantIndex].tool_calls, toolCalls, 'assistant tool_calls are echoed exactly as received');
  const toolMessages = second.messages.slice(assistantIndex + 1, assistantIndex + 5);
  assert.deepEqual(toolMessages.map(m => [m.role, m.tool_call_id]), [['tool', 'call_a'], ['tool', 'call_b'], ['tool', 'call_bad'], ['tool', 'call_hidden']]);
  const outputs = toolMessages.map(m => JSON.parse(m.content));
  assert.equal(outputs[0].ok, true); assert.equal(outputs[0].output, 'found A');
  assert.equal(outputs[1].ok, false);
  assert.equal(outputs[2].error, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(outputs[3].error, 'UNKNOWN_TOOL');
  assert.equal(JSON.stringify(h.requests).includes('<tool_result'), false);
  assert.equal(result.normalizedReply.toolChain.protocol, 'chat-completions');
  assertRebuildable(result, h.chat);
});

test('chat-completions without opt-in stays on the XML protocol: no tools field, XML spec in the prompt', async t => {
  const h = await harness(t, {
    config: { apiProtocol: 'chat-completions' },
    respond: () => ({ id: 'cmpl', model: 'local', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '直接回答。' } }] }),
  });
  const result = await h.run();
  assert.equal(result.normalizedReply.content, '直接回答。');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].path, '/v1/chat/completions');
  assert.equal('tools' in h.requests[0].body, false);
  assert.match(JSON.stringify(h.requests[0].body.messages), /<tool_call>/);
  assert.equal(result.normalizedReply.toolChain, undefined);
});

test('responses: unchanged request shape and the same protocol-neutral chain is persisted', async t => {
  const fn = (id, query, name = 'fixture_lookup') => ({ type: 'function_call', id: `item-${id}`, call_id: id, name, arguments: JSON.stringify({ query, limit: null }), status: 'completed' });
  const home = await mkdtemp(join(tmpdir(), 'melo-tool-protocol-responses-'));
  const requests = [], executions = [];
  const done = output => `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'fixture-response', model: 'fixture-model', status: 'completed', output } })}\n\n`;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: JSON.parse(raw) });
    res.setHeader('content-type', 'text/event-stream');
    res.end(done(requests.length === 1 ? [fn('a', 'A')] : [{ type: 'message', role: 'assistant', id: 'answer', status: 'completed', content: [{ type: 'output_text', text: '核对完成。', annotations: [] }] }]));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  registerTool({ id: 'fixture_lookup', name: 'Fixture lookup', description: 'Read the requested fixture entry.',
    parametersSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
    requiresPermission: false, isConcurrencySafe: true, run: async args => { executions.push(args.query); return { ok: true, output: `found ${args.query}` }; } });
  t.after(async () => { unregisterTool('fixture_lookup'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const config = { authMode: 'api-key', apiProtocol: 'responses', apiKey: 'fixture-key', model: 'fixture-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, activeLlmProfileId: 'fixture', conversationModelSelected: true };
  const text = '请调用工具读取本地代码并核对其中的内容';
  const chat = { id: 'responses-chat', title: 'Fixture', mode: 'chat', agentId: 'main', projectId: null, messages: [{ id: 'user-1', role: 'user', content: text, createdAt: new Date().toISOString() }], sessionMemory: [] };
  const state = { projects: [], chats: [chat], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [],
    agentProfiles: { main: { id: 'main', name: 'Fixture', model: 'fixture-model', tools: [], skills: [], channels: {}, identity: '', soulMd: '' } },
    projectAgentOverrides: {}, settings: { selectedChatId: chat.id, selectedAgentId: 'main', activeMode: 'chat', promptHistory: [] } };
  const context = Object.freeze({ ...createRequestContext({ home, chatId: chat.id, config, env: { MELO_MOCK_RESPONSE: '', MELO_DIAGNOSTICS_RECORD: '0', MELO_FUNCTION_CALLING: '', MELO_PROMPT_DEBUG: '0' } }), turnBinding: { role: 'main', project: null, taskId: null } });
  const result = await runWithRequestContext(context, () => runChatAgentExecutionGraph({ context, config, state, chat,
    workspace: { rootPath: home, exists: false, entries: [], filePaths: [], fileCount: 0, commandTemplates: [], commandRuns: [] },
    connectors: [], skills: [], latestUserMessage: text, agentId: 'main', _dependencies: { getEmbedding: async () => null }, sseEmitter() {} }));
  assert.equal(result.normalizedReply.content, '核对完成。');
  assert.deepEqual(executions, ['A']);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.path === '/v1/responses'));
  assert.deepEqual(requests[0].body.tools, [{ type: 'function', name: 'fixture_lookup', description: 'Read the requested fixture entry.', strict: true,
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { anyOf: [{ type: 'integer' }, { type: 'null' }] } }, required: ['query', 'limit'], additionalProperties: false } }]);
  assert.equal(requests[0].body.tool_choice, 'auto'); assert.equal(requests[0].body.parallel_tool_calls, true);
  const input = requests[1].body.input;
  assert.deepEqual(input.filter(i => i.type === 'function_call').map(i => i.call_id), ['a']);
  assert.deepEqual(input.filter(i => i.type === 'function_call_output').map(i => [i.call_id, JSON.parse(i.output).output]), [['a', 'found A']]);
  assert.equal(result.normalizedReply.toolChain.protocol, 'responses');
  assert.deepEqual(result.normalizedReply.toolChain.turns[0].toolCalls, [{ id: 'a', name: 'fixture_lookup', arguments: '{"query":"A"}' }]);
  assertRebuildable(result, chat);
});

// ─── Tool images (web_screenshot `meta.modelImage`) ──────────────────────────

const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from('fixture-jpeg-bytes-for-the-model').toString('base64')}`;
const SIGNED_URL = 'http://127.0.0.1:43127/api/files/signed/screenshot-1.png?p=abc&e=1&s=def';
const screenshotResult = () => ({ ok: true, output: `Screenshot of "Example" (https://example.com/, 1280×960, tier headless) saved.\n\n![Example](${SIGNED_URL})`,
  meta: { url: 'https://example.com/', finalUrl: 'https://example.com/', title: 'Example', width: 1280, height: 960, tier: 'headless', path: '/tmp/x.png', signedUrl: SIGNED_URL, modelImage: JPEG_DATA_URL } });

test('anthropic: a result with meta.modelImage is shown to the model as an image block after the tool_result; history keeps no base64', async t => {
  const h = await harness(t, {
    config: { apiProtocol: 'anthropic' },
    toolResult: screenshotResult,
    respond: round => round === 1
      ? { id: 'msg-1', model: 'claude-fixture', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, content: [
        { type: 'tool_use', id: 'toolu_shot', name: 'fixture_lookup', input: { query: 'A' } }] }
      : { id: 'msg-2', model: 'claude-fixture', stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 5 }, content: [{ type: 'text', text: '页面是蓝色的。' }] },
  });
  const result = await h.run();
  assert.equal(result.normalizedReply.content, '页面是蓝色的。');
  assert.equal(h.requests.length, 2);
  const second = h.requests[1].body.messages;
  const resultIndex = second.findIndex(m => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
  assert.ok(resultIndex > 0);
  assert.deepEqual(second[resultIndex].content.map(b => b.tool_use_id), ['toolu_shot']);
  const imageMessage = second[resultIndex + 1];
  assert.equal(imageMessage.role, 'user');
  assert.deepEqual(imageMessage.content, [
    { type: 'text', text: '[fixture_lookup of https://example.com/]' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG_DATA_URL.split(',')[1] } },
  ]);
  assert.equal(JSON.stringify(h.requests[0].body).includes('base64'), false, 'first request has no image');
  const toolChain = result.normalizedReply.toolChain;
  assert.equal(JSON.stringify(toolChain).includes('base64'), false, 'persisted toolChain carries no base64');
  assert.equal(JSON.stringify(result.normalizedReply.toolResults || []).includes(JPEG_DATA_URL.slice(-40)), false);
  assert.ok(JSON.stringify(toolChain.turns[0].toolResults[0].output).includes(SIGNED_URL), 'the markdown image for the UI stays in the text output');
  assertRebuildable(result, h.chat);
});

test('responses: a result with meta.modelImage becomes an input_image user item after the function_call_output; image-free turns unchanged', async t => {
  const fn = (id, query) => ({ type: 'function_call', id: `item-${id}`, call_id: id, name: 'fixture_lookup', arguments: JSON.stringify({ query, limit: null }), status: 'completed' });
  const home = await mkdtemp(join(tmpdir(), 'melo-tool-protocol-images-'));
  const requests = [];
  const done = output => `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'fixture-response', model: 'fixture-model', status: 'completed', output } })}\n\n`;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: JSON.parse(raw) });
    res.setHeader('content-type', 'text/event-stream');
    res.end(done(requests.length === 1 ? [fn('shot', 'A')] : [{ type: 'message', role: 'assistant', id: 'answer', status: 'completed', content: [{ type: 'output_text', text: '页面是蓝色的。', annotations: [] }] }]));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  registerTool({ id: 'fixture_lookup', name: 'Fixture lookup', description: 'Read the requested fixture entry.',
    parametersSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
    requiresPermission: false, isConcurrencySafe: true, run: async () => screenshotResult() });
  t.after(async () => { unregisterTool('fixture_lookup'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const config = { authMode: 'api-key', apiProtocol: 'responses', apiKey: 'fixture-key', model: 'fixture-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, activeLlmProfileId: 'fixture', conversationModelSelected: true };
  const text = '请调用工具读取本地代码并核对其中的内容';
  const chat = { id: 'responses-images-chat', title: 'Fixture', mode: 'chat', agentId: 'main', projectId: null, messages: [{ id: 'user-1', role: 'user', content: text, createdAt: new Date().toISOString() }], sessionMemory: [] };
  const state = { projects: [], chats: [chat], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [],
    agentProfiles: { main: { id: 'main', name: 'Fixture', model: 'fixture-model', tools: [], skills: [], channels: {}, identity: '', soulMd: '' } },
    projectAgentOverrides: {}, settings: { selectedChatId: chat.id, selectedAgentId: 'main', activeMode: 'chat', promptHistory: [] } };
  const context = Object.freeze({ ...createRequestContext({ home, chatId: chat.id, config, env: { MELO_MOCK_RESPONSE: '', MELO_DIAGNOSTICS_RECORD: '0', MELO_FUNCTION_CALLING: '', MELO_PROMPT_DEBUG: '0' } }), turnBinding: { role: 'main', project: null, taskId: null } });
  const result = await runWithRequestContext(context, () => runChatAgentExecutionGraph({ context, config, state, chat,
    workspace: { rootPath: home, exists: false, entries: [], filePaths: [], fileCount: 0, commandTemplates: [], commandRuns: [] },
    connectors: [], skills: [], latestUserMessage: text, agentId: 'main', _dependencies: { getEmbedding: async () => null }, sseEmitter() {} }));
  assert.equal(result.normalizedReply.content, '页面是蓝色的。');
  assert.equal(requests.length, 2);
  const input = requests[1].body.input;
  const outputIndex = input.findIndex(i => i.type === 'function_call_output');
  assert.ok(outputIndex > 0);
  assert.equal(input[outputIndex].call_id, 'shot');
  const imageItem = input[outputIndex + 1];
  assert.deepEqual(imageItem, { role: 'user', content: [
    { type: 'input_text', text: '[fixture_lookup of https://example.com/]' },
    { type: 'input_image', detail: 'low', image_url: JPEG_DATA_URL },
  ] });
  assert.equal(input.filter(i => Array.isArray(i.content) && i.content.some(part => part.type === 'input_image')).length, 1, 'exactly one image item');
  assert.equal(JSON.stringify(requests[0].body).includes('input_image'), false);
  assert.equal(JSON.stringify(result.normalizedReply.toolChain).includes('base64'), false, 'persisted toolChain carries no base64');
  assert.equal(result.normalizedReply.toolChain.turns[0].images, undefined);
  assertRebuildable(result, chat);
});
