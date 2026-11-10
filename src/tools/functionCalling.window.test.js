import test from 'node:test';
import assert from 'node:assert/strict';
import { createFunctionCallingSession, compactToolChain, modelFacingCap, WINDOWED_OUTPUT_CEILING } from './functionCalling.js';
import { functionName } from './functionSchema.js';
import { fetchUrlTool } from './builtins/fetchUrlTool.js';
import { pageWindow } from '../services/search/pageWindow.js';
import { SEARCH_LIMIT_DEFAULTS } from '../services/search/searchLimits.js';
import { buildToolInvocationRecord } from './toolInvocationRecord.js';

// 2026-11-10 latency audit L2. fetch_url returns one 20 000-character window
// of a page and ends it with "continue with offset=N". The loop used to cut
// every result at 8 000 characters, so the model saw two fifths of each window
// and never the offset; it then paged through the page with guessed offsets
// until its rounds ran out. These tests pin what the model is shown.

const reader = { id: 'page_reader', description: 'Read a page.', windowedOutput: true, parametersSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } };
const plain = { id: 'plain_tool', description: 'Any other tool.', parametersSchema: { type: 'object', properties: {} } };
// The forecast sits past the old 8 000-character cut, inside the first window.
const page = 'navigation '.repeat(900) + 'TOMORROW: max 19 min 15 partly cloudy. ' + 'footer '.repeat(6000);
const windowResult = (offset = 0) => {
  const part = pageWindow(page, offset, SEARCH_LIMIT_DEFAULTS.fetchMaxChars);
  const output = `${part.body}${part.suffix}\n\n[source: https://fixture.invalid/forecast] [via: jina]`;
  return { ok: true, output, meta: { url: 'https://fixture.invalid/forecast', truncated: part.truncated, nextOffset: part.nextOffset, windowChars: output.length } };
};
const modelFacing = message => (message.functionCallOutputs?.[0] || message.toolResults?.[0])?.output ?? message.content;

const protocols = {
  responses: { config: { authMode: 'codex' }, reply: (name, id) => ({ protocol: 'responses', text: '', responseItems: [{ type: 'function_call', id: 'item-' + id, call_id: id, name, arguments: '{"url":"https://fixture.invalid/forecast"}' }] }) },
  anthropic: { config: { authMode: 'api-key', apiProtocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }, reply: (name, id) => ({ protocol: 'anthropic', text: '', stopReason: 'tool_use', content: [{ type: 'tool_use', id, name, input: { url: 'https://fixture.invalid/forecast' } }] }) },
  text: { config: { authMode: 'api-key', apiProtocol: 'chat-completions', baseUrl: 'https://example.invalid/v1', toolCalling: 'legacy' }, reply: (name, id) => `<tool_call>${JSON.stringify({ id, name: 'page_reader', arguments: { url: 'https://fixture.invalid/forecast' } })}</tool_call>` },
};

for (const [name, protocol] of Object.entries(protocols)) test(`a page reader's whole window reaches the model on the ${name} protocol`, () => {
  const session = createFunctionCallingSession(protocol.config, [reader, plain]);
  const turn = session.parse(protocol.reply(functionName(reader.id), 'call-1'));
  assert.equal(turn.toolCalls[0].name, reader.id);
  const result = windowResult();
  const shown = modelFacing(session.append([], turn, [{ call: turn.toolCalls[0], result }]).at(-1));
  const visible = name === 'text' ? shown : JSON.parse(shown).output;
  assert.match(visible, /TOMORROW: max 19 min 15/, 'the part of the window past the general cap is visible');
  assert.match(visible, /continue with offset=20000/, 'the continuation offset is visible');
  assert.match(visible, /\[source: https:\/\/fixture\.invalid\/forecast\]/);
  assert.doesNotMatch(visible, /Tool output truncated/);
});

test('only a declared page reader keeps its window; any other result stays under the general cap', () => {
  const session = createFunctionCallingSession(protocols.responses.config, [reader, plain]);
  const turn = session.parse({ protocol: 'responses', text: '', responseItems: [{ type: 'function_call', id: 'item-2', call_id: 'call-2', name: functionName(plain.id), arguments: '{}' }] });
  // A result cannot enlarge its own cap by claiming a window.
  const result = { ok: true, output: 'y'.repeat(30000), meta: { windowChars: 30000 } };
  const shown = JSON.parse(modelFacing(session.append([], turn, [{ call: turn.toolCalls[0], result }]).at(-1))).output;
  assert.equal(shown.length < 8200, true);
  assert.match(shown, /Tool output truncated/);
  assert.equal(modelFacingCap(plain, result, 8000), 8000);
  assert.equal(modelFacingCap(reader, { meta: {} }, 8000), 8000, 'a reader result without a window uses the general cap');
  assert.equal(modelFacingCap(reader, { meta: { windowChars: 500 } }, 8000), 8000, 'a small window never lowers the cap');
  assert.equal(modelFacingCap(reader, { meta: { windowChars: 9e9 } }, 8000), WINDOWED_OUTPUT_CEILING, 'the window is bounded');
  assert.equal(session.outputCap(turn.toolCalls[0], result), 8000);
});

