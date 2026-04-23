/**
 * Session memory extractor.
 *
 * Continuously extracts durable facts from conversation turns so the
 * model has a growing "background knowledge" file about the user and
 * their projects.  Unlike the context compact (which summarises the
 * recent conversation), session memory is additive: new facts are
 * merged with existing ones across sessions.
 *
 * Implementation:
 *   - After every N assistant turns, extract new facts from the last
 *     few exchanges using a lightweight LLM call.
 *   - Facts are stored per-chat in the chat object as `sessionMemory`:
 *     an array of { fact, category, extractedAt }.
 *   - On the next request, the top MEMORY_INJECT_LIMIT facts (most recent
 *     + highest-priority categories) are injected into the system prompt.
 *
 * Categories:
 *   user_preference  – how the user likes to work
 *   project_context  – facts about the current project
 *   technical_detail – important technical details (stack, versions, patterns)
 *   decision         – explicit decisions the user has made
 *   correction       – things the model got wrong (high priority to inject)
 */

import { createOpenAICompatibleReply } from '../openai.js';
import { extractFactsRuleBased } from './offline/extractor.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Extract memory after every this many assistant turns. */
export const MEMORY_EXTRACT_INTERVAL = 4;

/** Maximum facts injected into system prompt per request. */
export const MEMORY_INJECT_LIMIT = 12;

/** Maximum total stored facts per chat. */
export const MEMORY_MAX_STORED = 80;

/** Minimum messages in the window to attempt extraction. */
const MEMORY_EXTRACTION_MIN_MESSAGES = 6;

// ─── Extraction ───────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `\
You are a memory extraction assistant. Given a conversation excerpt, extract discrete, reusable facts.

Return ONLY a valid JSON array. Each item must have:
  - "fact": a single, specific, self-contained statement (≤80 chars)
  - "category": one of: user_preference, project_context, technical_detail, decision, correction

Only extract facts that would be useful in a future turn. Skip conversational filler.
If nothing is worth remembering, return [].

Example:
[
  {"fact": "User prefers TypeScript over JavaScript", "category": "user_preference"},
  {"fact": "Project uses bun instead of npm", "category": "technical_detail"}
]`;

/**
 * Extract memory facts from recent messages.
 *
 * @param {Array}  messages     - recent { role, content } messages
 * @param {Object} config       - resolved Melo config
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ fact: string, category: string }>>}
 */
export async function extractMemoryFacts(messages, { config, signal } = {}) {
  if (!messages || messages.length < MEMORY_EXTRACTION_MIN_MESSAGES) return [];

  // Offline path: rule-based extractor only, no network.
  if (process.env.MELO_OFFLINE_ONLY === '1') {
    return extractFactsRuleBased(messages);
  }

  // Build a short transcript of the most recent exchanges
  const transcript = messages
    .filter(m => m?.role === 'user' || m?.role === 'assistant')
    .slice(-12)
    .map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const content = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n')
          : '';
      return `${role}: ${content.slice(0, 400)}`;
    })
    .join('\n\n');

  if (!transcript.trim()) return [];

  try {
    const raw = await createOpenAICompatibleReply({
      authMode: config.authMode,
      apiKey: process.env.MELO_API_KEY || process.env.OPENAI_API_KEY || config.apiKey,
      baseUrl: process.env.MELO_BASE_URL || process.env.OPENAI_BASE_URL || config.baseUrl,
      model: process.env.MELO_COMPACT_MODEL || process.env.MELO_MODEL || config.model,
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Extract memory facts from:\n\n${transcript}` }],
      signal,
    });

    if (!raw?.trim()) return extractFactsRuleBased(messages);

    // Parse JSON — the model should return only an array
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return extractFactsRuleBased(messages);
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return extractFactsRuleBased(messages);

    const llmFacts = parsed
      .filter(item => typeof item?.fact === 'string' && item.fact.trim())
      .map(item => ({
        fact: item.fact.trim().slice(0, 120),
        category: String(item.category || 'technical_detail').toLowerCase(),
      }));

    // Union with the rule-based extractor — the dedupe in mergeMemoryFacts
    // will drop any overlap.  This catches obvious facts (version numbers,
    // "I prefer X") that an LLM sometimes skips.
    const ruleFacts = extractFactsRuleBased(messages);
    const seen = new Set(llmFacts.map(f => f.fact.toLowerCase()));
    for (const f of ruleFacts) {
      if (!seen.has(f.fact.toLowerCase())) llmFacts.push(f);
    }
    return llmFacts;
  } catch {
    // If the LLM path explodes, still surface whatever the rule extractor
    // found — better than returning [] and losing the signal entirely.
    return extractFactsRuleBased(messages);
  }
}

// ─── Merge + deduplicate ─────────────────────────────────────────────────────

/**
 * Merge new facts into the existing stored facts array.
 * Deduplicates by exact fact string, caps at MEMORY_MAX_STORED.
 *
 * Each fact carries temporal validity fields so downstream layers can
 * reason about whether a fact is still current:
 *   - validFrom : ISO timestamp the fact was first extracted
 *   - validTo   : ISO timestamp it was invalidated, or null while active
 *
 * A new `correction` fact invalidates every previous active correction —
 * an explicit user override retires whatever was corrected before it.  The
 * same rule applies to `identity` facts sharing an attribute prefix (e.g.
 * a new `Role:` fact retires the prior active `Role:` fact, but not the
 * active `Name:` fact).
 *
 * @param {Array} existing   - current stored facts
 * @param {Array} newFacts   - freshly extracted facts
 * @returns {Array}
 */
