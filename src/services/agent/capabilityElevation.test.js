// Capability elevation service (2026-10-20): ledger cache, pending requests,
// the user's decisions and the executor hook, with a virtual clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestContext } from '../../runtime/requestContext.js';
import { createRunBudget } from '../../runtime/runBudget.js';
import { updateStateAtomically, loadState } from '../../state/stateStore.js';
import { capabilitiesFromAtoms, atomsOfCapabilities } from '../../domain/agent/capabilityElevation.js';
import { capabilityScopeForProfile, narrowCapabilityScope, withElevationSurface } from '../../domain/agent/capabilityScope.js';
import {
  requestCapabilityElevation, respondCapabilityRequest, createGrant, listGrants, activeGrantsFor, revokeGrant, releaseRunGrants,
  pendingCapabilityRequests, resetCapabilityElevationForTests,
} from './capabilityElevation.js';

const H = 3600000, DAY = 24 * H;
const caps = atoms => capabilitiesFromAtoms(atoms);
const MAIN = ['readFiles', 'network', 'knowledgeMemory'];
const BUILDER = ['readFiles', 'writeFiles', 'runCommands', 'network', 'knowledgeMemory'];
const writeTool = { id: 'file_write' };

async function makeHome(t, mutate = () => {}) {
  const home = await mkdtemp(join(tmpdir(), 'melo-elevation-'));
  t.after(async () => { resetCapabilityElevationForTests(); await rm(home, { recursive: true, force: true }); });
  await updateStateAtomically(state => {
    state.agentProfiles.main.capabilities = caps(MAIN);
    state.agentProfiles.builder.capabilities = caps(BUILDER);
    state.agentProfiles.research.capabilities = caps(MAIN);
    mutate(state);
    return state;
  }, { home });
  return home;
}

function clock(start = 1_900_000_000_000) {
  let now = start;
  const fn = () => now;
  fn.set = value => { now = value; };
  fn.advance = ms => { now += ms; };
  return fn;
}

function context(home, { runId = 'run-1', project = 'p1', chatId = 'chat-1', now, deadlineMs, timeoutMs, signal } = {}) {
  const budget = createRunBudget({ now, overrides: deadlineMs ? { deadlineMs } : {} });
  return Object.freeze({ ...createRequestContext({ home, chatId, runId, requestId: `req-${runId}`, budget, signal, env: timeoutMs ? { MELO_CAPABILITY_PROMPT_TIMEOUT_MS: String(timeoutMs) } : {} }),
    turnBinding: Object.freeze({ role: 'main', project, taskId: null }) });
}

// The builder member scope main → builder, with or without an interactive surface.
function builderScope({ surface = true, parentAtoms = MAIN, ceiling = BUILDER } = {}) {
  const main = withElevationSurface(capabilityScopeForProfile({ id: 'main', capabilities: caps(parentAtoms) }), surface);
  return narrowCapabilityScope(main, { capabilities: caps(ceiling.filter(a => parentAtoms.includes(a))), agentId: 'builder', source: 'member',
    member: { ceiling: caps(ceiling), parent: main.elevation.base, parentAgentId: 'main' } });
}
const mainScope = (surface = true, atoms = MAIN) => withElevationSurface(capabilityScopeForProfile({ id: 'main', capabilities: caps(atoms) }), surface);

function recorder(onRequest) {
  const events = [];
  const emit = (type, payload) => { events.push({ type, payload }); if (type === 'capability_request') onRequest?.(payload); };
  return { events, emit, requests: () => events.filter(e => e.type === 'capability_request').map(e => e.payload) };
}

