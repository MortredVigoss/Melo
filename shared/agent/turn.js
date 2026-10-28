import { resolveReplyLocale } from './locale.js';
import { runtimeMessage } from './runtimeMessages.js';
import { COMMON_TOOLS, validateCommonTool } from './tools.js';
import { AGENT_LOOP_CONTRACT } from './loopContract.js';
import { createRepeatGuard, toolCallFingerprint } from './repeatGuard.js';
import { toolEffect } from './toolEffects.js';

// Portable turn state. All time and identity come from the owning Host.
export const CORE_VERSION = 1;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function identity(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

export function startTurn({ runId, turnId, allowedTools = [], requiredTools = [], toolDependencies = {}, now, limits = {}, hostToolSchemas = false }) {
  if (!identity(runId) || !identity(turnId) || !Number.isFinite(now)) fail('INVALID_TURN', 'Invalid turn identity or clock.');
  const bounded = (key, fallback, max) => Number.isInteger(limits[key]) && limits[key] > 0 && limits[key] <= max ? limits[key] : fallback;
  return {
    version: CORE_VERSION, runId, turnId, status: 'running', startedAt: now, lastNow: now, successfulEffects: [], repairing: false,
    deadline: now + bounded('timeoutMs', AGENT_LOOP_CONTRACT.budget.deadlineMs, Number.MAX_SAFE_INTEGER - now),
    limits: { rounds: Number.isFinite(limits.rounds) ? Math.max(0, Math.min(AGENT_LOOP_CONTRACT.guardLimits.maxRounds, Math.floor(limits.rounds))) : AGENT_LOOP_CONTRACT.loop.maxIterations, callsPerRound: bounded('callsPerRound', AGENT_LOOP_CONTRACT.loop.maxCallsPerResponse, AGENT_LOOP_CONTRACT.loop.maxCallsPerResponse), errors: bounded('errors', AGENT_LOOP_CONTRACT.guardLimits.consecutiveErrors, AGENT_LOOP_CONTRACT.guardLimits.maxConsecutiveErrors), stagnant: bounded('stagnant', AGENT_LOOP_CONTRACT.guardLimits.stagnantRounds, AGENT_LOOP_CONTRACT.guardLimits.maxStagnantRounds) },
    allowedTools: [...new Set(allowedTools.filter(identity))], requiredTools: [...new Set(requiredTools.filter(identity))], toolDependencies: Object.fromEntries(Object.entries(toolDependencies).filter(([name, needs]) => identity(name) && Array.isArray(needs)).map(([name, needs]) => [name, needs.filter(identity).slice(0, AGENT_LOOP_CONTRACT.guardLimits.dependencyTools)])), successfulTools: [], pendingTools: {}, rounds: 0, awaitingModel: false,
    hostToolSchemas: hostToolSchemas === true, failures: [], pendingFingerprints: {}, rejectionResults: {},
    callIds: [], pending: [], permitted: [], phoneTasks: [], rejections: {}, errors: 0, roundSucceeded: false, stagnant: 0, progressKeys: [], reason: null,
  };
}

// phone_use and phone_workflow are two executors for the same granted phone
// capability. This aliases evidence/prerequisites, never grants or goal success.
function toolSucceeded(state, name) {
  return state.successfulTools.includes(name) || name === 'phone_use' && state.allowedTools.includes('phone_workflow') && state.successfulTools.includes('phone_workflow');
}
function prerequisites(state, name) {
  return [...new Set([...(state.toolDependencies?.[name] || []), ...(name === 'phone_workflow' ? state.toolDependencies?.phone_use || [] : [])])];
}

export function advanceTurn(previous, event, now) {
  if (previous?.version !== CORE_VERSION || !identity(previous?.runId)) fail('INVALID_TURN', 'Unknown turn version.');
  if (!Number.isFinite(now) || now < previous.lastNow) fail('INVALID_CLOCK', 'The Host clock must be monotonic.');
  if (event?.runId !== previous.runId || event?.turnId !== previous.turnId) fail('TURN_MISMATCH', 'The event belongs to another turn.');
  if (previous.status !== 'running') fail('TURN_CLOSED', 'The turn has ended; late events cannot issue effects.');
  const state = { ...previous, lastNow: now, callIds: [...previous.callIds], pending: [...previous.pending], progressKeys: [...previous.progressKeys], phoneTasks: [...(previous.phoneTasks || [])], successfulTools: [...(previous.successfulTools || [])], pendingTools: { ...previous.pendingTools }, pendingFingerprints: { ...previous.pendingFingerprints }, pendingEffects: { ...previous.pendingEffects } };
  const stop = reason => ({ ...state, status: 'blocked', reason, awaitingModel: false, pending: [], permitted: [] });
  if (event.type === 'cancel') return { ...state, status: 'cancelled', reason: 'CANCELLED', pending: [], permitted: [], awaitingModel: false };
  if (now >= state.deadline) return stop('DEADLINE_EXCEEDED');
  switch (event.type) {
    case 'request':
      if (state.pending.length || state.awaitingModel) fail('PENDING_EFFECT', 'Pair every effect with a result before the next model request.');
      if (state.rounds >= state.limits.rounds) return stop('ROUND_LIMIT');
      state.rounds++;
      state.awaitingModel = true;
      return state;
    case 'calls': {
      if (!state.awaitingModel || state.pending.length) fail('UNEXPECTED_CALLS', 'No model request is awaiting calls.');
      const calls = event.calls;
      if (!Array.isArray(calls) || !calls.length || calls.length > state.limits.callsPerRound) fail('INVALID_BATCH', 'Invalid tool batch size.');
      const seen = new Set(state.callIds);
      for (const call of calls) {
        if (!identity(call?.id) || seen.has(call.id)) fail('DUPLICATE_CALL_ID', 'Invalid or reused tool call ID.');
        seen.add(call.id);
      }
      state.callIds = [...seen];
      state.pending = calls.map(call => call.id);
      state.pendingTools = Object.fromEntries(calls.map(call => [call.id, call.name]));
      state.roundSucceeded = false;
      // Unknown tools still receive paired error receipts; they never get an
      // effect permit. One hallucinated name must not drop a valid sibling.
      state.rejections = {};
      state.rejectionResults = {};
      const guard = createRepeatGuard({ entries: state.failures, fingerprint: (_name, key) => key });
      state.permitted = calls.filter(call => {
        if (!state.allowedTools.includes(call.name)) { state.rejections[call.id] = 'UNKNOWN_TOOL'; return false; }
        if (prerequisites(state, call.name).some(name => !toolSucceeded(state, name))) { state.rejections[call.id] = 'PREREQUISITE_MISSING'; return false; }
        if (!state.hostToolSchemas && COMMON_TOOLS.some(tool => tool.name === call.name)) {
          try { validateCommonTool(call.name, call.arguments); }
          catch { state.rejections[call.id] = 'INVALID_TOOL_ARGUMENTS'; return false; }
        }
        const fingerprint = typeof call.fingerprint === 'string' && call.fingerprint ? call.fingerprint : toolCallFingerprint(call.name, call.arguments);
        if (state.repairing && (state.successfulEffects || []).includes(fingerprint)) { state.rejections[call.id] = 'ALREADY_EXECUTED'; return false; }
        state.pendingFingerprints[call.id] = fingerprint;
        state.pendingEffects = { ...state.pendingEffects, [call.id]: /^mcp[:_]/u.test(call.name) || !['read', 'compute'].includes(call.effect || toolEffect(call.name, call.arguments)) };
        const repeated = guard.check(call.name, fingerprint);
        if (repeated) { state.rejections[call.id] = repeated.error; state.rejectionResults[call.id] = repeated; return false; }
        if (call.name === 'phone_use') {
          if (typeof call.arguments?.goal !== 'string' || typeof call.arguments?.purpose !== 'string') { state.rejections[call.id] = 'INVALID_TOOL_ARGUMENTS'; return false; }
          const task = call.arguments.purpose + ':' + call.arguments.goal.trim().toLowerCase();
          if (state.phoneTasks.includes(task)) { state.rejections[call.id] = 'REPEATED_TASK'; return false; }
          if (state.phoneTasks.length >= 3) { state.rejections[call.id] = 'PHONE_TASK_LIMIT'; return false; }
          state.phoneTasks.push(task);
        }
        return true;
      }).map(call => call.id);
      state.awaitingModel = false;
      return state;
    }
    case 'reroute':
      if (state.pending.length || state.awaitingModel) fail('PENDING_EFFECT', 'Finish the current response and pair its tools before rerouting.');
      state.repairing = true;
      return state;
    case 'feedback':
      if (!state.awaitingModel || state.pending.length) fail('PENDING_EFFECT', 'Only an unverified model answer can receive feedback.');
      state.awaitingModel = false;
      if (event.repair === true) state.repairing = true;
      return state;
    case 'result': {
      if (!state.pending.includes(event.callId)) fail('UNKNOWN_RESULT', 'The result has no pending call in this turn.');
      if (typeof event.ok !== 'boolean') fail('INVALID_RESULT', 'A tool result must report success explicitly.');
      state.pending = state.pending.filter(id => id !== event.callId);
      const toolName = state.pendingTools[event.callId];
      const permitted = state.permitted.includes(event.callId);
      if (permitted) {
        if (event.ok && state.pendingEffects?.[event.callId]) state.successfulEffects = [...new Set([...(state.successfulEffects || []), state.pendingFingerprints[event.callId]])];
        const guard = createRepeatGuard({ entries: state.failures, fingerprint: (_name, key) => key });
        guard.record(toolName, state.pendingFingerprints[event.callId], { ok: event.ok, code: event.code, error: event.error, output: event.output });
        state.failures = guard.entries;
      }
      delete state.pendingFingerprints[event.callId];
      delete state.pendingEffects[event.callId];
      if (event.ok && state.permitted.includes(event.callId) && toolName && !state.successfulTools.includes(toolName)) state.successfulTools.push(toolName);
      delete state.pendingTools[event.callId];
      state.roundSucceeded = state.roundSucceeded || (event.ok && permitted);
      if (!state.pending.length) state.errors = state.roundSucceeded ? 0 : state.errors + 1;
      if (event.ok && permitted && typeof event.progressKey === 'string' && event.progressKey.length <= 256 && event.progressKey) {
        state.stagnant = state.progressKeys.includes(event.progressKey) ? state.stagnant + 1 : 0;
        if (!state.progressKeys.includes(event.progressKey)) state.progressKeys.push(event.progressKey);
      }
      // Let the Host drain the whole issued batch before closing the turn.
      if (!state.pending.length && state.errors >= state.limits.errors) return stop('REPEATED_TOOL_FAILURE');
      if (!state.pending.length && state.stagnant >= state.limits.stagnant) return stop('NO_PROGRESS');
      return state;
    }
    case 'device-observation': {
      if (state.pending.length || state.awaitingModel) fail('PENDING_EFFECT', 'A device observation must follow its paired result.');
      if (typeof event.ok !== 'boolean' || !identity(event.progressKey) || !identity(event.action)) fail('INVALID_RESULT', 'Invalid device observation.');
      const prior = state.deviceProgress || { seen: [], unchanged: 0, unresolvedErrors: 0 };
      const resolves = ['tap', 'type_text', 'submit_input', 'swipe', 'back', 'home', 'open_app'].includes(event.action);
      const unresolvedErrors = !event.ok ? prior.unresolvedErrors + 1 : resolves ? 0 : prior.unresolvedErrors;
      const repeated = prior.seen.includes(event.progressKey);
      state.deviceProgress = { seen: repeated ? prior.seen : [...prior.seen, event.progressKey], unchanged: repeated ? prior.unchanged + 1 : 0, unresolvedErrors };
      if (unresolvedErrors >= state.limits.errors) return stop('REPEATED_DEVICE_FAILURE');
      if (state.deviceProgress.unchanged >= state.limits.stagnant) return stop('NO_PROGRESS');
      return state;
    }
    case 'complete':
      if (!state.awaitingModel || state.pending.length) fail('PENDING_EFFECT', 'A final answer cannot drop pending tools.');
      if ((state.requiredTools || []).some(name => !toolSucceeded(state, name))) return stop('MISSING_TOOL_EVIDENCE');
      return { ...state, status: 'completed', awaitingModel: false };
    default: fail('UNKNOWN_EVENT', 'Unknown turn event.');
  }
}

export function turnStopReply(reason, text = '', locale) {
  const language = locale || resolveReplyLocale({ text });
  if (reason === 'ROUND_LIMIT' && ['zh','en'].includes(language)) return AGENT_LOOP_CONTRACT.loop.toolLimitReply[language];
  return runtimeMessage('stop', language, { reason: reason || 'LOOP_STOPPED' });
}
