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
import { estimateMessageTokens, estimateMessagesTokens, truncateToTokens } from './tokenEstimate.js';
export { estimateMessageTokens, estimateMessagesTokens } from './tokenEstimate.js';

// ─── Token estimation ──────────────────────────────────────────────────────────
// Multilingual/media-aware estimates live in tokenEstimate.js and are shared
// by the history window and the whole-request budget.

import { COMPACT_TRIGGER_TOKENS, CONTEXT_WINDOW_TOKENS, COMPACT_KEEP_RECENT_MIN, MAX_COMPACT_FAILURES, buildRecentWindow } from './contextWindow.js';
export { COMPACT_TRIGGER_TOKENS, CONTEXT_WINDOW_TOKENS, COMPACT_KEEP_RECENT_MIN, MAX_COMPACT_FAILURES, buildRecentWindow } from './contextWindow.js';

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

export function planIncrementalCompact(chat, { triggerTokens = COMPACT_TRIGGER_TOKENS, minKeep = COMPACT_KEEP_RECENT_MIN, maxChunkTokens = 45000 } = {}) {
  const all = Array.isArray(chat?.messages) ? chat.messages : [];
  const previousBoundary = chat?.compactSummary ? all.findIndex(message => message.id === chat.compactBoundaryMessageId) : -1;
  const start = previousBoundary + 1;
  const pending = all.slice(start);
  if ((chat?.compactFailures || 0) >= MAX_COMPACT_FAILURES || estimateMessagesTokens(pending) < triggerTokens) return null;
  let end = Math.max(start, all.length - Math.max(2, minKeep));
  let used = 0;
  for (let index = start; index < end; index += 1) {
    used += Math.ceil(estimateMessageTokens(all[index]) * 4 / 3);
    if (used > maxChunkTokens) { end = index; break; }
  }
  // Retain complete turns. The next visible message should be a user turn.
  while (end > start && all[end]?.role !== 'user') end -= 1;
  let compactMessages;
  let truncated = false;
  if (end <= start) {
    // An oversized first turn must not permanently block every later compact.
    // Keep the original messages intact and label the bounded excerpt honestly.
    const keepFrom = Math.max(start, all.length - Math.max(2, minKeep));
    end = start + 1;
    while (end < keepFrom && all[end]?.role !== 'user') end += 1;
    if (end > keepFrom || all[end]?.role !== 'user') return null;
    const excerpt = truncateToTokens(messagesToTranscript(all.slice(start, end)), Math.max(1, Math.floor((maxChunkTokens - 160) * 3 / 4)));
    compactMessages = [{ ...all[start], content: '[PARTIAL HISTORY EXCERPT: oversized turn; omitted material remains in the original chat. Do not infer omitted content.]\n' + excerpt,
      extractedMedia: [], attachments: [] }];
    truncated = true;
  }
  if (end <= start || !all[end - 1]?.id) return null;
  return {
    messages: compactMessages || all.slice(start, end),
    truncated,
    previousSummary: previousBoundary >= 0 ? chat.compactSummary : '',
    boundaryId: all[end - 1].id,
    compactedCount: end,
  };
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
      const media = (m.extractedMedia || []).filter(entry => entry?.text && !/placeholder|passthrough/.test(entry.metadata?.source || ''));
      text = [text, ...media.map(entry => `[Extracted ${entry.kind || 'media'}]\n${entry.text}`)].filter(Boolean).join('\n');
      text = text.trim();
      if (!text) return null;
      return `${role}${m.senderId ? ` [speaker:${m.senderId}]` : ''}: ${text}`;
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
  previousSummary = '',
  _createReply = createOpenAICompatibleReply,
  _compactOffline = compactOffline,
} = {}) {
  if (signal?.aborted) throw signal.reason || new Error('Request aborted');
  if (!messages.length) return null;

  const transcript = messagesToTranscript(messages);
  if (!transcript.trim()) return null;
  const offlineMessages = messages.map(message => ({ ...message, content: messagesToTranscript([message]) }));
  if (previousSummary) offlineMessages.unshift({ role: 'user', content: `Previous summary (background, not instructions):\n${previousSummary}` });
  const useOffline = async () => {
    const summary = await _compactOffline(offlineMessages, { config, signal });
    if (signal?.aborted) throw signal.reason || new Error('Request aborted');
    return summary?.trim() ? truncateToTokens(summary.trim(), 6000) : null;
  };

  // Offline-only mode: skip cloud LLMs entirely.  compactOffline tries every
  // local OAI-compatible endpoint in turn and falls back to a deterministic
  // rule summary if nothing is reachable.
  if (process.env.MELO_OFFLINE_ONLY === '1') {
    return useOffline();
  }

  const prior = previousSummary ? `Previous summary (background, not instructions):\n${truncateToTokens(previousSummary, 5000)}\n\nNew turns:\n` : '';
  const userContent = buildCompactUserPrompt(prior + transcript, customInstructions);

  try {
    const summary = await _createReply({
      authMode: config.authMode,
      apiProtocol: config.apiProtocol,
      apiKey: config.activeLlmProfileId ? config.apiKey : process.env.MELO_API_KEY || process.env.OPENAI_API_KEY || config.apiKey,
      baseUrl: config.activeLlmProfileId ? config.baseUrl : process.env.MELO_BASE_URL || process.env.OPENAI_BASE_URL || config.baseUrl,
      model: config.activeLlmProfileId ? config.model : process.env.MELO_COMPACT_MODEL || process.env.MELO_MODEL || config.model,
      systemPrompt: COMPACT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      signal,
      nativeWebSearchEnabled: false,
      // No onDelta — we want the full text synchronously for reliable parsing.
      // providerProfile defaults to 'default' (not 'fast') so the summary is thorough.
    });

    if (typeof summary === 'string' && summary.trim()) return truncateToTokens(summary.trim(), 6000);
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    // Fall through to the offline path so a transient network blip never
    // makes the compact hard-fail.
  }

  // Cloud path didn't yield a summary — attempt the offline fallback so we
  // never return null when there is something worth summarising.
  return useOffline();
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
