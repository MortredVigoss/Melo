// Internal routing members as their own sub-agent loops (phases A2/A3, 2026-11-04).
//
// Until 11-04 an internal member ran inside the lead's loop by swapping the
// message list, so every member round counted against the lead's round limit,
// every member request drew on the lead's whole token pool and only one job
// could run at a time. Here each job runs through `runSubAgent`: its own
// shared-core turn (rounds bounded by MAX_MEMBER_ROUNDS), a child budget that
// caps the member's input tokens and keeps a reserve for the lead's answer,
// the lead's cancel signal, and `role:<job>:` operation prefixes for the scene.
// Read-only jobs run in parallel lanes; execute jobs run one at a time after
// the readers, so nothing writes while a sibling still reads. Nothing here
// grants permission: approvals, capability scope and request policy are
// decided by the executor inside the member exactly as for the lead.
import { runSubAgent } from '../../../agents/subAgent.js';
import { currentRequestContext, runWithRequestContext } from '../../../runtime/requestScope.js';
import { narrowBudget, extendBudget, remainingMs } from '../../../runtime/runBudget.js';
import { internalHandoff, MAX_MEMBER_ROUNDS } from '../../../../shared/agent/internalRouting.js';

export const READ_ONLY_JOBS = Object.freeze(['research', 'lookup', 'calculate']);
export const INTERNAL_PARALLEL_LANES = 3;
// Input tokens one member may draw from the turn pool, the slice the lead keeps
// for its own rounds (the delivery reserve is separate), and the smallest share
// still worth starting a member for.
export const MEMBER_INPUT_SHARE = 120_000;
export const LEAD_INPUT_RESERVE = 60_000;
export const MIN_MEMBER_SHARE = 20_000;
const LIMITED_STOPS = new Set(['ROUND_LIMIT', 'BUDGET_EXHAUSTED', 'CANCELLED', 'DEADLINE_EXCEEDED', 'ERROR']);
// B1 (2026-11-04): a top-level turn grows by one member share per dispatched
// member, the way an explicit team plan grows it (runBudget T8), so members no
// longer eat the lead's own allowance. Bounded per turn; a nested pool (turn
// inside a member or skill) never widens beyond its parent.
export const ROUTING_EXTENSION_CAP = 4 * MEMBER_INPUT_SHARE;
export const MEMBER_TOOL_CALLS = 40;
export const MEMBER_DEADLINE_MS = 5 * 60_000;
export const ROUTING_DEADLINE_CAP_MS = 20 * 60_000;
// B2: a member reads fewer and shorter search results than the lead; its
// handoff carries the facts, not the pages.
export const MEMBER_SEARCH_RESULTS = 5;
export const MEMBER_SEARCH_CONTENT_CHARS = 3000;

export function extendForMember(budget, sseEmitter, job) {
  if (!budget || budget.parent) return null;
  const tokens = Math.max(0, Math.min(MEMBER_INPUT_SHARE, ROUTING_EXTENSION_CAP - (budget.routingExtension || 0)));
  const deadline = Math.max(0, Math.min(MEMBER_DEADLINE_MS, ROUTING_DEADLINE_CAP_MS - (budget.routingDeadlineExtension || 0)));
  if (!tokens && !deadline) return null;
  const result = extendBudget(budget, {
    ...(tokens ? { maxInputTokens: Math.max(0, budget.maxInputTokens - budget.used.inputTokens) + tokens, maxToolCalls: Math.max(0, budget.maxToolCalls - budget.used.toolCalls) + MEMBER_TOOL_CALLS } : {}),
    ...(deadline ? { deadlineMs: remainingMs(budget) + deadline } : {}),
  });
  if (result.inputTokens) budget.routingExtension = (budget.routingExtension || 0) + tokens;
  if (result.deadline) budget.routingDeadlineExtension = (budget.routingDeadlineExtension || 0) + deadline;
  if (result.extended) sseEmitter?.('execution_event', { kind: 'pipeline', id: `routing:budget:${job.index}`, module: 'compute', name: job.label, status: 'completed',
    output: `Turn budget extended for this member: +${tokens} input tokens, +${Math.round(deadline / 60000)} min (total +${budget.routingExtension || 0} tokens).`,
    budget: { maxInputTokens: budget.maxInputTokens, deadlineAt: budget.deadlineAt, routingExtension: budget.routingExtension || 0 } });
  return result;
}

export function memberConfig(config) {
  const search = { ...(config?.operationalLimits?.search || {}), maxResults: MEMBER_SEARCH_RESULTS, contentMaxChars: MEMBER_SEARCH_CONTENT_CHARS };
  return { ...config, operationalLimits: { ...(config?.operationalLimits || {}), search } };
}

