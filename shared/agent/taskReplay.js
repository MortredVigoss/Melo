import { startTurn, advanceTurn } from './turn.js';
import { planRequest } from './search.js';
import { budgetOperation } from './policyBridge.js';
import { completionObservation, completionResult } from './completion.js';
import { executionScene } from './execution.js';
import { sessionEvents } from '../../src/shared/sessionEvents.js';
import { toolCallFingerprint } from './repeatGuard.js';
import { scoreTaskReplay } from './taskScore.js';

// Deterministic fixture Host: no IO, model, tool effects or wall clock. The
// production Core decides permits, budgets, completion and event projection.
function invalid(message) { throw Object.assign(new Error(message), { code: 'INVALID_TASK_DATASET' }); }
function amount(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000; }
function validate(dataset) {
  if (dataset?.version !== 1 || dataset.kind !== 'fixture' || !Array.isArray(dataset.tasks) || !dataset.tasks.length || dataset.tasks.length > 32) invalid('Unsupported or unbounded fixture dataset.');
  const ids = new Set();
  for (const task of dataset.tasks) {
    if (!/^[a-z0-9-]{1,60}$/.test(task.id || '') || ids.has(task.id)) invalid('Invalid or duplicate task ID.');
    ids.add(task.id);
    if (!task.request || typeof task.request.text !== 'string' || !task.request.text.trim() || task.request.text.length > 8000 || !task.expected) invalid('A request and independent expectations are required.');
    if (!Array.isArray(task.frames) || !task.frames.length || task.frames.length > 20) invalid('Unbounded replay frames.');
    for (const frame of task.frames) {
      if (!['model', 'cancel', 'late-calls'].includes(frame.type) || !amount(frame.delayMs || 0)) invalid('Invalid fixture frame.');
      if (frame.type === 'model' && (![frame.inputTokens, frame.outputTokens, frame.latencyMs].every(amount))) invalid('Explicit fixture tokens and latency are required.');
      if (frame.calls && (!Array.isArray(frame.calls) || frame.calls.length > 6)) invalid('Unbounded fixture calls.');
      for (const call of frame.calls || []) if (typeof call.receipt?.ok !== 'boolean') invalid('Fixture calls need explicit receipts.');
    }
  }
}
function replay(task) {
  const runId = `eval-${task.id}`, start = 1000;
  let now = start, state, budget, scene, finalReply = '', terminalReason = '';
  const plan = planRequest(task.request);
  const observations = [], verifiedActions = [], executedTools = [], rejected = [], protocolErrors = [], repeats = {};
  let modelCalls = 0, inputTokens = 0, outputTokens = 0, attemptedCalls = 0;
  const at = () => new Date(1700000000000 + now).toISOString();
  state = startTurn({ runId, turnId: runId, now, allowedTools: plan.tools, requiredTools: plan.requiredTools, toolDependencies: plan.toolDependencies, limits: task.limits });
  const policy = (action, fields = {}) => JSON.parse(JSON.stringify(budgetOperation({ action, budget, now, ...fields })));
  budget = policy('create', { options: task.budget || {} });
  scene = executionScene({ action: 'create', runId, chatId: task.id, query: task.request.text, at: at() });
  scene.toolCalls = [];
  function advance(type, fields = {}) {
    try { state = advanceTurn(state, { runId, turnId: runId, type, ...fields }, now); return true; }
    catch (error) { protocolErrors.push(error.code || 'CORE_ERROR'); terminalReason ||= error.code || 'CORE_ERROR'; return false; }
  }
  function sceneEvent(event) { scene = executionScene({ action: 'event', scene, at: at(), event }); }
  function exhausted() {
    const reason = policy('exhausted');
    if (reason) terminalReason = `BUDGET_${reason.reason.toUpperCase().replace(/-/g, '_')}`;
    return !!reason;
  }
  for (const frame of task.frames) {
    now += frame.delayMs || 0;
    if (frame.type === 'late-calls') {
      advance('calls', { calls: frame.calls });
      continue;
    }
    if (state.status !== 'running' || terminalReason) break;
    if (frame.type === 'cancel') { advance('cancel'); terminalReason = state.reason; continue; }
    if (exhausted() || !advance('request') || state.status !== 'running') break;
    modelCalls++;
    const modelId = `model:${modelCalls}`;
    sceneEvent({ id: modelId, name: 'fixture-model', model: 'fixture', status: 'running' });
    inputTokens += frame.inputTokens; outputTokens += frame.outputTokens;
    budget = policy('record', { usage: { inputTokens: frame.inputTokens, providerCalls: 1 } });
    now += frame.latencyMs;
    sceneEvent({ id: modelId, status: 'completed', durationMs: frame.latencyMs });
    if (exhausted()) break;
    if (frame.calls?.length) {
      attemptedCalls += frame.calls.length;
      if (!advance('calls', { calls: frame.calls }) || state.status !== 'running') break;
      for (const call of frame.calls) {
        const permitted = state.permitted.includes(call.id);
        const admission = permitted ? policy('admitTool') : null;
        if (admission) budget = admission.budget;
        const executed = permitted && admission.allowed;
        const code = !permitted ? state.rejections[call.id] : !executed ? 'BUDGET_EXHAUSTED' : call.receipt.code;
        if (permitted && !executed) terminalReason = 'BUDGET_EXHAUSTED';
        const receipt = executed ? call.receipt : { ok: false, code };
        if (executed) {
          executedTools.push(call.name);
          const key = toolCallFingerprint(call.name, call.arguments);
          repeats[key] = (repeats[key] || 0) + 1;
          if (receipt.verifiedAction) verifiedActions.push(receipt.verifiedAction);
        } else rejected.push(code);
        observations.push(...completionObservation({ ...receipt, id: call.id, name: call.name, executed }));
        scene.toolCalls.push({ callId: call.id, iteration: modelCalls, toolId: call.name, executed, code,
          status: receipt.ok ? 'ok' : 'error', startedAt: at(), finishedAt: at() });
        if (!advance('result', { ...receipt, callId: call.id })) break;
      }
    } else {
      finalReply = frame.reply || '';
      advance('complete');
    }
  }
  terminalReason ||= state.reason || (state.status === 'running' ? 'FIXTURE_INCOMPLETE' : '');
  const completion = completionResult({ goal: task.request.text, plan, reply: finalReply, observations, verifiedActions, terminalReason });
  scene = executionScene({ action: 'finish', scene, at: at(), outcome: completion.outcome, reason: completion.reason, completion });
  const result = { id: task.id, route: plan.route, allowedTools: plan.tools, completion,
    metrics: { modelCalls, attemptedCalls, executedTools, rejected, protocolErrors,
      maxRepeat: Math.max(0, ...Object.values(repeats)), fixtureInputTokens: inputTokens, fixtureOutputTokens: outputTokens,
      simulatedElapsedMs: now - start, readSources: observations.filter(row => row.type === 'source' && ['extracted', 'partial'].includes(row.reading)).length },
    events: sessionEvents(scene) };
  return { ...result, score: scoreTaskReplay(result, task.expected) };
}
export function runTaskReplay(dataset) {
  validate(dataset);
  const tasks = dataset.tasks.map(replay);
  return { version: 1, kind: 'fixture', datasetId: dataset.id, qualityClaim: 'deterministic-contract-only',
    tokensAndLatency: 'declared fixture usage and virtual time; not provider measurements', tasks, passed: tasks.every(task => task.score.passed) };
}
