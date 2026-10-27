import { estimateMessagesTokens, estimateTextTokens } from '../memory/tokenEstimate.js';
import { admitModel, settleModel, modelOutputLimit, requestTimeoutMs, receiptInputTokens } from './runBudget.js';

// Same admission for work, delivery and its check. Pending input/output claims
// prevent sibling calls from consuming one another's or the parent's reserve.
export function budgetedMemberReply(reply, budget) {
  return async options => {
    options.signal?.throwIfAborted();
    const phase = options.budgetPhase || 'work';
    const input = estimateMessagesTokens(options.messages || []) + Math.ceil(estimateTextTokens((options.systemPrompt || '') + JSON.stringify(options.tools || options.functionTools || [])) * 4 / 3) + 32;
    const limit = modelOutputLimit(budget, { phase, inputTokens: input, cap: options.maxTokens });
    if (limit === 0 || (phase !== 'work' && limit != null && limit < options.maxTokens)) throw Object.assign(new Error('Member delivery allowance cannot be spent by another request.'), { code: 'BUDGET_EXHAUSTED' });
    const admission = admitModel(budget, { phase, inputTokens: input, outputTokens: limit || 0 });
    if (!admission.allowed) throw Object.assign(new Error('Member model request exceeds its remaining allowance.'), { code: 'BUDGET_EXHAUSTED', exhausted: admission.exhausted });
    let receipt, response;
    try {
      response = await reply({ ...options, ...(limit == null ? {} : { maxTokens: limit }), timeoutMs: requestTimeoutMs(budget, { phase, ...(options.timeoutMs ? { cap: options.timeoutMs } : {}) }),
        onProviderResponse: value => { receipt = value; options.onProviderResponse?.(value); } });
      options.signal?.throwIfAborted();
      return response;
    } finally {
      const measured = receipt?.usage?.output ?? receipt?.usage?.output_tokens ?? receipt?.usage?.completion_tokens;
      settleModel(budget, admission.claim, { inputTokens: receiptInputTokens(receipt) ?? input,
        outputTokens: Number.isFinite(Number(measured)) ? Number(measured) : response == null ? limit || 0 : Math.ceil(estimateTextTokens(typeof response === 'string' ? response : JSON.stringify(response)) * 4 / 3) });
    }
  };
}