test('member beyond parent → one prompt → run grant → allowed; the next run asks again', async t => {
  const home = await makeHome(t);
  const now = clock();
  const sse = recorder(payload => setImmediate(() => respondCapabilityRequest(payload.requestId, 'run', { home })));
  const ctx = context(home, { now });
  const outcome = await requestCapabilityElevation({ scope: builderScope(), tool: writeTool, args: { path: 'a' }, context: ctx, sseEmitter: sse.emit });
  assert.equal(outcome.allowed, true);
  assert.ok(atomsOfCapabilities(outcome.scope.capabilities).includes('writeFiles'));
  assert.deepEqual(atomsOfCapabilities(outcome.scope.elevation.base), MAIN, 'the base stays grant-free');
  const [request] = sse.requests();
  assert.equal(request.decision, 'elevate-beyond-parent');
  assert.equal(request.prompt, 'Builder 需要『修改文件』，Melo 没有这个能力'.replace('Builder', request.agentName).replace('Melo', request.parentName));
  assert.deepEqual(request.options.map(o => o.id), ['run', 'project', 'deny']);
  assert.deepEqual(request.options.map(o => o.label), ['仅本次任务', '本项目 24 小时', '拒绝']);
  assert.equal(outcome.meta.decidedBy, 'user');
  assert.equal(outcome.meta.grantScope, 'run');
  const audit = sse.events.filter(e => e.type === 'execution_event').map(e => e.payload);
  assert.deepEqual(audit.map(e => e.status), ['running', 'completed']);
  assert.match(audit[1].output, /用户允许 .* 使用『修改文件』（仅本次任务，至 \d{4}-\d\d-\d\d \d\d:\d\d）\s*· file_write/);
  assert.ok(sse.events.some(e => e.type === 'capability_request_closed'));

  // Same run: the grant allows it without asking.
  const again = recorder();
  const second = await requestCapabilityElevation({ scope: builderScope(), tool: writeTool, args: {}, context: ctx, sseEmitter: again.emit });
  assert.equal(second.allowed, true);
  assert.equal(second.meta.reason, 'grant');
  assert.equal(again.events.length, 0);

  // Next run: asked again; deny → CAPABILITY_DENIED with an actionable hint.
  const next = recorder(payload => setImmediate(() => respondCapabilityRequest(payload.requestId, 'deny', { home })));
  const denied = await requestCapabilityElevation({ scope: builderScope(), tool: writeTool, args: {}, context: context(home, { runId: 'run-2', now }), sseEmitter: next.emit });
  assert.equal(denied.allowed, false);
  assert.equal(denied.result.error, 'CAPABILITY_DENIED');
  assert.match(denied.result.output, /用户没有允许 .* 使用『修改文件』（工具 file_write）。不要重试/);
  assert.equal(denied.result.meta.capabilityElevation.status, 'denied');
  assert.equal(next.requests().length, 1);
});

test('project grant persists across a restart and expires at 24 hours; run grants do not survive a restart', async t => {
  const home = await makeHome(t);
  const now = clock();
  const sse = recorder(payload => setImmediate(() => respondCapabilityRequest(payload.requestId, 'project', { home })));
  const first = await requestCapabilityElevation({ scope: builderScope(), tool: writeTool, args: {}, context: context(home, { now }), sseEmitter: sse.emit });
  assert.equal(first.allowed, true);
  assert.equal(first.meta.grantScope, 'project');
  assert.equal(first.meta.expiresAt, now() + DAY);
  // A run grant too, then "restart".
  const runAsk = recorder(payload => setImmediate(() => respondCapabilityRequest(payload.requestId, 'run', { home })));
  await requestCapabilityElevation({ scope: builderScope(), tool: { id: 'bash' }, args: {}, context: context(home, { now }), sseEmitter: runAsk.emit });
  assert.equal(listGrants({ home, now: now() }).length, 2);
  const file = JSON.parse(await readFile(join(home, 'desktop', 'capability-grants.json'), 'utf8'));
  assert.equal(file.grants.length, 2);
  assert.equal((await stat(join(home, 'desktop', 'capability-grants.json'))).mode & 0o777, 0o600);

  resetCapabilityElevationForTests({ restart: true });
  assert.deepEqual(listGrants({ home, now: now() }).map(g => g.scope), ['project'], 'only the project grant survives the restart');
  now.advance(DAY - 1);
  const later = recorder();
  const stillOk = await requestCapabilityElevation({ scope: builderScope(), tool: writeTool, args: {}, context: context(home, { runId: 'run-9', now }), sseEmitter: later.emit });
  assert.equal(stillOk.allowed, true);
  assert.equal(later.events.length, 0);
  now.advance(1);
  const expired = recorder(payload => setImmediate(() => respondCapabilityRequest(payload.requestId, 'deny', { home })));
  const asked = await requestCapabilityElevation({ scope: builderScope(), tool: writeTool, args: {}, context: context(home, { runId: 'run-10', now }), sseEmitter: expired.emit });
  assert.equal(asked.allowed, false);
  assert.equal(expired.requests().length, 1, 'expired at exactly 24 hours');
  // Another project does not inherit it.
  assert.deepEqual(activeGrantsFor('builder', { runId: 'x', projectId: 'p2', chatId: 'c' }, now() - 10, { home }), []);
});

