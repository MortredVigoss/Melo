/**
 * Offline-capable conversation compactor.
 *
 * Layered fallback:
 *   1. Local OAI-compatible LLM (Ollama / LM Studio / llama.cpp server)
 *   2. Pure rule-based TextRank summariser — no network, no LLM
 *
 * The rule fallback produces a shorter, less nuanced summary than an LLM but
 * guarantees that the compact path never hard-fails when the user is fully
 * offline.  It follows the same 6-section structure as the LLM prompt so the
 * downstream injection format stays identical.
 *
 * Exports:
 *   - compactOffline(messages, { config, signal }) → string | null
 *   - ruleBasedCompact(messages) → string
 *   - extractKeySentences(text, n) → string[]
 */

import { createOpenAICompatibleReply } from '../../openai.js';

const LOCAL_LLM_CANDIDATES = [
  // Order matters — first reachable endpoint wins.
  { name: 'ollama',    baseUrl: 'http://localhost:11434/v1' },
  { name: 'lmstudio',  baseUrl: 'http://localhost:1234/v1' },
  { name: 'llamacpp',  baseUrl: 'http://localhost:8080/v1' },
];

const LOCAL_LLM_MODEL = process.env.MELO_LOCAL_COMPACT_MODEL || 'qwen2.5:3b';
const LOCAL_LLM_TIMEOUT_MS = 15_000;
const RULE_SUMMARY_MAX_CHARS = 1200;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Produce a summary of `messages` without any cloud dependency.
 * Always returns a string (rule summary is the ultimate fallback).
 *
 * @param {Array<{role: string, content: any}>} messages
 * @param {Object} [options]
 * @param {Object} [options.config]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>}
 */
export async function compactOffline(messages = [], { config = {}, signal } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const transcript = messagesToTranscript(messages);
  if (!transcript.trim()) return '';

  // Try local LLM first — skip if MELO_OFFLINE_ONLY is set AND the user has
  // asked us not to touch any model.  (Local LLMs are still considered
  // "offline" by our definition.)
  if (process.env.MELO_OFFLINE_DISABLE_LLM !== '1') {
    for (const candidate of LOCAL_LLM_CANDIDATES) {
      try {
        const summary = await callLocalLlm(candidate, transcript, signal);
        if (summary && summary.trim()) return summary.trim();
      } catch {
        // try next candidate
      }
    }
  }

  // Rule-based fallback — deterministic and works with zero dependencies.
  return ruleBasedCompact(messages);
}

// ─── Local LLM path ──────────────────────────────────────────────────────────

async function callLocalLlm(candidate, transcript, signal) {
  // A lightweight liveness probe so we don't block the whole compact on a
  // dead port.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  try {
    const probe = await fetch(`${candidate.baseUrl}/models`, {
      signal: ac.signal,
    }).catch(() => null);
    if (!probe || !probe.ok) return null;
  } finally {
    clearTimeout(timer);
  }

  return createOpenAICompatibleReply({
    authMode: 'local',
    apiKey: 'sk-local-no-auth',
    baseUrl: candidate.baseUrl,
    model: LOCAL_LLM_MODEL,
    systemPrompt:
      'You are a terse conversation summariser. Output ONLY the summary, no preamble.',
    messages: [{ role: 'user', content: buildPrompt(transcript) }],
    signal,
    timeoutMs: LOCAL_LLM_TIMEOUT_MS,
  }).catch(() => null);
}

function buildPrompt(transcript) {
  return (
    `Summarise the conversation in 6 short sections — Primary Request, ` +
    `Key Facts, Accomplishments, Pending, Style, Recent Context. ` +
    `≤ 300 words total.\n\n${transcript}`
  );
}

// ─── Rule-based fallback ─────────────────────────────────────────────────────

/**
 * Deterministic summariser.  Picks a handful of "keystone" sentences using a
 * simplified TextRank (degree in the sentence-similarity graph) then bins
 * them into the same 6 sections the LLM prompt targets.
 *
 * This intentionally stays simple — ~80 LOC, no external deps.  It will miss
 * nuance but it will never crash and will always finish in O(n²) over the
 * sentence count (practically < 50ms for a typical compact window).
 *
 * @param {Array<{role, content}>} messages
 * @returns {string}
 */
