import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mcpFunctionName, registerMcpTool, registerMcpTools, unregisterMcpServer, unregisterMcpTool,
  getMcpTool, getAllMcpTools, resolveMcpFunctionName, functionNameFor, toolsForAgent, indexMcpTools,
  clearMcpRegistry, MCP_FUNCTION_NAME_MAX,
} from './mcpRegistry.js';
import { getTool, getAllTools } from './registryCore.js';
import { compileFunctionTool } from './functionSchema.js';
import { createFunctionCallingSession } from './functionCalling.js';
import { buildMcpTool } from '../mcp/manager.js';

const fakeClient = { callTool: async (name, args) => ({ content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] }) };
const mcpTool = (server, name) => buildMcpTool(server, { name, description: `${server} ${name}`, inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }, fakeClient);

beforeEach(() => clearMcpRegistry());

test('naming: readable mcp__<server>__<tool>, sanitised to [A-Za-z0-9_]', () => {
  assert.equal(mcpFunctionName('antv-chart', 'line_chart'), 'mcp__antv_chart__line_chart');
  assert.equal(mcpFunctionName('srv', 'docs.search/v2'), 'mcp__srv__docs_search_v2');
  assert.equal(mcpFunctionName('srv', '查询'), 'mcp__srv____');
  assert.match(mcpFunctionName('a-b', 'c-d e'), /^[A-Za-z0-9_]+$/);
});

test('hashing: only names longer than 64 chars become mcp__<server>__<sha1[:10]>', () => {
  const exactly = 'x'.repeat(MCP_FUNCTION_NAME_MAX - 'mcp__srv__'.length);
  assert.equal(mcpFunctionName('srv', exactly).length, 64);
  assert.equal(mcpFunctionName('srv', exactly), `mcp__srv__${exactly}`);
  const long = `${exactly}y`;
  const hashed = mcpFunctionName('srv', long);
  const digest = createHash('sha1').update(`srv:${long}`).digest('hex').slice(0, 10);
  assert.equal(hashed, `mcp__srv__${digest}`);
  assert.ok(hashed.length <= 64);
  // A very long server id is truncated so the hashed form still fits.
  const longServer = 's'.repeat(80);
  const h2 = mcpFunctionName(longServer, 'tool');
  assert.ok(h2.length <= 64 && h2.startsWith('mcp__') && /__[0-9a-f]{10}$/.test(h2));
  // Stable.
  assert.equal(mcpFunctionName('srv', long), hashed);
});

test('register keeps tool.id as mcp:<server>:<tool>, never touches the global registry, reverse lookup resolves both forms', () => {
  const stored = registerMcpTool(mcpTool('antv-chart', 'line_chart'));
  assert.equal(stored.id, 'mcp:antv-chart:line_chart');
  assert.equal(stored.functionName, 'mcp__antv_chart__line_chart');
  assert.equal(functionNameFor('mcp:antv-chart:line_chart'), 'mcp__antv_chart__line_chart');
  assert.equal(getTool('mcp:antv-chart:line_chart'), null);
  assert.ok(!getAllTools().some(t => t.id.startsWith('mcp:')));
  assert.equal(resolveMcpFunctionName('mcp__antv_chart__line_chart'), stored);
  assert.equal(resolveMcpFunctionName('mcp:antv-chart:line_chart'), stored);
  assert.equal(resolveMcpFunctionName('nope'), null);
  // idempotent re-registration returns the stored object
  assert.equal(registerMcpTool(mcpTool('antv-chart', 'line_chart')), stored);
  assert.equal(getAllMcpTools().length, 1);
  // long tool name → hashed wire name, reverse map still resolves
  const longName = 'l'.repeat(70);
  const hashed = registerMcpTool(mcpTool('srv', longName));
  assert.ok(hashed.functionName.length <= 64);
  assert.equal(resolveMcpFunctionName(hashed.functionName).id, `mcp:srv:${longName}`);
  const index = indexMcpTools(getAllMcpTools());
  assert.equal(index.get(hashed.functionName), hashed);
  assert.equal(index.get(hashed.id), hashed);
  // XML parser normalisation (lowercase, '-' → '_') still resolves.
  assert.equal(index.get('mcp:antv_chart:line_chart'), stored);
  const camel = registerMcpTool(mcpTool('srv', 'getUser'));
  assert.equal(indexMcpTools([camel]).get('mcp__srv__getuser'), camel);
});

test('sanitisation collisions fall back to the hashed form so the reverse map stays unambiguous', () => {
  const a = registerMcpTool(mcpTool('srv', 'a-b'));
  const b = registerMcpTool(mcpTool('srv', 'a_b'));
  assert.equal(a.functionName, 'mcp__srv__a_b');
  assert.notEqual(b.functionName, a.functionName);
  assert.match(b.functionName, /^mcp__srv__[0-9a-f]{10}$/);
  assert.equal(resolveMcpFunctionName(b.functionName).id, 'mcp:srv:a_b');
  assert.equal(resolveMcpFunctionName(a.functionName).id, 'mcp:srv:a-b');
});

