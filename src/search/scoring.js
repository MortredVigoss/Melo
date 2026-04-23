import {
  codeUnitIndexToGraphemeIndex,
  normalizeSearchValue,
  sliceByGrapheme,
  splitGraphemes,
  tokenizeHaystack,
  tokenizeQuery,
} from './tokenizer.js';

export { normalizeSearchValue };

// ─── Scoring weights (named constants) ───────────────────────────────────────
// Every magic number in the scorer is named here.  Tweaks (re-calibration on
// telemetry, A/B, or manual tuning) happen in one place.  The hierarchy is
// intentional: exact > prefix > contains > token-contains > token-fuzzy >
// grapheme > raw-fallback.  The "position divisor" constants control how
// quickly a match buried deep in a haystack is penalised.
// ─────────────────────────────────────────────────────────────────────────────
export const SEARCH_WEIGHTS = Object.freeze({
  // fuzzySubsequenceScore base (before gap + length penalties).
  FUZZY_BASE: 140,
  // Whole-haystack equality.
  EXACT_MATCH: 1200,
  // Haystack starts with the raw query.
  PREFIX_MATCH: 880,
  // Haystack contains the raw query: floor → ceiling.
  CONTAINS_CEILING: 760,
  CONTAINS_FLOOR: 420,
  CONTAINS_POSITION_DIVISOR: 3,
  // Per-token contains: floor → ceiling.
  TOKEN_CEILING: 240,
  TOKEN_FLOOR: 90,
  TOKEN_POSITION_DIVISOR: 5,
  // Per-token subsequence bonus (only if token contains missed).
  TOKEN_SUBSEQUENCE_BONUS: 120,
  // Per-grapheme CJK presence.
  GRAPHEME_PRESENCE: 24,
  // Fallback: raw query as a full subsequence match.
  RAW_SUBSEQUENCE_FALLBACK: 160,
  // Length-of-haystack bonus ceiling (shorter haystacks rank higher).
  LENGTH_BONUS_CEILING: 90,
  LENGTH_BONUS_DIVISOR: 10,
});

// Snippet-builder tuning.
const SNIPPET_CONTEXT_LEAD_RATIO = 0.32;

// ─── LRU cache ───────────────────────────────────────────────────────────────
// Typing into the search box re-runs fuzzySearchScore against every candidate
// row on every keystroke.  For a 2 000-row workspace the scorer dominates the
// keystroke latency budget.  A small LRU (default 512 entries) keyed on
// (query, haystack) short-circuits the repeat work without growing unbounded.
//
// Insertion order of a Map is the eviction order, which gives us LRU for free:
// `get` removes-and-re-inserts on hit, and we evict the oldest when size goes
// over the cap.  Exported `_clearFuzzyCache` exists for tests that want a
// clean slate between runs.
// ─────────────────────────────────────────────────────────────────────────────
const FUZZY_CACHE_CAPACITY = 512;
const _fuzzyCache = new Map();

export function _clearFuzzyCache() {
  _fuzzyCache.clear();
}

export function isSubsequenceMatch(text = '', query = '') {
  let queryIndex = 0;
  for (let index = 0; index < text.length && queryIndex < query.length; index += 1) {
    if (text[index] === query[queryIndex]) {
      queryIndex += 1;
    }
  }
  return queryIndex === query.length;
}

/**
 * Shared parametric fuzzy subsequence scorer used by both search and memory.
 * Both domains need the same "chars appear in order, penalise gaps + length"
 * core; they differ only in `base` (search=140, memory=100 because memory
 * multiplies the output by a 0.4 recency factor downstream).
 *
 * Exported so src/memory/store.js can stop duplicating the algorithm.  The
 * Bug 5 noise-floor removal (`Math.max(0, …)` with no hard floor) is baked in
 * here so both sides inherit the fix automatically.
 *
 * @param {string} query
 * @param {string} target
 * @param {{ base?: number }} [options]
 */