export function ruleBasedCompact(messages = []) {
  const buckets = {
    request: [],
    facts: [],
    accomplished: [],
    pending: [],
    style: [],
    recent: [],
  };

  const sentences = messagesToSentences(messages);
  if (sentences.length === 0) return '';

  const keySentences = extractKeySentences(sentences.map(s => s.text).join(' '), 12);
  const keyLookup = new Set(keySentences.map(s => s.toLowerCase()));

  for (const { role, text } of sentences) {
    const lower = text.toLowerCase();
    const isKey = keyLookup.has(lower);

    // Lightweight category classifier — pure regex, no ML.
    if (/\?(?:[^?]*$|$)|request|please|help|能不能|可以吗|帮我/i.test(text) && role === 'user') {
      buckets.request.push(text);
    }
    if (/(decided|resolved|fixed|完成了|决定|搞定|done)/i.test(text)) {
      buckets.accomplished.push(text);
    }
    if (/(TODO|待办|pending|不确定|稍后|later|next step)/i.test(text)) {
      buckets.pending.push(text);
    }
    if (/(prefer|style|tone|喜欢|用中文|formal|concise|brief|simple)/i.test(text)) {
      buckets.style.push(text);
    }
    if (isKey) buckets.facts.push(text);
  }

  // Recent context = last 3 non-empty message texts.
  buckets.recent = sentences.slice(-3).map(s => `${s.role === 'user' ? 'U' : 'A'}: ${s.text}`);

  const lines = [
    '1. Primary Request and Intent:',
    ...pickLines(buckets.request, 3),
    '',
    '2. Key Facts and Decisions:',
    ...pickLines(buckets.facts, 6),
    '',
    '3. What Was Accomplished:',
    ...pickLines(buckets.accomplished, 3),
    '',
    '4. Pending / Unresolved Items:',
    ...pickLines(buckets.pending, 3),
    '',
    '5. Tone and Style Preferences:',
    ...pickLines(buckets.style, 2),
    '',
    '6. Recent Context:',
    ...pickLines(buckets.recent, 3),
  ];

  const joined = lines.join('\n');
  return joined.length > RULE_SUMMARY_MAX_CHARS
    ? joined.slice(0, RULE_SUMMARY_MAX_CHARS - 1) + '…'
    : joined;
}

function pickLines(items, limit) {
  const seen = new Set();
  const picked = [];
  for (const raw of items) {
    const trimmed = normaliseForBullet(raw);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    picked.push(`   - ${trimmed}`);
    if (picked.length >= limit) break;
  }
  if (picked.length === 0) return ['   - (none)'];
  return picked;
}

function normaliseForBullet(text = '') {
  const trimmed = String(text).replace(/\s+/g, ' ').trim();
  return trimmed.length > 180 ? trimmed.slice(0, 179) + '…' : trimmed;
}

// ─── Sentence-level TextRank ─────────────────────────────────────────────────

/**
 * Extract top-N keystone sentences from `text` using a lightweight
 * degree-based TextRank (build a sentence-overlap graph and rank each node
 * by its weighted degree).
 *
 * Exported for unit tests.
 *
 * @param {string} text
 * @param {number} n
 * @returns {string[]}
 */
export function extractKeySentences(text = '', n = 10) {
  const sentences = splitIntoSentences(text);
  if (sentences.length <= n) return sentences.slice();

  const tokenized = sentences.map(s => new Set(tokenize(s)));
  const scores = new Array(sentences.length).fill(0);

  for (let i = 0; i < sentences.length; i++) {
    for (let j = i + 1; j < sentences.length; j++) {
      const overlap = intersectionSize(tokenized[i], tokenized[j]);
      if (!overlap) continue;
      const norm =
        Math.log(tokenized[i].size + 1) + Math.log(tokenized[j].size + 1) + 1;
      const edgeWeight = overlap / norm;
      scores[i] += edgeWeight;
      scores[j] += edgeWeight;
    }
  }

  return sentences
    .map((text, idx) => ({ text, score: scores[idx], idx }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .sort((a, b) => a.idx - b.idx) // restore chronological order for readability
    .map(s => s.text);
}

function splitIntoSentences(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 8);
}

function tokenize(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

function intersectionSize(a, b) {
  // Iterate the smaller set for a minor speed win on unbalanced pairs.
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let n = 0;
  for (const v of small) if (big.has(v)) n++;
  return n;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function messagesToTranscript(messages) {
  return messages
    .filter(m => m?.role === 'user' || m?.role === 'assistant')
    .map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const text = flattenContent(m.content).trim();
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n\n');
}

function messagesToSentences(messages) {
  const out = [];
  for (const m of messages) {
    if (m?.role !== 'user' && m?.role !== 'assistant') continue;
    const text = flattenContent(m.content).trim();
    if (!text) continue;
    for (const s of splitIntoSentences(text)) {
      out.push({ role: m.role, text: s });
    }
  }
  return out;
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
