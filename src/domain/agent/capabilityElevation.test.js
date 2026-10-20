// Desktop half of the capability-elevation contract (2026-10-20). The same
// fixtures (shared/protocol/agent-loop.json fixtures.capabilityElevation) are
// for the iPhone port's SharedContractTests.swift runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_LOOP_CONTRACT } from '../../runtime/agentLoopContract.js';
import { CAPABILITY_LABELS, normalizeCapabilities, emptyCapabilities } from './capabilities.js';
import {
  CAPABILITY_ELEVATION, isCapabilityAtom, sortAtoms, atomsOfCapabilities, capabilitiesFromAtoms, unionCapabilities, hasAtom,
  atomLabel, atomsLabel, grantIsActive, grantExpiry, effectiveScope, candidateAtoms, missingAtoms, decideCapability,
  isPromptDecision, requestableCapabilities, capabilityPromptText, capabilityOptionLabel, elevationText,
} from './capabilityElevation.js';

const F = AGENT_LOOP_CONTRACT.fixtures.capabilityElevation;
const caps = atoms => (atoms === null ? null : capabilitiesFromAtoms(atoms));
const party = value => (value ? { ...value, capabilities: caps(value.capabilities), ...(value.globalCapabilities ? { globalCapabilities: caps(value.globalCapabilities) } : {}) } : null);

test('contract labels and capability keys are the desktop ones', () => {
  assert.deepEqual(CAPABILITY_ELEVATION.labels.capabilities, CAPABILITY_LABELS);
  assert.deepEqual(CAPABILITY_ELEVATION.booleanCapabilities, Object.keys(CAPABILITY_LABELS));
  assert.deepEqual(CAPABILITY_ELEVATION.listCapabilities, ['mcpServers', 'skills', 'connectors']);
  assert.ok(!CAPABILITY_ELEVATION.jitVisible.includes('delegate'), 'delegation needs collaboration settings; it is never offered just in time');
  for (const [decision, options] of Object.entries(CAPABILITY_ELEVATION.options)) {
    assert.ok(CAPABILITY_ELEVATION.decisions.includes(decision));
    for (const option of options) assert.ok(CAPABILITY_ELEVATION.responses.includes(option));
  }
  assert.equal(CAPABILITY_ELEVATION.grantScopes.project.durationMs, 24 * 3600 * 1000);
  assert.equal(CAPABILITY_ELEVATION.grantScopes.chat.durationMs, 24 * 3600 * 1000);
});

test('decision fixtures', () => {
  assert.ok(F.decisions.length >= 25);
  for (const row of F.decisions) {
    const input = row.input;
    const decision = decideCapability({ ...input, member: party(input.member), parent: party(input.parent), base: input.base ? caps(input.base) : undefined });
    const actual = { ...decision, effective: decision.effective ? atomsOfCapabilities(decision.effective) : null };
    for (const [key, value] of Object.entries(row.expected)) assert.deepEqual(actual[key], value, `${row.name}: ${key}`);
    if (!Object.hasOwn(row.expected, 'alwaysUnavailable')) assert.equal(actual.alwaysUnavailable, undefined, `${row.name}: alwaysUnavailable`);
    assert.ok(Object.isFrozen(decision));
  }
});

test('prompt text and expiry fixtures', () => {
  for (const row of F.prompts) assert.equal(capabilityPromptText(row), row.expected);
  for (const row of F.expiries) assert.equal(grantExpiry(row.scope, row.now), row.expected);
  assert.throws(() => grantExpiry('forever', 0), /Unknown grant scope/);
  assert.equal(capabilityOptionLabel('elevate-beyond-parent', 'project', 'chat'), '本对话 24 小时');
  assert.equal(capabilityOptionLabel('elevate-beyond-parent', 'project', 'project'), '本项目 24 小时');
  assert.equal(capabilityOptionLabel('enable-own', 'always'), '一直开启');
  assert.equal(elevationText('runNotice', { agent: 'builder', capability: '修改文件' }), '本次运行临时允许 builder 使用『修改文件』');
});

