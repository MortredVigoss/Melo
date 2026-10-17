// Phase 3.2.2 — rule-based skill pre-filter.
// Phase 4 — optimized search (inverted index, LRU cache, multi-turn context,
// recency boost, generative/evolved priority tiers).
//
// Before the assembled skill list is injected into the system prompt and
// tool loop, we score each enabled skill against the current user message
// (and, if provided, the recent conversation context) and keep only the
// ones that look relevant. This shrinks both the system prompt size and
// the tool list the model has to consider, without a single extra API call.
//
// Pipeline:
//   1. (optional) consult an inverted index to produce a candidate set in
//      O(tokens) time instead of O(skills × triggers). Protected skills
//      (built-in / melo-bundle) and always-on skills bypass the index and
//      are always considered candidates.
//   2. Score each candidate via `scoreSkill`, blending: trigger hits,
//      name/id hits, tag hits, description overlap, recency (if a run-log
//      snapshot is provided), and a priority-tier bonus so user-created
//      and user-evolved skills sort ahead of a bundled skill on a tie.
//   3. Safety net — if filtering would leave fewer than minKeep results,
//      fall back to the original list.
//
// Multi-turn context: callers may pass either a single string (legacy) or
// an array of `{ role, content }` messages. Messages closer to "now" get
// full weight; older messages get a discount. Concretely: newest msg ×1.0,
// previous msg ×0.6, two-back ×0.3, older dropped. That means a skill's
// trigger still matches when the user's latest reply is short
// ("另外也存成word") but the intent lives in the previous turn.
//
// This module has no external dependencies — it takes an array of
// already-normalized skill objects and a message (string | messages[])
// and returns a filtered copy.

import { buildSkillIndex, candidateSkillIdsFor } from './skillIndex.js';
import { defaultSkillMatchCache } from './skillMatchCache.js';
import { tokenizeForMatch } from './skillTokenize.js';
import { createHash } from 'node:crypto';

// Re-export so existing callers (skillUpgrade.js, skillMatcher.test.js) keep
// working without knowing about the new shared module.
export { tokenizeForMatch };

const DEFAULT_MAX_KEEP = 16;
const DEFAULT_MIN_KEEP = 2;

// Default weights for the weighted-context haystack. Index 0 = newest.
// Messages older than this list are dropped from scoring.
const DEFAULT_MSG_WEIGHTS = [1.0, 0.6, 0.3];

// Recency boost windows (ms). Anything older gets 0. Kept as constants
// so tests can mock nowFn and get deterministic boosts.
const RECENCY_24H_MS = 24 * 60 * 60 * 1000;
const RECENCY_7D_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Return true if the needle (already lowercased) appears as a word-boundary
 * match inside message. Uses word boundaries so "ship" doesn't match "shipping".
 * For multi-word needles, allow any whitespace between tokens in the haystack.
 */
