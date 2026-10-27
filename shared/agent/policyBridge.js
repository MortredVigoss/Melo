import { reserveDelivery, workRemainingMs, admitModel, settleModel, createRunBudget, armBudget, remainingMs, requestTimeoutMs, recordUsage, budgetExhausted, narrowBudget, extendBudget, describeBudgetReason, budgetExhaustedReply } from './runBudget.js';

// Native Hosts retain object ownership, locking and clocks. This JSON boundary
// calls the very same budget implementation used by the Node compatibility API.
export function budgetOperation({ action, budget = null, now, options = {}, usage = {}, exhausted = null }) {
  if (!Number.isFinite(now)) throw Object.assign(new Error('A Host clock is required.'), { code: 'INVALID_CLOCK' });
  function bind(value, depth = 0) {
    if (!value) return null;
    if (depth > 32) throw new Error('Budget ancestry exceeds its limit.');
    return { ...value, ...(value.delivery ? { delivery: { ...value.delivery } } : {}), used: { ...value.used }, now: () => now, parent: bind(value.parent, depth + 1) };
  }
  const state = bind(budget);
  switch (action) {
    case 'create': return createRunBudget({ now, overrides: options });
    case 'arm': return armBudget(state, now);
    case 'reserveDelivery': return reserveDelivery(state);
    case 'workRemaining': return workRemainingMs(state, now);
    case 'admitModel': return admitModel(state, options);
    case 'settleModel': return settleModel(state, options.claim, usage);
    case 'remaining': return remainingMs(state, now);
    case 'timeout': return requestTimeoutMs(state, { ...options, now });
    case 'record': return recordUsage(state, usage);
    case 'admitTool': {
      if (!state) throw Object.assign(new Error('A run budget is required.'), { code: 'BUDGET_MISSING' });
      const exhausted = budgetExhausted(state, now);
      if (exhausted) return { allowed: false, budget: state, exhausted };
      return { allowed: true, budget: recordUsage(state, { toolCalls: 1 }), exhausted: null };
    }
    case 'exhausted': return budgetExhausted(state, now, options);
    case 'narrow': return narrowBudget(state, options);
    case 'extend': return { changes: extendBudget(state, options, now), budget: state };
    case 'describe': return describeBudgetReason(exhausted, options.locale);
    case 'reply': return budgetExhaustedReply(exhausted, options.locale);
    default: throw Object.assign(new Error('Unknown budget operation.'), { code: 'UNKNOWN_OPERATION' });
  }
}