export function memberShare(budget) {
  if (!budget) return { share: null, reason: null };
  const limit = Number(budget.maxInputTokens);
  if (!Number.isFinite(limit)) return { share: MEMBER_INPUT_SHARE, reason: null };
  const remaining = Math.max(0, limit - (Number(budget.used?.inputTokens) || 0) - (Number(budget.delivery?.inputTokens) || 0));
  const available = remaining - LEAD_INPUT_RESERVE;
  if (available < MIN_MEMBER_SHARE) return { share: 0, reason: 'LEAD_RESERVE' };
  return { share: Math.min(MEMBER_INPUT_SHARE, available), reason: null };
}

function limitedResult(result, signal) {
  if (!result) return true;
  if (signal?.aborted || result.meta?.aborted === true || result.meta?.exhausted === true) return true;
  return LIMITED_STOPS.has(result.meta?.stopReason);
}

export async function runInternalMembers({ jobs = [], goal = '', background = '', config, extraTools = [], replyFn, signal, sseEmitter, chatId, workspacePath,
  chatSource, projectId, onProviderResponse, run = runSubAgent, lanes = INTERNAL_PARALLEL_LANES } = {}) {
  const context = currentRequestContext();
  const budget = context?.budget || null;
  const reference = String(goal || '').slice(0, 12000);
  const memberBackground = [reference ? `Original user goal (reference only; your assignment is the task above):\n${reference}` : '', String(background || '').trim()].filter(Boolean).join('\n\n');
  const outcomes = new Array(jobs.length);
  const pipeline = (job, fields) => sseEmitter?.('execution_event', { kind: 'pipeline', id: `internal:${job.index}`, module: 'compute', name: job.label, ...fields });
  const runOne = async index => {
    const job = jobs[index];
    pipeline(job, { status: 'running', input: job.task });
    extendForMember(budget, sseEmitter, job);
    const { share, reason } = memberShare(budget);
    if (reason === 'LEAD_RESERVE') {
      const handoff = internalHandoff({ job, answer: 'Not started: the lead keeps its remaining budget for the answer. Continue with the evidence already gathered.', observations: [], limited: true });
      outcomes[index] = { job, handoff, result: null, started: false };
      pipeline(job, { status: 'interrupted', output: 'Lead budget reserve reached; member not started.' });
      return;
    }
    // Member events keep their own ids under the job prefix (like delegated
    // members) so a member's model:N stage never merges into the lead's.
    const emit = (type, event) => sseEmitter?.(type, type === 'execution_event' ? { ...event, ...(event?.id ? { id: `${job.id}:${event.id}` } : {}), actorName: job.label } : event);
    const invoke = () => run({ task: job.task, roleSystem: job.system, background: memberBackground, allowedToolIds: job.tools, extraTools, config: memberConfig(config), nativeWebSearch: false, nativeImageGeneration: false, condenseEachRound: true,
      // runSubAgent caps a member's input tokens at maxTokens (32k by default,
      // sized for delegated members); an internal member gets its whole share.
      ...(replyFn ? { replyFn } : {}), maxIterations: MAX_MEMBER_ROUNDS, maxTokens: share || MEMBER_INPUT_SHARE, roleId: job.id, depth: 1, signal, sseEmitter: emit, chatId, workspacePath, chatSource, projectId, onProviderResponse });
    const child = budget ? narrowBudget(budget, share ? { maxInputTokens: share } : {}) : null;
    let result;
    try { result = await (context ? runWithRequestContext(Object.freeze({ ...context, ...(child ? { budget: child } : {}) }), invoke) : invoke()); }
    catch (error) { result = { ok: false, output: String(error?.message || error), meta: { aborted: signal?.aborted === true, stopReason: 'ERROR' } }; }
    const limited = limitedResult(result, signal);
    const handoff = internalHandoff({ job, answer: String(result?.output || ''), observations: result?.meta?.observations || [], limited });
    outcomes[index] = { job, handoff, result, started: true };
    pipeline(job, { status: JSON.parse(handoff).status === 'observed' ? 'completed' : 'interrupted', output: String(result?.output || '').slice(0, 500) });
  };
  const readers = jobs.map((job, index) => index).filter(index => READ_ONLY_JOBS.includes(jobs[index].role));
  const writers = jobs.map((job, index) => index).filter(index => !READ_ONLY_JOBS.includes(jobs[index].role));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, readers.length)) }, async () => { while (cursor < readers.length) await runOne(readers[cursor++]); }));
  for (const index of writers) await runOne(index);
  return outcomes;
}