test('atoms: grammar, canonical order, round trip, labels', () => {
  for (const atom of ['readFiles', 'delegate', 'mcpServers:github', 'skills:weekly-report', 'connectors:c1']) assert.ok(isCapabilityAtom(atom), atom);
  for (const atom of ['', 'evil', 'mcpServers:', 'mcpServers: x', 'tools:bash', ':x', 42, null, `skills:${'x'.repeat(240)}`]) assert.equal(isCapabilityAtom(atom), false, String(atom));
  assert.deepEqual(sortAtoms(['skills:b', 'network', 'mcpServers:z', 'readFiles', 'skills:a', 'network']), ['readFiles', 'network', 'mcpServers:z', 'skills:a', 'skills:b']);
  const c = normalizeCapabilities({ readFiles: true, network: true, mcpServers: ['github'], skills: ['s'], connectors: ['c'] });
  assert.deepEqual(atomsOfCapabilities(c), ['readFiles', 'network', 'mcpServers:github', 'skills:s', 'connectors:c']);
  assert.deepEqual(capabilitiesFromAtoms(atomsOfCapabilities(c)), c);
  assert.deepEqual(capabilitiesFromAtoms(['evil', 'mcpServers:', 'writeFiles']), capabilitiesFromAtoms(['writeFiles']));
  assert.equal(atomsOfCapabilities(null), null);
  assert.equal(unionCapabilities(null, null), null);
  assert.deepEqual(unionCapabilities(null, c), c);
  assert.ok(hasAtom(c, 'mcpServers:github'));
  assert.equal(hasAtom(c, 'mcpServers:other'), false);
  assert.equal(hasAtom(null, 'readFiles'), false);
  assert.equal(atomLabel('runCommands'), '运行命令');
  assert.equal(atomLabel('connectors:c1'), '连接器「c1」');
  assert.equal(atomsLabel(['network', 'writeFiles']), '修改文件、联网');
});

test('grant activity checks shape, agent, kind, scope binding and time', () => {
  const now = 10_000;
  const base = { id: 'g', agentId: 'a', atoms: ['writeFiles'], kind: 'enable-own', scope: 'run', runId: 'r', createdAt: 0, expiresAt: now + 1 };
  const context = { agentId: 'a', runId: 'r', projectId: null, chatId: 'c' };
  assert.ok(grantIsActive(base, context, now));
  for (const broken of [{ atoms: [] }, { atoms: ['tools:bash'] }, { kind: 'superuser' }, { scope: 'forever' }, { expiresAt: now }, { expiresAt: 'later' }, { revokedAt: 1 }, { agentId: 'b' }, { runId: 'other' }]) {
    assert.equal(grantIsActive({ ...base, ...broken }, context, now), false, JSON.stringify(broken));
  }
  assert.equal(grantIsActive(null, context, now), false);
  assert.equal(grantIsActive({ ...base, scope: 'run', runId: null }, { ...context, runId: null }, now), false, 'a missing run id never matches');
  assert.equal(grantIsActive({ ...base, scope: 'chat', chatId: 'c' }, { ...context, projectId: 'p' }, now), false, 'a chat grant does not apply inside a project');
});

test('beyond-parent grants never apply to a top-level Agent and never exceed the ceiling', () => {
  const grant = { id: 'g', agentId: 'main', atoms: ['writeFiles', 'runCommands'], kind: 'elevate-beyond-parent', scope: 'run', runId: 'r', expiresAt: 1e15 };
  const top = effectiveScope({ member: { agentId: 'main', capabilities: caps(['readFiles', 'writeFiles']) }, grants: [grant], context: { runId: 'r' }, now: 0 });
  assert.deepEqual(atomsOfCapabilities(top.capabilities), ['readFiles', 'writeFiles']);
  assert.deepEqual(top.grantIds, []);
  const member = effectiveScope({ member: { agentId: 'main', capabilities: caps(['readFiles', 'writeFiles']) }, parent: { agentId: 'x', capabilities: caps(['readFiles']) }, grants: [grant], context: { runId: 'r' }, now: 0 });
  assert.deepEqual(atomsOfCapabilities(member.capabilities), ['readFiles', 'writeFiles']);
  assert.deepEqual(member.grantIds, ['g']);
});

test('candidate atoms name the MCP server or skill of the tool id; malformed ids add nothing', () => {
  assert.deepEqual(candidateAtoms('mcp:github:create_issue').slice(-1), ['mcpServers:github']);
  assert.deepEqual(candidateAtoms('skill:report').slice(-1), ['skills:report']);
  assert.equal(candidateAtoms('mcp:bad server:x').length, CAPABILITY_ELEVATION.booleanCapabilities.length);
  assert.equal(candidateAtoms('skill:').length, CAPABILITY_ELEVATION.booleanCapabilities.length);
  assert.equal(candidateAtoms('file_write').length, CAPABILITY_ELEVATION.booleanCapabilities.length);
});

