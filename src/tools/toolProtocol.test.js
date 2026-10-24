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
  toolImagesMessage, normalizeToolImages, MAX_TOOL_IMAGES_PER_TURN, MAX_TOOL_IMAGE_DATA_CHARS,
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
  assert.equal(resolveToolProtocol({ authMode: 'api-key', baseUrl: 'https://api.openai.com/v1', model: 'custom', modelCapabilities:{custom:{tools:false}} }), 'xml');
  assert.equal(resolveToolProtocol({ ...deepseek, model:'audio-realtime-custom', toolCalling:'native' }), 'chat-completions');
  assert.equal(resolveToolProtocol(deepseek,{MELO_FUNCTION_CALLING:'true'}),'chat-completions');
  assert.equal(resolveToolProtocol({...deepseek,toolCalling:'native'},{MELO_FUNCTION_CALLING:'false'}),'xml');
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
  // Bug audit T13: tool-call-only turns echo `content: null`, tool messages carry `name`.
  assert.deepEqual(rendered, [
    { role: 'user', content: '查 A' },
    { role: 'assistant', content: null, tool_calls: toolCalls },
    { role: 'tool', tool_call_id: 'call_1', name: 'fixture_lookup', content: envelopeJson('found A') },
    { role: 'tool', tool_call_id: 'call_2', name: 'fixture_lookup', content: messages[2].toolResults[1].output },
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
  assert.deepEqual(chat[1], { role: 'tool', tool_call_id: 'c1', name: 'fixture_lookup', content: chain.turns[0].toolResults[0].output });
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

// ─── Tool images (web_screenshot) ────────────────────────────────────────────

const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from('fixture-jpeg-bytes').toString('base64')}`;
const shotResult = { ok: true, status: 'ok', output: 'Screenshot of "Example" saved.\n\n![Example](http://127.0.0.1:43127/api/files/signed/s.png?p=a&e=1&s=b)',
  meta: { url: 'https://example.com/', finalUrl: 'https://example.com/', modelImage: JPEG_DATA_URL } };
const shotCall = { id: 'call_shot', name: 'web_screenshot', arguments: { url: 'https://example.com/' } };
const shotTool = { id: 'web_screenshot', description: 'Screenshot a page.', parametersSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } };

test('tool images: one extra user message after the results on native protocols, none on xml, requests without images unchanged', () => {
  for (const [config, protocol] of [[{ apiProtocol: 'responses', authMode: 'api-key' }, 'responses'], [{ apiProtocol: 'anthropic' }, 'anthropic'], [{ apiProtocol: 'chat-completions', toolCalling: 'native' }, 'chat-completions']]) {
    const session = createFunctionCallingSession(config, [shotTool]);
    assert.equal(session.protocol, protocol);
    const images = session.imagesOf([{ call: shotCall, result: shotResult }, { call: { id: 'c2', name: 'web_screenshot', arguments: {} }, result: { ok: false, output: 'x' } }]);
    assert.deepEqual(images, [{ callId: 'call_shot', name: 'web_screenshot', text: '[web_screenshot of https://example.com/]', dataUrl: JPEG_DATA_URL, detail: 'low' }]);
    const base = [{ role: 'user', content: 'show me' }];
    assert.strictEqual(session.appendToolImages(base, []), base, 'no images → same array');
    const withImages = session.appendToolImages(base, images);
    assert.equal(withImages.length, 2);
    const message = withImages[1];
    assert.equal(message.role, 'user'); assert.equal(message.isToolResult, true);
    assert.deepEqual(message.toolImages, [{ callId: 'call_shot', name: 'web_screenshot', text: '[web_screenshot of https://example.com/]' }]);
    assert.deepEqual(message.content, [{ type: 'text', text: '[web_screenshot of https://example.com/]' }, { type: 'image_url', image_url: { url: JPEG_DATA_URL, detail: 'low' } }]);
    // The image message is an ordinary user message for the transports.
    assert.equal(renderToolMessage(message, protocol), null);
    if (protocol === 'anthropic') {
      const body = anthropicRequestBody({ model: 'm', systemPrompt: 's', messages: withImages, promptCache: false });
      assert.deepEqual(body.messages[1].content, [{ type: 'text', text: '[web_screenshot of https://example.com/]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG_DATA_URL.split(',')[1] } }]);
    }
    // Turn record carries bounded images; the persisted chain drops them.
    const record = session.turnRecord({ text: '', toolCalls: [shotCall], protocolCalls: [{ id: 'call_shot', name: 'web_screenshot', arguments: '{"url":"https://example.com/"}' }] }, [{ call: shotCall, result: shotResult }]);
    assert.equal(record.images.length, 1);
    const chain = buildToolChainRecord([record], { protocol });
    assert.equal(JSON.stringify(chain).includes('base64'), false, 'persisted history never carries base64');
    assert.equal('images' in chain.turns[0], false);
    assert.deepEqual(toLoopMessages({ ...record }, protocol).length, 3, 'IR with images renders three loop messages');
    assert.deepEqual(toolChainToMessages(chain, protocol).length, 2, 'rebuilt history has no image message');
  }
  const xml = createFunctionCallingSession({ apiProtocol: 'chat-completions' }, [shotTool]);
  assert.equal(xml.protocol, 'xml');
  assert.deepEqual(xml.imagesOf([{ call: shotCall, result: shotResult }]), []);
  const base = [{ role: 'user', content: 'show me' }];
  assert.strictEqual(xml.appendToolImages(base, [{ callId: 'call_shot', name: 'web_screenshot', text: 't', dataUrl: JPEG_DATA_URL }]), base);
  assert.equal(toLoopMessages({ text: '', toolCalls: [], toolResults: [], images: [{ callId: 'x', name: 'web_screenshot', text: 't', dataUrl: JPEG_DATA_URL }] }, 'xml').length, 2);
});

test('tool images are bounded: at most 4 per turn, data URLs only, oversized ones dropped; the fitter counts them as images not prose', async () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ callId: `c${i}`, name: 'web_screenshot', text: `[shot ${i}]`, dataUrl: JPEG_DATA_URL }));
  assert.equal(normalizeToolImages(many).length, MAX_TOOL_IMAGES_PER_TURN);
  assert.deepEqual(normalizeToolImages([{ callId: 'a', name: 'x', dataUrl: 'https://example.com/a.jpg' }, { callId: 'b', name: 'x', dataUrl: 'data:text/plain;base64,QUJD' },
    { callId: 'c', name: 'x', dataUrl: `data:image/png;base64,${'A'.repeat(MAX_TOOL_IMAGE_DATA_CHARS)}` }]), []);
  const big = toolImagesMessage([{ callId: 'c', name: 'web_screenshot', text: 't', dataUrl: `data:image/jpeg;base64,${'A'.repeat(400_000)}` }], 'responses');
  const { estimateMessageTokens } = await import('../memory/tokenEstimate.js');
  assert.ok(estimateMessageTokens(big) < 3000, 'a 400 KB data URL costs one image, not 100k prose tokens');
  const request = fitRequestContext({ sections: [{ id: 'sys', text: 'system', required: true }], messages: [{ role: 'user', content: 'show me' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_shot', name: 'web_screenshot', arguments: '{}' }] },
    { role: 'user', content: '', isToolResult: true, toolResults: [{ callId: 'call_shot', name: 'web_screenshot', output: envelopeJson('saved') }] }, big], totalTokens: 60000, outputReserve: 8000 });
  assert.equal(request.messages.length, 4, 'the image message stays with its tool chain');
});

test('compactToolChain condenses older tool images to text and keeps the newest', async () => {
  const { compactToolChain } = await import('./functionCalling.js');
  const image = () => toolImagesMessage([{ callId: 'c', name: 'web_screenshot', text: '[web_screenshot of https://example.com/]', dataUrl: JPEG_DATA_URL }], 'responses');
  const results = i => ({ role: 'user', content: '', isToolResult: true, functionCallOutputs: [{ type: 'function_call_output', call_id: `c${i}`, output: envelopeJson('x') }] });
  const messages = [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', responseItems: [] }, results(1), image(),
    { role: 'assistant', content: '', responseItems: [] }, results(2), image()];
  const { messages: next, changed } = compactToolChain(messages, { keepRecentResults: 2 });
  assert.equal(changed, true);
  assert.equal(typeof next[3].content, 'string'); assert.match(next[3].content, /no longer attached/); assert.equal(next[3].toolImagesCondensed, true);
  assert.equal(JSON.stringify(next[3]).includes('base64'), false);
  assert.deepEqual(next[6], messages[6], 'newest image kept');
  assert.equal(compactToolChain(next, { keepRecentResults: 2 }).changed, false);
});

// ─── Bug audit 2026-10-18 (T6 / T11 / T12 / T18) ─────────────────────────────

test('T11/T12: empty arguments parse as {} and id-less chat-completions tool_calls get session-unique call_<n> ids', () => {
  const optional = { id: 'fixture_ping', description: 'Ping.', parametersSchema: { type: 'object', properties: { note: { type: 'string' } } } };
  assert.deepEqual(compileFunctionTool(optional).parse('', { strict: false }), { args: {} });
  assert.deepEqual(compileFunctionTool(optional).parse('   ', { strict: false }), { args: {} });
  assert.equal(compileFunctionTool(tool).parse('', { strict: false }).error, 'INVALID_TOOL_ARGUMENTS', 'required fields are still enforced after the empty payload becomes {}');
  const session = createFunctionCallingSession({ authMode: 'api-key', apiProtocol: 'chat-completions', baseUrl: 'http://localhost:11434/v1', toolCalling: 'native' }, [optional]);
  const reply = calls => ({ protocol: 'chat-completions', text: '', message: { role: 'assistant', content: null, tool_calls: calls } });
  const first = session.parse(reply([{ type: 'function', function: { name: 'fixture_ping', arguments: '' } }, { id: 'call_2', type: 'function', function: { name: 'fixture_ping', arguments: '{}' } }]));
  assert.deepEqual(first.toolCalls.map(c => c.id), ['call_1', 'call_2'], 'a synthesized id never collides with a real one in the same batch');
  assert.deepEqual(first.toolCalls[0].arguments, {});
  const second = session.parse(reply([{ type: 'function', function: { name: 'fixture_ping', arguments: '' } }]));
  assert.deepEqual(second.toolCalls.map(c => c.id), ['call_3'], 'ids keep increasing across turns so seenCallIds never rejects them');
  const rendered = toRequestMessages(session.append([], first, first.toolCalls.map(call => ({ call, result: { ok: true, status: 'ok', output: 'pong' } }))), 'chat-completions');
  assert.deepEqual(rendered[0].tool_calls.map(c => c.id), ['call_1', 'call_2'], 'the echoed raw tool_call carries the synthesized id');
  assert.equal(rendered[0].content, null);
});

test('T18: replayed chains re-mint ids that repeat (XML call_001 per turn, chains of several replies) and keep unique well-formed ids', () => {
  const turn = (id, query) => ({ text: '', toolCalls: [{ id, name: 'fixture_lookup', arguments: JSON.stringify({ query }) }], toolResults: [{ callId: id, name: 'fixture_lookup', output: envelopeJson(`found ${query}`) }] });
  // Same id in two turns of one reply (what the XML protocol produces).
  const xmlChain = buildToolChainRecord([turn('call_001', 'A'), turn('call_001', 'B')], { protocol: 'xml' });
  const responses = toolChainToMessages(xmlChain, 'responses');
  const callIds = responses.filter(m => m.responseItems).flatMap(m => m.responseItems.filter(i => i.type === 'function_call').map(i => i.call_id));
  const outputIds = responses.filter(m => m.functionCallOutputs).flatMap(m => m.functionCallOutputs.map(o => o.call_id));
  assert.equal(new Set(callIds).size, 2, 'duplicate ids are re-minted');
  assert.deepEqual(outputIds, callIds, 'results follow their calls');
  assert.ok(callIds.every(id => /^[A-Za-z0-9_-]+$/.test(id)));
  // Unique, well-formed ids are preserved; a malformed one forces a remap.
  const clean = buildToolChainRecord([turn('toolu_01A', 'A')], { protocol: 'anthropic' });
  assert.equal(toolChainToMessages(clean, 'responses')[0].responseItems.find(i => i.type === 'function_call').call_id, 'toolu_01A');
  const odd = buildToolChainRecord([turn('call 001!', 'A')], { protocol: 'xml' });
  assert.notEqual(toolChainToMessages(odd, 'anthropic')[0].toolCalls[0].id, 'call 001!');
  // Two replies in one chat both recorded `call_1`: the history builder keeps every id unique.
  const chainA = buildToolChainRecord([turn('call_1', 'A')], { protocol: 'chat-completions' });
  const chainB = buildToolChainRecord([turn('call_1', 'B')], { protocol: 'chat-completions' });
  const chat = { id: 'chat', messages: [
    { id: 'u1', role: 'user', content: '查 A', createdAt: '2026-10-17T00:00:00Z' },
    { id: 'a1', role: 'assistant', content: 'A。', createdAt: '2026-10-17T00:00:01Z', metadata: { toolChain: chainA } },
    { id: 'u2', role: 'user', content: '查 B', createdAt: '2026-10-17T00:00:02Z' },
    { id: 'a2', role: 'assistant', content: 'B。', createdAt: '2026-10-17T00:00:03Z', metadata: { toolChain: chainB } },
    { id: 'u3', role: 'user', content: '继续', createdAt: '2026-10-17T00:00:04Z' },
  ] };
  const history = toRequestMessages(buildModelMessagesFromChat(chat, { toolChainProtocol: 'anthropic' }), 'anthropic');
  const useIds = history.filter(m => m.role === 'assistant' && Array.isArray(m.content)).flatMap(m => m.content.filter(b => b.type === 'tool_use').map(b => b.id));
  const resultIds = history.filter(m => m.role === 'user' && Array.isArray(m.content)).flatMap(m => m.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id));
  assert.equal(useIds.length, 2);
  assert.equal(new Set(useIds).size, 2, 'ids repeated across replies are unique in the request');
  assert.deepEqual(resultIds, useIds);
  assert.equal(useIds[0], 'call_1', 'the first reply keeps its original id');
});

test('T6: the persisted tool chain redacts secret values inside outputs', () => {
  const chain = buildToolChainRecord([{ text: '', toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"curl"}' }],
    toolResults: [{ callId: 'c1', name: 'bash', output: envelopeJson('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c\nOPENAI_API_KEY=sk-proj-abcdefghijklmnop https://u:p@h.test/x?token=abc123') }] }], { protocol: 'xml' });
  const output = chain.turns[0].toolResults[0].output;
  assert.doesNotMatch(output, /sflKxwRJ|sk-proj-abcdefghijklmnop|u:p@|token=abc123/);
  assert.match(output, /Bearer \[redacted\]/);
  assert.equal(JSON.parse(output).ok, true, 'the envelope JSON stays valid after redaction');
});

test('T10: on the XML protocol a screenshot result tells the model the image is not attached', async () => {
  const { IMAGE_NOT_ATTACHED_NOTE } = await import('./functionCalling.js');
  const session = createFunctionCallingSession({ authMode: 'api-key', apiProtocol: 'chat-completions', baseUrl: 'http://localhost:11434/v1' }, [shotTool]);
  assert.equal(session.protocol, 'xml');
  const turn = session.parse('<tool_call>{"id":"call_shot","name":"web_screenshot","arguments":{"url":"https://example.com/"}}</tool_call>');
  const messages = session.append([{ role: 'user', content: '看看' }], turn, [{ call: turn.toolCalls[0], result: shotResult }]);
  assert.ok(messages[2].content.includes(IMAGE_NOT_ATTACHED_NOTE), messages[2].content);
  assert.equal(JSON.stringify(messages).includes('base64,'), false, 'no image data on xml');
  // Native protocols attach the image and add no such note.
  const native = createFunctionCallingSession({ authMode: 'api-key', apiProtocol: 'anthropic' }, [shotTool]);
  const nativeTurn = { text: '', protocol: 'anthropic', toolCalls: [shotCall], protocolCalls: [{ id: 'call_shot', name: 'web_screenshot', arguments: '{}' }] };
  const nativeMessages = native.append([], nativeTurn, [{ call: shotCall, result: shotResult }]);
  assert.equal(JSON.stringify(nativeMessages).includes(IMAGE_NOT_ATTACHED_NOTE), false);
});
