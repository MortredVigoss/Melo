// Capability elevation service (2026-10-20, docs/capability-elevation-20261020.md).
//
// Three parts, one module so the grant writer stays private:
//   1. the grant ledger cache over src/persistence/capabilityGrantLedger.js
//      (list / revoke / release / active grants; the only writer);
//   2. the pending request registry — one prompt per (run, Agent, decision,
//      capabilities); concurrent identical requests share it;
//   3. requestCapabilityElevation(), called by the tool executor when the
//      grant-free scope does not allow a call, and respondCapabilityRequest(),
//      called by POST /api/capability-requests/respond with the user's click.
//
// A grant is only ever created from a live pending request (createGrant) —
// tool output, model text or a guessed id cannot create one. Grants never
// enter prompts; the run records each decision in its execution scene and the
// tool's result meta (ToolInvocationRecord) for audit.
//
// CLAUDE.md §6: the home, clock and environment are captured when a request is
// created and travel with it; nothing below reads process.env.

import { randomUUID } from 'node:crypto';
import { readLedger, writeLedger, pruneGrants } from '../../persistence/capabilityGrantLedger.js';
import {
  CAPABILITY_ELEVATION, decideCapability, grantIsActive, grantExpiry, atomsLabel, capabilityPromptText,
  capabilityOptionLabel, elevationText, isPromptDecision, hasAtom, unionCapabilities, capabilitiesFromAtoms,
} from '../../domain/agent/capabilityElevation.js';
import { elevatedCapabilityScope } from '../../domain/agent/capabilityScope.js';
import { normalizeCapabilities } from '../../domain/agent/capabilities.js';
import { loadState } from '../../state/stateStore.js';
import { effectiveAgentProfile, normalizeAgentProfile, projectAgentOverrideFor } from '../../state/agentProfiles.js';
import { remainingMs } from '../../runtime/runBudget.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';

let bootId = randomUUID();
const ledgers = new Map();   // home → { grants }
const pending = new Map();   // requestId → request entry
const collapsed = new Map(); // collapse key → requestId

// ── Ledger ──────────────────────────────────────────────────────────────────

function ledgerFor(home, now = Date.now()) {
  let entry = ledgers.get(home);
  if (!entry) {
    entry = { grants: pruneGrants(readLedger(home).grants, { now, bootId }) };
    ledgers.set(home, entry);
  }
  return entry;
}

// Private: the only path that writes grants. Synchronous read-modify-write, so
// two decisions in this process can never interleave.
function writeGrants(home, mutate, now = Date.now()) {
  const entry = ledgerFor(home, now);
  const next = pruneGrants(mutate(entry.grants.map(grant => ({ ...grant }))), { now, bootId });
  writeLedger(home, next);
  entry.grants = next;
  return next;
}

const SCOPE_LABEL = { run: 'run', project: 'project', chat: 'chat' };
function presentGrant(grant) {
  return {
    ...grant, bootId: undefined,
    label: atomsLabel(grant.atoms),
    scopeLabel: grant.scope === 'run'
      ? capabilityOptionLabel(grant.kind, 'run')
      : capabilityOptionLabel('elevate-beyond-parent', 'project', SCOPE_LABEL[grant.scope]),
  };
}