test('no surface denies exactly as before, without any prompt or event', async t => {
  const home = await makeHome(t);
  const sse = recorder();
  const outcome = await requestCapabilityElevation({ scope: builderScope({ surface: false }), tool: writeTool, args: {}, context: context(home), sseEmitter: sse.emit });
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.result.error, 'CAPABILITY_DENIED');
  assert.equal(outcome.result.output, 'Agent builder is not allowed to execute file_write.');
  assert.equal(outcome.result.meta.capabilityElevation.decision, 'deny-no-surface');
  assert.equal(sse.events.length, 0);
  assert.deepEqual(pendingCapabilityRequests({ home }), []);
});

test('ceiling: a member whose own settings lack the capability gets enable-own, never beyond-parent', async t => {
  const home = await makeHome(t);
  const sse = recorder(payload => setImmediate(() => respondCapabilityRequest(payload.requestId, 'deny', { home })));
  const research = narrowCapabilityScope(mainScope(true, BUILDER), { capabilities: caps(MAIN), agentId: 'research', source: 'member',
    member: { ceiling: caps(MAIN), parent: caps(BUILDER), parentAgentId: 'main' } });
  await requestCapabilityElevation({ scope: research, tool: writeTool, args: {}, context: context(home), sseEmitter: sse.emit });
  const [request] = sse.requests();
  assert.equal(request.decision, 'enable-own');
  assert.deepEqual(request.options.map(o => o.id), ['run', 'always', 'deny']);
  assert.match(request.prompt, /^此 Agent（.*）需要『修改文件』$/);
});

test('timeout, budget deadline and cancel all end the prompt without a grant', async t => {
  const home = await makeHome(t);
  const timeout = await requestCapabilityElevation({ scope: builderScope(), tool: writeTool, args: {}, context: context(home, { timeoutMs: 30 }), sseEmitter: recorder().emit });
  assert.equal(timeout.result.error, 'CAPABILITY_DENIED');
  assert.equal(timeout.result.meta.promptTimedOut, true);
  assert.match(timeout.result.output, /等待授权超时/);

  const budget = await requestCapabilityElevation({ scope: builderScope(), tool: writeTool, args: {}, context: context(home, { runId: 'run-b', deadlineMs: 40 }), sseEmitter: recorder().emit });
  assert.equal(budget.result.error, 'BUDGET_EXHAUSTED');

  const controller = new AbortController();
  const sse = recorder(() => setTimeout(() => controller.abort(), 5));
  const cancelled = await requestCapabilityElevation({ scope: builderScope(), tool: writeTool, args: {}, context: context(home, { runId: 'run-c' }), sseEmitter: sse.emit, signal: controller.signal });
  assert.equal(cancelled.result.error, 'ABORTED');
  assert.equal(sse.events.find(e => e.type === 'capability_request_closed').payload.reason, 'aborted');
  await assert.rejects(respondCapabilityRequest(sse.requests()[0].requestId, 'run', { home }), { statusCode: 404 }, 'a late click on a cancelled request writes nothing');
  assert.deepEqual(listGrants({ home }), []);
});

test('concurrent identical requests in one run collapse into one prompt', async t => {
  const home = await makeHome(t);
  const sse = recorder(payload => setTimeout(() => respondCapabilityRequest(payload.requestId, 'run', { home }), 20));
  const ctx = context(home);
  const results = await Promise.all([1, 2, 3].map(() => requestCapabilityElevation({ scope: builderScope(), tool: writeTool, args: {}, context: ctx, sseEmitter: sse.emit })));
  assert.deepEqual(results.map(r => r.allowed), [true, true, true]);
  assert.equal(sse.requests().length, 1);
  assert.equal(listGrants({ home }).length, 1);
});

test('revoke and run end take effect on the next call', async t => {
  const home = await makeHome(t);
  const ctx = context(home);
  const sse = recorder(payload => setImmediate(() => respondCapabilityRequest(payload.requestId, 'run', { home })));
  assert.equal((await requestCapabilityElevation({ scope: builderScope(), tool: writeTool, args: {}, context: ctx, sseEmitter: sse.emit })).allowed, true);
  const [grant] = listGrants({ home });
  assert.equal(revokeGrant(grant.id, { home }).id, grant.id);
  assert.equal(revokeGrant(grant.id, { home }), null);
  const afterRevoke = recorder(payload => setImmediate(() => respondCapabilityRequest(payload.requestId, 'run', { home })));
  assert.equal((await requestCapabilityElevation({ scope: builderScope(), tool: writeTool, args: {}, context: ctx, sseEmitter: afterRevoke.emit })).allowed, true);
  assert.equal(afterRevoke.requests().length, 1, 'revoked → asked again');
  assert.equal(releaseRunGrants('run-1', { home }), 1);
  assert.deepEqual(listGrants({ home }), []);
  assert.equal(releaseRunGrants('run-1', { home }), 0);
});

