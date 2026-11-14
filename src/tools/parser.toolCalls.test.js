/**
 * parser.toolCalls.test.js — text-protocol tool calls whose JSON is broken.
 *
 * Until 2026-11-14 a `<tool_call>` block that was not valid JSON, but from
 * which the tool name could still be read, became a call with EMPTY arguments
 * and was run. A tool that needs no arguments ran on a request the model
 * never completed; every other tool reported a misleading "missing argument".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseModelResponse } from './parser.js';
import { createFunctionCallingSession } from './functionCalling.js';

const block = body => `before\n<tool_call>${body}</tool_call>\nafter`;

test('a well-formed call is parsed as before, with no rejection', () => {
  const { thinking, toolCalls } = parseModelResponse(block('{"id":"c1","name":"File-Read","arguments":{"path":"a.txt"}}'));
  assert.equal(thinking, 'before\n\nafter');
  assert.deepEqual(toolCalls.map(({ raw, ...call }) => call), [{ id: 'c1', name: 'file_read', arguments: { path: 'a.txt' } }]);
  assert.deepEqual(parseModelResponse(block('{"tool":"bash","args":{"command":"ls"}}')).toolCalls[0].arguments, { command: 'ls' });
  assert.equal(parseModelResponse(block('{"name":"device_location"}')).toolCalls[0].rejectedResult, undefined, 'no arguments at all is a valid call');
});

test('broken JSON with a readable name is a rejected call, not a call with empty arguments', () => {
  for (const body of [
    '{"id":"c1","name":"file_delete","arguments":{"paths":["a.txt"',          // cut off
    '{"name":"file_delete","arguments":{"paths":["a.txt"],}}',                  // trailing comma
    '{"name": "file_delete", arguments: {paths: [a.txt]}}',                     // unquoted keys
  ]) {
    const [call, ...rest] = parseModelResponse(block(body)).toolCalls;
    assert.deepEqual(rest, []);
    assert.equal(call.name, 'file_delete');
    assert.deepEqual(call.arguments, {});
    assert.deepEqual(call.rejectedResult, {
      ok: false,
      error: 'INVALID_TOOL_ARGUMENTS',
      output: 'Tool arguments must be a complete JSON object within the size and nesting limits.',
    }, body);
  }
});

test('arguments that are not an object are rejected the same way; a block with no readable name is dropped', () => {
  for (const args of ['"ls -la"', '["a.txt"]', '42', 'null']) {
    const [call] = parseModelResponse(block(`{"name":"bash","arguments":${args}}`)).toolCalls;
    // `null` means "no arguments" (the native protocols send it for omitted values).
    if (args === 'null') { assert.equal(call.rejectedResult, undefined); continue; }
    assert.equal(call.rejectedResult?.error, 'INVALID_TOOL_ARGUMENTS', args);
    assert.deepEqual(call.arguments, {});
  }
  assert.deepEqual(parseModelResponse(block('not json at all')).toolCalls, []);
  assert.deepEqual(parseModelResponse(block('"just a string"')).toolCalls, []);
  assert.deepEqual(parseModelResponse(block('[1,2,3]')).toolCalls, []);
  assert.equal(parseModelResponse(block('not json at all')).thinking, 'before\n\nafter', 'the prose around it is kept');
});

test('each rejected call carries its own result object', () => {
  const calls = parseModelResponse(`${block('{"name":"a","arguments":{')}${block('{"name":"b","arguments":{')}`).toolCalls;
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].rejectedResult, calls[1].rejectedResult);
  calls[0].rejectedResult.output = 'changed';
  assert.match(calls[1].rejectedResult.output, /complete JSON object/);
});

test('a session that is handed a text reply keeps the rejection on the parsed turn', () => {
  const tool = { id: 'file_delete', name: 'File Delete', description: 'x', parametersSchema: { type: 'object', properties: {} } };
  // A string reply takes the text-protocol path whatever the session's own protocol is.
  const session = createFunctionCallingSession({ authMode: 'codex' }, [tool]);
  const turn = session.parse(block('{"name":"file_delete","arguments":{"paths":['));
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].name, 'file_delete');
  assert.equal(turn.toolCalls[0].rejectedResult.error, 'INVALID_TOOL_ARGUMENTS');
});
