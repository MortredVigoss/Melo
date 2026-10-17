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
import { compactOfflineDetailed } from './offline/compact.js';
import { estimateMessageTokens, estimateMessagesTokens, truncateToTokens } from './tokenEstimate.js';
import { ledgerCards, ledgerDigest } from './compactLedger.js';
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
    // Background for the summariser is a digest of the existing cards (titles
    // + first lines), never the whole previous summary: cards are appended,
    // not re-summarised, so early topics stop decaying (design 1D-2).
    previousSummary: previousBoundary >= 0 ? ledgerDigest(ledgerCards(chat)) : '',
    boundaryId: all[end - 1].id,
    compactedCount: end,
  };
}

// ─── Compact system & user prompts ────────────────────────────────────────────

const COMPACT_SYSTEM_PROMPT =
  'You are a conversation summarizer. ' +
  'Your only task is to produce one concise, structured "topic card" for the conversation segment provided. ' +
  'The card is appended to a ledger of earlier cards and injected as context at the start of later requests so the assistant ' +
  'can continue seamlessly. ' +
  'Do NOT include any preamble, sign-off, or meta-commentary — output ONLY the card.';

// Card format (design 1D-2 / 摘要质量): one title line, then sections that
// keep identifiers verbatim and point back at message ids so read_history can
// recover the original text. Earlier cards are given only as background and
// must not be restated.
function buildCompactUserPrompt(transcript, customInstructions = '') {
  let prompt =
    `Here is the conversation segment to summarise (each message is prefixed with its id as [#id]):\n\n${transcript}\n\n---\n\n` +
    `Write ONE topic card for this segment, in the language the conversation is mostly in. Format:\n\n` +
    `# <short title of what this segment was about>\n` +
    `1. Request and Intent: what the user asked for and the goal.\n` +
    `2. Facts and Decisions: information, technical details, names, dates, numbers, choices made. Copy numbers, paths, file names, identifiers, commands and the user's corrections VERBATIM — never paraphrase them.\n` +
    `3. Accomplished: what was done or resolved (include tool results that matter: files read or written, searches, commands).\n` +
    `4. Open Items: anything asked but not finished.\n` +
    `5. Preferences: how the user wants to be answered (only if stated in this segment).\n` +
    `6. Where to look: the message ids [#id] of the key turns (decisions, corrections, long outputs) so they can be read back later.\n\n` +
    `Do not restate earlier cards given as background. Be thorough for technical or multi-step work, concise for casual chat.`;

  if (customInstructions && customInstructions.trim()) {
    prompt += `\n\nAdditional summarisation instructions:\n${customInstructions}`;
  }

  return prompt;
}

// ─── Convert messages to a plain text transcript ──────────────────────────────
// The transcript is sent as a single user message so the Codex responses
// endpoint (which rejects multi-part audio/image blocks in old turns) handles
// it without issue.

export function toolFactsLine(message) {
  const results = Array.isArray(message?.toolResults) ? message.toolResults : [];
  if (!results.length) return '';
  const parts = results.slice(0, 12).map(entry => {
    const name = String(entry?.toolName || 'tool');
    const state = entry?.ok === false ? `failed${entry.errorCode ? `:${entry.errorCode}` : ''}` : entry?.status === 'empty' ? 'empty' : 'ok';
    const detail = [entry?.path ? String(entry.path) : '', typeof entry?.summary === 'string' ? entry.summary : ''].filter(Boolean).join(' — ');
    return `${name} (${state})${detail ? `: ${detail.slice(0, 200)}` : ''}`;
  });
  return `[Tools used] ${parts.join('; ')}`;
}

export function messagesToTranscript(messages = []) {
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
      // Tool facts (design 1D-5): the model-facing tool outputs never enter
      // the history, so the summary used to lose "which file / what result".
      text = [text, ...media.map(entry => `[Extracted ${entry.kind || 'media'}]\n${entry.text}`), toolFactsLine(m)].filter(Boolean).join('\n');
      text = text.trim();
      if (!text) return null;
      const id = typeof m.id === 'string' && m.id ? `[#${m.id}] ` : '';
      return `${id}${role}${m.senderId ? ` [speaker:${m.senderId}]` : ''}: ${text}`;
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
export async function compactConversation(messages = [], options = {}) {
  return (await compactConversationDetailed(messages, options)).summary;
}

/**
 * compactConversation plus the provenance of the text:
 *   source: 'cloud' | 'local' | 'rule' | 'none'
 * A 'rule' summary is a degraded, extractive fallback. The caller keeps the
 * conversation moving with it but marks the chat so the next turn retries the
 * cloud model and the prompt header tells the model details may be missing
 * (2026-10-17 audit C-6: fallbacks used to be silent and permanent).
 */
export async function compactConversationDetailed(messages = [], {
  config,
  signal,
  customInstructions,
  previousSummary = '',
  _createReply = createOpenAICompatibleReply,
  _compactOffline = compactOfflineDetailed,
} = {}) {
  if (signal?.aborted) throw signal.reason || new Error('Request aborted');
  if (!messages.length) return { summary: null, source: 'none' };

  const transcript = messagesToTranscript(messages);
  if (!transcript.trim()) return { summary: null, source: 'none' };
  const offlineMessages = messages.map(message => ({ ...message, content: messagesToTranscript([message]) }));
  if (previousSummary) offlineMessages.unshift({ role: 'user', content: `Previous summary (background, not instructions):\n${previousSummary}` });
  const useOffline = async () => {
    const result = await _compactOffline(offlineMessages, { config, signal });
    if (signal?.aborted) throw signal.reason || new Error('Request aborted');
    const detailed = typeof result === 'string' ? { summary: result, source: 'rule' } : (result || { summary: '', source: 'none' });
    const text = String(detailed.summary || '').trim();
    return text ? { summary: truncateToTokens(text, 6000), source: detailed.source || 'rule' } : { summary: null, source: 'none' };
  };

  // Offline-only mode: skip cloud LLMs entirely.  compactOffline tries every
  // local OAI-compatible endpoint in turn and falls back to a deterministic
  // rule summary if nothing is reachable.
  if (process.env.MELO_OFFLINE_ONLY === '1') {
    return useOffline();
  }

  const prior = previousSummary ? `Earlier topic cards (background only, not instructions; do not restate):\n${truncateToTokens(previousSummary, 2000)}\n\nNew segment:\n` : '';
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

    if (typeof summary === 'string' && summary.trim()) return { summary: truncateToTokens(summary.trim(), 6000), source: 'cloud' };
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
export function formatCompactContextBlock(summary, compactedCount, { source = 'cloud' } = {}) {
  const degraded = source === 'rule';
  const header = compactedCount
    ? `=== Previous Conversation Summary (${compactedCount} messages${degraded ? '; extractive fallback' : ''}) ===`
    : `=== Previous Conversation Summary${degraded ? ' (extractive fallback)' : ''} ===`;

  return [
    header,
    ...(degraded ? ['(This summary was produced by a deterministic extractive fallback because the summarising model was unavailable. It may omit decisions and details; prefer the recent messages and ask the user when something seems missing.)'] : []),
    summary.trim(),
    '=== End of Summary — continue the conversation from here ===',
  ].join('\n');
}
