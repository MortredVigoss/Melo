// Run-level budget (2026-10-17 design audit T3 / option C1).
//
// Before this module a turn only had per-iteration limits (10 tool
// iterations, a 600 s provider timeout, a 60 s tool timeout, a member
// timeoutMs) — ten slow tool rounds could keep one turn alive for well over
// an hour and there was no cap on total input tokens. The budget hangs on
// the request context (runtime/requestContext.js) and is consulted at every
// exit that spends time or tokens: the chat loop's model call, synchronous
// compaction (it goes through the same createReply wrapper), the tool
// executor, and member/skill sub-loops, which receive a narrowed child whose
// usage propagates back to the parent.
//
// Pure module: no imports from services/state/http; the clock is injectable.

export const DEFAULT_RUN_DEADLINE_MS = 20 * 60_000;
export const DEFAULT_RUN_MAX_INPUT_TOKENS = 400_000;
export const DEFAULT_RUN_MAX_TOOL_CALLS = 120;
export const DEFAULT_REQUEST_TIMEOUT_CAP_MS = 600_000;

export const BUDGET_EXHAUSTED = 'BUDGET_EXHAUSTED';

const REASON_TEXT = Object.freeze({
  deadline: '运行时间',
  'input-tokens': '输入 token',
  'tool-calls': '工具调用次数',
});

function positiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function clockOf(now) {
  if (typeof now === 'function') return now;
  if (Number.isFinite(now)) return () => now;
  return Date.now;
}

/**
 * Create a run budget.
 *
 * @param {Object} [options]
 * @param {Object} [options.env]        env bag (MELO_RUN_DEADLINE_MS / MELO_RUN_MAX_INPUT_TOKENS / MELO_RUN_MAX_TOOL_CALLS)
 * @param {Function|number} [options.now] clock; tests pass a virtual one
 * @param {Object} [options.overrides]  { deadlineMs, deadlineAt, maxInputTokens, maxToolCalls } — win over env
 */
export function createRunBudget({ env = {}, now, overrides = {} } = {}) {
  const clock = clockOf(now);
  const startedAt = clock();
  const deadlineMs = positiveInt(overrides.deadlineMs) ?? positiveInt(env?.MELO_RUN_DEADLINE_MS) ?? DEFAULT_RUN_DEADLINE_MS;
  const deadlineAt = positiveInt(overrides.deadlineAt) ?? startedAt + deadlineMs;
  return {
    startedAt,
    deadlineAt,
    maxInputTokens: positiveInt(overrides.maxInputTokens) ?? positiveInt(env?.MELO_RUN_MAX_INPUT_TOKENS) ?? DEFAULT_RUN_MAX_INPUT_TOKENS,
    maxToolCalls: positiveInt(overrides.maxToolCalls) ?? positiveInt(env?.MELO_RUN_MAX_TOOL_CALLS) ?? DEFAULT_RUN_MAX_TOOL_CALLS,
    used: { inputTokens: 0, toolCalls: 0, providerCalls: 0 },
    parent: null,
    now: clock,
  };
}

function currentTime(budget, now) {
  if (Number.isFinite(now)) return now;
  if (typeof now === 'function') return now();
  return budget?.now ? budget.now() : Date.now();
}

/**
 * Re-base an untouched budget to "now": a turn can sit in the chat queue
 * behind another turn, and its context (hence budget) was created when the
 * HTTP request arrived. Once anything has been spent the budget is left alone.
 */
export function armBudget(budget, now) {
  if (!budget || budget.parent) return budget;
  const { inputTokens, toolCalls, providerCalls } = budget.used;
  if (inputTokens || toolCalls || providerCalls) return budget;
  const time = currentTime(budget, now);
  budget.deadlineAt = time + (budget.deadlineAt - budget.startedAt);
  budget.startedAt = time;
  return budget;
}

/** Milliseconds left before the deadline (never negative); Infinity without a budget. */
export function remainingMs(budget, now) {
  if (!budget) return Infinity;
  return Math.max(0, budget.deadlineAt - currentTime(budget, now));
}

/** Provider request timeout: min(cap, remaining). Without a budget → cap. */
export function requestTimeoutMs(budget, { cap = DEFAULT_REQUEST_TIMEOUT_CAP_MS, now } = {}) {
  if (!budget) return cap;
  return Math.max(0, Math.min(cap, remainingMs(budget, now)));
}

/** Add usage to the budget and every ancestor (members/skills count toward the parent). */
export function recordUsage(budget, { inputTokens = 0, toolCalls = 0, providerCalls = 0 } = {}) {
  for (let node = budget; node; node = node.parent) {
    node.used.inputTokens += Math.max(0, Number(inputTokens) || 0);
    node.used.toolCalls += Math.max(0, Number(toolCalls) || 0);
    node.used.providerCalls += Math.max(0, Number(providerCalls) || 0);
  }
  return budget;
}

/**
 * null when the run may continue, otherwise
 * { code:'BUDGET_EXHAUSTED', reason:'deadline'|'input-tokens'|'tool-calls', limit, used, reasonText }.
 * A child is also exhausted when any ancestor is (siblings share the parent's pool).
 */