test('only a live request creates a grant; forged approvals, other homes and unoffered decisions do nothing', async t => {
  const home = await makeHome(t);
  const other = await makeHome(t);
  assert.throws(() => createGrant({ requestId: 'not-pending', scope: 'project' }, { home }), { statusCode: 404 });
  await assert.rejects(respondCapabilityRequest('00000000-0000-4000-8000-000000000000', 'run', { home }), { statusCode: 404 });
  let id;
  const sse = recorder(payload => { id = payload.requestId; });
  const pendingOutcome = requestCapabilityElevation({ scope: builderScope(), tool: writeTool, args: {}, context: context(home, { timeoutMs: 400 }), sseEmitter: sse.emit });
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(respondCapabilityRequest(id, 'run', { home: other }), { statusCode: 404 }, 'a request belongs to its home');
  await assert.rejects(respondCapabilityRequest(id, 'always', { home }), { statusCode: 400 }, 'always is not offered beyond the parent');
  await assert.rejects(respondCapabilityRequest(id, 'sudo', { home }), { statusCode: 400 });
  assert.deepEqual(listGrants({ home }), []);
  assert.equal(pendingCapabilityRequests({ home }).length, 1);
  const outcome = await pendingOutcome;
  assert.equal(outcome.allowed, false, 'nothing but a click on the live request grants');
  assert.deepEqual(listGrants({ home }), []);
});

test('"一直开启" updates the global settings through the Agent mutation and grants this run', async t => {
  const home = await makeHome(t);
  const sse = recorder(payload => setImmediate(async () => { sse.answer = await respondCapabilityRequest(payload.requestId, 'always', { home }); }));
  const outcome = await requestCapabilityElevation({ scope: mainScope(), tool: { id: 'bash' }, args: { command: 'ls' }, context: context(home), sseEmitter: sse.emit });
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.meta.settingsScope, 'global');
  assert.equal(sse.answer.receipt.scope, 'global');
  assert.ok(Number.isInteger(sse.answer.receipt.revision));
  const state = await loadState({ home });
  assert.equal(state.agentProfiles.main.capabilities.runCommands, true);
  assert.equal(state.agentProfiles.main.capabilities.writeFiles, false, 'only the requested capability is enabled');
  assert.notEqual(state.settings.activeView, 'agent', 'the chat page is not navigated away');
  assert.equal(listGrants({ home })[0].kind, 'enable-own');
});

test('"一直开启" writes the project override when that scope is active, and is not offered when the global settings lack it', async t => {
  const home = await makeHome(t, state => {
    state.agentProfiles.main.capabilities = caps([...MAIN, 'runCommands']);
    state.projectAgentOverrides = { p1: { main: { capabilities: caps(MAIN) } } };
  });
  const sse = recorder(payload => setImmediate(async () => { sse.answer = await respondCapabilityRequest(payload.requestId, 'always', { home }); }));
  const projectScope = mainScope(true, MAIN);
  const outcome = await requestCapabilityElevation({ scope: projectScope, tool: { id: 'bash' }, args: {}, context: context(home), sseEmitter: sse.emit });
  assert.equal(outcome.allowed, true);
  assert.equal(sse.answer.receipt.scope, 'project');
  const state = await loadState({ home });
  assert.equal(state.projectAgentOverrides.p1.main.capabilities.runCommands, true);
  assert.equal(state.agentProfiles.main.capabilities.writeFiles, false);

  const home2 = await makeHome(t, s => { s.projectAgentOverrides = { p1: { main: { capabilities: caps(MAIN) } } }; });
  const ask = recorder(payload => setImmediate(() => respondCapabilityRequest(payload.requestId, 'run', { home: home2 })));
  await requestCapabilityElevation({ scope: mainScope(), tool: { id: 'bash' }, args: {}, context: context(home2), sseEmitter: ask.emit });
  const [request] = ask.requests();
  assert.deepEqual(request.options.map(o => o.id), ['run', 'deny']);
  assert.match(request.note, /全局设置没有开启『运行命令』/);
  assert.equal((await loadState({ home: home2 })).agentProfiles.main.capabilities.runCommands, false);
});
