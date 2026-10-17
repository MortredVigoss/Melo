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

export function startTurn({ runId, turnId, allowedTools = [], now, limits = {} }) {
  if (!identity(runId) || !identity(turnId) || !Number.isFinite(now)) fail('INVALID_TURN', 'Invalid turn identity or clock.');
  const bounded = (key, fallback, max) => Number.isInteger(limits[key]) && limits[key] > 0 && limits[key] <= max ? limits[key] : fallback;
  return {
    version: CORE_VERSION, runId, turnId, status: 'running', startedAt: now, lastNow: now,
    deadline: now + bounded('timeoutMs', 600_000, 3_600_000),
    limits: { rounds: bounded('rounds', 10, 64), callsPerRound: bounded('callsPerRound', 8, 32), errors: bounded('errors', 3, 10), stagnant: bounded('stagnant', 5, 20) },
    allowedTools: [...new Set(allowedTools.filter(identity))], rounds: 0, awaitingModel: false,
    callIds: [], pending: [], permitted: [], errors: 0, roundSucceeded: false, stagnant: 0, progressKeys: [], reason: null,
  };
}

export function advanceTurn(previous, event, now) {
  if (previous?.version !== CORE_VERSION || !identity(previous?.runId)) fail('INVALID_TURN', 'Unknown turn version.');
  if (!Number.isFinite(now) || now < previous.lastNow) fail('INVALID_CLOCK', 'The Host clock must be monotonic.');
  if (event?.runId !== previous.runId || event?.turnId !== previous.turnId) fail('TURN_MISMATCH', 'The event belongs to another turn.');
  if (previous.status !== 'running') fail('TURN_CLOSED', 'The turn has ended; late events cannot issue effects.');
  const state = { ...previous, lastNow: now, callIds: [...previous.callIds], pending: [...previous.pending], progressKeys: [...previous.progressKeys] };
  const stop = reason => ({ ...state, status: 'blocked', reason, awaitingModel: false, pending: [] });
  if (event.type === 'cancel') return { ...state, status: 'cancelled', reason: 'CANCELLED', pending: [], awaitingModel: false };
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
      state.roundSucceeded = false;
      // Unknown tools still receive paired error receipts; they never get an
      // effect permit. One hallucinated name must not drop a valid sibling.
      state.permitted = calls.filter(call => state.allowedTools.includes(call.name)).map(call => call.id);
      state.awaitingModel = false;
      return state;
    }
    case 'feedback':
      if (!state.awaitingModel || state.pending.length) fail('PENDING_EFFECT', 'Only an unverified model answer can receive feedback.');
      state.awaitingModel = false;
      return state;
    case 'result': {
      if (!state.pending.includes(event.callId)) fail('UNKNOWN_RESULT', 'The result has no pending call in this turn.');
      if (typeof event.ok !== 'boolean') fail('INVALID_RESULT', 'A tool result must report success explicitly.');
      state.pending = state.pending.filter(id => id !== event.callId);
      state.roundSucceeded = state.roundSucceeded || event.ok;
      if (!state.pending.length) state.errors = state.roundSucceeded ? 0 : state.errors + 1;
      if (typeof event.progressKey === 'string' && event.progressKey.length <= 256 && event.progressKey) {
        state.stagnant = state.progressKeys.includes(event.progressKey) ? state.stagnant + 1 : 0;
        if (!state.progressKeys.includes(event.progressKey)) state.progressKeys.push(event.progressKey);
      }
      // Let the Host drain the whole issued batch before closing the turn.
      if (!state.pending.length && state.errors >= state.limits.errors) return stop('REPEATED_TOOL_FAILURE');
      if (!state.pending.length && state.stagnant >= state.limits.stagnant) return stop('NO_PROGRESS');
      return state;
    }
    case 'complete':
      if (!state.awaitingModel || state.pending.length) fail('PENDING_EFFECT', 'A final answer cannot drop pending tools.');
      return { ...state, status: 'completed', awaitingModel: false };
    default: fail('UNKNOWN_EVENT', 'Unknown turn event.');
  }
}
