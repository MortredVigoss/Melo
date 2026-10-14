/**
 * Skill drafting — Phase 3B.
 *
 * Given a chunk of recent conversation, ask the model to propose a reusable
 * skill: id, name, description, systemPrompt, (optional) parametersSchema,
 * and a suggested type ("prompt" | "executable").
 *
 * The caller is expected to show the returned draft to the user for
 * confirmation before it is persisted via createCustomSkill. We never
 * persist automatically — "涉及到外联的bot，所以需要用户打字或者语音回答"
 * is the operator intent.
 *
 * The drafting prompt is deliberately explicit about the output schema so
 * the model cannot accidentally smuggle free-form prose past the JSON
 * parser. Any parse / validation failure is surfaced as
 * { ok: false, error: 'PARSE_ERROR' | 'VALIDATION_ERROR', raw }.
 *
 * DI seams:
 *   - `replyFn` lets tests swap out createOpenAICompatibleReply.
 *   - `nowFn` lets tests pin the generated id suffix.
 */

import { createOpenAICompatibleReply } from '../openai.js';
import { normalizeCustomSkill } from '../domain/skill/skillService.js';

// Hard caps so a single /save-as-skill cannot feed the whole transcript to
// the model (a) to control cost, (b) to keep the draft focused on a single
// coherent workflow rather than summarising the entire chat.
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_CHARS_PER_TURN = 2000;
const DEFAULT_MAX_TOTAL_CHARS = 16000;

const DRAFTING_SYSTEM_PROMPT = [
  'You turn recent user↔assistant conversations into a reusable "skill" so the user can trigger the same workflow again later.',
  '',
  'Output hard rules:',
  '  1. Reply with a SINGLE fenced JSON block (```json ... ```). Nothing before or after the block.',
  '  2. The JSON MUST have exactly the fields below, in this order. No extras.',
  '  3. "id" is a short kebab-case slug (≤48 chars, [a-z0-9-]).',
  '  4. "name" is a human title (≤80 chars).',
  '  5. "description" is one sentence (≤200 chars) describing WHEN to invoke the skill.',
  '  6. "systemPrompt" is the operator prompt the skill will run with (≤2000 chars). Write it in second person ("You are …").',
  '  7. "type" is "executable" if the skill will call tools (web search, file ops, etc.) OR fills in a {task} placeholder; "prompt" if it is a static persona / style guide the parent agent should read verbatim.',
  '  8. "parametersSchema" is a JSON Schema describing the inputs the skill needs. For most workflows the default wrapper { "type":"object", "properties":{"task":{"type":"string","description":"..."}}, "required":["task"] } is correct. Only diverge if the workflow clearly needs named parameters (e.g. {"city":"...","date":"..."}).',
  '  9. Do NOT reproduce the user\'s private data in the systemPrompt — generalise it into a reusable workflow.',
  ' 10. Do NOT output jailbreak / prompt-injection phrasing ("ignore previous instructions", "you are now a raw shell", etc.).',
  '',
  'Example skeleton:',
  '```json',
  '{',
  '  "id": "weekly-status-summariser",',
  '  "name": "Weekly status summariser",',
  '  "description": "Turn a dump of standup notes into a 5-bullet weekly summary.",',
  '  "systemPrompt": "You are the weekly status summariser. Accept a block of raw notes via {task} and return at most 5 bullets: wins, risks, blockers, next-week plan, and asks. Keep each bullet under 140 chars.",',
  '  "type": "executable",',
  '  "parametersSchema": {',
  '    "type": "object",',
  '    "properties": { "task": { "type": "string", "description": "Raw standup notes." } },',
  '    "required": ["task"]',
  '  }',
  '}',
  '```',
].join('\n');

function sanitizeTurns(messages, {
  maxTurns = DEFAULT_MAX_TURNS,
  maxCharsPerTurn = DEFAULT_MAX_CHARS_PER_TURN,
  maxTotalChars = DEFAULT_MAX_TOTAL_CHARS,
} = {}) {
  if (!Array.isArray(messages)) return [];
  // Only keep user/assistant turns with non-empty text content — system /
  // tool / function calls are internal noise at this layer.
  const keep = [];
  for (let i = messages.length - 1; i >= 0 && keep.length < maxTurns; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content
            .filter(p => p && (p.type === 'text' || typeof p.text === 'string'))
            .map(p => (typeof p === 'string' ? p : p.text || ''))
            .join(' ')
        : '';
    const trimmed = content.trim();
    if (!trimmed) continue;
    const clipped = trimmed.length > maxCharsPerTurn
      ? `${trimmed.slice(0, maxCharsPerTurn)}…[truncated]`
      : trimmed;
    keep.unshift({ role: m.role, content: clipped });
  }
  // Enforce total cap by dropping oldest turns until within budget.
  let totalChars = keep.reduce((n, m) => n + m.content.length, 0);
  while (keep.length > 1 && totalChars > maxTotalChars) {
    const dropped = keep.shift();
    totalChars -= dropped.content.length;
  }
  return keep;
}

