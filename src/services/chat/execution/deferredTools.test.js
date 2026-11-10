import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolDeferral, LOAD_TOOLS_NAME, DEFERRED_MIN_TOOLS, DEFERRED_MIN_CHARS } from './deferredTools.js';
import { compileFunctionTool } from '../../../tools/functionSchema.js';

// 2026-11-10 latency audit L4: the lead keeps built-in tools in full and lists
// MCP tools by name; a definition is sent only after the lead asks for it.
const mcp = (index, size = 2400) => ({ id: `mcp:charts:chart_${index}`, functionName: `mcp__charts__chart_${index}`, name: `chart ${index}`,
  description: `Generate chart number ${index} from tabular data. Second sentence with details that the list leaves out.`,
  parametersSchema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } } }, description: 'x'.repeat(size) } }, required: ['data'] } });
const builtin = id => ({ id, name: id, description: `Built-in ${id}.`, parametersSchema: { type: 'object', properties: {} } });
const tools = [builtin('file_read'), ...Array.from({ length: 8 }, (_, index) => mcp(index)), builtin('route_task')];

test('MCP tools are listed by name; built-in tools keep their definitions and their order', () => {
  const deferral = createToolDeferral(tools);
  assert.deepEqual(deferral.active.map(tool => tool.id), ['file_read', 'route_task']);
  assert.equal(deferral.deferred.length, 8);
  assert.equal(deferral.loaderTool.id, LOAD_TOOLS_NAME);
  for (let index = 0; index < 8; index++) assert.match(deferral.loaderTool.description, new RegExp(`- mcp__charts__chart_${index}: Generate chart number ${index} from tabular data\\.`));
  assert.doesNotMatch(deferral.loaderTool.description, /Second sentence/, 'one line per tool');
  // What the lead sends instead of the eight definitions is a fraction of their size.
  const loaderChars = JSON.stringify(compileFunctionTool(deferral.loaderTool).definition).length;
  assert.equal(deferral.savedChars > 8 * 2400, true);
  assert.equal(loaderChars < deferral.savedChars / 8, true, `${loaderChars} vs ${deferral.savedChars}`);
  assert.ok(!compileFunctionTool(deferral.loaderTool).schemaError);
});

test('loading moves named tools once, by wire name or id, and reports unknown names', () => {
  const deferral = createToolDeferral(tools);
  assert.equal(deferral.isPending('mcp__charts__chart_3'), true);
  const first = deferral.load(['mcp__charts__chart_3', 'mcp:charts:chart_5', 'mcp__charts__nope', 7, ' mcp__charts__chart_3 ']);
  assert.deepEqual(first.loaded.map(tool => tool.id), ['mcp:charts:chart_3', 'mcp:charts:chart_5']);
  assert.equal(first.ok, true);
  assert.deepEqual(JSON.parse(first.report), { loaded: ['mcp__charts__chart_3', 'mcp__charts__chart_5'], unknown: ['mcp__charts__nope'], hint: 'Use the exact names from the load_tools list.', next: 'These tools are now callable: call them in your next step.' });
  assert.equal(deferral.isPending('mcp__charts__chart_3'), false);
  assert.equal(deferral.isPending('mcp:charts:chart_5'), false);
  assert.equal(deferral.isPending('mcp__charts__chart_4'), true);
  assert.equal(deferral.isPending('file_read'), false);
  const again = deferral.load(['mcp__charts__chart_3']);
  assert.deepEqual(again.loaded, []);
  assert.equal(again.ok, true);
  assert.deepEqual(JSON.parse(again.report).alreadyLoaded, ['mcp__charts__chart_3']);
  for (const names of [['mcp__charts__nope'], [], undefined, 'mcp__charts__chart_1']) {
    const none = deferral.load(names);
    assert.equal(none.ok, false, JSON.stringify(names)); assert.deepEqual(none.loaded, []);
  }
});

test('deferring does not apply to the text protocol, when switched off, or when there is little to save', () => {
  assert.equal(createToolDeferral(tools, { native: false }), null);
  assert.equal(createToolDeferral(tools, { enabled: false }), null);
  assert.equal(createToolDeferral([builtin('file_read'), ...Array.from({ length: DEFERRED_MIN_TOOLS - 1 }, (_, index) => mcp(index, 9000))]), null, 'too few tools');
  const small = Array.from({ length: 8 }, (_, index) => mcp(index, 10));
  assert.equal(small.reduce((sum, tool) => sum + JSON.stringify(compileFunctionTool(tool).definition).length, 0) < DEFERRED_MIN_CHARS, true);
  assert.equal(createToolDeferral(small), null, 'too little to save');
  assert.equal(createToolDeferral([builtin('file_read'), builtin('pdf')]), null);
});
