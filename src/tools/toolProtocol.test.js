import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFunctionTool } from './functionSchema.js';
import { createFunctionCallingSession } from './functionCalling.js';
import { buildToolsSystemPrompt } from './systemPrompt.js';
import { TOOL_RESULT_CONTRACT_NOTE } from './toolResult.js';
import { fitRequestContext } from '../services/chat/contextBudget.js';
import { anthropicRequestBody, requestAnthropicReply } from '../providers/anthropic.js';
import { readChatCompletionsSseResponse } from '../providers/streams.js';
import { buildModelMessagesFromChat } from '../services/chat/messageBuilder.js';
import {
  resolveToolProtocol, toolDefinitionsForProtocol, parseAssistantResponse, toLoopMessages, renderToolMessage,
  toRequestMessages, buildToolChainRecord, toolChainToMessages, withAnthropicToolCache,
} from './toolProtocol.js';

const tool = { id: 'fixture_lookup', description: 'Read the requested fixture entry.', parametersSchema: {
  type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } };
const envelopeJson = (output, ok = true) => JSON.stringify({ ok, status: ok ? 'ok' : 'error', ...(ok ? {} : { code: 'NOT_FOUND', error: 'NOT_FOUND' }), output });

// ─── Resolution ──────────────────────────────────────────────────────────────

test('protocol resolution: responses / anthropic / opt-in chat-completions / xml default', () => {
  assert.equal(resolveToolProtocol({ authMode: 'codex' }), 'responses');
  assert.equal(resolveToolProtocol({ authMode: 'api-key', apiProtocol: 'responses' }), 'responses');
  assert.equal(resolveToolProtocol({ authMode: 'api-key', apiProtocol: 'chat-completions', baseUrl: 'https://api.openai.com/v1' }), 'responses');
  assert.equal(resolveToolProtocol({ authMode: 'api-key', apiProtocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }), 'anthropic');
  assert.equal(resolveToolProtocol({ authMode: 'api-key', baseUrl: 'https://api.anthropic.com/v1' }), 'anthropic');
  // chat-completions is opt-in: local-model quality varies, so the default stays XML.
  const deepseek = { authMode: 'api-key', apiProtocol: 'chat-completions', baseUrl: 'https://api.deepseek.com/v1' };
  assert.equal(resolveToolProtocol(deepseek), 'xml');
  assert.equal(resolveToolProtocol({ ...deepseek, toolCalling: 'native' }), 'chat-completions');
  assert.equal(resolveToolProtocol(deepseek, { MELO_CHAT_TOOLS: '1' }), 'chat-completions');
  assert.equal(resolveToolProtocol({ authMode: 'local', baseUrl: 'http://localhost:11434/v1', toolCalling: 'native' }), 'chat-completions');
  // legacy always wins, for every connection kind.
  assert.equal(resolveToolProtocol({ authMode: 'codex', toolCalling: 'legacy' }), 'xml');
  assert.equal(resolveToolProtocol({ ...deepseek, toolCalling: 'legacy' }, { MELO_CHAT_TOOLS: '1' }), 'xml');
  assert.equal(resolveToolProtocol({ authMode: 'api-key', apiProtocol: 'anthropic', toolCalling: 'legacy' }), 'xml');
  assert.equal(resolveToolProtocol({ authMode: 'api-key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-realtime' }), 'xml');
  // Session exposes protocol and the derived `native` getter.
  const session = createFunctionCallingSession({ ...deepseek, toolCalling: 'native' }, [tool]);
  assert.equal(session.protocol, 'chat-completions'); assert.equal(session.native, true);
  assert.equal(createFunctionCallingSession(deepseek, [tool]).native, false);
});

// ─── Definitions ─────────────────────────────────────────────────────────────