function renderConversationForPrompt(turns) {
  return turns
    .map(m => `[${m.role.toUpperCase()}]\n${m.content}`)
    .join('\n\n');
}

function extractJsonBlock(rawReply) {
  if (!rawReply || typeof rawReply !== 'string') return null;
  // Prefer a fenced ```json ... ``` block. Fall back to the first
  // brace-balanced chunk if the model forgot the fence.
  const fenced = rawReply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    const inner = fenced[1].trim();
    if (inner) return inner;
  }
  const firstBrace = rawReply.indexOf('{');
  if (firstBrace === -1) return null;
  // Balance braces to find the matching close — naive but handles nested
  // JSON (parametersSchema has nested objects).
  let depth = 0;
  for (let i = firstBrace; i < rawReply.length; i++) {
    const c = rawReply[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return rawReply.slice(firstBrace, i + 1);
    }
  }
  return null;
}

/**
 * Draft a skill from a conversation.
 *
 * @param {Object}  options
 * @param {Array}   options.messages              - chat turns in chronological order
 * @param {Object}  options.config                - resolved Melo config (authMode/apiKey/baseUrl/model)
 * @param {string}  [options.hint]                - optional user-provided hint ("make this about weather lookups")
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.replyFn]            - DI seam for tests
 * @param {Function} [options.nowFn]              - DI seam for tests (generates id fallback)
 * @returns {Promise<{
 *   ok: boolean,
 *   skill?: Object,
 *   raw?: string,
 *   error?: 'NO_CONVERSATION' | 'MISSING_CONFIG' | 'MODEL_ERROR' | 'PARSE_ERROR' | 'VALIDATION_ERROR',
 *   reason?: string,
 * }>}
 */
export async function draftSkillFromConversation({
  messages = [],
  config,
  hint = '',
  signal,
  replyFn = createOpenAICompatibleReply,
  nowFn = () => Date.now(),
  windowOptions = {},
} = {}) {
  const turns = sanitizeTurns(messages, windowOptions);
  if (turns.length === 0) {
    return { ok: false, error: 'NO_CONVERSATION', reason: 'No user/assistant turns to draft from.' };
  }
  if (!config || typeof config !== 'object') {
    return { ok: false, error: 'MISSING_CONFIG', reason: 'Drafting needs resolved config.' };
  }

  const conversation = renderConversationForPrompt(turns);
  const userTurn = [
    'Recent conversation to turn into a skill:',
    '',
    conversation,
    '',
    hint ? `User hint: ${hint}` : '',
    '',
    'Produce the skill JSON now.',
  ]
    .filter(Boolean)
    .join('\n');

  let rawReply;
  try {
    rawReply = await replyFn({
      authMode: config.authMode,
      apiProtocol: config.apiProtocol,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      systemPrompt: DRAFTING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userTurn }],
      signal,
    });
  } catch (err) {
    return {
      ok: false,
      error: 'MODEL_ERROR',
      reason: err?.message || 'Drafting model call failed.',
    };
  }

  const jsonChunk = extractJsonBlock(rawReply);
  if (!jsonChunk) {
    return {
      ok: false,
      error: 'PARSE_ERROR',
      reason: 'Drafting reply did not contain a JSON block.',
      raw: rawReply,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonChunk);
  } catch (err) {
    return {
      ok: false,
      error: 'PARSE_ERROR',
      reason: `JSON.parse failed: ${err.message}`,
      raw: rawReply,
    };
  }

  // Backfill id from name if the model omitted it, so normalizeCustomSkill
  // doesn't reject the draft purely on a missing id.
  if (!parsed.id && parsed.name) {
    parsed.id = String(parsed.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || `draft-${nowFn()}`;
  }

  const normalized = normalizeCustomSkill(parsed);
  if (!normalized) {
    return {
      ok: false,
      error: 'VALIDATION_ERROR',
      reason: 'normalizeCustomSkill rejected the draft (likely missing id/name or id shadows a built-in).',
      raw: rawReply,
    };
  }

  return { ok: true, skill: normalized, raw: rawReply };
}

// Exported helpers for tests.
export const __internals__ = {
  sanitizeTurns,
  extractJsonBlock,
  DRAFTING_SYSTEM_PROMPT,
};
