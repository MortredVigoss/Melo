// Tool self-description (design audit T8/T9, option F2): a tool declares
// capability / needsWorkspace / uiModule / inputKeys / concurrency on itself and
// every consumer reads the declaration first, falling back to its legacy id
// table only for undeclared tools. The fixture tool below appears in no table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTool, unregisterTool, getTool } from './registryCore.js';
import { validateTool, toolConcurrencySafe } from './tool.js';
import { observeTool, describeToolInput } from './executionObservation.js';
import { moduleForOperation } from '../shared/executionScene.js';
import { toolCapabilityAllowed, normalizeCapabilities, filterToolsByCapabilities } from '../domain/agent/capabilities.js';
import { scopeAllowsTool, normalizeCapabilityScope } from '../domain/agent/capabilityScope.js';
import { toolNeedsWorkspace } from '../services/workspace/toolWorkspace.js';
import { reserveTaskOperation, listTaskOperations } from '../services/task/operationLedger.js';
import { filterToolsForSearchPlan } from '../retrieval/searchRouter.js';
import { inheritableReadToolIds } from '../agents/team.js';
import { executeToolCalls, executeTool, withLegacyAgentFixture } from '../testSupport/directAgentFixture.js';
import { createRequestContext } from '../runtime/requestContext.js';
import { resolvePermission } from './permissions.js';
import { pdfTool } from './builtins/pdfTool.js';
import { xlsxTool } from './builtins/xlsxTool.js';
import { imageTool } from './builtins/imageTool.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Records overlap so the batch schedule can be observed, not inferred.
function tracker() {
  const log = [];
  let active = 0, peak = 0;
  return {
    log, peak: () => peak,
    async run(args) {
      active++; peak = Math.max(peak, active);
      log.push(`start:${args.action}:${args.target}`);
      await sleep(25);
      active--;
      log.push(`end:${args.action}:${args.target}`);
      return { ok: true, output: `${args.action} ${args.target}` };
    },
  };
}

function fixtureTool(run) {
  return {
    id: 'self_described_fixture',
    name: 'Self-described fixture',
    description: 'Test-only tool that lives in no id table.',
    category: 'general',
    requiresPermission: false,
    parametersSchema: { type: 'object', properties: { action: { type: 'string' }, target: { type: 'string' } } },
    capability: args => args ? (args.action === 'write' ? 'writeFiles' : 'readFiles') : { anyOf: ['readFiles', 'writeFiles'] },
    needsWorkspace: args => args.action === 'write',
    uiModule: 'compute',
    inputKeys: ['action', 'target'],
    concurrency: args => args.action === 'read',
    run,
  };
}

function withFixture(t, run = async () => ({ ok: true, output: 'ok' })) {
  registerTool(fixtureTool(run));
  t.after(() => unregisterTool('self_described_fixture'));
  return getTool('self_described_fixture');
}

test('contract validates the optional self-description fields and keeps them optional', () => {
  const base = { id: 'x', name: 'x', description: 'x', parametersSchema: {}, run() {} };
  assert.equal(validateTool(base).valid, true);
  assert.equal(validateTool({ ...base, capability: null, needsWorkspace: false, uiModule: 'files', inputKeys: ['a'], concurrency: () => true }).valid, true);
  assert.equal(validateTool({ ...base, capability: ['readFiles', 'network'] }).valid, true);
  assert.equal(validateTool({ ...base, capability: { anyOf: ['readFiles'] } }).valid, true);
  for (const bad of [{ capability: 'root' }, { capability: [] }, { needsWorkspace: 'yes' }, { uiModule: '' }, { inputKeys: 'path' }, { concurrency: 1 }]) {
    assert.equal(validateTool({ ...base, ...bad }).valid, false, JSON.stringify(bad));
  }
});

test('capability is judged from the declaration; an undeclared unknown id is still denied', t => {
  const tool = withFixture(t);
  const readOnly = normalizeCapabilities({ readFiles: true });
  const writer = normalizeCapabilities({ writeFiles: true });
  assert.equal(toolCapabilityAllowed(tool.id, readOnly, { action: 'read' }, tool), true);
  assert.equal(toolCapabilityAllowed(tool.id, readOnly, { action: 'write' }, tool), false);
  assert.equal(toolCapabilityAllowed(tool.id, writer, { action: 'write' }, tool), true);
  // Visibility (no args) honours the anyOf declaration.
  assert.equal(toolCapabilityAllowed(tool.id, readOnly, undefined, tool), true);
  assert.deepEqual(filterToolsByCapabilities([tool], normalizeCapabilities({ network: true })), []);
  // Without the tool object the id is unmapped and fails closed, as before.
  assert.equal(toolCapabilityAllowed(tool.id, writer, { action: 'write' }), false);
  // A declaration that returns something outside the grammar also fails closed.
  assert.equal(toolCapabilityAllowed(tool.id, writer, { action: 'write' }, { id: tool.id, capability: () => 'everything' }), false);
  // Scope checks accept the tool object and apply the same rule.
  const scope = normalizeCapabilityScope({ agentId: 'research', capabilities: readOnly });
  assert.equal(scopeAllowsTool(scope, tool, { action: 'read' }), true);
  assert.equal(scopeAllowsTool(scope, tool, { action: 'write' }), false);
  assert.equal(scopeAllowsTool(scope, tool.id, { action: 'read' }), false);
});