function identityAttrPrefix(text = '') {
  const m = String(text || '').match(/^\s*([A-Za-z][A-Za-z\s]{0,24}?)\s*[:：]/);
  return m?.[1]?.trim().toLowerCase() || '';
}

export function mergeMemoryFacts(existing = [], newFacts = []) {
  const seen = new Set(existing.map(f => f.fact.toLowerCase()));
  const now = new Date().toISOString();
  const merged = existing.map(f => ({ ...f }));

  for (const f of newFacts) {
    const key = f.fact.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);

    if (f.category === 'correction') {
      for (const prior of merged) {
        if (!prior.validTo && prior.category === 'correction') {
          prior.validTo = now;
        }
      }
    }

    // Identity supersession: a new "Role: X" retires prior active "Role: *"
    // facts; "Name: …" doesn't touch them.  The attribute prefix is parsed
    // from the fact text, so senders don't need to opt in explicitly.
    if (f.category === 'identity') {
      const attr = identityAttrPrefix(f.fact);
      if (attr) {
        for (const prior of merged) {
          if (prior.validTo) continue;
          if (prior.category !== 'identity') continue;
          if (identityAttrPrefix(prior.fact) === attr) prior.validTo = now;
        }
      }
    }

    merged.push({
      ...f,
      extractedAt: now,
      validFrom: now,
      validTo: null,
    });
  }

  // Keep most recent, capped at max
  return merged.slice(-MEMORY_MAX_STORED);
}

/**
 * Return only facts that are still active (validTo is null/undefined or
 * in the future).  Back-compat: facts written before the temporal-validity
 * change have no validTo and pass through unchanged.
 */
export function filterActiveFacts(facts = [], nowMs = Date.now()) {
  return facts.filter(f => {
    if (!f?.validTo) return true;
    const ts = Date.parse(f.validTo);
    return !Number.isFinite(ts) || ts > nowMs;
  });
}

// ─── Injection ────────────────────────────────────────────────────────────────

const CATEGORY_PRIORITY = {
  correction: 0,
  decision: 1,
  user_preference: 2,
  project_context: 3,
  technical_detail: 4,
};

/**
 * Select and format the top facts for injection into the system prompt.
 *
 * @param {Array}  facts   - stored facts
 * @param {number} [limit] - max facts to inject
 * @returns {string}  - formatted section or ''
 */
export function formatSessionMemoryBlock(facts = [], limit = MEMORY_INJECT_LIMIT) {
  if (!facts.length) return '';

  // Temporal-validity gate: never inject invalidated facts even if they
  // somehow slipped past upstream filtering.
  const active = filterActiveFacts(facts);
  if (!active.length) return '';

  // Sort by category priority, then by recency
  const sorted = [...active].sort((a, b) => {
    const pa = CATEGORY_PRIORITY[a.category] ?? 5;
    const pb = CATEGORY_PRIORITY[b.category] ?? 5;
    if (pa !== pb) return pa - pb;
    return new Date(b.extractedAt || 0).getTime() - new Date(a.extractedAt || 0).getTime();
  });

  const selected = sorted.slice(0, limit);

  const lines = ['## Session Memory (persistent facts from prior turns)'];
  for (const f of selected) {
    lines.push(`- [${f.category}] ${f.fact}`);
  }
  lines.push('(Use these facts to avoid repeating questions or making known mistakes.)');

  return lines.join('\n');
}

// ─── Auto-extract hook ────────────────────────────────────────────────────────

/**
 * Decide whether to run memory extraction now.
 * Triggers every MEMORY_EXTRACT_INTERVAL assistant messages.
 *
 * @param {Object} chat       - chat record
 * @returns {boolean}
 */
export function shouldExtractMemory(chat) {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const assistantCount = messages.filter(m => m?.role === 'assistant').length;
  const lastExtractedAt = chat.memoryLastExtractedAt || 0;
  const lastExtractedCount = chat.memoryLastExtractedAtCount || 0;

  return (
    assistantCount >= MEMORY_EXTRACT_INTERVAL &&
    assistantCount - lastExtractedCount >= MEMORY_EXTRACT_INTERVAL
  );
}

/**
 * Run memory extraction and merge results into the chat object.
 * Mutates chat in-place. Safe to call; returns false on failure.
 *
 * @param {Object} chat
 * @param {Object} options
 * @param {Object} options.config
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<boolean>}
 */
export async function maybeExtractSessionMemory(chat, { config, signal } = {}) {
  if (!shouldExtractMemory(chat)) return false;

  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const assistantCount = messages.filter(m => m?.role === 'assistant').length;

  try {
    const newFacts = await extractMemoryFacts(messages, { config, signal });
    if (newFacts.length) {
      const existing = Array.isArray(chat.sessionMemory) ? chat.sessionMemory : [];
      chat.sessionMemory = mergeMemoryFacts(existing, newFacts);
    }
    chat.memoryLastExtractedAt = Date.now();
    chat.memoryLastExtractedAtCount = assistantCount;
    return true;
  } catch {
    return false;
  }
}