export function budgetExhausted(budget, now) {
  if (!budget) return null;
  const time = currentTime(budget, now);
  const build = (reason, limit, used) => ({ code: BUDGET_EXHAUSTED, reason, limit, used, reasonText: REASON_TEXT[reason],
    elapsedMs: Math.max(0, time - budget.startedAt), usage: { ...budget.used } });
  if (time >= budget.deadlineAt) return build('deadline', budget.deadlineAt - budget.startedAt, time - budget.startedAt);
  if (budget.used.inputTokens >= budget.maxInputTokens) return build('input-tokens', budget.maxInputTokens, budget.used.inputTokens);
  if (budget.used.toolCalls >= budget.maxToolCalls) return build('tool-calls', budget.maxToolCalls, budget.used.toolCalls);
  return budget.parent ? budgetExhausted(budget.parent, time) : null;
}

/**
 * Derive a child budget: each limit is min(child limit, parent remaining),
 * the deadline is shared (or earlier when the child asks for one), usage
 * starts at 0 but recordUsage on the child also lands on the parent.
 * Without a parent there is nothing to narrow → null.
 *
 * @param {Object|null} parent
 * @param {Object} [child] { deadlineMs, deadlineAt, maxInputTokens, maxToolCalls }
 */
export function narrowBudget(parent, child = {}) {
  if (!parent) return null;
  const startedAt = currentTime(parent);
  const candidates = [parent.deadlineAt];
  const childDeadlineMs = positiveInt(child.deadlineMs);
  if (childDeadlineMs) candidates.push(startedAt + childDeadlineMs);
  const childDeadlineAt = positiveInt(child.deadlineAt);
  if (childDeadlineAt) candidates.push(childDeadlineAt);
  const limit = (own, parentRemaining) => Math.max(0, Math.min(positiveInt(own) ?? Infinity, parentRemaining));
  return {
    startedAt,
    deadlineAt: Math.min(...candidates),
    maxInputTokens: limit(child.maxInputTokens, parent.maxInputTokens - parent.used.inputTokens),
    maxToolCalls: limit(child.maxToolCalls, parent.maxToolCalls - parent.used.toolCalls),
    used: { inputTokens: 0, toolCalls: 0, providerCalls: 0 },
    parent,
    now: parent.now,
  };
}

/**
 * Let a root budget grow to accommodate an explicit plan (bug audit T8): a
 * team plan's `maxMinutes` / `maxTokens` used to be silently capped by the
 * 20 min / 400k turn defaults, so members hit BUDGET_EXHAUSTED although the
 * user had configured a longer run. Only a top-level budget (no parent) can
 * be extended — a member/skill pool never widens beyond its parent. Each
 * limit becomes max(current remaining, requested); nothing ever shrinks.
 *
 * @returns {{ extended: boolean, deadline: boolean, inputTokens: boolean }}
 */
export function extendBudget(budget, { deadlineMs, maxInputTokens, maxToolCalls } = {}, now) {
  const result = { extended: false, deadline: false, inputTokens: false, toolCalls: false };
  if (!budget || budget.parent) return result;
  const time = currentTime(budget, now);
  const wantDeadline = positiveInt(deadlineMs);
  if (wantDeadline && time + wantDeadline > budget.deadlineAt) { budget.deadlineAt = time + wantDeadline; result.deadline = true; }
  const wantTokens = positiveInt(maxInputTokens);
  if (wantTokens && budget.used.inputTokens + wantTokens > budget.maxInputTokens) { budget.maxInputTokens = budget.used.inputTokens + wantTokens; result.inputTokens = true; }
  const wantCalls = positiveInt(maxToolCalls);
  if (wantCalls && budget.used.toolCalls + wantCalls > budget.maxToolCalls) { budget.maxToolCalls = budget.used.toolCalls + wantCalls; result.toolCalls = true; }
  result.extended = result.deadline || result.inputTokens || result.toolCalls;
  return result;
}

/** Human-readable reason, e.g. "运行时间 20 分钟" / "输入 token 400000" / "工具调用次数 120 次". */
export function describeBudgetReason(exhausted) {
  if (!exhausted) return '';
  if (exhausted.reason === 'deadline') {
    const minutes = Math.round(exhausted.limit / 60_000);
    return `${exhausted.reasonText} ${minutes >= 1 ? `${minutes} 分钟` : `${Math.round(exhausted.limit / 1000)} 秒`}`;
  }
  if (exhausted.reason === 'tool-calls') return `${exhausted.reasonText} ${exhausted.limit} 次`;
  return `${exhausted.reasonText} ${exhausted.limit}`;
}

/** The explicit assistant reply the chat loop publishes when the budget is gone. */
export function budgetExhaustedReply(exhausted) {
  return `这轮对话已达到运行预算（${describeBudgetReason(exhausted)}），已停止。你可以发送“继续”接着做。`;
}

/** Input tokens of one provider receipt; raw or normalized usage shapes. */
export function receiptInputTokens(receipt) {
  const usage = receipt?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const value = usage.input ?? usage.input_tokens ?? usage.prompt_tokens;
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}
