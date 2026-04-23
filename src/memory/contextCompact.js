/**
 * Context compression for Melo.
 *
 * Three-layer strategy (lightest → heaviest):
 *
 *   Layer 0 – Token-bounded sliding window
 *     Always active. Replaces the old hard slice(-12) with a token-budget
 *     window so recent history is preserved up to ~60 K tokens instead of
 *     being truncated at a fixed message count.
 *
 *   Layer 1 – LLM-based full compact (this file's main export)
 *     Triggered when the total chat history exceeds COMPACT_TRIGGER_TOKENS.
 *     Calls the configured model (codex / api-key / local – all three modes
 *     are supported) to produce a structured 6-section summary.  The summary
 *     is stored on the chat object and injected into the system prompt so the
 *     model always has full context without carrying the raw history.
 *
 * Design constraints that differ from the source-code (melo_ai/main):
 *  - Melo messages are plain { role, content } objects, no tool_use/tool_result.
 *  - All three auth modes must work. The compact call uses a single plain-text
 *    user message (a transcript) so it is safe for the Codex responses endpoint
 *    which rejects multi-part input_audio / image blocks in older turns.
 *  - No recursion guards needed (compact call is a fresh single-turn request).
 */

import { createOpenAICompatibleReply } from '../openai.js';
import { compactOffline } from './offline/compact.js';

// ─── Token estimation ──────────────────────────────────────────────────────────
// Rough heuristic: ~4 chars per token (English/CJK mix), pad 33% conservative.

function estimateTextTokens(text = '') {
  return Math.ceil(String(text).length / 4);
}

/**
 * Rough token count for a single { role, content } message.
 * Handles plain string content and OpenAI multi-part arrays.
 */
export function estimateMessageTokens(message) {
  const content = message?.content;
  if (!content) return 0;
  if (typeof content === 'string') return estimateTextTokens(content);
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (!part) return sum;
      if (part.type === 'text') return sum + estimateTextTokens(part.text);
      if (part.type === 'image_url') return sum + 500;        // flat image estimate
      if (part.type === 'audio_attachment') return sum + 200; // transcript placeholder
      return sum + estimateTextTokens(JSON.stringify(part));
    }, 0);
  }
  return estimateTextTokens(JSON.stringify(content));
}

/**
 * Total estimated tokens for an array of messages.
 * Pads by 4/3 to stay conservative (matches source-code approach).
 */
export function estimateMessagesTokens(messages = []) {
  const raw = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  return Math.ceil(raw * (4 / 3));
}

// ─── Thresholds ────────────────────────────────────────────────────────────────

/** Trigger a full LLM compact when total history exceeds this. */
export const COMPACT_TRIGGER_TOKENS = 80_000;

/**
 * Maximum tokens sent in a single API request.
 * The sliding window never exceeds this budget.
 */
export const CONTEXT_WINDOW_TOKENS = 60_000;

/** Always preserve at least this many recent messages verbatim. */
export const COMPACT_KEEP_RECENT_MIN = 6;

/** Stop retrying compact after this many consecutive failures. */
export const MAX_COMPACT_FAILURES = 3;

// ─── Token-bounded sliding window ─────────────────────────────────────────────

/**
 * Returns the tail of `messages` that fits within `tokenBudget` tokens,
 * always keeping at least `minKeep` messages regardless of size.
 *
 * This replaces the old hard `slice(-12)`:  short conversations send their full
 * history; long ones are trimmed at the token boundary, not a fixed count.
 *
 * @param {Array}  messages
 * @param {number} [tokenBudget]  – default CONTEXT_WINDOW_TOKENS
 * @param {number} [minKeep]      – default COMPACT_KEEP_RECENT_MIN
 * @returns {Array}
 */
export function buildRecentWindow(
  messages = [],
  tokenBudget = CONTEXT_WINDOW_TOKENS,
  minKeep = COMPACT_KEEP_RECENT_MIN,
) {
  const all = messages;
  // Start from the minimum guaranteed tail and grow backwards.
  // Use raw (un-padded) per-message estimates throughout so the loop increment
  // is consistent with the initial used sum.  The caller-facing budget is
  // already expressed in conservative "final" tokens; dividing by (4/3) here
  // converts it to the same raw scale as estimateMessageTokens().
  const rawBudget = Math.floor(tokenBudget * (3 / 4));
  let start = Math.max(0, all.length - minKeep);
  let used = all.slice(start).reduce((s, m) => s + estimateMessageTokens(m), 0);

  while (start > 0) {
    const cost = estimateMessageTokens(all[start - 1]);
    if (used + cost > rawBudget) break;
    start--;
    used += cost;
  }

  return all.slice(start);
}

// ─── Should compact? ───────────────────────────────────────────────────────────

/**
 * Returns true when the full message history is large enough to warrant
 * an LLM-based compact.  Also respects the circuit-breaker failure count.
 *
 * @param {Array}  allMessages      – entire chat.messages array
 * @param {number} [compactFailures] – consecutive failures stored on chat
 */
export function shouldCompact(allMessages = [], compactFailures = 0) {
  if (compactFailures >= MAX_COMPACT_FAILURES) return false;
  return estimateMessagesTokens(allMessages) >= COMPACT_TRIGGER_TOKENS;
}