export function scoreFuzzySubsequence(query, target, { base = SEARCH_WEIGHTS.FUZZY_BASE } = {}) {
  if (!query || !target) {
    return 0;
  }
  // Bug 5 (P1): single-character subsequence matches are pure noise — every
  // query letter trivially appears somewhere in any long target.  Require at
  // least two characters before awarding any score.
  if (query.length < 2) {
    return 0;
  }

  let searchIndex = 0;
  let gapPenalty = 0;

  for (const char of query) {
    const foundAt = target.indexOf(char, searchIndex);
    if (foundAt === -1) {
      return 0;
    }
    gapPenalty += Math.max(0, foundAt - searchIndex);
    searchIndex = foundAt + 1;
  }

  // Bug 5 (P1): no hard floor — the score is allowed to fall to 0 when the
  // gap penalty + length penalty swamp the base.  This is what prevents the
  // raw-query fallback from awarding noise on every long haystack.
  return Math.max(0, base - gapPenalty - Math.max(0, target.length - query.length));
}

export function fuzzySubsequenceScore(query, target) {
  return scoreFuzzySubsequence(query, target);
}

// ─── Weight hierarchy ────────────────────────────────────────────────────────
// Search relevance is scored from the highest-confidence signal to the
// weakest, so that an exact hit always outranks a fuzzy one.  Tiers (per call
// to fuzzySearchScore):
//
//   exact haystack === raw            +1200
//   haystack startsWith raw           + 880
//   haystack includes raw             + 420–760   (monotone in position)
//   token-contains (per token)        +  90–240   (monotone in position)
//   token-subsequence bonus           + 120       (only if contains missed)
//   fuzzy subsequence score           +   0–140   (gap-penalised)
//   CJK grapheme presence (per char)  +  24
//   raw-only subsequence fallback     + 160       (only if nothing else hit)
//   length bonus (shorter = better)   +   0–90
//
// `weightedKeywordScore` multiplies the final number by a caller-supplied
// weight.  Because weights are external, we clamp: no negative / non-finite
// weights may produce surprising totals.
// ─────────────────────────────────────────────────────────────────────────────
export function fuzzySearchScore(query, ...values) {
  // Cache-key prelude: cheap string concat keyed on the normalised query and
  // the (pre-tokenisation) joined values.  We do this BEFORE the heavier
  // tokenizer work so a repeat call costs one Map.get instead of two
  // Intl.Segmenter traversals.  The normaliser on `query` is cheap; skipping
  // it would conflate "Foo " / "foo" / " foo" in the cache, so we eat it.
  const joinedRaw = values.filter(Boolean).join('\n');
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery || !joinedRaw) {
    return 0;
  }
  const cacheKey = `${normalizedQuery}\u0000${joinedRaw}`;
  if (_fuzzyCache.has(cacheKey)) {
    // Touch for LRU: delete + re-insert bumps it to the freshest slot.
    const cached = _fuzzyCache.get(cacheKey);
    _fuzzyCache.delete(cacheKey);
    _fuzzyCache.set(cacheKey, cached);
    return cached;
  }

  const haystack = tokenizeHaystack(joinedRaw);
  const { tokens, graphemes, raw } = tokenizeQuery(query);

  if (!raw || !haystack) {
    _rememberFuzzyScore(cacheKey, 0);
    return 0;
  }

  const W = SEARCH_WEIGHTS;
  let score = 0;
  if (haystack === raw) {
    score += W.EXACT_MATCH;
  }
  if (haystack.startsWith(raw)) {
    score += W.PREFIX_MATCH;
  }

  const exactIndex = haystack.indexOf(raw);
  if (exactIndex >= 0) {
    // Position penalty: ceil(index / 3) means the floor is only reached
    // ~1020 chars in.  Earlier positions outrank later ones, but we stop
    // punishing once you're clearly deep inside a long document.
    score += Math.max(
      W.CONTAINS_FLOOR,
      W.CONTAINS_CEILING - Math.ceil(exactIndex / W.CONTAINS_POSITION_DIVISOR),
    );
  }

  for (const token of tokens) {
    const tokenIndex = haystack.indexOf(token);
    if (tokenIndex >= 0) {
      score += Math.max(
        W.TOKEN_FLOOR,
        W.TOKEN_CEILING - Math.ceil(tokenIndex / W.TOKEN_POSITION_DIVISOR),
      );
      continue;
    }

    if (isSubsequenceMatch(haystack, token)) {
      score += W.TOKEN_SUBSEQUENCE_BONUS;
    }
    score += scoreFuzzySubsequence(token, haystack);
  }

  for (const grapheme of graphemes) {
    if (haystack.includes(grapheme)) {
      score += W.GRAPHEME_PRESENCE;
    }
  }

  if (!score && isSubsequenceMatch(haystack, raw)) {
    score += W.RAW_SUBSEQUENCE_FALLBACK;
  }

  if (!score) {
    // Bug 5 (P1): compact raw before the fallback so multi-word queries like
    // "hello world" don't score 18 against every haystack merely because
    // spaces are omnipresent.  Strip every inner whitespace run and run the
    // subsequence scorer on the resulting compact string.
    const compactRaw = raw.replace(/\s+/g, '');
    score = scoreFuzzySubsequence(compactRaw, haystack);
  }

  if (!score) {
    _rememberFuzzyScore(cacheKey, 0);
    return 0;
  }

  const total =
    score +
    Math.max(0, W.LENGTH_BONUS_CEILING - Math.floor(haystack.length / W.LENGTH_BONUS_DIVISOR));
  _rememberFuzzyScore(cacheKey, total);
  return total;
}

