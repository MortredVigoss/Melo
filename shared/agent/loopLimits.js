import { AGENT_LOOP_CONTRACT } from './loopContract.js';
const C = AGENT_LOOP_CONTRACT;

// One contract for every Host. Previously saved small limits remain explicit;
// editors offer the new 10..64 range without rewriting stored configuration.
export function resolveLoopLimits({ maxIterations, route } = {}) {
  const deep = route?.mode === 'smart' && route.deepTask === true;
  const configured = Number.isInteger(maxIterations) && maxIterations > 0
    ? Math.min(maxIterations, C.guardLimits.maxRounds) : C.loop.maxIterations;
  return {
    maxIterations: deep ? C.loop.deepTask.maxIterations : configured,
    minIterations: C.loop.minIterations, maxRounds: C.guardLimits.maxRounds,
    maxToolCalls: deep ? C.loop.deepTask.maxToolCalls : C.budget.maxToolCalls,
    deadlineMs: deep ? C.loop.deepTask.deadlineMs : C.budget.deadlineMs,
  };
}
