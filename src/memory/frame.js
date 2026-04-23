/**
 * Frame layer — the "picture" in the Scene → Frame → Content hierarchy.
 *
 * A frame is a small group of 3-5 consecutive turns within a single chat
 * that share a topic.  Each frame gets its own embedding so the model can
 * recall whole discussion slices at the picture granularity instead of
 * individual disconnected messages.
 *
 * Frame split boundaries (any one triggers a new frame):
 *   1. Gap > FRAME_GAP_MS (30 minutes) between adjacent turns.
 *   2. Cumulative user-turn count ≥ FRAME_MAX_USER_TURNS (5).
 *   3. Cumulative token count ≥ FRAME_MAX_TOKENS (2000).
 *   4. (Optional, when embeddings are available) topic drift:
 *      cosine(newTurnEmbedding, frameCentroid) < FRAME_DRIFT_COS (0.35).
 *      This is handled by the caller since we don't want frame.js to own
 *      embedding IO — splitFrames is pure.
 *
 * Frame payload text  (≤ 220 chars):
 *   "<start..end> • <user's opening question>  →  <assistant's wrap-up>"
 *
 * This file is pure — all DB writes happen in the caller (desktopStore's
 * buildMemoryStoreEntries or a worker).
 */

import { createHash } from 'node:crypto';
import { normalizeConversationSnippet } from './heuristics.js';

export const FRAME_GAP_MS = 30 * 60 * 1000;
export const FRAME_MAX_USER_TURNS = 5;
export const FRAME_MAX_TOKENS = 2000;
export const FRAME_DRIFT_COS = 0.35;
export const FRAME_MIN_TURNS = 2;

// ─── Token estimation (shared with contextCompact.js heuristic) ──────────────

function estimateTokens(text = '') {
  return Math.ceil(String(text || '').length / 4);
}

function flattenContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p?.type === 'text')
      .map(p => p.text || '')
      .join('\n');
  }
  return '';
}

function messageTimestamp(message) {
  const raw = message?.createdAt || message?.timestamp || message?.updatedAt;
  const ts = Date.parse(raw || '');
  return Number.isFinite(ts) ? ts : 0;
}

// ─── Pure split algorithm ────────────────────────────────────────────────────

/**
 * Split a chat's messages into frame windows.  Returns an array of
 *   { startIndex, endIndex, startAt, endAt, userTurns, tokens }
 *
 * Callers turn each window into a memory entry via `buildFrameEntry`.
 *
 * @param {Array}  messages   The chat's full messages array.
 * @param {Object} [options]
 * @param {number} [options.gapMs]        override FRAME_GAP_MS
 * @param {number} [options.maxUserTurns] override FRAME_MAX_USER_TURNS
 * @param {number} [options.maxTokens]    override FRAME_MAX_TOKENS
 * @returns {Array<{startIndex: number, endIndex: number, startAt: string, endAt: string, userTurns: number, tokens: number}>}
 */
export function splitFrames(messages = [], options = {}) {
  const gapMs = Number.isFinite(options.gapMs) ? options.gapMs : FRAME_GAP_MS;
  const maxUserTurns = Number.isFinite(options.maxUserTurns) ? options.maxUserTurns : FRAME_MAX_USER_TURNS;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : FRAME_MAX_TOKENS;

  const frames = [];
  let current = null;

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
      continue;
    }
    const ts = messageTimestamp(message);
    const tokens = estimateTokens(flattenContent(message.content));
    const isUser = message.role === 'user';

    if (!current) {
      current = openFrame(i, ts, isUser, tokens);
      continue;
    }

    const gap = ts && current.endTs ? ts - current.endTs : 0;
    const nextUserTurns = current.userTurns + (isUser ? 1 : 0);
    const nextTokens = current.tokens + tokens;

    const mustSplit =
      (gap > gapMs && ts > 0 && current.endTs > 0) ||
      nextUserTurns > maxUserTurns ||
      nextTokens > maxTokens;

    if (mustSplit && i - current.startIndex >= FRAME_MIN_TURNS) {
      frames.push(closeFrame(current, messages));
      current = openFrame(i, ts, isUser, tokens);
      continue;
    }

    current.endIndex = i;
    current.endTs = ts || current.endTs;
    current.userTurns = nextUserTurns;
    current.tokens = nextTokens;
  }

  if (current && current.endIndex >= current.startIndex) {
    frames.push(closeFrame(current, messages));
  }

  return frames;
}

function openFrame(index, ts, isUser, tokens) {
  return {
    startIndex: index,
    endIndex: index,
    startTs: ts,
    endTs: ts,
    userTurns: isUser ? 1 : 0,
    tokens,
  };
}

