import { createHash, randomUUID } from 'node:crypto';
import { toolCallFingerprint } from '../agents/repeatGuard.js';
import { turnStopReply } from '../../shared/agent/turn.js';
import { startTurn, advanceTurn } from '../../shared/agent/turn.js';

/** Node Host for the same reducer packaged for Android / iOS. */
export function createCoreTurn({ runId = randomUUID(), turnId = randomUUID(), allowedTools, requiredTools, toolDependencies, limits, hostToolSchemas = true, clock = () => performance.timeOrigin + performance.now() }) {
  let state = startTurn({ runId, turnId, allowedTools, requiredTools, toolDependencies, limits, hostToolSchemas, now: clock() });
  return {
    get status() { return state.status; },
    get reason() { return state.reason; },
    reply(text = '') { return turnStopReply(state.reason, text); },
    rejectionResult(callId) { return state.rejectionResults?.[callId] || { ok: false, error: state.rejections?.[callId] || 'TOOL_NOT_PERMITTED', output: `Tool request rejected by the shared loop policy: ${state.rejections?.[callId] || 'TOOL_NOT_PERMITTED'}` }; },
    results(pairs) {
      for (const { call, result } of pairs) {
        if (state.status !== 'running') break;
        const progressKey = createHash('sha256').update(JSON.stringify([call.name, toolCallFingerprint(call.name, call.arguments), result?.status, result?.output])).digest('hex');
        state = advanceTurn(state, { type: 'result', runId, turnId, callId: call.id, ok: result?.ok === true, code: result?.code, error: result?.error, output: String(result?.output || '').slice(0, 500), progressKey }, clock());
      }
      return state.status;
    },
    rejection(callId) { return state.rejections?.[callId] || 'TOOL_NOT_PERMITTED'; },
    permits(callId) { return state.status === 'running' && state.pending.includes(callId) && state.permitted.includes(callId); },
    update(type, fields = {}) {
      if (type === 'calls') fields = { ...fields, calls: fields.calls.map(call => ({ ...call, fingerprint: toolCallFingerprint(call.name, call.arguments) })) };
      state = advanceTurn(state, { ...fields, type, runId, turnId }, clock());
      return state.status;
    },
  };
}
