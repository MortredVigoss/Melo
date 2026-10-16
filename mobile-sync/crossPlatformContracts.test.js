// Desktop half of the cross-platform behaviour contract. The same fixture runs
// in ios/Tests/SharedContractTests.swift; both must pass for the two clients
// to extract links, key sources and replay tool calls identically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractTextUrls } from '../src/media/textUrls.js';
import { sceneSourceUrl } from '../src/shared/executionScene.js';
import { createFunctionCallingSession } from '../src/tools/functionCalling.js';
import { buildCodexResponsesInput } from '../src/openai.js';

const contract = JSON.parse(readFileSync(new URL('../shared/protocol/contracts.json', import.meta.url), 'utf8'));

test('prose URL extraction matches the shared contract', () => {
  assert.ok(contract.proseUrls.length >= 10);
  for (const { text, urls } of contract.proseUrls) assert.deepEqual(extractTextUrls(text), urls, text);
});

test('source identity keys match the shared contract', () => {
  assert.ok(contract.sourceIdentity.length >= 20);
  for (const { url, identity } of contract.sourceIdentity) assert.equal(sceneSourceUrl(url), identity, url);
});

test('tool-call replay appends output items verbatim, then one output per call in order', async () => {
  const { output, results } = contract.toolLoopReplay;
  const session = createFunctionCallingSession({ authMode: 'codex' }, [{ id: 'lookup', description: 'fixture', parametersSchema: { type: 'object', properties: {} }, run: async () => ({ ok: true, output: '' }) }]);
  assert.equal(session.native, true);
  const turn = session.parse({ protocol: 'responses', text: '', responseItems: output });
  const prior = [{ role: 'user', content: '问题' }];
  const messages = session.append(prior, turn, results.map(r => ({ call: { id: r.call_id }, result: { ok: true, output: r.output } })));
  const input = await buildCodexResponsesInput(messages);
  const tail = input.slice(input.length - output.length - results.length);
  assert.deepEqual(tail.slice(0, output.length), output);
  const outputs = tail.slice(output.length);
  assert.deepEqual(outputs.map(item => [item.type, item.call_id, typeof item.output]), results.map(r => ['function_call_output', r.call_id, 'string']));
});
