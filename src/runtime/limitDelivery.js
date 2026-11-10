import { createFunctionCallingSession } from '../tools/functionCalling.js';
import { deliveryRequest, deliveryCandidate, reviewDelivery, deliveryReply, hostEvidenceReply } from '../../shared/agent/limitDelivery.js';
import { goalReviewRequest } from '../../shared/agent/goal.js';
import { requestTimeoutMs, budgetExhausted } from './runBudget.js';

// No tool registry enters this function. The caller passes the same metered
// provider used by its working loop; usage and cancellation remain Host-owned.
//
// `candidate` is an answer that was already written and was waiting for its check when the
// allowance ended. It is the delivery: checked if the check can still run, delivered as written
// either way. Asking the model to write the answer again from the tool results discarded it and,
// for an answer that had used no tools, produced an empty three-part form (2026-11-10 audit).
//
// For such an answer the result also carries `answer` (the text exactly as written) and `notes` (what
// the delivery adds after it) apart. The caller's own last step still has to treat the answer like any
// other: the lead applies the verdict on a claim the answer flagged as uncertain and removes the marker
// from its last line. Joined here, the notes would leave that marker in the middle of the text, and
// removing it here dropped the verdict: a claim the check had corrected was delivered uncorrected
// (2026-11-10 pre-push review).
export async function runLimitDelivery({ task, observations, reason, fallback, candidate: pending = '', createReply, options, budget, signal, locale }) {
  let candidate = '', checkedTask = task;
  const written = String(pending || '').trim() ? String(pending) : '';
  const delivered = state => written
    ? { reply: deliveryReply(state, written, locale), answer: written, notes: deliveryReply(state, '', locale) }
    : { reply: deliveryReply(state, candidate, locale) };
  const parser = createFunctionCallingSession(options || {}, []);
  // The request carries no tools, but it must still travel on the connection's
  // own protocol. An empty tool list without a protocol is read by the provider
  // dispatcher as the OpenAI Responses protocol, which every Anthropic and
  // chat-completions connection rejects (2026-11-10 latency audit L1).
  const transport = parser.native ? { functionTools: [], toolProtocol: parser.protocol } : { functionTools: undefined, toolProtocol: undefined };
  const cancelled = () => signal?.aborted && signal.reason?.name !== 'TimeoutError';
  const stopped = () => {
    if (written && !cancelled()) {
      const unchecked = reviewDelivery(deliveryCandidate(task, written, observations, reason), null, observations);
      return { ...delivered(unchecked), task: unchecked, terminalReason: 'LIMIT_DELIVERED' };
    }
    return { reply: hostEvidenceReply(candidate || fallback, observations, locale), task: checkedTask,
      terminalReason: signal?.aborted ? (signal.reason?.name === 'TimeoutError' ? 'DEADLINE_EXCEEDED' : 'CANCELLED') : reason };
  };
  if (signal?.aborted || !budget?.delivery || budgetExhausted(budget, undefined, { phase: 'delivery' })) return stopped();
  const call = async (request, phase, maxTokens) => createReply({ ...options, ...request, signal,
    budgetPhase: phase, purpose: phase === 'delivery' ? 'limit-delivery' : 'limit-check', maxTokens,
    timeoutMs: requestTimeoutMs(budget, { phase }), kind: phase === 'delivery' ? 'delivery' : 'check', workspacePath: null, toolChoice: 'none', tools: [], functions: [], ...transport,
    nativeWebSearchEnabled: false, nativeImageGenerationEnabled: false, onDelta: undefined, onReasoningDelta: undefined, onNativeToolEvent: undefined, onExecutionEvent: undefined });
  if (written) candidate = written;
  else try {
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
  return { ...delivered(checkedTask), task: checkedTask, terminalReason: 'LIMIT_DELIVERED' };
}
