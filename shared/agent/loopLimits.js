import { AGENT_LOOP_CONTRACT } from './loopContract.js';
const C = AGENT_LOOP_CONTRACT;

// One contract for every Host. Previously saved small limits remain explicit;
// editors offer the new 10..64 range without rewriting stored configuration.
//
// Until 2026-11-14 a second input, `route`, enlarged the limits for a task that
// automatic model selection had classified as deep. That selection is retired
// on every host and the input went with it. (`loop.deepTask.deadlineMs` in the
// contract is still the desktop's and Android's overall run deadline.)
export function resolveLoopLimits({ maxIterations } = {}) {
  const configured = Number.isInteger(maxIterations) && maxIterations > 0
    ? Math.min(maxIterations, C.guardLimits.maxRounds) : C.loop.maxIterations;
  return {
    maxIterations: configured,
    minIterations: C.loop.minIterations, maxRounds: C.guardLimits.maxRounds,
    maxToolCalls: C.budget.maxToolCalls,
    deadlineMs: C.budget.deadlineMs,
  };
}
