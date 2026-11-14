// Compatibility entry: the budget policy is shared with the native Host bridges.
export {
  memberTokenLimit, modelOutputLimit, reserveDelivery, workRemainingMs, admitModel, settleModel,
  DEFAULT_RUN_DEADLINE_MS,
  DEFAULT_RUN_MAX_INPUT_TOKENS,
  DEFAULT_RUN_MAX_TOOL_CALLS,
  createRunBudget,
  armBudget,
  remainingMs,
  requestTimeoutMs,
  recordUsage,
  budgetExhausted,
  narrowBudget,
  extendBudget,
  describeBudgetReason,
  budgetExhaustedReply,
  receiptInputTokens,
} from '../../shared/agent/runBudget.js';
