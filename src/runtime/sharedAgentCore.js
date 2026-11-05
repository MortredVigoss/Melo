import { createHash, randomUUID } from 'node:crypto';
import { toolCallFingerprint } from '../agents/repeatGuard.js';
import { turnStopReply } from '../../shared/agent/turn.js';
import { tracedStart, tracedAdvance } from '../../shared/agent/trace.js';
import { traceEvent, currentLoopTrace } from './loopTrace.js';
import { completionObservation, completionResult } from '../../shared/agent/completion.js';
import { startGoal, amendGoal, goalText, goalSnapshot, goalCandidate, goalReviewRequest, reviewGoal, stopGoal, goalOperation } from '../../shared/agent/goal.js';
import { toolEffect } from '../../shared/agent/toolEffects.js';

/** Node Host for the same reducer packaged for Android / iOS. */
export function createCoreTurn({ runId = currentLoopTrace()?.context.runId || randomUUID(), turnId = randomUUID(), allowedTools, requiredTools, toolDependencies, limits, budget, goal, tools = [], hostToolSchemas = true, clock = () => performance.timeOrigin + performance.now() }) {
  const initial = tracedStart({ runId, turnId, allowedTools, requiredTools, toolDependencies, limits: { ...limits, finalReport: typeof goal === 'string' }, hostToolSchemas, now: clock() });
  let state = initial.state;
  const observe = events => { for (const event of events) traceEvent(event.type, event.data, event.payload, { round: event.round, ...(event.spanId ? { spanId: runId + ':' + event.spanId, parentSpanId: runId } : {}) }); };
  observe(initial.events);
  const advance = event => {
    if (state.status === 'running' && Number.isFinite(budget?.deadlineAt) && budget.deadlineAt > state.deadline && budget.deadlineAt > clock()) {
      const extension = tracedAdvance(state, { type: 'extend-deadline', runId, turnId, deadline: Math.ceil(budget.deadlineAt) }, clock());
      state = extension.state; observe(extension.events);
    }
    const next = tracedAdvance(state, event, clock()); state = next.state; observe(next.events); };
  const observations = [];
  let task = typeof goal === 'string' ? startGoal(goal, runId) : null;
  let candidateReply = '';
  const declaration = name => tools.find(tool => tool.id === name || tool.functionName === name) || {};
  return {
    progress(args, evaluationMode) {
      task = goalOperation({ action: 'progress', state: task, progress: args, observations, evaluationMode,
        resourceUse: { elapsedMs: budget ? budget.now() - budget.startedAt : 0, toolCalls: budget?.used?.toolCalls || 0, inputTokens: budget?.used?.inputTokens || 0 } });
      return goalOperation({ action: 'progressResult', state: task });
    },
    get goalState() { return task; },
    get observations() { return observations; },
    acceptDelivery(value) { task = value; },
    receipt(goal, reply, terminalReason = state.reason, plan, citations = []) { return completionResult({ goal: task ? goalText(task) : goal, reply, terminalReason, plan, citations, observations, task: goalSnapshot(task) }); },
    get reporting() { return task?.phase !== 'checking' && (state.awaitingModel ? state.requestMode === 'report' : state.rounds >= state.limits.rounds && !state.reportIssued); },
    get checking() { return task?.phase === 'checking'; },
    get repairing() { return state.repairing; },
    get candidateReply() { return candidateReply; },
    get task() { return goalSnapshot(task); },
    amend(text) { if (task) task = amendGoal(task, text); traceEvent('goal.updated', {}, goalSnapshot(task)); },
    candidate(reply, { research = false, nativeSearch = false, context = {}, offeredTools = [] } = {}) {
      candidateReply = reply;
      if (!task) return false;
      task = goalCandidate(task, { reply, observations, research, context: { capabilities: tools, ...context }, tools: [...allowedTools, ...offeredTools, ...(nativeSearch ? ['native_web_search'] : [])], roundsLeft: state.limits.rounds - state.rounds });
      return task.phase === 'checking';
    },
    reviewRequest() { return goalReviewRequest(task, observations); },
    review(text) { task = reviewGoal(task, text, observations); traceEvent('goal.check', {}, goalSnapshot(task)); return task; },
    stopReview(reason) { if (task) task = stopGoal(task, reason); },
    observeNative(event) {
      if (event?.name !== 'native_web_search' || event.status !== 'completed') return false;
      const counted = state.awaitingModel && state.status === 'running' && !state.nativeRound;
      if (counted) advance({ type: 'hosted-call', runId, turnId });
      const id = String(event.id || 'native-search');
      if (!observations.some(row => row.id === id)) observations.push(...completionObservation({ id, name: 'web_search', ok: true, executed: true, output: event.output, sources: event.sources || [] }));
      return counted;

    },
    get status() { return state.status; },
    get effects() { return { successful: [...(state.successfulEffects || [])], uncertain: [...(state.uncertainEffects || [])] }; },
    get routingProgress() { return { rounds: state.rounds, failures: state.errors, stopped: state.status !== 'running', pendingEffects: state.pending.length > 0 || state.awaitingModel }; },
    get reason() { return state.reason; },
    reply(text = '', locale) { return turnStopReply(state.reason, text, locale); },
    rejectionResult(callId) { return state.rejectionResults?.[callId] || { ok: false, error: state.rejections?.[callId] || 'TOOL_NOT_PERMITTED', output: `Tool request rejected by the shared loop policy: ${state.rejections?.[callId] || 'TOOL_NOT_PERMITTED'}` }; },
    results(pairs) {
      for (const { call, result } of pairs) {
        observations.push(...completionObservation({ id: call.id, name: call.name, ok: result?.ok, executed: result?.ok === true && result?.meta?.executionStarted !== false,
          output: result?.output, arguments: call.arguments, declaration: declaration(call.name), data: { url: result?.meta?.canonicalUrl || result?.meta?.url, reading:result?.meta?.reading,truncated:result?.meta?.truncated, text: call.name === 'fetch_url' ? String(result?.output || '').replace(/\n\n\[source:[\s\S]*$/u, '') : '' }, sources: result?.completionSources || result?.meta?.contentItems || [] }));

        if (state.status !== 'running') continue;
        const progressKey = createHash('sha256').update(JSON.stringify([call.name, toolCallFingerprint(call.name, call.arguments), result?.status, result?.output])).digest('hex');
        advance({ type: 'result', runId, turnId, callId: call.id, ok: result?.ok === true, code: result?.code, error: result?.error, output: String(result?.output || '').slice(0, 500), progressKey });
      }
      return state.status;
    },
    rejection(callId) { return state.rejections?.[callId] || 'TOOL_NOT_PERMITTED'; },
    permits(callId) { return state.status === 'running' && state.pending.includes(callId) && state.permitted.includes(callId); },
    update(type, fields = {}) {
      if (type === 'request') fields = { kind: task?.phase === 'checking' ? 'check' : 'tools', ...fields };
      if (type === 'calls') fields = { ...fields, calls: fields.calls.map(call => ({ ...call, effect: toolEffect(call.name, call.arguments, declaration(call.name)), fingerprint: toolCallFingerprint(call.name, call.arguments) })) };
      advance({ ...fields, type, runId, turnId });
      return state.status;
    },
  };
}