/** Grants in force (not expired, run grants of this process), newest first. */
export function listGrants({ home, agentId = null, now = Date.now() } = {}) {
  return ledgerFor(home, now).grants
    .filter(grant => grant.expiresAt > now && (!agentId || grant.agentId === agentId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(presentGrant);
}

/** Grants that apply to this Agent in this run / project / chat at `now`. */
export function activeGrantsFor(agentId, { runId = null, projectId = null, chatId = null } = {}, now = Date.now(), { home } = {}) {
  return ledgerFor(home, now).grants.filter(grant => grantIsActive(grant, { agentId, runId, projectId, chatId }, now));
}

/** Revocation takes effect on the next tool call (the executor re-reads grants per call). */
export function revokeGrant(id, { home, now = Date.now() } = {}) {
  const found = ledgerFor(home, now).grants.find(grant => grant.id === id);
  if (!found) return null;
  writeGrants(home, grants => grants.filter(grant => grant.id !== id), now);
  return presentGrant(found);
}

/** Run grants end with their run (called when the turn finishes, whatever its outcome). */
export function releaseRunGrants(runId, { home, now = Date.now() } = {}) {
  if (!runId) return 0;
  let released = 0;
  try {
    if (!ledgerFor(home, now).grants.some(grant => grant.scope === 'run' && grant.runId === runId)) return 0;
    writeGrants(home, grants => grants.filter(grant => {
      const match = grant.scope === 'run' && grant.runId === runId;
      if (match) released++;
      return !match;
    }), now);
  } catch { /* best effort: the grant still expires and never survives a restart */ }
  for (const request of [...pending.values()]) if (request.home === home && request.runId === runId) settle(request, { status: 'aborted' });
  return released;
}

// ── Requests ────────────────────────────────────────────────────────────────

function clockOf(context) {
  return typeof context?.budget?.now === 'function' ? context.budget.now : Date.now;
}

function promptTimeout(context) {
  const raw = Number(context?.env?.MELO_CAPABILITY_PROMPT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, CAPABILITY_ELEVATION.promptTimeoutMs) : CAPABILITY_ELEVATION.promptTimeoutMs;
}

function settle(request, outcome) {
  if (request.settled) return;
  request.settled = true;
  clearTimeout(request.timer);
  request.cleanup?.();
  pending.delete(request.id);
  if (collapsed.get(request.key) === request.id) collapsed.delete(request.key);
  try { request.emit?.('capability_request_closed', { requestId: request.id, agentId: request.agentId, reason: outcome.status }); } catch {}
  request.resolve(outcome);
}

function agentInfo(state, agentId, projectId) {
  const known = Object.hasOwn(state.agentProfiles || {}, agentId);
  const profile = known ? effectiveAgentProfile(state, agentId, projectId) : null;
  const override = projectAgentOverrideFor(state, projectId, agentId);
  return {
    known,
    name: profile?.name || agentId,
    settingsScope: override?.capabilities ? 'project' : 'global',
    globalCapabilities: known ? normalizeAgentProfile(agentId, state.agentProfiles[agentId]).capabilities : null,
  };
}

function deniedResult(scope, tool, extra = {}, output) {
  return {
    ok: false, error: 'CAPABILITY_DENIED',
    output: output || `Agent ${scope.agentId} is not allowed to execute ${tool.id}.`,
    meta: { denied: true, executionStarted: false, ...extra },
  };
}

function auditEvent(request, status, output) {
  try {
    request.emit?.('execution_event', {
      kind: 'pipeline', id: `capability:${request.id}`, module: 'compute', name: elevationText('auditStage'),
      status, input: request.prompt, output,
    });
  } catch {}
}

// Local wall-clock time of the Mac the user is sitting at, as the audit line is read there.
const isoMinute = ms => { const d = new Date(ms), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

/**
 * Executor hook. `scope` is the grant-free (live) scope of the call.
 * Resolves to { allowed: true, scope, meta } or { allowed: false, result }.
 */
export async function requestCapabilityElevation({ scope, tool, args, context, sseEmitter, signal }) {
  const home = context?.home;
  const elevation = scope?.elevation;
  if (!home || !elevation) return { allowed: false, result: deniedResult(scope, tool) };
  const clock = clockOf(context);
  const binding = { runId: context.runId || null, projectId: context.turnBinding?.project ?? null, chatId: context.chatId || null };
  const decide = (info = {}) => decideCapability({
    toolId: tool.id, args, tool,
    member: { agentId: scope.agentId, capabilities: elevation.ceiling, scope: info.settingsScope, globalCapabilities: info.globalCapabilities },
    parent: elevation.parent ? { agentId: elevation.parentAgentId, capabilities: elevation.parent } : null,
    base: scope.capabilities,
    grants: activeGrantsFor(scope.agentId, binding, clock(), { home }),
    context: { ...binding, surface: elevation.surface, allowedToolIds: scope.allowedToolIds },
    now: clock(),
  });
  let decision;
  try { decision = decide(); }
  catch { return { allowed: false, result: deniedResult(scope, tool) }; }
  const summary = d => ({ decision: d.decision, ...(d.reason ? { reason: d.reason } : {}), ...(d.wouldPrompt ? { wouldPrompt: d.wouldPrompt } : {}), missing: d.missing, ...(d.grantIds.length ? { grantIds: d.grantIds } : {}) });
  if (decision.decision === 'allowed') return { allowed: true, scope: elevatedCapabilityScope(scope, decision.effective), meta: summary(decision) };
  if (!isPromptDecision(decision.decision)) return { allowed: false, result: deniedResult(scope, tool, { capabilityElevation: summary(decision) }) };

  // A prompt needs names and, for enable-own, which settings scope "一直开启" writes.
  const state = await loadState({ home });
  const info = agentInfo(state, scope.agentId, binding.projectId);
  const parentName = elevation.parentAgentId ? agentInfo(state, elevation.parentAgentId, binding.projectId).name : '';
  decision = decide(info);
  if (decision.decision === 'allowed') return { allowed: true, scope: elevatedCapabilityScope(scope, decision.effective), meta: summary(decision) };
  if (!isPromptDecision(decision.decision)) return { allowed: false, result: deniedResult(scope, tool, { capabilityElevation: summary(decision) }) };
  if (!info.known) return { allowed: false, result: deniedResult(scope, tool, { capabilityElevation: { ...summary(decision), decision: 'deny-ceiling', reason: 'unknown-agent' } }) };

  const outcome = await awaitDecision({ scope, tool, context, signal, sseEmitter, home, clock, binding, decision, info, parentName });
  const label = atomsLabel(decision.missing);
  const meta = { decision: decision.decision, missing: decision.missing, requestId: outcome.requestId, response: outcome.response || null, status: outcome.status };
  if (outcome.status === 'granted') {
    const after = decide(info);
    if (after.decision === 'allowed') {
      return { allowed: true, scope: elevatedCapabilityScope(scope, after.effective),
        meta: { ...meta, grantId: outcome.grant?.id || null, grantScope: outcome.grant?.scope || null, expiresAt: outcome.grant?.expiresAt || null, decidedBy: 'user', ...(outcome.receipt ? { settingsScope: outcome.receipt.scope } : {}) } };
    }
    return { allowed: false, result: deniedResult(scope, tool, { capabilityElevation: { ...meta, status: 'changed' } }) };
  }
  if (outcome.status === 'budget') {
    return { allowed: false, result: { ok: false, error: 'BUDGET_EXHAUSTED', code: 'BUDGET_EXHAUSTED', output: elevationText('timeoutOutput', { agent: info.name, capability: label, tool: tool.id }),
      meta: { executionStarted: false, denied: true, capabilityElevation: meta, budget: { reason: 'deadline' } } } };
  }
  if (outcome.status === 'aborted') {
    return { allowed: false, result: { ok: false, error: 'ABORTED', output: elevationText('abortedOutput', { agent: info.name, capability: label }),
      meta: { executionStarted: false, denied: true, aborted: true, capabilityElevation: meta } } };
  }
  const textKey = outcome.status === 'timeout' ? 'timeoutOutput' : 'deniedOutput';
  return { allowed: false, result: deniedResult(scope, tool, { capabilityElevation: meta, ...(outcome.status === 'timeout' ? { timedOut: true } : {}) },
    elevationText(textKey, { agent: info.name, capability: label, tool: tool.id })) };
}

function awaitDecision({ scope, tool, context, signal, sseEmitter, home, clock, binding, decision, info, parentName }) {
  const key = JSON.stringify([home, binding.runId, scope.agentId, decision.decision, decision.missing]);
  const existing = pending.get(collapsed.get(key));
  if (existing && !existing.settled) {
    existing.waiters++;
    return existing.promise.then(outcome => ({ ...outcome, requestId: existing.id, collapsed: true }));
  }
  const now = clock();
  const budgetLeft = context.budget ? remainingMs(context.budget) : Infinity;
  const id = randomUUID();
  const prompt = capabilityPromptText({ decision: decision.decision, agent: info.name, parent: parentName, atoms: decision.missing });
  const request = {
    id, key, home, agentId: scope.agentId, agentName: info.name, parentAgentId: scope.elevation.parentAgentId, parentName,
    decision: decision.decision, atoms: decision.missing, toolId: tool.id, options: decision.options, projectOptionScope: decision.projectOptionScope || null,
    alwaysUnavailable: decision.alwaysUnavailable === true, settingsScope: info.settingsScope,
    runId: binding.runId, projectId: binding.projectId, chatId: binding.chatId, createdAt: now, prompt,
    emit: typeof sseEmitter === 'function' ? sseEmitter : null, waiters: 1, settled: false, resolving: false, clock,
  };
  request.promise = new Promise(resolve => { request.resolve = resolve; });
  if (budgetLeft <= 0) { request.settled = true; request.resolve({ status: 'budget' }); return request.promise.then(o => ({ ...o, requestId: id })); }
  const wait = Math.max(1, Math.min(promptTimeout(context), budgetLeft));
  request.expiresAt = now + wait;
  // The run deadline still applies while waiting: when it is the nearer limit, expiry is a budget stop.
  const byBudget = budgetLeft <= promptTimeout(context);
  request.timer = setTimeout(() => settle(request, { status: byBudget ? 'budget' : 'timeout' }), wait);
  const abortSignal = signal || context.signal;
  const onAbort = () => settle(request, { status: 'aborted' });
  if (abortSignal) {
    if (abortSignal.aborted) { request.settled = true; request.resolve({ status: 'aborted' }); return request.promise.then(o => ({ ...o, requestId: id })); }
    abortSignal.addEventListener('abort', onAbort, { once: true });
    request.cleanup = () => abortSignal.removeEventListener('abort', onAbort);
  }
  pending.set(id, request);
  collapsed.set(key, id);
  const label = atomsLabel(decision.missing);
  try {
    request.emit?.('capability_request', {
      requestId: id, kind: 'capability', decision: decision.decision,
      agentId: scope.agentId, agentName: info.name, parentAgentId: request.parentAgentId, parentName,
      capabilities: decision.missing, capabilityLabel: label, toolId: tool.id,
      prompt, reason: elevationText('toolLine', { tool: tool.id }),
      options: decision.options.map(option => ({ id: option, label: capabilityOptionLabel(decision.decision, option, request.projectOptionScope || 'project') })),
      ...(request.alwaysUnavailable ? { note: elevationText('alwaysUnavailable', { capability: label }) } : {}),
      settingsScope: info.settingsScope, chatId: binding.chatId, runId: binding.runId, turnRequestId: context.requestId || null,
      projectId: binding.projectId, expiresAt: request.expiresAt,
    });
  } catch {}
  auditEvent(request, 'running', elevationText('auditWaiting', { prompt }));
  return request.promise.then(outcome => {
    const values = { agent: info.name, capability: label };
    if (outcome.status === 'granted') {
      auditEvent(request, 'completed', outcome.response === 'always'
        ? `${elevationText('auditAlways', { ...values, settingsScope: CAPABILITY_ELEVATION.texts.settingsScopes[outcome.receipt?.scope] || '' })} · ${tool.id}`
        : `${elevationText('auditGranted', { ...values, scope: capabilityOptionLabel(decision.decision, outcome.response, request.projectOptionScope || 'project'), expires: isoMinute(outcome.grant.expiresAt) })} · ${tool.id}`);
    } else {
      const key = { denied: 'auditDenied', timeout: 'auditTimeout', budget: 'auditTimeout', aborted: 'auditAborted' }[outcome.status] || 'auditDenied';
      auditEvent(request, outcome.status === 'aborted' ? 'cancelled' : 'failed', `${elevationText(key, values)} · ${tool.id}`);
    }
    return { ...outcome, requestId: id };
  });
}

/** Requests still waiting for the user (no ids are exposed to model tools or prompts). */
export function pendingCapabilityRequests({ home } = {}) {
  return [...pending.values()].filter(request => !home || request.home === home).map(request => ({
    requestId: request.id, agentId: request.agentId, decision: request.decision, capabilities: request.atoms, runId: request.runId, chatId: request.chatId, expiresAt: request.expiresAt,
  }));
}

/**
 * Create the grant a live request asks for. Only reachable from a pending
 * request object in this module's registry.
 */
export function createGrant({ requestId, scope }, { home, now } = {}) {
  const request = pending.get(requestId);
  if (!request || request.settled || request.home !== home) throw Object.assign(new Error('No such pending capability request.'), { statusCode: 404, code: 'CAPABILITY_REQUEST_NOT_FOUND' });
  if (!['run', 'project'].includes(scope) || (scope === 'project' && request.decision !== 'elevate-beyond-parent')) {
    throw Object.assign(new Error('This grant scope is not offered for this request.'), { statusCode: 400, code: 'INVALID_CAPABILITY_DECISION' });
  }
  now ??= request.clock();
  const grantScope = scope === 'project' ? request.projectOptionScope || (request.projectId ? 'project' : 'chat') : 'run';
  const kind = request.decision;
  const grant = {
    id: `cg_${randomUUID()}`, agentId: request.agentId, atoms: request.atoms, kind, scope: grantScope,
    runId: request.runId, projectId: grantScope === 'chat' ? null : request.projectId, chatId: request.chatId,
    parentAgentId: request.parentAgentId, toolId: request.toolId, requestId: request.id, decidedBy: 'user',
    createdAt: now, expiresAt: grantExpiry(grantScope, now), bootId,
  };
  writeGrants(home, grants => [...grants, grant], now);
  return presentGrant(grant);
}

async function enableAlways(request) {
  const { updateAgentProfile } = await import('./agentMutations.js');
  const state = await loadState({ home: request.home });
  if (!Object.hasOwn(state.agentProfiles || {}, request.agentId)) throw Object.assign(new Error('Agent no longer exists.'), { statusCode: 409, code: 'AGENT_NOT_FOUND' });
  const info = agentInfo(state, request.agentId, request.projectId);
  const ceiling = effectiveAgentProfile(state, request.agentId, request.projectId).capabilities;
  if (!ceiling) throw Object.assign(new Error('Complete this Agent\'s capability migration first.'), { statusCode: 409, code: 'AGENT_MIGRATION_REQUIRED' });
  const own = request.atoms.filter(atom => !hasAtom(ceiling, atom));
  const projectScope = info.settingsScope === 'project';
  if (projectScope && own.some(atom => !hasAtom(info.globalCapabilities, atom))) {
    throw Object.assign(new Error(elevationText('alwaysUnavailable', { capability: atomsLabel(own) })), { statusCode: 409, code: 'ALWAYS_UNAVAILABLE' });
  }
  const current = projectScope
    ? normalizeCapabilities(projectAgentOverrideFor(state, request.projectId, request.agentId).capabilities)
    : info.globalCapabilities;
  const capabilities = unionCapabilities(current, capabilitiesFromAtoms(own));
  // The normal Agent mutation (P1 receipt). Desktop click = desktop confirmation;
  // the change syncs to the phone as a desktop edit.
  return runWithRequestContext(createRequestContext({ home: request.home }), () => updateAgentProfile(request.agentId, { capabilities },
    { scope: projectScope ? 'project' : 'global', projectId: projectScope ? request.projectId : null, preserveSelection: true }));
}

/**
 * The user's decision on a live request. `decision`: run | project | always | deny.
 * @returns {Promise<{ok:true, decision, grant?, receipt?}>}
 */
export async function respondCapabilityRequest(requestId, decision, { home, now } = {}) {
  const request = typeof requestId === 'string' ? pending.get(requestId) : null;
  if (!request || request.settled || request.home !== home) throw Object.assign(new Error('Unknown or expired capability request.'), { statusCode: 404, code: 'CAPABILITY_REQUEST_NOT_FOUND' });
  if (!CAPABILITY_ELEVATION.responses.includes(decision) || !request.options.includes(decision)) {
    throw Object.assign(new Error('This decision is not offered for this request.'), { statusCode: 400, code: 'INVALID_CAPABILITY_DECISION' });
  }
  if (request.resolving) throw Object.assign(new Error('A decision is already being applied.'), { statusCode: 409, code: 'CAPABILITY_DECISION_IN_PROGRESS' });
  request.resolving = true;
  try {
    if (decision === 'deny') {
      settle(request, { status: 'denied', response: 'deny' });
      return { ok: true, decision };
    }
    let receipt = null;
    if (decision === 'always') {
      const committed = await enableAlways(request);
      receipt = { agentId: committed.agentId, scope: committed.scope, projectId: committed.projectId, revision: committed.revision, ...(committed.agentExportWarning ? { agentExportWarning: committed.agentExportWarning } : {}) };
    }
    if (request.settled) throw Object.assign(new Error('The request ended while the decision was applied.'), { statusCode: 409, code: 'CAPABILITY_REQUEST_ENDED' });
    // "一直开启" also grants this run: the turn's settings snapshot predates the change.
    const grant = createGrant({ requestId, scope: decision === 'project' ? 'project' : 'run' }, { home, now });
    settle(request, { status: 'granted', response: decision, grant, receipt });
    return { ok: true, decision, grant, ...(receipt ? { receipt } : {}) };
  } finally {
    request.resolving = false;
  }
}

/** Tests: forget caches and pending requests, as a process restart would. */
export function resetCapabilityElevationForTests({ restart = true } = {}) {
  for (const request of [...pending.values()]) settle(request, { status: 'aborted' });
  ledgers.clear();
  collapsed.clear();
  if (restart) bootId = randomUUID();
}