// ─── Compact system & user prompts ────────────────────────────────────────────

const COMPACT_SYSTEM_PROMPT =
  'You are a conversation summarizer. ' +
  'Your only task is to produce a concise, structured summary of the conversation provided. ' +
  'The summary will be injected as context at the start of a new request so the assistant ' +
  'can continue seamlessly. ' +
  'Do NOT include any preamble, sign-off, or meta-commentary — output ONLY the summary.';

function buildCompactUserPrompt(transcript, customInstructions = '') {
  let prompt =
    `Here is the conversation to summarise:\n\n${transcript}\n\n---\n\n` +
    `Create a detailed summary. Include these sections:\n\n` +
    `1. Primary Request and Intent: What the user has been asking for and their overall goal.\n` +
    `2. Key Facts and Decisions: Important information, technical details, names, dates, numbers, choices made.\n` +
    `3. What Was Accomplished: What has been done or resolved so far.\n` +
    `4. Pending / Unresolved Items: Anything the user asked about that has not been fully addressed.\n` +
    `5. Tone and Style Preferences: How the user likes to communicate and what they expect.\n` +
    `6. Recent Context: A brief description of the last 2–3 exchanges so the next response picks up naturally.\n\n` +
    `Be thorough for technical or multi-step conversations. Be concise for casual chats.`;

  if (customInstructions && customInstructions.trim()) {
    prompt += `\n\nAdditional summarisation instructions:\n${customInstructions}`;
  }

  return prompt;
}

// ─── Convert messages to a plain text transcript ──────────────────────────────
// The transcript is sent as a single user message so the Codex responses
// endpoint (which rejects multi-part audio/image blocks in old turns) handles
// it without issue.

function messagesToTranscript(messages = []) {
  return messages
    .filter(m => m?.role === 'user' || m?.role === 'assistant')
    .map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      let text = '';
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        text = m.content
          .filter(p => p?.type === 'text')
          .map(p => p.text || '')
          .join('\n');
      }
      text = text.trim();
      if (!text) return null;
      return `${role}: ${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

// ─── Run LLM compact ──────────────────────────────────────────────────────────

/**
 * Generate a structured summary of `messages` using the configured model.
 * Works with all three Melo auth modes: codex, api-key, local.
 *
 * The call is a fresh single-turn request (no streaming, no tool calls) so it
 * is safe even in Codex OAuth mode where multi-turn audio/image inputs are
 * rejected.
 *
 * @param {Array}  messages                  – full chat.messages to summarise
 * @param {Object} options
 * @param {Object} options.config            – resolved Melo config
 * @param {AbortSignal} [options.signal]     – optional abort
 * @param {string} [options.customInstructions]
 * @returns {Promise<string|null>}           – summary text or null on failure
 */
export async function compactConversation(messages = [], {
  config,
  signal,
  customInstructions,
} = {}) {
  if (!messages.length) return null;

  const transcript = messagesToTranscript(messages);
  if (!transcript.trim()) return null;

  // Offline-only mode: skip cloud LLMs entirely.  compactOffline tries every
  // local OAI-compatible endpoint in turn and falls back to a deterministic
  // rule summary if nothing is reachable.
  if (process.env.MELO_OFFLINE_ONLY === '1') {
    const summary = await compactOffline(messages, { config, signal });
    return summary && summary.trim() ? summary.trim() : null;
  }

  const userContent = buildCompactUserPrompt(transcript, customInstructions);

  try {
    const summary = await createOpenAICompatibleReply({
      authMode: config.authMode,
      apiKey: process.env.MELO_API_KEY || process.env.OPENAI_API_KEY || config.apiKey,
      baseUrl: process.env.MELO_BASE_URL || process.env.OPENAI_BASE_URL || config.baseUrl,
      model: process.env.MELO_COMPACT_MODEL || process.env.MELO_MODEL || config.model,
      systemPrompt: COMPACT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      signal,
      // No onDelta — we want the full text synchronously for reliable parsing.
      // providerProfile defaults to 'default' (not 'fast') so the summary is thorough.
    });

    if (typeof summary === 'string' && summary.trim()) return summary.trim();
  } catch {
    // Fall through to the offline path so a transient network blip never
    // makes the compact hard-fail.
  }

  // Cloud path didn't yield a summary — attempt the offline fallback so we
  // never return null when there is something worth summarising.
  const fallback = await compactOffline(messages, { config, signal });
  return fallback && fallback.trim() ? fallback.trim() : null;
}

// ─── Format compact summary for system prompt injection ───────────────────────

/**
 * Wraps the stored summary in a clearly-delimited block for insertion into
 * the system prompt.  Keeps the main system prompt uncluttered and makes the
 * boundary visible in debug output.
 *
 * @param {string} summary
 * @param {number} [compactedCount]  – how many messages are summarised
 * @returns {string}
 */
export function formatCompactContextBlock(summary, compactedCount) {
  const header = compactedCount
    ? `=== Previous Conversation Summary (${compactedCount} messages) ===`
    : '=== Previous Conversation Summary ===';

  return [
    header,
    summary.trim(),
    '=== End of Summary — continue the conversation from here ===',
  ].join('\n');
}
