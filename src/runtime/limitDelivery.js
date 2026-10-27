import { createFunctionCallingSession } from '../tools/functionCalling.js';
import { deliveryRequest, deliveryCandidate, reviewDelivery, deliveryReply, hostEvidenceReply } from '../../shared/agent/limitDelivery.js';
import { goalReviewRequest } from '../../shared/agent/goal.js';
import { requestTimeoutMs, budgetExhausted } from './runBudget.js';

// No tool registry enters this function. The caller passes the same metered
// provider used by its working loop; usage and cancellation remain Host-owned.
export async function runLimitDelivery({ task, observations, reason, fallback, createReply, options, budget, signal, locale }) {
  let candidate = '', checkedTask = task;
  const parser = createFunctionCallingSession(options || {}, []);
  const stopped = () => ({ reply: hostEvidenceReply(candidate || fallback, observations, locale), task: checkedTask,
    terminalReason: signal?.aborted && signal.reason?.name !== 'TimeoutError' ? 'CANCELLED' : reason });
  if (signal?.aborted || !budget?.delivery || budgetExhausted(budget, undefined, { phase: 'delivery' })) return stopped();
  const call = async (request, phase, maxTokens) => createReply({ ...options, ...request, signal,
    budgetPhase: phase, purpose: phase === 'delivery' ? 'limit-delivery' : 'limit-check', maxTokens,
    timeoutMs: requestTimeoutMs(budget, { phase }), kind: phase === 'delivery' ? 'delivery' : 'check', workspacePath: null, toolChoice: 'none', tools: [], functions: [], functionTools: [],
    nativeWebSearchEnabled: false, nativeImageGenerationEnabled: false, onDelta: undefined, onReasoningDelta: undefined, onNativeToolEvent: undefined, onExecutionEvent: undefined });
  try {
    const raw = await call(deliveryRequest(task, observations, reason), 'delivery', 8192);
    const parsed = parser.parse(raw);
    if (!parsed.text.trim() || parsed.toolCalls.length) return stopped();
    candidate = parsed.text;
  } catch (error) {
    if (signal?.aborted) return stopped();
    return stopped();
  }
  checkedTask = deliveryCandidate(task, candidate, observations, reason);
  try {
    if (signal?.aborted) return stopped();
    const raw = await call(goalReviewRequest(checkedTask, observations), 'delivery-check', 2048);
    const parsed = parser.parse(raw);
    checkedTask = reviewDelivery(checkedTask, parsed.toolCalls.length ? '' : parsed.text, observations);
  } catch {
    if (signal?.aborted) return stopped();
    checkedTask = reviewDelivery(checkedTask, null, observations);
  }
  return { reply: deliveryReply(checkedTask, candidate, locale), task: checkedTask, terminalReason: 'LIMIT_DELIVERED' };
}
