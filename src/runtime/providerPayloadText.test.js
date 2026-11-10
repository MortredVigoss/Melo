import test from 'node:test';
import assert from 'node:assert/strict';
import { traceProviderPayload } from './loopTrace.js';
import { createFunctionCallingSession } from '../tools/functionCalling.js';
import { functionName } from '../tools/functionSchema.js';
import { pageWindow } from '../services/search/pageWindow.js';

// 2026-11-10 agent audit. A truncation that lands inside a surrogate pair leaves half an emoji in
// the text. A provider that validates its JSON refuses the whole request (Anthropic: 400 "no low
// surrogate in string"), and the same string is in every later request of the run. On the native
// tool protocols a tool result travels as JSON inside a string, which already escapes the lone
// half; on the text tool protocol, and wherever plain text is cut, it reaches the request as it
// is. These tests build the string through the real truncation code and check what goes on the wire.

const lone = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const tool = { id: 'read_posts', description: 'Read posts.', parametersSchema: { type: 'object', properties: {} } };
const textProtocol = { authMode: 'api-key', apiProtocol: 'chat-completions', baseUrl: 'https://example.invalid/v1', toolCalling: 'legacy' };
const anthropic = { authMode: 'api-key', apiProtocol: 'anthropic', baseUrl: 'https://api.anthropic.com' };
// The general cap is 8 000 characters: the emoji starts at 7 999, so the cut keeps only its first half.
const output = '好'.repeat(7999) + '😀' + ' the rest of the post';

test('a tool result cut inside an emoji reaches the provider as valid text, and the stored history is unchanged', async () => {
  const session = createFunctionCallingSession(textProtocol, [tool]);
  const turn = session.parse('<tool_call>' + JSON.stringify({ id: 'call-1', name: tool.id, arguments: {} }) + '</tool_call>');
  const history = session.append([], turn, [{ call: turn.toolCalls[0], result: { ok: true, output } }]);
  assert.equal(strings(history).some(text => !text.isWellFormed()), true, 'the fixture really holds a lone surrogate (otherwise this test proves nothing)');
  assert.match(JSON.stringify(history), lone);
  const before = structuredClone(history);

  const body = await traceProviderPayload({ model: 'fixture', max_tokens: 16, messages: history });
  assert.doesNotMatch(body, lone);
  const sent = JSON.parse(body);
  assert.equal(strings(sent).every(text => text.isWellFormed()), true);
  assert.match(strings(sent).join('\n'), /好\ufffd/, 'the lone half becomes U+FFFD; nothing else moves');
  assert.equal(strings(sent).join('').includes('好'.repeat(7999)), true);
  assert.deepEqual(history, before, 'only the wire copy is repaired');
});

test('on a native tool protocol the cut result is already valid text and passes through unchanged', async () => {
  const session = createFunctionCallingSession(anthropic, [tool]);
  const turn = session.parse({ protocol: 'anthropic', text: '', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'call-1', name: functionName(tool.id), input: {} }] });
  const history = session.append([], turn, [{ call: turn.toolCalls[0], result: { ok: true, output } }]);
  assert.equal(strings(history).every(text => text.isWellFormed()), true);
  assert.equal(await traceProviderPayload({ model: 'fixture', max_tokens: 16, messages: history }), JSON.stringify({ model: 'fixture', max_tokens: 16, messages: history }));
});

test('whole pairs, ordinary text and nested values pass through byte for byte', async () => {
  const payload = { model: 'fixture', input: [{ role: 'user', content: [{ type: 'input_text', text: 'emoji 😀 family 👨‍👩‍👧 flag 🇦🇺 中文 "quoted" \\ud83d as six plain characters' }] }], tools: [{ name: 'x', parameters: { enum: ['a', '😀'] } }], max: 3, flag: true, none: null };
  assert.equal(await traceProviderPayload(payload), JSON.stringify(payload));
});

test('a lone half from any source is repaired wherever it sits', async () => {
  const high = '\ud83d', low = '\ude00';
  const body = await traceProviderPayload({ system: 'ends with ' + high, messages: [{ role: 'user', content: low + ' starts with a low half' }, { role: 'assistant', content: [{ type: 'text', text: 'mid ' + high + ' dle' }] }], tools: [{ description: high + low + high }] });
  assert.doesNotMatch(body, lone);
  const sent = JSON.parse(body);
  assert.equal(sent.system, 'ends with �');
  assert.equal(sent.messages[0].content, '� starts with a low half');
  assert.equal(sent.messages[1].content[0].text, 'mid � dle');
  assert.equal(sent.tools[0].description, '😀�');
});

test('the page window helper can end inside a pair, which is why the wire copy is repaired centrally', () => {
  const part = pageWindow('a'.repeat(19999) + '😀 tail', 0, 20000);
  assert.equal(part.body.isWellFormed(), false);
});
