import { createHash, randomUUID } from 'node:crypto';
import { toolCallFingerprint } from '../agents/repeatGuard.js';
import { turnStopReply } from '../../shared/agent/turn.js';
import { startTurn, advanceTurn } from '../../shared/agent/turn.js';
import { completionObservation, completionResult } from '../../shared/agent/completion.js';
import { startGoal, amendGoal, goalText, goalSnapshot, goalCandidate, goalReviewRequest, reviewGoal, stopGoal } from '../../shared/agent/goal.js';
import { toolEffect } from '../../shared/agent/toolEffects.js';

/** Node Host for the same reducer packaged for Android / iOS. */
export function createCoreTurn({ runId = randomUUID(), turnId = randomUUID(), allowedTools, requiredTools, toolDependencies, limits, goal, tools = [], hostToolSchemas = true, clock = () => performance.timeOrigin + performance.now() }) {
  let state = startTurn({ runId, turnId, allowedTools, requiredTools, toolDependencies, limits, hostToolSchemas, now: clock() });
  const observations = [];
  let task = typeof goal === 'string' ? startGoal(goal, runId) : null;
  let candidateReply = '';
  const declaration = name => tools.find(tool => tool.id === name || tool.functionName === name) || {};
  return {
    receipt(goal, reply, terminalReason = state.reason, plan) { return completionResult({ goal: task ? goalText(task) : goal, reply, terminalReason, plan, observations, task: goalSnapshot(task) }); },
    get checking() { return task?.phase === 'checking'; },
    get repairing() { return state.repairing; },
    get candidateReply() { return candidateReply; },
    get task() { return goalSnapshot(task); },
    amend(text) { if (task) task = amendGoal(task, text); },
    candidate(reply, { research = false, nativeSearch = false } = {}) {
      candidateReply = reply;
      if (!task) return false;
      task = goalCandidate(task, { reply, observations, research, tools: [...allowedTools, ...(nativeSearch ? ['native_web_search'] : [])], roundsLeft: state.limits.rounds - state.rounds });
      return task.phase === 'checking';
    },
    reviewRequest() { return goalReviewRequest(task, observations); },
    review(text) { task = reviewGoal(task, text, observations); return task; },
    stopReview(reason) { if (task) task = stopGoal(task, reason); },
    observeNative(event) {
      if (event?.name !== 'native_web_search' || event.status !== 'completed') return;
      const id = String(event.id || 'native-search');
      if (!observations.some(row => row.id === id)) observations.push(...completionObservation({ id, name: 'web_search', ok: true, executed: true, output: event.output, sources: event.sources || [] }));
      if (observations.length > 128) observations.splice(0, observations.length - 128);
    },
    get status() { return state.status; },
    get reason() { return state.reason; },
    reply(text = '') { return turnStopReply(state.reason, text); },
    rejectionResult(callId) { return state.rejectionResults?.[callId] || { ok: false, error: state.rejections?.[callId] || 'TOOL_NOT_PERMITTED', output: `Tool request rejected by the shared loop policy: ${state.rejections?.[callId] || 'TOOL_NOT_PERMITTED'}` }; },
    results(pairs) {
      for (const { call, result } of pairs) {
        observations.push(...completionObservation({ id: call.id, name: call.name, ok: result?.ok, executed: result?.ok === true && result?.meta?.executionStarted !== false,
          output: result?.output, arguments: call.arguments, declaration: declaration(call.name), data: { url: result?.meta?.url, text: call.name === 'fetch_url' ? String(result?.output || '').replace(/\n\n\[source:[\s\S]*$/u, '') : '' }, sources: result?.completionSources || result?.meta?.contentItems || [] }));
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
      if (type === 'calls') fields = { ...fields, calls: fields.calls.map(call => ({ ...call, effect: toolEffect(call.name, call.arguments, declaration(call.name)), fingerprint: toolCallFingerprint(call.name, call.arguments) })) };
      state = advanceTurn(state, { ...fields, type, runId, turnId }, clock());
      return state.status;
    },
  };
}
