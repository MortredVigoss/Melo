// Desktop half of the shared agent-loop contract (2026-10-19 手机 agent loop 对齐桌面).
// The same fixtures run in ios/Tests/SharedContractTests.swift; the desktop
// functions below read their constants from the same JSON file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENT_LOOP_CONTRACT, fillTemplate, contractRegExp } from './agentLoopContract.js';
import { createRunBudget, recordUsage, budgetExhausted, describeBudgetReason, budgetExhaustedReply, narrowBudget,
  DEFAULT_RUN_DEADLINE_MS, DEFAULT_RUN_MAX_INPUT_TOKENS, DEFAULT_RUN_MAX_TOOL_CALLS } from './runBudget.js';
import { createRepeatGuard } from '../agents/repeatGuard.js';
import { finalizeToolResult, TOOL_ERROR_CODES, TOOL_RESULT_CONTRACT_NOTE, toolCodeHint } from '../tools/toolResult.js';
import { createFunctionCallingSession, MAX_FUNCTION_CALLS_PER_RESPONSE } from '../tools/functionCalling.js';
import { supplementMessage } from '../services/chat/supplements.js';
import { buildToolTraceText, TOOL_TRACE_PREFIX, TOOL_TRACE_MAX_CHARS } from '../services/chat/toolTraceReplay.js';
import { parseUncertaintyMarker, applyVerificationToReply, buildUncertaintySignalingRules } from '../retrieval/selfVerification.js';
import { classifyByRules, classifyRequest, classifyRisk, intentRequiresVerification } from '../retrieval/intentRouter.js';
import { redactSecretsInText } from '../tools/secretRedaction.js';
import { hashToolArgs, redactToolArgs, toolArgsDigest, MAX_MODEL_FACING_OUTPUT_CHARS } from '../tools/toolInvocationRecord.js';
import { sliceHistory, READ_HISTORY_MAX_TOKENS } from '../tools/builtins/readHistoryTool.js';
import { estimateTextTokens, NON_LATIN_TOKENS_PER_CHAR } from '../memory/tokenEstimate.js';
import { collectVerificationEvidence, buildVerificationEvidence, isSupportedVerification } from '../retrieval/verificationEvidence.js';

const C = AGENT_LOOP_CONTRACT;
const F = C.fixtures;

test('the module reads the checked-in JSON and desktop constants come from it', () => {
  const file = JSON.parse(readFileSync(new URL('../../shared/protocol/agent-loop.json', import.meta.url), 'utf8'));
  assert.deepEqual(C, file);
  assert.equal(C.loop.maxIterations, 10);
  assert.equal(MAX_FUNCTION_CALLS_PER_RESPONSE, C.loop.maxCallsPerResponse);
  assert.deepEqual([DEFAULT_RUN_DEADLINE_MS, DEFAULT_RUN_MAX_INPUT_TOKENS, DEFAULT_RUN_MAX_TOOL_CALLS], [C.budget.deadlineMs, C.budget.maxInputTokens, C.budget.maxToolCalls]);
  assert.deepEqual([...TOOL_ERROR_CODES], C.toolResult.errorCodes);
  assert.equal(TOOL_RESULT_CONTRACT_NOTE, C.toolResult.contractNote);
  for (const [code, hint] of Object.entries(C.toolResult.hints)) assert.equal(toolCodeHint(code), hint);
  assert.equal(toolCodeHint('constructor'), '');
  assert.equal([TOOL_TRACE_PREFIX, TOOL_TRACE_MAX_CHARS].join(), [C.toolTrace.prefix, C.toolTrace.maxChars].join());
  assert.equal(buildUncertaintySignalingRules(), C.uncertainty.rules.join('\n'));
  assert.equal(MAX_MODEL_FACING_OUTPUT_CHARS, C.toolResult.maxModelFacingOutputChars);
  assert.equal(READ_HISTORY_MAX_TOKENS, C.readHistory.maxTokens);
  assert.equal(NON_LATIN_TOKENS_PER_CHAR, C.readHistory.nonLatinTokensPerChar);
  assert.equal(fillTemplate('{a} {b} {missing}', { a: 1, b: '{a}' }), '1 {a} {missing}');
  for (const entry of [C.cjkPattern, ...C.redaction.patterns, ...C.uncertainty.fuzzy, ...Object.values(C.intent.patterns)]) assert.ok(contractRegExp(entry, 'g'));
});

test('tool-trace text matches the fixtures', () => {
  for (const row of F.toolTrace) assert.equal(buildToolTraceText(row.records, { status: row.status, ...(row.maxChars ? { maxChars: row.maxChars } : {}) }), row.expected);
});

test('repeat-guard decisions match the fixtures', () => {
  const guard = createRepeatGuard();
  for (const step of F.repeatGuard) {
    const rejected = guard.check(step.name, step.args);
    assert.deepEqual(rejected ? { rejected: true, code: rejected.error, output: rejected.output } : { rejected: false }, step.expected, JSON.stringify(step));
    if (!rejected && step.result) guard.record(step.name, step.args, step.result);
  }
});

