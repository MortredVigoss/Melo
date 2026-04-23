// Phase 4 — inverted index for skill matching.
//
// For small skill sets (≤ a few dozen) the linear scan in skillMatcher.js
// is plenty fast. Once a user accumulates 100+ skills — which is the
// realistic target for long-running Melo instances — scoring every skill
// on every message becomes expensive. This module builds a Map<token,
// Set<skillId>> indexed on the skill's search-facing strings (triggers,
// tags, name, id, description tokens) so the matcher can narrow the
// candidate set to O(message tokens) hits before scoring.
//
// The index is not authoritative. Missing the index (or losing it to a
// build error) never drops a skill — skillMatcher only uses the index to
// *skip* scoring for skills that definitely can't match token-for-token.
// Protected skills (built-in / melo-bundle) and no-metadata skills bypass
// the index entirely in the matcher.
//
// API:
//   buildSkillIndex(skills)            → Index
//   addSkillToIndex(skill, index)      → void (mutates index)
//   removeSkillFromIndex(id, index)    → void (mutates index)
//   candidateSkillIdsFor(text, index)  → Set<skillId>
//
// Index shape (exported only as a type shape, not a class):
//   {
//     tokenMap:    Map<token, Set<skillId>>,
//     skillTokens: Map<skillId, Set<token>>,  // reverse map for O(1) remove
//   }

// Shared tokenizer. Extracted into ./skillTokenize.js (Search audit C-1) so
// the matcher and the index no longer carry drifting copies of the same
// function. skillTokenize.js is a leaf module with no other imports, so
// there's no circular-import risk even though skillMatcher.js also pulls
// from this file.
import { tokenizeForMatch } from './skillTokenize.js';

/**
 * Collect every string that should contribute a token for a skill:
 * triggers, tags, name, id, and a bounded slice of description tokens.
 */
function tokensForSkill(skill) {
  const tokens = new Set();
  if (!skill) return tokens;

  const push = (s) => {
    if (typeof s !== 'string' || !s) return;
    for (const t of tokenizeForMatch(s)) tokens.add(t);
    // Also add the raw lowercased form as a single token — lets us match
    // multi-word triggers like "code review" or CJK phrases against the
    // same normalized key on the lookup side.
    const raw = s.toLowerCase().trim();
    if (raw) tokens.add(raw);
  };

  if (Array.isArray(skill.triggers)) {
    for (const t of skill.triggers) push(t);
  }
  if (Array.isArray(skill.tags)) {
    for (const t of skill.tags) push(t);
  }
  push(skill.name);
  push(skill.id);

  // Description contributes too, but cap at the first N tokens so a
  // 2000-word description doesn't dominate the index.
  if (typeof skill.description === 'string' && skill.description) {
    const descTokens = tokenizeForMatch(skill.description);
    for (let i = 0; i < Math.min(descTokens.length, 32); i += 1) {
      tokens.add(descTokens[i]);
    }
  }

  return tokens;
}

export function buildSkillIndex(skills) {
  const index = {
    tokenMap: new Map(),
    skillTokens: new Map(),
  };
  if (!Array.isArray(skills)) return index;
  for (const s of skills) addSkillToIndex(s, index);
  return index;
}

export function addSkillToIndex(skill, index) {
  if (!skill || !skill.id || !index) return;
  // If already present, refresh by removing first — cheap and keeps the
  // index consistent when a skill's triggers change.
  if (index.skillTokens.has(skill.id)) {
    removeSkillFromIndex(skill.id, index);
  }
  const tokens = tokensForSkill(skill);
  if (tokens.size === 0) return; // nothing to index
  index.skillTokens.set(skill.id, tokens);
  for (const t of tokens) {
    let set = index.tokenMap.get(t);
    if (!set) {
      set = new Set();
      index.tokenMap.set(t, set);
    }
    set.add(skill.id);
  }
}

export function removeSkillFromIndex(skillId, index) {
  if (!skillId || !index) return;
  const tokens = index.skillTokens.get(skillId);
  if (!tokens) return;
  for (const t of tokens) {
    const set = index.tokenMap.get(t);
    if (!set) continue;
    set.delete(skillId);
    if (set.size === 0) index.tokenMap.delete(t);
  }
  index.skillTokens.delete(skillId);
}

/**
 * Given a message (string), look up every token in the index and union
 * the skill-id sets. Returns a Set<skillId> — the caller uses it to narrow
 * its scoring loop.
 *
 * For a message that shares no tokens with any indexed skill, returns an
 * empty set. The matcher treats that as "no scored candidates"; protected
 * and no-metadata skills still pass through by separate paths.
 */
export function candidateSkillIdsFor(text, index) {
  const out = new Set();
  if (!index || !index.tokenMap || !text) return out;

  const tokens = tokenizeForMatch(text);
  // Also try the raw lowercased whole message once, so multi-word triggers
  // keyed by their raw form can fire (e.g. a skill with trigger "code
  // review" stored as "code review" matches a message containing that
  // exact phrase).
  const candidates = new Set(tokens);
  const rawLower = String(text).toLowerCase().trim();
  if (rawLower) {
    // Cheap heuristic: if the raw text is short enough, include it whole.
    if (rawLower.length <= 64) candidates.add(rawLower);
  }

  for (const t of candidates) {
    const set = index.tokenMap.get(t);
    if (!set) continue;
    for (const id of set) out.add(id);
  }
  return out;
}