test('missing atoms prefer the ceiling on ties and report null when nothing helps', () => {
  // image without args (visibility): readFiles OR generateMedia — the ceiling holds generateMedia.
  const effective = emptyCapabilities();
  assert.deepEqual(missingAtoms({ toolId: 'image', effective, ceiling: caps(['generateMedia']) }), ['generateMedia']);
  assert.deepEqual(missingAtoms({ toolId: 'image', effective, ceiling: emptyCapabilities() }), ['readFiles']);
  assert.equal(missingAtoms({ toolId: 'nope', effective, ceiling: emptyCapabilities() }), null);
  // image process needs three atoms at once.
  assert.deepEqual(missingAtoms({ toolId: 'image', args: { action: 'process', output: 'o.png' }, effective, ceiling: emptyCapabilities() }), ['readFiles', 'writeFiles', 'generateMedia']);
});

test('requestable capabilities widen visibility only with a surface, never to delegation or foreign MCP servers', () => {
  const own = caps(['readFiles']);
  const ceiling = caps(['readFiles', 'writeFiles', 'mcpServers:github']);
  assert.deepEqual(requestableCapabilities({ capabilities: own, ceiling, surface: false }), own);
  const visible = requestableCapabilities({ capabilities: own, ceiling, surface: true });
  assert.deepEqual(atomsOfCapabilities(visible), ['readFiles', 'writeFiles', 'runCommands', 'network', 'knowledgeMemory', 'generateMedia', 'mcpServers:github']);
  assert.equal(visible.delegate, false);
  assert.equal(requestableCapabilities({ capabilities: null, surface: true }), null);
  assert.ok(requestableCapabilities({ capabilities: own, ceiling: caps(['delegate']), surface: true }).delegate, 'delegation inside the ceiling stays visible');
});

test('prompt decisions are the only ones that ask', () => {
  assert.ok(isPromptDecision('elevate-beyond-parent'));
  assert.ok(isPromptDecision('enable-own'));
  for (const decision of ['allowed', 'deny-no-surface', 'deny-ceiling']) assert.equal(isPromptDecision(decision), false);
});

// Property check over a deterministic pseudo-random space: the rules hold for
// every combination, not just the fixtures.
test('invariants: base ⊆ parent, effective ⊆ ceiling ∪ enable-own grants, prompts only with a surface', () => {
  let seed = 20261020;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pool = [...CAPABILITY_ELEVATION.booleanCapabilities, 'mcpServers:github', 'mcpServers:linear', 'skills:s1'];
  const pickAtoms = () => pool.filter(() => random() < 0.45);
  const tools = ['file_read', 'file_write', 'bash', 'web_search', 'knowledge', 'image', 'pdf', 'delegate', 'mcp:github:x', 'mcp:linear:y', 'skill:s1', 'calculator', 'unknown_tool'];
  const argsFor = id => ({ image: { action: random() < 0.5 ? 'generate' : 'ocr' }, pdf: { action: random() < 0.5 ? 'read' : 'write', ...(random() < 0.3 ? { url: 'https://x' } : {}) }, knowledge: { action: random() < 0.5 ? 'index' : 'search' } })[id];
  for (let i = 0; i < 1500; i++) {
    const member = { agentId: 'm', capabilities: caps(pickAtoms()) };
    const parent = random() < 0.6 ? { agentId: 'p', capabilities: caps(pickAtoms()) } : null;
    const grants = Array.from({ length: Math.floor(random() * 3) }, (_, n) => ({
      id: `g${n}`, agentId: random() < 0.8 ? 'm' : 'other', atoms: pickAtoms().slice(0, 3), kind: random() < 0.5 ? 'enable-own' : 'elevate-beyond-parent',
      scope: 'run', runId: random() < 0.8 ? 'r' : 'old', expiresAt: random() < 0.9 ? 100 : 1,
    })).filter(g => g.atoms.length);
    const context = { surface: random() < 0.7, runId: 'r', projectId: random() < 0.5 ? 'p1' : null, chatId: 'c' };
    const toolId = tools[Math.floor(random() * tools.length)];
    const scope = effectiveScope({ member, parent, grants, context, now: 50 });
    const ceiling = atomsOfCapabilities(member.capabilities);
    if (parent) for (const atom of atomsOfCapabilities(scope.base)) assert.ok(hasAtom(parent.capabilities, atom) && ceiling.includes(atom));
    const ownGranted = grants.filter(g => g.kind === 'enable-own' && grantIsActive(g, { agentId: 'm', ...context }, 50)).flatMap(g => g.atoms);
    for (const atom of atomsOfCapabilities(scope.capabilities)) assert.ok(ceiling.includes(atom) || ownGranted.includes(atom), `${atom} escaped the ceiling`);
    const decision = decideCapability({ toolId, args: argsFor(toolId), member, parent, grants, context, now: 50 });
    assert.ok(CAPABILITY_ELEVATION.decisions.includes(decision.decision));
    if (isPromptDecision(decision.decision)) {
      assert.equal(context.surface, true);
      assert.ok(decision.missing.length > 0 && decision.options.includes('deny'));
    }
    if (decision.decision === 'elevate-beyond-parent') {
      assert.ok(parent, 'beyond-parent needs a parent');
      for (const atom of decision.missing) assert.ok(ceiling.includes(atom), 'beyond-parent stays inside the ceiling');
    }
    if (decision.decision === 'enable-own') assert.ok(decision.missing.some(atom => !ceiling.includes(atom)));
    if (decision.decision === 'deny-no-surface') assert.equal(context.surface, false);
  }
});

