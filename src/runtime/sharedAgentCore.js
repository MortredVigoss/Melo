import { startTurn, advanceTurn } from '../../shared/agent/turn.js';

/** Node Host for the same reducer packaged for Android / iOS. */
export function createCoreTurn({ runId, turnId, allowedTools, requiredTools, toolDependencies, limits, clock = () => performance.timeOrigin + performance.now() }) {
  let state = startTurn({ runId, turnId, allowedTools, requiredTools, toolDependencies, limits, now: clock() });
  return {
    get status() { return state.status; },
    get reason() { return state.reason; },
    rejection(callId) { return state.rejections?.[callId] || 'TOOL_NOT_PERMITTED'; },
    permits(callId) { return state.status === 'running' && state.pending.includes(callId) && state.permitted.includes(callId); },
    update(type, fields = {}) {
      state = advanceTurn(state, { ...fields, type, runId, turnId }, clock());
      return state.status;
    },
  };
}