test('fetch_url declares its window and the invocation record keeps what the model saw', () => {
  assert.equal(fetchUrlTool.windowedOutput, true);
  const session = createFunctionCallingSession(protocols.responses.config, [fetchUrlTool]);
  const result = windowResult();
  const call = { id: 'call-3', name: 'fetch_url', arguments: { url: 'https://fixture.invalid/forecast' } };
  const cap = session.outputCap(call, result);
  assert.equal(cap, result.output.length);
  const record = buildToolInvocationRecord({ runId: 'run', iteration: 0, call, result, modelFacingOutput: JSON.stringify({ ok: true, output: result.output }), modelFacingOutputChars: cap });
  assert.equal(record.modelFacingOutputTruncated, undefined);
  assert.match(record.modelFacingOutput, /continue with offset=20000/);
  // Without a declared window the record keeps its general bound.
  const bounded = buildToolInvocationRecord({ runId: 'run', iteration: 0, call, result, modelFacingOutput: 'z'.repeat(30000) });
  assert.equal(bounded.modelFacingOutput.length, 8000);
  assert.equal(bounded.modelFacingOutputTruncated, true);
});

const resultMessage = (id, size) => ({ role: 'user', content: '', isToolResult: true, toolResults: [{ callId: id, name: 'fetch_url', output: JSON.stringify({ ok: true, output: 'word '.repeat(size / 5) }) }] });
const outputsOf = messages => messages.filter(message => message.isToolResult).map(message => message.toolResults[0].output);

test('a size allowance keeps two sources readable and still bounds a run of full pages', () => {
  const assistant = { role: 'assistant', content: '', toolCalls: [] };
  // Two medium sources (about 2 500 tokens each) fit the allowance together.
  const two = [{ role: 'user', content: 'task' }, assistant, resultMessage('a', 10000), assistant, resultMessage('b', 10000)];
  assert.equal(compactToolChain(two, { keepRecentResults: 1, keepRecentTokens: 16000 }).changed, false, 'both sources stay in full');
  assert.equal(compactToolChain(two, { keepRecentResults: 1 }).changed, true, 'by count alone the first source was condensed');
  // Four full windows do not fit: the oldest are condensed, the newest are kept.
  const four = [{ role: 'user', content: 'task' }, ...['a', 'b', 'c', 'd'].flatMap(id => [assistant, resultMessage(id, 40000)])];
  const { messages, changed } = compactToolChain(four, { keepRecentResults: 1, keepRecentTokens: 16000 });
  assert.equal(changed, true);
  const kept = outputsOf(messages).map(output => output.length > 30000);
  assert.deepEqual(kept, [false, false, false, true], 'one 10 000-token window fits a 16 000-token allowance, a second does not');
  assert.match(outputsOf(messages)[0], /condensed/);
  // The newest result always stays, even when it alone exceeds the allowance.
  const huge = [{ role: 'user', content: 'task' }, assistant, resultMessage('a', 1000), assistant, resultMessage('b', 200000)];
  const after = compactToolChain(huge, { keepRecentResults: 1, keepRecentTokens: 16000 });
  assert.equal(outputsOf(after.messages)[1], outputsOf(huge)[1]);
  assert.match(outputsOf(after.messages)[0], /condensed|word/);
});

// One page window costs about the same number of tokens whatever the script.
test('a CJK page gets a shorter window whose continuation offset is still shown to the model', async () => {
  const { windowChars, PAGE_WINDOW_TOKENS } = await import('../services/search/pageWindow.js');
  const { estimateTextTokens } = await import('../memory/tokenEstimate.js');
  const latin = 'forecast for the coming week '.repeat(2000), chinese = '明天墨尔本多云转晴，气温十五到十九度。'.repeat(3000);
  assert.equal(windowChars(latin, 0, 20000), 20000, 'Latin text keeps the configured window');
  const limit = windowChars(chinese, 0, 20000);
  assert.equal(limit < 9000 && limit >= 1000, true, String(limit));
  assert.equal(estimateTextTokens(chinese.slice(0, limit)) <= PAGE_WINDOW_TOKENS * 1.05, true);
  assert.equal(windowChars(chinese, 5000, 20000), limit, 'the same script gives the same window at any offset');
  assert.equal(windowChars('短', 0, 20000), 20000, 'a short page is never shortened');
  // Through the tool: the window ends where its continuation line says, and all of it reaches the model.
  const result = await fetchUrlTool.run({ url: 'https://fixture.invalid/zh' }, { _fetchViaJina: async () => chinese });
  assert.equal(result.ok, true);
  assert.equal(result.meta.nextOffset, limit);
  assert.match(result.output, new RegExp(`continue with offset=${limit}\\.\\]`));
  const session = createFunctionCallingSession(protocols.anthropic.config, [fetchUrlTool]);
  const call = { id: 'zh-1', name: 'fetch_url', arguments: { url: 'https://fixture.invalid/zh' } };
  assert.equal(session.outputCap(call, result) >= result.output.length, true, 'the whole window fits the model-facing cap');
  const next = await fetchUrlTool.run({ url: 'https://fixture.invalid/zh', offset: limit }, { _fetchViaJina: async () => chinese });
  assert.equal(next.output.startsWith(chinese.slice(limit, limit + 20)), true, 'the next read continues exactly where the first one stopped');
});
