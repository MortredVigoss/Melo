import test from 'node:test';
import assert from 'node:assert/strict';
import { compactToolChain } from './functionCalling.js';

// 2026-10-17 audit C-8: long tool loops used to throw CONTEXT_BUDGET_EXCEEDED
// after the tools already ran because every call/output in the current turn
// was required and uncompressible.
function nativeResult(id, size) {
  return { role: 'user', content: '', isToolResult: true,
    functionCallOutputs: [{ type: 'function_call_output', call_id: id, output: JSON.stringify({ ok: true, output: 'x'.repeat(size) }) }] };
}

test('older native tool outputs are condensed, the newest two stay intact, call ids survive', () => {
  const messages = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: '', responseItems: [] }, nativeResult('c1', 5000),
    { role: 'assistant', content: '', responseItems: [] }, nativeResult('c2', 5000),
    { role: 'assistant', content: '', responseItems: [] }, nativeResult('c3', 5000),
    { role: 'assistant', content: '', responseItems: [] }, nativeResult('c4', 5000),
  ];
  const { messages: next, changed } = compactToolChain(messages);
  assert.equal(changed, true);
  const outputs = next.filter(m => m.isToolResult).map(m => m.functionCallOutputs[0]);
  assert.deepEqual(outputs.map(o => o.call_id), ['c1', 'c2', 'c3', 'c4']);
  assert.ok(outputs[0].output.length < 1000 && /condensed/.test(outputs[0].output));
  assert.ok(outputs[1].output.length < 1000);
  assert.equal(outputs[2].output, messages[6].functionCallOutputs[0].output, 'second newest untouched');
  assert.equal(outputs[3].output, messages[8].functionCallOutputs[0].output, 'newest untouched');
  assert.equal(JSON.parse(outputs[0].output).ok, true, 'structure preserved');
  assert.equal(messages[2].functionCallOutputs[0].output.length > 5000, true, 'input not mutated');
});

test('legacy text tool results are condensed too and a short chain reports no change', () => {
  const legacy = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'calling' }, { role: 'user', content: 'y'.repeat(3000), isToolResult: true },
    { role: 'assistant', content: 'calling' }, { role: 'user', content: 'z'.repeat(3000), isToolResult: true },
    { role: 'assistant', content: 'calling' }, { role: 'user', content: 'w'.repeat(3000), isToolResult: true },
  ];
  const { messages: next, changed } = compactToolChain(legacy);
  assert.equal(changed, true);
  assert.ok(next[2].content.length < 800 && /condensed/.test(next[2].content));
  assert.equal(next[4].content, legacy[4].content);
  assert.equal(compactToolChain(legacy.slice(0, 3)).changed, false, 'nothing older than the protected tail');
});