test('capability scopes carry the elevation descriptor through narrowing, member switches and live re-evaluation', async () => {
  const { capabilityScopeForProfile, narrowCapabilityScope, withElevationSurface, liveCapabilityScope, elevatedCapabilityScope, scopeAllowsTool, toolsForCapabilityScope, visibleCapabilities } = await import('./capabilityScope.js');
  const main = capabilityScopeForProfile({ id: 'main', capabilities: caps(['readFiles', 'network']) });
  assert.deepEqual(atomsOfCapabilities(main.elevation.ceiling), ['readFiles', 'network']);
  assert.equal(main.elevation.surface, false);
  assert.equal(main.elevation.parent, null);
  const surfaced = withElevationSurface(main, true);
  assert.equal(surfaced.elevation.surface, true);
  assert.ok(Object.isFrozen(surfaced.elevation) && Object.isFrozen(surfaced.elevation.base));
  // Same-Agent narrowing keeps the ceiling and narrows the base.
  const skill = narrowCapabilityScope(surfaced, { capabilities: caps(['readFiles']), allowedToolIds: ['file_read', 'file_write'], source: 'skill' });
  assert.deepEqual(atomsOfCapabilities(skill.elevation.base), ['readFiles']);
  assert.deepEqual(skill.elevation.ceiling, surfaced.elevation.ceiling);
  assert.equal(skill.elevation.surface, true);
  // A tool run that a grant allowed: the ambient holds the grant, the base does not,
  // and a member derived from it starts from the grant-free base.
  const elevated = elevatedCapabilityScope(surfaced, caps(['readFiles', 'network', 'writeFiles']));
  assert.ok(scopeAllowsTool(elevated, 'file_write', {}));
  assert.equal(scopeAllowsTool(liveCapabilityScope(elevated), 'file_write', {}), false, 'live view drops granted atoms');
  const builderCeiling = caps(['readFiles', 'writeFiles', 'runCommands']);
  const parentBase = elevated.elevation.base;
  const member = narrowCapabilityScope(elevated, { capabilities: caps(['readFiles', 'writeFiles', 'runCommands']), agentId: 'builder', source: 'member',
    member: { ceiling: builderCeiling, parent: parentBase, parentAgentId: 'main' } });
  assert.equal(member.agentId, 'builder');
  assert.deepEqual(atomsOfCapabilities(member.elevation.parent), ['readFiles', 'network']);
  assert.equal(member.elevation.parentAgentId, 'main');
  assert.equal(member.elevation.surface, true);
  // Visibility: with a surface the member sees its ceiling and the just-in-time booleans, never delegation.
  const tools = ['file_read', 'file_write', 'bash', 'web_search', 'delegate', 'calculator'].map(id => ({ id }));
  assert.deepEqual(atomsOfCapabilities(visibleCapabilities(member)), ['readFiles', 'writeFiles', 'runCommands', 'network', 'knowledgeMemory', 'generateMedia']);
  assert.deepEqual(toolsForCapabilityScope(tools, member).map(t => t.id), ['file_read', 'file_write', 'bash', 'web_search', 'calculator']);
  assert.deepEqual(atomsOfCapabilities(member.capabilities), ['readFiles'], 'the parent grant (writeFiles) is not inherited');
  assert.deepEqual(toolsForCapabilityScope(tools, withElevationSurface(member, false)).map(t => t.id), ['file_read', 'calculator']);
  // Legacy and hand-built scopes behave exactly as before.
  const legacy = capabilityScopeForProfile({ id: 'old', capabilities: null });
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.elevation, null);
  assert.deepEqual(toolsForCapabilityScope(tools, Object.freeze({ agentId: 'x', capabilities: caps(['readFiles']), legacy: false, source: 'turn' })).map(t => t.id), ['file_read', 'calculator']);
});