test('workspace requirement follows the declaration per call', t => {
  const tool = withFixture(t);
  assert.equal(toolNeedsWorkspace(tool, { action: 'write' }), true);
  assert.equal(toolNeedsWorkspace(tool, { action: 'read' }), false);
  assert.equal(toolNeedsWorkspace(tool.id, { action: 'write' }), false); // id only → table → not local
  assert.equal(toolNeedsWorkspace({ id: 'file_read' }), true); // undeclared object → table
});

test('execution scene module and input summary follow uiModule and inputKeys', t => {
  const tool = withFixture(t);
  const args = { action: 'read', target: 'alpha', query: 'hidden query', path: '/hidden/path', count: 3 };
  const declared = observeTool({ id: 'call', name: tool.id, args, status: 'running', tool });
  assert.equal(declared.module, 'compute');
  assert.equal(declared.input, 'action: read\ntarget: alpha');
  const undeclared = observeTool({ id: 'call', name: tool.id, args, status: 'running' });
  assert.equal(undeclared.module, 'tools');
  assert.equal(undeclared.input, 'action: read\nquery: hidden query\npath: /hidden/path');
  assert.equal(moduleForOperation(tool.id, args, 'compute'), 'compute');
  assert.equal(moduleForOperation(tool.id, args, 'not-a-module'), 'tools');
  assert.equal(describeToolInput({ path: 'a', command: 'b' }, ['command']), 'command: b');
});

test('per-call concurrency: read actions overlap, write actions run one at a time', async t => {
  const track = tracker();
  const tool = withFixture(t, track.run);
  assert.equal(toolConcurrencySafe(tool, { action: 'read' }), true);
  assert.equal(toolConcurrencySafe(tool, { action: 'write' }), false);
  assert.equal(toolConcurrencySafe({ isConcurrencySafe: true }, {}), true); // legacy fallback
  assert.equal(toolConcurrencySafe({ isConcurrencySafe: true, concurrency: false }, {}), false); // declaration wins
  const home = await mkdtemp(join(tmpdir(), 'melo-self-description-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const reads = await executeToolCalls([
    { id: 'r1', tool, args: { action: 'read', target: 'one' } },
    { id: 'r2', tool, args: { action: 'read', target: 'two' } },
  ], { workspacePath: home });
  assert.deepEqual(reads.map(r => r.result.ok), [true, true]);
  assert.equal(track.peak(), 2, 'two read actions should overlap');
  assert.deepEqual(track.log.slice(0, 2), ['start:read:one', 'start:read:two']);
  track.log.length = 0;
  const writes = await executeToolCalls([
    { id: 'w1', tool, args: { action: 'write', target: 'one' } },
    { id: 'w2', tool, args: { action: 'write', target: 'two' } },
  ], { workspacePath: home });
  assert.deepEqual(writes.map(r => r.result.ok), [true, true]);
  assert.deepEqual(track.log, ['start:write:one', 'end:write:one', 'start:write:two', 'end:write:two']);
});

test('pdf / xlsx / image declare their write actions serial and capability by action', () => {
  assert.equal(toolConcurrencySafe(pdfTool, { action: 'read' }), true);
  for (const action of ['write', 'structured', 'merge', 'split', 'render', 'from_spec', 'watermark']) {
    assert.equal(toolConcurrencySafe(pdfTool, { action }), false, `pdf ${action}`);
  }
  assert.equal(toolConcurrencySafe(xlsxTool, { sheets: [] }), false);
  assert.equal(toolConcurrencySafe(imageTool, { action: 'info' }), true);
  assert.equal(toolConcurrencySafe(imageTool, { action: 'ocr' }), true);
  assert.equal(toolConcurrencySafe(imageTool, { action: 'generate' }), false);
  assert.equal(toolConcurrencySafe(imageTool, { action: 'process' }), false);
  // Declared capabilities reproduce the former table verdicts.
  const readOnly = normalizeCapabilities({ readFiles: true, knowledgeMemory: true });
  assert.equal(toolCapabilityAllowed('pdf', readOnly, { action: 'read', path: '/tmp/a' }, pdfTool), true);
  assert.equal(toolCapabilityAllowed('pdf', readOnly, { action: 'read', path: 'https://example.com/a.pdf' }, pdfTool), false);
  assert.equal(toolCapabilityAllowed('pdf', readOnly, { action: 'write' }, pdfTool), false);
  assert.equal(toolCapabilityAllowed('pdf', normalizeCapabilities({ writeFiles: true }), { action: 'merge' }, pdfTool), false);
  assert.equal(toolCapabilityAllowed('pdf', normalizeCapabilities({ writeFiles: true }), { action: 'write' }, pdfTool), true);
  assert.equal(toolCapabilityAllowed('pdf', readOnly, undefined, pdfTool), true);
  assert.equal(toolCapabilityAllowed('xlsx', readOnly, undefined, xlsxTool), false);
  assert.equal(toolCapabilityAllowed('image', readOnly, { action: 'generate' }, imageTool), false);
  const media = normalizeCapabilities({ generateMedia: true });
  assert.equal(toolCapabilityAllowed('image', media, { action: 'generate' }, imageTool), true);
  assert.equal(toolCapabilityAllowed('image', media, { action: 'generate', output: '/tmp/a.png' }, imageTool), false);
  assert.equal(toolCapabilityAllowed('image', media, { action: 'process' }, imageTool), false);
  assert.equal(toolCapabilityAllowed('image', readOnly, { action: 'ocr' }, imageTool), true);
  assert.equal(moduleForOperation('pdf', { action: 'write' }, pdfTool.uiModule({ action: 'write' })), 'create');
  assert.equal(moduleForOperation('pdf', { action: 'read' }, pdfTool.uiModule({ action: 'read' })), 'files');
});