function closeFrame(frame, messages) {
  const start = messages[frame.startIndex];
  const end = messages[frame.endIndex];
  return {
    startIndex: frame.startIndex,
    endIndex: frame.endIndex,
    startAt: messageTimestamp(start)
      ? new Date(messageTimestamp(start)).toISOString()
      : null,
    endAt: messageTimestamp(end)
      ? new Date(messageTimestamp(end)).toISOString()
      : null,
    userTurns: frame.userTurns,
    tokens: frame.tokens,
  };
}

// ─── Frame → memory entry ────────────────────────────────────────────────────

/**
 * Build a memory-store entry for a single frame.
 * Callers pass the chat + the frame window produced by splitFrames.
 *
 * @param {Object} chat
 * @param {Object} frame  one element of splitFrames output
 * @param {Object} [options]
 * @param {string} [options.sceneId]   parent scene id (may be null; filled later)
 * @returns {Object|null} entry ready for replaceMemories/upsertMemory
 */
export function buildFrameEntry(chat, frame, options = {}) {
  const { sceneId = null } = options;
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const slice = messages.slice(frame.startIndex, frame.endIndex + 1);

  // Collect participants & topic words.
  const participants = new Set();
  const openingQuestion = findOpening(slice);
  const wrapUp = findWrapUp(slice);

  for (const m of slice) {
    if (m?.role === 'user') {
      const label = m.senderName || m.senderUsername || m.senderId;
      if (label) participants.add(String(label));
    }
  }

  const participantList = Array.from(participants);
  const topicTags = topTopicTokens(slice, 3);

  const summaryText = [
    openingQuestion ? normalizeConversationSnippet(openingQuestion, 110) : '',
    wrapUp ? normalizeConversationSnippet(wrapUp, 110) : '',
  ].filter(Boolean).join(' → ');

  if (!summaryText) return null;

  // Stable frame id: hash of (chatId, startAt, endAt) — the "time window"
  // identity of the frame.  This is deliberately *not* keyed on message
  // indices so that when the chat gets re-indexed (new message inserted,
  // older turns pruned, etc.) the same slice still hashes to the same id,
  // preserving attic level, useCount, mergedFrom history and hit log.
  //
  // Fallback: if the window lacks startAt/endAt (edge case in tests with
  // timestampless messages), fall back to the old position-based scheme so
  // callers never get an empty id.
  const frameId = buildFrameId(chat, frame);
  const now = new Date().toISOString();

  return {
    id: frameId,
    namespace: chat?.id ? `chat:${chat.id}` : '',
    kind: 'frame',
    sourceId: null,
    text: summaryText,
    searchText: summaryText.toLowerCase(),
    tokensEstimate: Math.ceil(summaryText.length / 4),
    createdAt: frame.startAt || now,
    updatedAt: frame.endAt || now,
    lastUsedAt: null,
    metadata: {
      sceneId,
      frameId,
      participants: participantList,
      topicTags,
      startAt: frame.startAt,
      endAt: frame.endAt,
      userTurns: frame.userTurns,
      tokens: frame.tokens,
      chatId: chat?.id || null,
    },
  };
}

/**
 * Produce a stable id for a frame window.  Exposed for tests — callers should
 * rely on buildFrameEntry instead.
 */
export function buildFrameId(chat, frame) {
  const chatId = chat?.id || 'unknown';
  if (frame?.startAt && frame?.endAt) {
    const digest = createHash('sha1')
      .update(`${chatId}\u241E${frame.startAt}\u241E${frame.endAt}`)
      .digest('hex')
      .slice(0, 16);
    return `frame:${chatId}:${digest}`;
  }
  return `frame:${chatId}:${frame?.startIndex ?? 'na'}-${frame?.endIndex ?? 'na'}`;
}

function findOpening(slice) {
  for (const m of slice) {
    if (m?.role !== 'user') continue;
    const text = flattenContent(m.content).trim();
    if (text) return text.slice(0, 220);
  }
  return '';
}

function findWrapUp(slice) {
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    const m = slice[i];
    if (m?.role !== 'assistant') continue;
    const text = flattenContent(m.content).trim();
    if (text) return text.slice(0, 220);
  }
  return '';
}

/**
 * Return the most frequent "content words" across the frame's messages.
 * Exported for unit tests.
 */
export function topTopicTokens(slice, n = 3) {
  const counts = new Map();
  const stop = STOPWORDS;

  for (const m of slice) {
    const text = flattenContent(m?.content);
    if (!text) continue;
    const tokens = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3 && !stop.has(t));
    for (const t of tokens) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([tok]) => tok);
}

// Lightweight English stopword list.  CJK text naturally skips this because
// Chinese characters aren't in this set — the CJK tokens still count.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your',
  'this', 'that', 'with', 'from', 'have', 'has', 'was', 'were',
  'will', 'would', 'can', 'could', 'should', 'just', 'only',
  'what', 'when', 'where', 'which', 'who', 'why', 'how',
  'okay', 'yes', 'yeah', 'sure', 'thanks', 'please', 'about',
  'some', 'any', 'all', 'there', 'here', 'they', 'them', 'their',
]);
