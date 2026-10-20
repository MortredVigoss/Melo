import { createHash, randomUUID } from 'node:crypto';
import { toolCallFingerprint } from '../agents/repeatGuard.js';
import { turnStopReply } from '../../shared/agent/turn.js';
import { startTurn, advanceTurn } from '../../shared/agent/turn.js';
import { completionObservation, completionResult } from '../../shared/agent/completion.js';

/** Node Host for the same reducer packaged for Android / iOS. */
export function createCoreTurn({ runId = randomUUID(), turnId = randomUUID(), allowedTools, requiredTools, toolDependencies, limits, hostToolSchemas = true, clock = () => performance.timeOrigin + performance.now() }) {
  let state = startTurn({ runId, turnId, allowedTools, requiredTools, toolDependencies, limits, hostToolSchemas, now: clock() });
  const observations = [];
  return {
    receipt(goal, reply, terminalReason = state.reason, plan) { return completionResult({ goal, reply, terminalReason, plan, observations }); },
    observeNative(event) {
      if (event?.name !== 'native_web_search' || event.status !== 'completed') return;
      const id = String(event.id || 'native-search');
      if (!observations.some(row => row.id === id)) observations.push(...completionObservation({ id, name: 'web_search', ok: true, executed: true, sources: event.sources || [] }));
      if (observations.length > 128) observations.splice(0, observations.length - 128);
    },
    get status() { return state.status; },
    get reason() { return state.reason; },
    reply(text = '') { return turnStopReply(state.reason, text); },
    rejectionResult(callId) { return state.rejectionResults?.[callId] || { ok: false, error: state.rejections?.[callId] || 'TOOL_NOT_PERMITTED', output: `Tool request rejected by the shared loop policy: ${state.rejections?.[callId] || 'TOOL_NOT_PERMITTED'}` }; },
    results(pairs) {
      for (const { call, result } of pairs) {
        observations.push(...completionObservation({ id: call.id, name: call.name, ok: result?.ok, executed: result?.ok === true && result?.meta?.executionStarted !== false,
          output: result?.output, data: { url: result?.meta?.url, text: call.name === 'fetch_url' ? String(result?.output || '').replace(/\n\n\[source:[\s\S]*$/u, '') : '' }, sources: result?.completionSources || result?.meta?.contentItems || [] }));
        if (observations.length > 128) observations.splice(0, observations.length - 128);
        if (state.status !== 'running') continue;
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