test('pdf write gets a ledger receipt and no longer overlaps; pdf read stays receipt-free', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-self-description-ledger-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const direct = reserveTaskOperation({ home, taskId: 'task', tool: pdfTool, args: { action: 'write', path: 'a.pdf', content: 'x' } });
  assert.ok(direct, 'write action reserves a receipt');
  direct.finish({ ok: true, output: 'written' });
  assert.equal(reserveTaskOperation({ home, taskId: 'task', tool: pdfTool, args: { action: 'read', path: 'a.pdf' } }), null);
  const sheet = reserveTaskOperation({ home, taskId: 'task', tool: xlsxTool, args: { sheets: [] } });
  assert.ok(sheet, 'xlsx always writes and reserves a receipt');
  sheet.finish({ ok: true, output: 'saved' });
  // image is permission-free, so the ledger's existing rule skips it for every action.
  assert.equal(reserveTaskOperation({ home, taskId: 'task', tool: imageTool, args: { action: 'info', path: 'a.png' } }), null);

  // Through the executor: two pdf writes in one batch run serially and each
  // leaves a receipt. The pdf tool keeps requiresPermission:true (the ledger
  // ignores permission-free tools), so the prompt is auto-approved here.
  const track = tracker();
  const stub = { ...pdfTool, run: args => track.run({ action: args.action, target: args.path }) };
  const approve = (type, payload) => { if (type === 'tool_permission') resolvePermission(payload.requestId, true); };
  const context = { ...createRequestContext({ home, chatId: 'chat' }), turnBinding: { role: 'main', project: null, taskId: 'task-batch' } };
  const results = await withLegacyAgentFixture(() => executeToolCalls([
    { id: 'p1', tool: stub, args: { action: 'write', path: 'one.pdf', content: 'a' } },
    { id: 'p2', tool: stub, args: { action: 'write', path: 'two.pdf', content: 'b' } },
  ], { workspacePath: home, sseEmitter: approve }), context);
  assert.deepEqual(results.map(r => r.result.ok), [true, true]);
  assert.equal(track.peak(), 1, 'pdf writes must not overlap');
  assert.deepEqual(track.log, ['start:write:one.pdf', 'end:write:one.pdf', 'start:write:two.pdf', 'end:write:two.pdf']);
  const receipts = listTaskOperations('task-batch', home);
  assert.equal(receipts.filter(r => r.toolId === 'pdf').length, 2);
  assert.ok(receipts.every(r => !r.uncertain));
  track.log.length = 0;
  const read = await withLegacyAgentFixture(() => executeTool(stub, { action: 'read', path: 'one.pdf' }, { workspacePath: home, sseEmitter: approve }), context);
  assert.equal(read.ok, true);
  assert.equal(listTaskOperations('task-batch', home).length, 2, 'read action leaves no receipt');
});

test('search routing and team read inheritance read the declaration before their id tables', t => {
  const tool = withFixture(t);
  const webTool = { id: 'custom_web', capability: 'network', uiModule: 'search' };
  const otherTool = { id: 'custom_api', capability: 'network', uiModule: 'tools' };
  const exposed = filterToolsForSearchPlan([webTool, otherTool, { id: 'web_search' }, { id: 'calculator' }], { exposedNetworkTools: ['web_search'] });
  assert.deepEqual(exposed.map(t => t.id), ['custom_api', 'web_search', 'calculator']);
  assert.deepEqual(filterToolsForSearchPlan([webTool], { exposedNetworkTools: ['custom_web'] }).map(t => t.id), ['custom_web']);
  const readIds = inheritableReadToolIds([
    { id: 'notes_lookup', capability: 'knowledgeMemory' },
    { id: 'poster_maker', capability: 'generateMedia' },
    { id: 'api_caller', capability: 'network', uiModule: 'tools' },
    { id: 'page_reader', capability: 'network', uiModule: 'search' },
  ]);
  for (const id of ['file_read', 'glob', 'grep', 'web_search', 'fetch_url', 'calculator', 'media_info', 'search_history', 'notes_lookup', 'page_reader']) assert.ok(readIds.includes(id), id);
  for (const id of ['poster_maker', 'api_caller', tool.id, 'file_write', 'bash']) assert.equal(readIds.includes(id), false, id);
});