test('unregisterMcpServer removes only that server; invalid ids are rejected', () => {
  registerMcpTools([mcpTool('alpha', 'one'), mcpTool('alpha', 'two'), mcpTool('beta', 'one')]);
  assert.equal(unregisterMcpServer('alpha'), 2);
  assert.deepEqual(getAllMcpTools().map(t => t.id), ['mcp:beta:one']);
  assert.equal(resolveMcpFunctionName('mcp__alpha__one'), null);
  assert.equal(unregisterMcpTool('mcp:beta:one'), true);
  assert.equal(unregisterMcpTool('mcp:beta:one'), false);
  assert.throws(() => registerMcpTool({ id: 'mcp:bad id:x', name: 'x', description: 'x', parametersSchema: {}, run() {} }), /Invalid MCP tool id/);
  assert.throws(() => registerMcpTool({ id: 'mcp:ok:x', name: 'x', description: 'x', parametersSchema: {} }), /Invalid MCP tool/);
});

test('per-agent filtering: capabilities.mcpServers or enabledMcpServerIds; default deny-all', () => {
  registerMcpTools([mcpTool('alpha', 'one'), mcpTool('beta', 'one'), mcpTool('gamma', 'one')]);
  assert.deepEqual(toolsForAgent({ id: 'legacy', enabledMcpServerIds: ['alpha'] }).map(t => t.id), ['mcp:alpha:one']);
  assert.deepEqual(toolsForAgent({ id: 'cap', capabilities: { mcpServers: ['beta', 'gamma'] } }).map(t => t.id), ['mcp:beta:one', 'mcp:gamma:one']);
  assert.deepEqual(toolsForAgent({ id: 'none' }), []);
  assert.deepEqual(toolsForAgent(null), []);
  assert.deepEqual(toolsForAgent({ id: 'other', enabledMcpServerIds: ['delta'] }), []);
});

test('two agents in parallel chats see disjoint MCP sets; each session resolves its own wire names only', async () => {
  registerMcpTools([mcpTool('alpha', 'one'), mcpTool('beta', 'one')]);
  const agentA = { id: 'a', enabledMcpServerIds: ['alpha'] };
  const agentB = { id: 'b', capabilities: { mcpServers: ['beta'] } };
  // Simulate two prepare steps running concurrently.
  const [setA, setB] = await Promise.all([
    (async () => { await new Promise(r => setTimeout(r, 2)); return toolsForAgent(agentA); })(),
    (async () => toolsForAgent(agentB))(),
  ]);
  assert.deepEqual(setA.map(t => t.id), ['mcp:alpha:one']);
  assert.deepEqual(setB.map(t => t.id), ['mcp:beta:one']);
  assert.equal(setA.filter(t => setB.some(o => o.id === t.id)).length, 0);

  // The model-facing definitions use the readable names, and a call for the
  // other agent's tool is UNKNOWN_TOOL inside this session.
  const sessionA = createFunctionCallingSession({ authMode: 'codex' }, setA);
  assert.deepEqual(sessionA.definitions.map(d => d.name), ['mcp__alpha__one']);
  assert.equal(compileFunctionTool(setB[0]).definition.name, 'mcp__beta__one');
  const envelope = name => ({ protocol: 'responses', text: '', responseItems: [
    { type: 'function_call', id: 'item-1', call_id: 'call-1', name, arguments: JSON.stringify({ q: 'x' }) },
  ] });
  const ok = sessionA.parse(envelope('mcp__alpha__one'));
  assert.equal(ok.toolCalls[0].name, 'mcp:alpha:one');
  assert.equal(ok.toolCalls[0].rejectedResult, undefined);
  const sessionA2 = createFunctionCallingSession({ authMode: 'codex' }, setA);
  assert.equal(sessionA2.parse(envelope('mcp__beta__one')).toolCalls[0].rejectedResult.error, 'UNKNOWN_TOOL');
});

test('buildMcpTool.run still calls the client with the original MCP tool name', async () => {
  const stored = registerMcpTool(mcpTool('srv', 'docs.search'));
  assert.equal(stored.functionName, 'mcp__srv__docs_search');
  const result = await stored.run({ q: 'hi' });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /docs\.search:\{"q":"hi"\}/);
});

// Bug audit 2026-10-18 T14: when the readable name AND the 10-char hashed
// name both collide, registration used to throw (and the manager swallowed
// it, so the tool silently vanished). The digest now lengthens instead.
test('T14: a double collision lengthens the hash instead of throwing; every tool stays registered and resolvable', () => {
  const a = registerMcpTool(mcpTool('srv', 'a-b'));
  const digest = createHash('sha1').update('mcp:srv:a_b').digest('hex').slice(0, 10);
  // A tool literally named after the digest squats the hashed wire name of `a_b`.
  const squatter = registerMcpTool(mcpTool('srv', digest));
  assert.equal(squatter.functionName, `mcp__srv__${digest}`);
  const b = registerMcpTool(mcpTool('srv', 'a_b'));
  assert.notEqual(b.functionName, a.functionName);
  assert.notEqual(b.functionName, squatter.functionName);
  assert.match(b.functionName, /^mcp__srv__[0-9a-f]{14}$/);
  assert.equal(resolveMcpFunctionName(b.functionName).id, 'mcp:srv:a_b');
  assert.equal(resolveMcpFunctionName(a.functionName).id, 'mcp:srv:a-b');
  assert.equal(resolveMcpFunctionName(squatter.functionName).id, `mcp:srv:${digest}`);
  assert.equal(getAllMcpTools().length, 3);
  const names = new Set(getAllMcpTools().map(t => t.functionName));
  assert.equal(names.size, 3, 'wire names are unique');
  assert.ok([...names].every(name => name.length <= MCP_FUNCTION_NAME_MAX));
});
