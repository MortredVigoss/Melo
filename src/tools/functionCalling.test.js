import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFunctionTool, functionName } from './functionSchema.js';
import { createFunctionCallingSession, supportsResponsesFunctions } from './functionCalling.js';
import { fitRequestContext } from '../services/chat/contextBudget.js';
import { buildToolsSystemPrompt } from './systemPrompt.js';

const tool = { id: 'mcp:server:lookup', description: 'Look up an entry.', parametersSchema: {
  type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 },
    filter: { type: 'object', properties: { tag: { type: 'string' } } },
    explicitNull: { type: ['string', 'null'] } }, required: ['query'],
} };
const envelope = calls => ({ protocol: 'responses', text: '', responseItems: calls });
const call = (id = 'call-A', args = { query: '中国', limit: null, filter: { tag: null }, explicitNull: null }) => ({
  type: 'function_call', id: 'item-' + id, call_id: id, name: functionName(tool.id), arguments: JSON.stringify(args),
});

test('strict conversion retains original schema and restores omitted optional values without coercion', () => {
  const original = structuredClone(tool.parametersSchema);
  const compiled = compileFunctionTool(tool);
  assert.equal(compiled.definition.strict, true);
  assert.equal(compiled.definition.parameters.additionalProperties, false);
  assert.deepEqual(compiled.definition.parameters.required, ['query', 'limit', 'filter', 'explicitNull']);
  assert.deepEqual(compiled.parse(call().arguments).args, { query: '中国', filter: {}, explicitNull: null });
  assert.deepEqual(tool.parametersSchema, original);
  for (const raw of ['{', '[]', 'null', '3', JSON.stringify({ query: 3 }),
    call('a', { query: 'x', limit: '2', filter: null, explicitNull: null }).arguments,
    call('a', { query: 'x', limit: 12, filter: null, explicitNull: null }).arguments,
    call('a', { query: 'x', limit: null, filter: null, explicitNull: null, extra: true }).arguments]) {
    assert.equal(compiled.parse(raw).error, 'INVALID_TOOL_ARGUMENTS', raw);
  }
});

test('dictionary and compound schemas use explicit non-strict mode without losing keys', () => {
  const dictionary = { ...tool, parametersSchema: { type: 'object', properties: {
    headers: { type: 'object', additionalProperties: { type: 'string' } },
  }, required: ['headers'] } };
  const compiled = compileFunctionTool(dictionary);
  assert.equal(compiled.definition.strict, false);
  assert.deepEqual(compiled.definition.parameters, dictionary.parametersSchema);
  assert.deepEqual(compiled.parse('{"headers":{"custom":"value"}}').args, { headers: { custom: 'value' } });
  assert.equal(compiled.parse('{"headers":{"custom":4}}').error, 'INVALID_TOOL_ARGUMENTS');
  const nested = '{"x":'.repeat(70) + '1' + '}'.repeat(70);
  assert.equal(compiled.parse(nested).error, 'INVALID_TOOL_ARGUMENTS');
  const union = compileFunctionTool({ ...tool, parametersSchema: { type: 'object', properties: {
    value: { anyOf: [{ type: 'object', properties: { name: { type: 'string' } } }, { type: 'string' }] },
  } } });
  assert.equal(union.definition.strict, false);
});

test('local references preserve nested optional semantics and invalid schemas fail closed', () => {
  const compiled = compileFunctionTool({ ...tool, parametersSchema: { type: 'object', properties: {
    filter: { $ref: '#/$defs/filter' },
  }, $defs: { filter: { type: 'object', properties: { tag: { type: 'string' } } } } } });
  assert.deepEqual(compiled.parse('{"filter":{"tag":null}}').args, { filter: {} });
  const recursive = compileFunctionTool({ ...tool, parametersSchema: { type: 'object', properties: {
    value: { type: 'string' }, child: { $ref: '#' },
  }, required: ['value'] } });
  assert.deepEqual(recursive.parse('{"value":"A","child":{"value":"B","child":null}}').args, { value: 'A', child: { value: 'B' } });
  assert.equal(compileFunctionTool({ ...tool, parametersSchema: { type: 'object', properties: { x: { $ref: 'https://invalid.example/schema' } } } }).parse('{}').error, 'INVALID_TOOL_SCHEMA');
  assert.throws(() => createFunctionCallingSession({ authMode: 'codex' }, [{ ...tool, parametersSchema: { type: 'object', properties: { x: { $ref: 'https://invalid.example/schema' } } } }]), /unsupported parameter schema/);
});