test('definitions are generated per protocol from the same compiled schema', () => {
  const compiled = [compileFunctionTool(tool)];
  const responses = toolDefinitionsForProtocol(compiled, 'responses');
  assert.deepEqual(responses, [{ type: 'function', name: 'fixture_lookup', description: tool.description, strict: true,
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { anyOf: [{ type: 'integer' }, { type: 'null' }] } }, required: ['query', 'limit'], additionalProperties: false } }]);
  assert.deepEqual(toolDefinitionsForProtocol(compiled, 'anthropic'),
    [{ name: 'fixture_lookup', description: tool.description, input_schema: tool.parametersSchema }]);
  assert.deepEqual(toolDefinitionsForProtocol(compiled, 'chat-completions'),
    [{ type: 'function', function: { name: 'fixture_lookup', description: tool.description, parameters: tool.parametersSchema } }]);
  assert.deepEqual(toolDefinitionsForProtocol(compiled, 'xml'), []);
  assert.deepEqual(createFunctionCallingSession({ authMode: 'api-key', apiProtocol: 'anthropic' }, [tool]).definitions[0].input_schema, tool.parametersSchema);
  // Loose protocols accept omitted optional fields; strict Responses does not.
  assert.deepEqual(compiled[0].parse('{"query":"A"}', { strict: false }).args, { query: 'A' });
  assert.deepEqual(compiled[0].parse('{"query":"A","limit":null}', { strict: false }).args, { query: 'A' });
  assert.equal(compiled[0].parse('{"query":"A"}').error, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(compiled[0].parse('{"query":9}', { strict: false }).error, 'INVALID_TOOL_ARGUMENTS');
});

test('native instructions and the result contract note cover all three native protocols; XML spec only for xml', () => {
  for (const protocol of ['responses', 'anthropic', 'chat-completions']) {
    const text = buildToolsSystemPrompt([tool], { native: true, protocol });
    assert.ok(text.includes(TOOL_RESULT_CONTRACT_NOTE), protocol);
    assert.doesNotMatch(text, /<tool_call>|Parameters:/);
  }
  assert.match(buildToolsSystemPrompt([tool], { native: true, protocol: 'anthropic' }), /tool_result blocks/);
  assert.match(buildToolsSystemPrompt([tool], { native: true, protocol: 'chat-completions' }), /tool-role messages/);
  assert.match(buildToolsSystemPrompt([tool], { native: true, protocol: 'responses' }), /function_call_output items/);
  assert.equal(buildToolsSystemPrompt([tool], { native: true }), buildToolsSystemPrompt([tool], { native: true, protocol: 'responses' }));
  assert.match(buildToolsSystemPrompt([tool], { native: false, protocol: 'xml' }), /<tool_call>|fixture_lookup/);
});

// ─── Responses: byte-identical to the pre-adapter chain ──────────────────────

test('responses protocol: definitions, parsed turn and loop messages are byte-identical to the pre-E1 snapshot', () => {
  const session = createFunctionCallingSession({ authMode: 'api-key', apiProtocol: 'responses', baseUrl: 'http://127.0.0.1:1/v1' }, [tool]);
  assert.equal(JSON.stringify(session.definitions), '[{"type":"function","name":"fixture_lookup","description":"Read the requested fixture entry.","parameters":{"type":"object","properties":{"query":{"type":"string"},"limit":{"anyOf":[{"type":"integer"},{"type":"null"}]}},"required":["query","limit"],"additionalProperties":false},"strict":true}]');
  assert.deepEqual(session.requestOptions().functionTools, session.definitions);
  const items = [{ type: 'reasoning', id: 'rs-1', summary: [], encrypted_content: 'opaque' }, { type: 'function_call', id: 'item-a', call_id: 'a', name: 'fixture_lookup', arguments: '{"query":"A","limit":null}', status: 'completed' }];
  const turn = session.parse({ protocol: 'responses', text: '', responseItems: items });
  assert.deepEqual(turn.toolCalls, [{ id: 'a', name: 'fixture_lookup', arguments: { query: 'A' } }]);
  assert.equal(turn.responseItems, items);
  const messages = session.append([{ role: 'user', content: 'go' }], turn, [{ call: turn.toolCalls[0], result: { ok: true, output: 'found A', status: 'ok' } }]);
  assert.equal(JSON.stringify(messages), '[{"role":"user","content":"go"},{"role":"assistant","content":"","responseItems":[{"type":"reasoning","id":"rs-1","summary":[],"encrypted_content":"opaque"},{"type":"function_call","id":"item-a","call_id":"a","name":"fixture_lookup","arguments":"{\\"query\\":\\"A\\",\\"limit\\":null}","status":"completed"}]},{"role":"user","content":"","isToolResult":true,"functionCallOutputs":[{"type":"function_call_output","call_id":"a","output":"{\\"ok\\":true,\\"status\\":\\"ok\\",\\"output\\":\\"found A\\"}"}]}]');
  // Rendering responses loop messages for responses is the identity.
  assert.deepEqual(toRequestMessages(messages, 'responses'), messages);
  // IR record of the turn keeps the wire name and raw arguments.
  const record = session.turnRecord(turn, [{ call: turn.toolCalls[0], result: { ok: true, output: 'found A', status: 'ok' } }]);
  assert.deepEqual(record, { text: '', toolCalls: [{ id: 'a', name: 'fixture_lookup', arguments: '{"query":"A"}' }],
    toolResults: [{ callId: 'a', name: 'fixture_lookup', output: envelopeJson('found A') }] });
});