function _rememberFuzzyScore(key, value) {
  _fuzzyCache.set(key, value);
  if (_fuzzyCache.size > FUZZY_CACHE_CAPACITY) {
    // Map iteration order is insertion order — the first key IS the LRU.
    const oldest = _fuzzyCache.keys().next().value;
    _fuzzyCache.delete(oldest);
  }
}

export function weightedKeywordScore(query, keywords = []) {
  const entries = Array.isArray(keywords)
    ? keywords
    : String(keywords || '')
        .split(/\s+/)
        .filter(Boolean)
        .map(keyword => ({ keyword, weight: 1 }));

  return entries.reduce((total, entry) => {
    const keyword = String(entry?.keyword || '').trim();
    const weight = Number(entry?.weight);
    if (!keyword) {
      return total;
    }

    const baseScore = fuzzySearchScore(query, keyword);
    if (!baseScore) {
      return total;
    }

    // Search audit P2: clamp the weight.  Negative weights would flip the
    // sort order for that keyword (actively demoting a match); NaN / ±Infinity
    // would produce NaN totals that propagate through the whole result list.
    // We default to 1 for anything non-finite and floor at 0.
    const safeWeight = Math.max(0, Number.isFinite(weight) ? weight : 1);
    return total + Math.round(baseScore * safeWeight);
  }, 0);
}

export function buildSearchSnippet(text, query, maxLength = 96, { fallback = '' } = {}) {
  const rawText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!rawText) {
    // Search audit P2: return caller-supplied fallback (default '').  The
    // function never synthesises English UI strings of its own — the caller
    // owns the localized placeholder ("Untitled result" / "未命名结果" / …).
    return fallback;
  }

  const graphemes = splitGraphemes(rawText);
  if (graphemes.length <= maxLength) {
    return rawText;
  }

  const normalizedText = rawText.toLowerCase();
  // Bug 4 (P1): `String.prototype.toLowerCase()` can change the code-unit
  // length of a string when case-folding expands characters (German ß → ss,
  // Turkish İ → i̇, a handful of Greek letters).  When that happens, any
  // indexOf() position computed against `normalizedText` cannot be mapped
  // back to `rawText` via codeUnitIndexToGraphemeIndex without silently
  // sliding the snippet window off the real match.  We fall back to a
  // truncate-only snippet for those (rare) inputs rather than render a
  // wrong window.
  if (normalizedText.length !== rawText.length) {
    return `${sliceByGrapheme(rawText, 0, Math.max(1, maxLength - 1))}…`;
  }
  const { tokens, graphemes: cjkGraphemes, raw } = tokenizeQuery(query);
  const candidates = [...tokens, ...cjkGraphemes, raw].filter(Boolean);
  const matchToken = candidates.find(token => normalizedText.includes(token));
  if (!matchToken) {
    return `${sliceByGrapheme(rawText, 0, Math.max(1, maxLength - 1))}…`;
  }

  const matchIndex = normalizedText.indexOf(matchToken);
  const matchGraphemeIndex = codeUnitIndexToGraphemeIndex(rawText, matchIndex);
  const start = Math.max(0, matchGraphemeIndex - Math.floor(maxLength * SNIPPET_CONTEXT_LEAD_RATIO));
  const end = Math.min(graphemes.length, start + maxLength);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < graphemes.length ? '…' : '';
  return `${prefix}${sliceByGrapheme(rawText, start, end).trim()}${suffix}`;
}