test('aliases are bounded, stable, distinct and resolved only inside the current role', () => {
  for (const id of ['mcp:server:lookup', 'skill:财务', 'x'.repeat(120)]) {
    assert.match(functionName(id), /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(functionName(id), functionName(id));
  }
  assert.notEqual(functionName('mcp:a:b'), functionName('mcp_a_b'));
  const session = createFunctionCallingSession({ authMode: 'codex' }, [tool]);
  const turn = session.parse(envelope([call()]));
  assert.equal(turn.toolCalls[0].name, tool.id);
  assert.equal(turn.toolCalls[0].id, 'call-A');
  const other = createFunctionCallingSession({ authMode: 'codex' }, []);
  assert.equal(other.parse(envelope([call()])).toolCalls[0].rejectedResult.error, 'UNKNOWN_TOOL');
});

test('native textual XML is not an executable function; malformed args produce a repairable result', () => {
  const session = createFunctionCallingSession({ authMode: 'codex' }, [tool]);
  const text = '<tool_call>{"name":"bash","arguments":{"command":"echo forbidden"}}</tool_call>';
  assert.deepEqual(session.parse({ ...envelope([]), text }).toolCalls, []);
  assert.equal(session.parse(envelope([{ ...call(), arguments: '{' }])).toolCalls[0].rejectedResult.error, 'INVALID_TOOL_ARGUMENTS');
});

test('multiple same-tool calls retain distinct IDs; duplicates and oversized batches execute nothing', () => {
  const session = createFunctionCallingSession({ authMode: 'codex' }, [tool]);
  assert.equal(session.parse(envelope([call('a'), call('b')])).toolCalls.length, 2);
  assert.throws(() => session.parse(envelope([call('a')])), /duplicate/);
  assert.throws(() => session.parse(envelope([call('c'), call('c')])), /duplicate/);
  assert.throws(() => session.parse(envelope(Array.from({ length: 33 }, (_, i) => call('x' + i)))), /limit/);
});

test('tool output is linked by call_id with bounded text and all reasoning items preserved', () => {
  const session = createFunctionCallingSession({ authMode: 'codex' }, [tool]);
  const items = [{ id: 'rs1', type: 'reasoning', encrypted_content: 'opaque-test', summary: [] }, call()];
  const turn = session.parse(envelope(items));
  const messages = session.append([{ role: 'user', content: 'lookup' }], turn,
    [{ call: turn.toolCalls[0], result: { ok: true, output: 'x'.repeat(1000) } }], { maxOutputChars: 20 });
  assert.deepEqual(messages[1].responseItems, items);
  assert.equal(messages[2].functionCallOutputs[0].call_id, 'call-A');
  assert.match(messages[2].functionCallOutputs[0].output, /truncated/);
  assert.equal(messages[2].isToolResult, true);
});

test('Responses context preserves every step or rejects the whole oversized current turn', () => {
  const messages = [{ role: 'user', content: 'current' },
    { role: 'assistant', content: '', responseItems: [call('a')] },
    { role: 'user', content: '', isToolResult: true, functionCallOutputs: [{ type: 'function_call_output', call_id: 'a', output: 'first' }] },
    { role: 'assistant', content: '', responseItems: [call('b')] },
    { role: 'user', content: '', isToolResult: true, functionCallOutputs: [{ type: 'function_call_output', call_id: 'b', output: 'second' }] }];
  assert.deepEqual(fitRequestContext({ messages }).messages, messages);
  messages[1].responseItems.unshift({ type: 'reasoning', encrypted_content: 'x'.repeat(18000) });
  assert.throws(() => fitRequestContext({ messages, totalTokens: 4096, outputReserve: 512 }), /budget/);
  assert.throws(() => fitRequestContext({ messages: [], toolDefinitions: [{ description: 'x'.repeat(18000) }], totalTokens: 4096, outputReserve: 512 }), /budget/);
});

test('native tool prompt avoids repeating schemas and unrelated providers keep compatibility mode', () => {
  assert.doesNotMatch(buildToolsSystemPrompt([tool], { native: true }), /Parameters:|lookup|<tool_call>/);
  assert.equal(supportsResponsesFunctions({ authMode: 'api-key', baseUrl: 'https://api.openai.com/v1' }), true);
  assert.equal(supportsResponsesFunctions({ authMode: 'api-key', baseUrl: 'https://api.openai.com.fake/v1' }), false);
  assert.equal(supportsResponsesFunctions({ authMode: 'codex', toolCalling: 'legacy' }), false);
  assert.equal(supportsResponsesFunctions({ authMode: 'api-key', apiProtocol: 'anthropic' }), false);
  assert.equal(supportsResponsesFunctions({ authMode: 'local', baseUrl: 'http://localhost:11434/v1' }), false);
});