test('model-facing envelope matches the fixtures', () => {
  const session = createFunctionCallingSession({ authMode: 'codex' }, []);
  for (const { input, expected } of F.envelope) {
    const call = { id: 'c1', name: 'tool' };
    const output = session.turnRecord({ text: '', toolCalls: [call], protocolCalls: [] }, [{ call, result: finalizeToolResult(input) }]).toolResults[0].output;
    assert.deepEqual(JSON.parse(output), expected, JSON.stringify(input).slice(0, 80));
  }
});

test('run budget reasons, replies and narrowing match the fixtures', () => {
  for (const row of F.budget) {
    const budget = createRunBudget({ now: () => row.startedAt, overrides: row.overrides });
    recordUsage(budget, row.used);
    const exhausted = budgetExhausted(budget, row.now);
    assert.deepEqual(exhausted ? { reason: exhausted.reason, limit: exhausted.limit, used: exhausted.used, describe: describeBudgetReason(exhausted), reply: budgetExhaustedReply(exhausted) } : null, row.expected);
  }
  const { parent: p, child: c, childUsed, expected } = F.narrowBudget;
  const parent = createRunBudget({ now: () => 0, overrides: p.overrides });
  recordUsage(parent, p.used);
  const child = narrowBudget(parent, c);
  recordUsage(child, childUsed);
  assert.deepEqual({ childDeadlineAt: child.deadlineAt, childMaxToolCalls: child.maxToolCalls, childMaxInputTokens: child.maxInputTokens, parentToolCalls: parent.used.toolCalls,
    childExhausted: budgetExhausted(child, 0)?.reason || null, parentExhausted: budgetExhausted(parent, 0)?.reason || null }, expected);
});

test('supplement wrapper and tool-limit reply match the fixtures', () => {
  for (const row of F.supplement) assert.equal(supplementMessage(row.entries.map(text => ({ text }))), row.expected);
  for (const row of F.toolLimitReply) assert.equal(contractRegExp(C.cjkPattern).test(row.question) ? C.loop.toolLimitReply.zh : C.loop.toolLimitReply.en, row.expected);
});

test('uncertainty marker, verification application and evidence match the fixtures', () => {
  for (const row of F.uncertainty) assert.deepEqual(parseUncertaintyMarker(row.text), row.expected, row.text);
  for (const row of F.applyVerification) assert.equal(applyVerificationToReply(row.reply, row.verification), row.expected);
  for (const row of F.verificationSupport) assert.equal(isSupportedVerification(row.payload, row.evidence), row.expected);
  const ev = F.verificationEvidence;
  assert.deepEqual(buildVerificationEvidence(ev.contextBlocks, collectVerificationEvidence(ev.pairs, { query: ev.query })), ev.expected);
});

test('intent rules, contextual replies and risk match the fixtures', async () => {
  for (const row of F.intentRules) assert.equal(classifyByRules(row.text), row.expected, row.text);
  for (const row of F.intentContext) {
    const contextMessages = row.previous ? [{ role: 'user', content: row.previous }, { role: 'assistant', content: 'x' }, { role: 'user', content: row.text }] : [{ role: 'user', content: row.text }];
    const result = await classifyRequest(row.text, { config: {}, contextMessages });
    assert.deepEqual({ taskType: result.taskType, riskLevel: result.riskLevel, requiresVerification: result.requiresVerification }, row.expected, row.text);
  }
  for (const row of F.riskLevel) assert.equal(classifyRisk(row.text), row.expected);
  for (const row of F.requiresVerification) assert.equal(intentRequiresVerification(row.intent), row.expected);
});

test('secret redaction, args hash and digest match the fixtures', () => {
  for (const row of F.redaction) assert.equal(redactSecretsInText(row.text), row.expected, row.text);
  for (const row of F.args) {
    const args = JSON.parse(row.json);
    const redacted = redactToolArgs(args);
    assert.deepEqual({ hash: hashToolArgs(args), redacted, digest: toolArgsDigest(redacted, C.toolTrace.digest) }, row.expected, row.json.slice(0, 60));
  }
});

test('read_history slicing and token estimates match the fixtures', () => {
  const messages = Array.from({ length: F.readHistoryMessages }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `message ${i}` }));
  for (const row of F.readHistorySlice) {
    const slice = sliceHistory(messages, row.args);
    assert.deepEqual({ ids: slice.messages.map(m => m.id), hasMore: Boolean(slice.hasMore), nextMessageId: slice.nextMessageId || '', missing: slice.missing || '' }, row.expected, JSON.stringify(row.args));
  }
  for (const row of F.tokens) assert.equal(estimateTextTokens(row.text), row.expected);
});
