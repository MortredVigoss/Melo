/**
 * speakerProfile.js
 *
 * Algorithmic compaction of enumerated speaker facts into a short profile
 * block.  Used by the prompt builder when a speaker has accumulated enough
 * facts that the raw bulleted list starts wasting tokens (typical in long
 * Telegram DMs that never rotate through channel).
 *
 * Facts come from `extractSpeakerFacts` with shape
 *   { category, text, metadata? }
 * where `text` is pre-formatted like `"Role: data scientist"` / `"Likes: coffee"`.
 *
 * Design choices:
 *   - Synchronous & deterministic.  No LLM call in the hot prompt path —
 *     the gain from natural-language synthesis is small compared to the
 *     latency/cost/fragility of an extra inference per turn.
 *   - Singleton categories (name/role/location/work) collapse to the most
 *     recent/relevant value; multi-value categories (preference/likes)
 *     are deduplicated and joined.
 *   - All thresholds exported so callers and tests can introspect.
 */

const SINGLETON_CATEGORIES = ['name', 'role', 'location', 'work'];
const MULTI_CATEGORIES = ['preference', 'likes'];
const ALL_CATEGORIES = [...SINGLETON_CATEGORIES, ...MULTI_CATEGORIES];

/** Cap per multi-value category when rendering the profile line. */
const MULTI_CATEGORY_LIMIT = 6;

/**
 * Minimum number of enumerated facts before we prefer the condensed profile
 * block over the raw bulleted list.  Tuned against `recallMemories(..., limit: 8)`
 * for the speaker fact namespace — once ~6/8 slots are filled, grouping wins.
 */
export const SPEAKER_PROFILE_COMPACT_THRESHOLD = 6;

const CATEGORY_PREFIX_PATTERNS = {
  name: /^Name:\s*/i,
  role: /^Role:\s*/i,
  location: /^Location:\s*/i,
  work: /^Works?\s+(?:at|on):\s*/i,
  preference: /^Prefers(?:\s+[^:]+)?:\s*/i,
  likes: /^Likes:\s*/i,
};

function stripCategoryPrefix(text, category) {
  const re = CATEGORY_PREFIX_PATTERNS[category];
  const raw = String(text || '').trim();
  if (!raw) return '';
  return re ? raw.replace(re, '').trim() : raw;
}

/**
 * Decide whether the enumerated fact list is long enough that emitting a
 * condensed profile block will improve prompt efficiency.
 */
export function shouldCompactSpeakerFacts(facts = []) {
  return Array.isArray(facts) && facts.length >= SPEAKER_PROFILE_COMPACT_THRESHOLD;
}

function resolveFactCategory(fact) {
  return String(fact?.category || fact?.metadata?.category || '').toLowerCase();
}

/**
 * Build a list of category-grouped lines.  Returns an empty array when there
 * is nothing meaningful to emit (caller decides how to render).
 *
 * @param {Array<{category: string, text: string, metadata?: any}>} facts
 * @returns {string[]}
 */
export function buildSpeakerProfileLines(facts = []) {
  const grouped = new Map();
  for (const category of ALL_CATEGORIES) grouped.set(category, []);

  for (const fact of facts) {
    const category = resolveFactCategory(fact);
    if (!grouped.has(category)) continue;
    const value = stripCategoryPrefix(fact?.text || '', category);
    if (!value) continue;
    const bucket = grouped.get(category);
    if (bucket.some(existing => existing.toLowerCase() === value.toLowerCase())) continue;
    bucket.push(value);
  }

  const lines = [];

  for (const category of SINGLETON_CATEGORIES) {
    const [first] = grouped.get(category);
    if (!first) continue;
    const label = category === 'work'
      ? 'Works at/on'
      : category.charAt(0).toUpperCase() + category.slice(1);
    lines.push(`${label}: ${first}`);
  }

  for (const category of MULTI_CATEGORIES) {
    const values = grouped.get(category).slice(0, MULTI_CATEGORY_LIMIT);
    if (!values.length) continue;
    // `preference` renders as "Prefers: …" to read naturally as a sentence;
    // `likes` is already the verbed form.
    const label = category === 'preference'
      ? 'Prefers'
      : category.charAt(0).toUpperCase() + category.slice(1);
    lines.push(`${label}: ${values.join(', ')}`);
  }

  return lines;
}

/**
 * Build a single-line identity summary from the singleton categories only.
 *
 * Intended as an L0-cheap always-injected header: "Alice — data scientist
 * · Shanghai · Acme Corp".  Returns '' when no singleton fact is known.
 *
 * Useful to keep at the top of the system prompt even when the full facts
 * block is suppressed for token-budget reasons.
 *
 * @param {Array} facts
 * @param {{ label?: string }} [options]
 * @returns {string}
 */
export function buildIdentityLine(facts = [], { label } = {}) {
  const grouped = new Map();
  for (const category of SINGLETON_CATEGORIES) grouped.set(category, null);

  for (const fact of facts) {
    const category = resolveFactCategory(fact);
    if (!grouped.has(category) || grouped.get(category)) continue; // keep first
    const value = stripCategoryPrefix(fact?.text || '', category);
    if (value) grouped.set(category, value);
  }

  const parts = [];
  for (const category of SINGLETON_CATEGORIES) {
    const value = grouped.get(category);
    if (value) parts.push(value);
  }
  if (!parts.length) return '';

  const joined = parts.join(' · ');
  return label ? `${label} — ${joined}` : joined;
}

/**
 * Render the full profile block for a speaker namespace.
 * Returns '' when there is nothing to emit so the caller can fall back to
 * the raw enumerated list if desired.
 *
 * @param {Array} facts
 * @param {{ label?: string }} [options]
 * @returns {string}
 */
export function buildSpeakerProfileBlock(facts = [], { label } = {}) {
  const lines = buildSpeakerProfileLines(facts);
  if (!lines.length) return '';

  const header = label
    ? `Speaker profile (${label}) — condensed from ${facts.length} fact nodes:`
    : `Speaker profile — condensed from ${facts.length} fact nodes:`;

  return `${header}\n${lines.map(line => `- ${line}`).join('\n')}`;
}