// ─── Anthropic round trip ────────────────────────────────────────────────────

test('anthropic round trip: tool_use blocks → IR → tool_result user message, with cache_control on tools and system', () => {
  const session = createFunctionCallingSession({ authMode: 'api-key', apiProtocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }, [tool]);
  assert.equal(session.protocol, 'anthropic');
  const reply = { protocol: 'anthropic', text: '我先查一下。', stopReason: 'tool_use', content: [
    { type: 'text', text: '我先查一下。' },
    { type: 'tool_use', id: 'toolu_1', name: 'fixture_lookup', input: { query: 'A' } },
    { type: 'tool_use', id: 'toolu_2', name: 'fixture_lookup', input: { query: 9 } },
    { type: 'tool_use', id: 'toolu_3', name: 'missing_tool', input: {} },
  ] };
  const ir = parseAssistantResponse(reply, 'anthropic');
  assert.deepEqual(ir.toolCalls.map(c => [c.id, c.name, c.arguments]), [['toolu_1', 'fixture_lookup', '{"query":"A"}'], ['toolu_2', 'fixture_lookup', '{"query":9}'], ['toolu_3', 'missing_tool', '{}']]);
  const turn = session.parse(reply);
  assert.equal(turn.text, '我先查一下。');
  assert.deepEqual(turn.toolCalls[0], { id: 'toolu_1', name: 'fixture_lookup', arguments: { query: 'A' } });
  assert.equal(turn.toolCalls[1].rejectedResult.error, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(turn.toolCalls[2].rejectedResult.error, 'UNKNOWN_TOOL');
  assert.throws(() => session.parse(reply), /duplicate/, 'call ids are single-use inside a session');
  assert.throws(() => session.parse({ protocol: 'responses', text: '', responseItems: [] }), /Invalid model tool response/);
  const results = [
    { call: turn.toolCalls[0], result: { ok: true, status: 'ok', output: 'found A' } },
    { call: turn.toolCalls[1], result: turn.toolCalls[1].rejectedResult },
    { call: turn.toolCalls[2], result: turn.toolCalls[2].rejectedResult },
  ];
  const messages = session.append([{ role: 'user', content: '查 A' }], turn, results);
  assert.equal(messages.length, 3);
  assert.equal(messages[1].role, 'assistant'); assert.equal(messages[1].content, '我先查一下。');
  assert.deepEqual(messages[1].toolCalls.map(c => c.id), ['toolu_1', 'toolu_2', 'toolu_3']);
  assert.equal(messages[2].isToolResult, true);
  assert.deepEqual(messages[2].toolResults.map(r => r.callId), ['toolu_1', 'toolu_2', 'toolu_3']);
  assert.equal(messages[2].toolResults[0].output, envelopeJson('found A'));
  assert.equal(JSON.parse(messages[2].toolResults[1].output).error, 'INVALID_TOOL_ARGUMENTS');
  // The chain is indivisible for the context fitter.
  assert.deepEqual(fitRequestContext({ messages }).messages, messages);

  const body = anthropicRequestBody({ model: 'claude', systemPrompt: 'SYSTEM', messages, tools: session.definitions });
  assert.deepEqual(body.tools, [{ name: 'fixture_lookup', description: tool.description, input_schema: tool.parametersSchema, cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.tool_choice, { type: 'auto' });
  assert.deepEqual(body.system, [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.messages[0], { role: 'user', content: '查 A' });
  assert.equal(body.messages[1].role, 'assistant');
  assert.deepEqual(body.messages[1].content[0], { type: 'text', text: '我先查一下。' });
  assert.deepEqual(body.messages[1].content[1], { type: 'tool_use', id: 'toolu_1', name: 'fixture_lookup', input: { query: 'A' } });
  // Last assistant block carries the history breakpoint (3 breakpoints total: tools, system, history).
  assert.deepEqual(body.messages[1].content.at(-1).cache_control, { type: 'ephemeral' });
  assert.equal(JSON.stringify(body).match(/"cache_control"/g).length, 3);
  assert.deepEqual(body.messages[2], { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: envelopeJson('found A') },
    { type: 'tool_result', tool_use_id: 'toolu_2', content: messages[2].toolResults[1].output },
    { type: 'tool_result', tool_use_id: 'toolu_3', content: messages[2].toolResults[2].output },
  ] });
  // Without tools the body is unchanged from the text-only path.
  const plain = anthropicRequestBody({ model: 'claude', systemPrompt: 'SYSTEM', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal('tools' in plain, false); assert.equal('tool_choice' in plain, false);
  assert.deepEqual(withAnthropicToolCache([]), []);
});

test('anthropic streaming assembles tool_use input from input_json_delta and accepts stop_reason tool_use', async () => {
  const sse = events => {
    const bytes = new TextEncoder().encode(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 5) c.enqueue(bytes.slice(i, i + 5)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const events = [
    { type: 'message_start', message: { id: 'msg', model: 'claude-fixture', usage: { input_tokens: 10, cache_read_input_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '先查' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_s', name: 'fixture_lookup', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"que' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ry":"中国"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ];
  const deltas = [];
  let sentBody = null;
  const reply = await requestAnthropicReply({ baseUrl: 'https://fixture.test', apiKey: 'k', model: 'm', systemPrompt: 'S', tools: [{ name: 'fixture_lookup', description: 'd', input_schema: tool.parametersSchema }],
    messages: [{ role: 'user', content: 'hi' }], onDelta: d => deltas.push(d.delta), fetchImpl: async (url, init) => { sentBody = JSON.parse(init.body); return sse(events); } });
  assert.equal(sentBody.stream, true);
  assert.deepEqual(sentBody.tools[0].cache_control, { type: 'ephemeral' });
  assert.equal(reply.protocol, 'anthropic'); assert.equal(reply.text, '先查'); assert.equal(reply.stopReason, 'tool_use');
  assert.deepEqual(reply.content, [{ type: 'text', text: '先查' }, { type: 'tool_use', id: 'toolu_s', name: 'fixture_lookup', input: { query: '中国' } }]);
  assert.deepEqual(deltas, ['先查'], 'tool arguments never enter the streamed reply text');
  // Without tools, an unrequested tool_use is still an error (pre-E1 behaviour).
  await assert.rejects(requestAnthropicReply({ baseUrl: 'https://fixture.test', apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], onDelta() {}, fetchImpl: async () => sse(events) }), /未请求的工具调用/);
  // Tool-only turn (no text) is a valid reply when tools were sent.
  const toolOnly = await requestAnthropicReply({ baseUrl: 'https://fixture.test', apiKey: 'k', model: 'm', tools: [], messages: [{ role: 'user', content: 'hi' }], onDelta() {}, fetchImpl: async () => sse(events.filter(e => e.index !== 0)) });
  assert.equal(toolOnly.text, ''); assert.equal(toolOnly.content[0].type, 'tool_use');
});

// ─── chat-completions round trip ─────────────────────────────────────────────

test('chat-completions round trip: tool_calls → IR → tool-role messages, assistant tool_calls echoed as received', () => {
  const session = createFunctionCallingSession({ authMode: 'api-key', apiProtocol: 'chat-completions', baseUrl: 'https://api.deepseek.com/v1', toolCalling: 'native' }, [tool]);
  assert.deepEqual(session.requestOptions(), { functionTools: [{ type: 'function', function: { name: 'fixture_lookup', description: tool.description, parameters: tool.parametersSchema } }], toolProtocol: 'chat-completions' });
  const toolCalls = [
    { id: 'call_1', type: 'function', function: { name: 'fixture_lookup', arguments: '{"query":"A"}' } },
    { id: 'call_2', type: 'function', function: { name: 'fixture_lookup', arguments: '{"query":' } },
  ];
  const reply = { protocol: 'chat-completions', text: '', message: { role: 'assistant', content: null, tool_calls: toolCalls } };
  const turn = session.parse(reply);
  assert.deepEqual(turn.toolCalls[0], { id: 'call_1', name: 'fixture_lookup', arguments: { query: 'A' } });
  assert.equal(turn.toolCalls[1].rejectedResult.error, 'INVALID_TOOL_ARGUMENTS');
  const results = [{ call: turn.toolCalls[0], result: { ok: true, status: 'ok', output: 'found A' } }, { call: turn.toolCalls[1], result: turn.toolCalls[1].rejectedResult }];
  const messages = session.append([{ role: 'user', content: '查 A' }], turn, results);
  const rendered = toRequestMessages(messages, 'chat-completions');
  assert.deepEqual(rendered, [
    { role: 'user', content: '查 A' },
    { role: 'assistant', content: '', tool_calls: toolCalls },
    { role: 'tool', tool_call_id: 'call_1', content: envelopeJson('found A') },
    { role: 'tool', tool_call_id: 'call_2', content: messages[2].toolResults[1].output },
  ]);
  assert.equal(rendered[1].tool_calls[0], toolCalls[0], 'the provider object itself is echoed back');
  // Streamed delta.tool_calls (fragments by index) accumulate into the same shape.
  assert.deepEqual(fitRequestContext({ messages }).messages, messages);
});

test('chat-completions stream accumulates delta.tool_calls by index and finishes on finish_reason tool_calls', async () => {
  const sse = events => {
    const bytes = new TextEncoder().encode([...events.map(e => `data: ${JSON.stringify(e)}\n\n`), 'data: [DONE]\n\n'].join(''));
    return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const chunk = (delta, finish_reason = null) => ({ id: 'cmpl', model: 'qwen', choices: [{ index: 0, delta, finish_reason }] });
  const events = [
    chunk({ role: 'assistant', content: '' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'fixture_lookup', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'fixture_lookup', arguments: '{"query":"B"}' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"中国"}' } }] }),
    chunk({}, 'tool_calls'),
  ];
  const deltas = [];
  const reply = await readChatCompletionsSseResponse(sse(events), { returnToolResponse: true, onDelta: d => deltas.push(d.delta) });
  assert.deepEqual(reply, { protocol: 'chat-completions', text: '', message: { role: 'assistant', content: '', tool_calls: [
    { id: 'call_a', type: 'function', function: { name: 'fixture_lookup', arguments: '{"query":"中国"}' } },
    { id: 'call_b', type: 'function', function: { name: 'fixture_lookup', arguments: '{"query":"B"}' } },
  ] } });
  assert.deepEqual(deltas, []);
  // Text turn in tool mode keeps the text contract; without tool mode finish_reason tool_calls is still incomplete.
  const textReply = await readChatCompletionsSseResponse(sse([chunk({ content: '好的' }), chunk({}, 'stop')]), { returnToolResponse: true });
  assert.deepEqual(textReply, { protocol: 'chat-completions', text: '好的', message: { role: 'assistant', content: '好的' } });
  await assert.rejects(readChatCompletionsSseResponse(sse(events), {}), /incomplete/);
});

// ─── Persisted IR → any protocol ─────────────────────────────────────────────

test('persisted tool chain renders into every protocol and the history builder places it before the final prose', () => {
  const turns = [{ text: '先查', toolCalls: [{ id: 'c1', name: 'fixture_lookup', arguments: '{"query":"A"}' }],
    toolResults: [{ callId: 'c1', name: 'fixture_lookup', output: envelopeJson('x'.repeat(5000)) }] }];
  const chain = buildToolChainRecord(turns, { protocol: 'anthropic' });
  assert.equal(chain.version, 1); assert.equal(chain.protocol, 'anthropic'); assert.equal(chain.truncated, false);
  assert.ok(chain.turns[0].toolResults[0].output.length < 2000, 'outputs are bounded');
  assert.match(JSON.parse(chain.turns[0].toolResults[0].output).output, /condensed for history/);

  const responses = toolChainToMessages(chain, 'responses');
  assert.deepEqual(responses[0].responseItems, [
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '先查', annotations: [] }] },
    { type: 'function_call', call_id: 'c1', name: 'fixture_lookup', arguments: '{"query":"A"}' }]);
  assert.deepEqual(responses[1].functionCallOutputs.map(o => [o.type, o.call_id]), [['function_call_output', 'c1']]);
  const anthropic = toRequestMessages(toolChainToMessages(chain, 'anthropic'), 'anthropic');
  assert.deepEqual(anthropic[0].content[1], { type: 'tool_use', id: 'c1', name: 'fixture_lookup', input: { query: 'A' } });
  assert.equal(anthropic[1].content[0].tool_use_id, 'c1');
  const chat = toRequestMessages(toolChainToMessages(chain, 'chat-completions'), 'chat-completions');
  assert.deepEqual(chat[0].tool_calls, [{ id: 'c1', type: 'function', function: { name: 'fixture_lookup', arguments: '{"query":"A"}' } }]);
  assert.deepEqual(chat[1], { role: 'tool', tool_call_id: 'c1', content: chain.turns[0].toolResults[0].output });
  const xml = toolChainToMessages(chain, 'xml');
  assert.match(xml[0].content, /<tool_call>\n\{"id":"c1","name":"fixture_lookup","arguments":\{"query":"A"\}\}\n<\/tool_call>/);
  assert.match(xml[1].content, /<tool_result id="c1" name="fixture_lookup" ok="true" status="ok">/);
  assert.equal(renderToolMessage({ role: 'user', content: 'plain' }, 'anthropic'), null);

  const chatRecord = { id: 'chat', messages: [
    { id: 'u1', role: 'user', content: '查 A', createdAt: '2026-10-17T00:00:00Z' },
    { id: 'a1', role: 'assistant', content: '结果是 A。', createdAt: '2026-10-17T00:00:01Z', metadata: { toolChain: chain } },
    { id: 'u2', role: 'user', content: '继续', createdAt: '2026-10-17T00:00:02Z' },
  ] };
  // Default: prose only (pre-E1 history).
  assert.deepEqual(buildModelMessagesFromChat(chatRecord).map(m => m.role), ['user', 'assistant', 'user']);
  const withChain = buildModelMessagesFromChat(chatRecord, { toolChainProtocol: 'chat-completions' });
  assert.deepEqual(withChain.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.deepEqual(withChain[1].toolCalls.map(c => c.id), ['c1']);
  assert.equal(withChain[2].isToolResult, true);
  assert.equal(withChain[3].content, '结果是 A。');
  assert.ok(buildModelMessagesFromChat(chatRecord, { toolChainProtocol: 'responses' })[1].responseItems.some(i => i.type === 'function_call'));
  // Oversized chains drop the oldest turns first.
  const big = buildToolChainRecord(Array.from({ length: 40 }, (_, i) => ({ ...turns[0], toolCalls: [{ ...turns[0].toolCalls[0], id: `c${i}` }], toolResults: [{ ...turns[0].toolResults[0], callId: `c${i}` }] })), { protocol: 'responses' });
  assert.equal(big.truncated, true); assert.ok(big.turns.length < 40); assert.equal(big.turns.at(-1).toolCalls[0].id, 'c39');
  assert.deepEqual(toLoopMessages({ text: '', toolCalls: [], toolResults: [] }, 'anthropic')[0].toolCalls, []);
});