function hasWordMatch(message, needle) {
  if (!needle) return false;
  const lowerMsg = message.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  // Simple substring check first (fast path).
  if (!lowerMsg.includes(lowerNeedle)) return false;
  // For CJK or multi-word needles, substring is enough — word boundaries
  // don't apply cleanly. For single-word latin needles, enforce word boundary.
  if (/^[a-z0-9-]+$/.test(lowerNeedle)) {
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(lowerNeedle)}(?:$|[^a-z0-9])`, 'u');
    return re.test(lowerMsg);
  }
  return true;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Priority tier ──────────────────────────────────────────────────────────
//
// Bundled skills (source='melo-bundle') are read-only from the user's
// perspective — they exist but users didn't pick them. User-created skills
// (origin='json' or 'disk' with no bundle marker) beat bundled skills on a
// tie because they reflect work the user actually invested in. Evolved
// skills — those the upgrade-proposal flow has already touched — beat
// both because they're literally trained on this user's activity.
//
// Exported so tests can assert the classification directly.

export function classifySkillTier(skill) {
  if (!skill) return 0;
  if (skill.source === 'melo-bundle') return 0; // bundled — baseline
  if (skill.origin === 'built-in') return 1;    // built-in — baseline user trust
  // Evidence of evolution: Phase 3.4.2 upgrade writes a "## Recent pattern"
  // block into systemPrompt AND a file under references/. Either signal is
  // enough to count as evolved.
  const prompt = String(skill.systemPrompt || '');
  const hasPatternBlock = prompt.includes('## Recent pattern');
  const hasReferences =
    Array.isArray(skill.referenceFiles) && skill.referenceFiles.length > 0
    || skill.hasReferences === true;
  if (hasPatternBlock || hasReferences) return 2; // evolved user skill
  return 1; // plain user-created skill
}

// ─── Recency boost ──────────────────────────────────────────────────────────
//
// Caller passes a map of {skillId → lastRunAtMs}. We translate:
//   • lastRun within 24h   → +3
//   • lastRun within 7d    → +2
//   • else                 → 0
// Skills never run get 0 — no implicit cold-start bonus; new skills still
// win matches on their triggers alone.

export function recencyBonusFor(skillId, recencyByIdMap, now = Date.now()) {
  if (!recencyByIdMap) return 0;
  const last =
    recencyByIdMap instanceof Map
      ? recencyByIdMap.get(skillId)
      : recencyByIdMap[skillId];
  if (!Number.isFinite(last)) return 0;
  const age = now - last;
  if (age < 0) return 0;
  if (age <= RECENCY_24H_MS) return 3;
  if (age <= RECENCY_7D_MS) return 2;
  return 0;
}

// ─── Haystack construction ──────────────────────────────────────────────────
//
// Normalize the caller's input into `[{ text, weight }, …]` from newest
// to oldest, with weights from DEFAULT_MSG_WEIGHTS.
//
// Accepted shapes:
//   - string                           → single piece, weight 1.0
//   - [{ role, content }, …]           → last N messages (newest LAST), we
//                                        reverse so newest is piece 0
//   - { text: '…' }                    → single piece, weight 1.0 (future-proof)

function buildHaystack(input, msgWeights = DEFAULT_MSG_WEIGHTS) {
  if (typeof input === 'string') {
    return input.trim() ? [{ text: input, weight: msgWeights[0] }] : [];
  }
  if (!Array.isArray(input)) {
    if (input && typeof input.text === 'string' && input.text.trim()) {
      return [{ text: input.text, weight: msgWeights[0] }];
    }
    return [];
  }
  // Messages array. We want newest → oldest, clipped to msgWeights.length.
  // Callers pass messages oldest-first (same shape they record chats).
  const reversed = input.slice().reverse();
  const out = [];
  let weightIdx = 0;
  for (const m of reversed) {
    if (weightIdx >= msgWeights.length) break;
    if (!m) continue;
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(p => (typeof p?.text === 'string' ? p.text : '')).join(' ')
        : '';
    if (!content.trim()) continue;
    // Assistant / tool messages carry intent signal too, but weaker — halve
    // the weight for non-user roles so they still contribute without
    // dominating a user's fresh ask.
    const roleAttenuation = (!m.role || m.role === 'user') ? 1.0 : 0.5;
    out.push({ text: content, weight: msgWeights[weightIdx] * roleAttenuation });
    weightIdx += 1;
  }
  return out;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/**
 * Score a single skill against a message or a multi-turn context.
 *
 * `message` can be:
 *   - a string (legacy)
 *   - an array of { role, content } messages (oldest-first; we weight newest
 *     heaviest and attenuate non-user roles)
 *
 * Returns 0 for no match.
 *
 * options:
 *   recencyByIdMap     — Map/object of skillId → lastRunAtMs; adds a small
 *                        boost for recently-used skills.
 *   now                — epoch ms, defaults to Date.now() (test hook).
 *   applyTierBonus     — default true; adds a small priority bonus so
 *                        user-created/evolved skills beat bundled on ties.
 *   msgWeights         — override the [newest, prev, older] weight array.
 */
export function scoreSkill(skill, message, options = {}) {
  if (!skill) return 0;
  const tags = Array.isArray(skill.tags) ? skill.tags : [];
  const triggers = Array.isArray(skill.triggers) ? skill.triggers : [];

  // Always-on shortcut.
  if (tags.includes('always-on')) return Number.POSITIVE_INFINITY;

  const haystack = buildHaystack(message, options.msgWeights);
  if (haystack.length === 0) return 0;

  let score = 0;

  // Trigger / name / id / tag / description scoring, weighted by haystack
  // piece. Triggers are the authored "this is when I'm relevant" signal —
  // weight them heaviest.
  for (const piece of haystack) {
    for (const t of triggers) {
      if (hasWordMatch(piece.text, t)) score += 3 * piece.weight;
    }
    if (skill.name && hasWordMatch(piece.text, skill.name)) {
      score += 2 * piece.weight;
    }
    if (skill.id && hasWordMatch(piece.text, skill.id)) {
      score += 2 * piece.weight;
    }
    for (const tag of tags) {
      if (hasWordMatch(piece.text, tag)) score += 1 * piece.weight;
    }
    // Description overlap — very weak tie-breaker, capped per piece.
    const descTokens = tokenizeForMatch(skill.description || '');
    if (descTokens.length > 0) {
      const msgTokens = new Set(tokenizeForMatch(piece.text));
      let descHits = 0;
      for (const tok of descTokens) {
        if (msgTokens.has(tok)) descHits += 1;
        if (descHits >= 3) break;
      }
      score += descHits * 0.5 * piece.weight;
    }
  }

  // No content match — no score. The recency/tier bonuses are only
  // applied on top of a real match so we don't resurrect genuinely
  // irrelevant skills just because they ran yesterday.
  if (score <= 0) return 0;

  // Recency bonus.
  score += recencyBonusFor(skill.id, options.recencyByIdMap, options.now);

  // Priority tier: 0 bundled, 1 user-created, 2 evolved user skill. Add as
  // a small bias so ties break toward user-owned work, but it can never
  // drown out a strong trigger match.
  if (options.applyTierBonus !== false) {
    score += classifySkillTier(skill);
  }

  return score;
}

// ─── Cache key helpers ──────────────────────────────────────────────────────

function canonical(value) {
  if (value instanceof Map) return canonical(Object.fromEntries(value));
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
}

// ─── Main entry ─────────────────────────────────────────────────────────────

/**
 * Filter skills by relevance to a message (or multi-turn context).
 *
 *   skills              — array of normalized skill objects. Order is
 *                         preserved for ties and for the passthrough path.
 *   messageOrMessages   — latest user message text (string) OR an oldest-
 *                         first array of { role, content } messages. In
 *                         the multi-turn case we weight newest messages
 *                         heaviest.
 *   options:
 *     maxKeep           — cap on relevant-by-score skills kept (default 16).
 *     minKeep           — if match produces fewer than this, return
 *                         original list (safety net; default 2).
 *     keepProtected     — always keep built-in / melo-bundle skills
 *                         (default true). Alias `keepBuiltIn` still works.
 *     recencyByIdMap    — { [skillId]: lastRunAtMs } for recency boost.
 *     skillIndex        — optional inverted index (Map<token, Set<id>>).
 *                         When provided, the candidate set is narrowed
 *                         via the index before scoring.
 *     cache             — optional LRU for memoizing results. Defaults to
 *                         a module-level singleton; pass false to disable.
 *     now               — epoch ms (test hook).
 *     applyTierBonus    — boolean, default true.
 */
export function matchSkillsForMessage(skills, messageOrMessages, options = {}) {
  if (!Array.isArray(skills) || skills.length === 0) return [];

  // Passthrough: empty / whitespace-only messages mean "no signal yet".
  // Don't filter; keep everything so the tool loop still has access to
  // the full skill set.
  const haystack = buildHaystack(messageOrMessages, options.msgWeights);
  if (haystack.length === 0) return [...skills];

  const maxKeep = Number.isFinite(options.maxKeep) ? options.maxKeep : DEFAULT_MAX_KEEP;
  const minKeep = Number.isFinite(options.minKeep) ? options.minKeep : DEFAULT_MIN_KEEP;
  const keepProtected = options.keepProtected !== undefined
    ? options.keepProtected !== false
    : options.keepBuiltIn !== false; // back-compat alias

  // Without a fixed clock, recency can cross a threshold while cached.
  const hasRecency = options.recencyByIdMap instanceof Map
    ? options.recencyByIdMap.size > 0 : Object.keys(options.recencyByIdMap || {}).length > 0;
  const cache = options.cache === false || (hasRecency && options.now === undefined)
    ? null
    : (options.cache || defaultSkillMatchCache);
  let cacheKey = null;
  if (cache) {
    cacheKey = fingerprint({ scope: options.cacheScope ?? null, message: messageOrMessages, skills,
      maxKeep, minKeep, keepProtected, recency: options.recencyByIdMap, now: options.now,
      applyTierBonus: options.applyTierBonus, msgWeights: options.msgWeights });
    const hit = cache.get(cacheKey);
    if (hit) {
      const current = new Map(skills.map(skill => [skill.id, skill]));
      return hit.map(id => current.get(id)).filter(Boolean);
    }
  }

  // Candidate narrowing via inverted index, if provided. Protected /
  // no-metadata / always-on skills ALWAYS pass through candidate selection
  // because the index only contains skills with triggers/tags/name tokens
  // and we never want to drop protected skills on indexing grounds.
  const index = options.skillIndex || null;
  let candidateIds = null;
  if (index) {
    const combinedText = haystack.map(p => p.text).join(' ');
    candidateIds = candidateSkillIdsFor(combinedText, index);
  }

  const kept = [];
  const scored = [];
  for (const skill of skills) {
    const triggers = Array.isArray(skill.triggers) ? skill.triggers : [];
    const tags = Array.isArray(skill.tags) ? skill.tags : [];
    const hasSignal = triggers.length > 0 || tags.length > 0;

    // No metadata — we can't filter confidently, keep it.
    if (!hasSignal) {
      kept.push({ skill, score: Number.POSITIVE_INFINITY, reason: 'no-metadata' });
      continue;
    }

    // Protected passthrough: built-in + melo-bundle (read-only-ish) skills
    // bypass scoring so a user can always invoke them by name even if the
    // matcher would otherwise filter them out.
    const isProtected =
      skill.source === 'melo-bundle'
      || skill.origin === 'built-in'
      || skill.source === 'built-in';
    if (keepProtected && isProtected) {
      kept.push({ skill, score: Number.POSITIVE_INFINITY, reason: 'protected' });
      continue;
    }

    // Index narrowing applies only to non-protected, metadata-bearing
    // skills. If the index has no row for this id, it cannot possibly
    // match — skip scoring for a real speedup on large skill sets.
    if (candidateIds && !candidateIds.has(skill.id)) continue;

    const score = scoreSkill(skill, messageOrMessages, {
      recencyByIdMap: options.recencyByIdMap,
      now: options.now,
      applyTierBonus: options.applyTierBonus,
      msgWeights: options.msgWeights,
    });
    if (score > 0) {
      scored.push({ skill, score, reason: 'matched' });
    }
  }

  // Merge: passthrough skills preserve input order; scored group sorts
  // by score descending, stable by original index.
  scored.sort((a, b) => b.score - a.score);
  const merged = [...kept, ...scored].slice(0, maxKeep);

  // Safety net: if the filtered list is too small, fall back to original
  // (don't starve the model).
  let result;
  if (merged.length < minKeep && skills.length >= minKeep) {
    result = [...skills];
  } else {
    result = merged.map(entry => entry.skill);
  }

  // Resolve definitions from the current Registry, never cached foreign objects.
  if (cache && cacheKey) cache.set(cacheKey, result.map(skill => skill.id));
  return result;
}

/**
 * Diagnostic variant used by the health panel / debug logs. Returns the
 * same skills plus score/reason so the UI can show "this one was dropped
 * because it scored 0".
 */
export function explainSkillMatches(skills, messageOrMessages, options = {}) {
  if (!Array.isArray(skills) || skills.length === 0) return [];
  const haystack = buildHaystack(messageOrMessages, options.msgWeights);
  const keepProtected = options.keepProtected !== undefined
    ? options.keepProtected !== false
    : options.keepBuiltIn !== false;

  return skills.map(skill => {
    const triggers = Array.isArray(skill.triggers) ? skill.triggers : [];
    const tags = Array.isArray(skill.tags) ? skill.tags : [];
    const hasSignal = triggers.length > 0 || tags.length > 0;
    if (!hasSignal) {
      return { id: skill.id, score: Number.POSITIVE_INFINITY, reason: 'no-metadata', tier: classifySkillTier(skill) };
    }
    const isProtected =
      skill.source === 'melo-bundle'
      || skill.origin === 'built-in'
      || skill.source === 'built-in';
    if (keepProtected && isProtected) {
      return { id: skill.id, score: Number.POSITIVE_INFINITY, reason: 'protected', tier: classifySkillTier(skill) };
    }
    if (haystack.length === 0) {
      return { id: skill.id, score: 0, reason: 'no-message', tier: classifySkillTier(skill) };
    }
    const score = scoreSkill(skill, messageOrMessages, {
      recencyByIdMap: options.recencyByIdMap,
      now: options.now,
      applyTierBonus: options.applyTierBonus,
      msgWeights: options.msgWeights,
    });
    return {
      id: skill.id,
      score,
      reason: score > 0 ? 'matched' : 'filtered-out',
      tier: classifySkillTier(skill),
    };
  });
}

// Re-export helpers so callers can build an index / clear the cache via
// the matcher module without tracking two extra imports.
export { buildSkillIndex } from './skillIndex.js';
export { defaultSkillMatchCache, createSkillMatchCache } from './skillMatchCache.js';
