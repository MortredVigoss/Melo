// The delivery check as the task space shows it (review 2026-11-07): what the
// checker decided, each requirement it checked, and the evidence ids it cited.
// A task without a contract (a single fact, a calculation, an action) has no
// evaluation ledger, so this is the only structured record of how its answer
// was approved. Bounded, display-only and never sent to a model.
//
// Kept free of imports so the phone scene bundle can carry it.

// Requirements and evidence ids keep the checker's own bounds (goal.js GOAL_LIMITS.requirements
// and ids(): 16 ids of up to 256 characters), so a cited id always still matches its call.
export const GOAL_REVIEW_LIMITS = Object.freeze({ requirements: 12, text: 160, evidence: 16, id: 256, explanation: 240 });
export const GOAL_REVIEW_DECISIONS = Object.freeze(['complete', 'deliver', 'continue', 'needs_user', 'partial']);
export const GOAL_REQUIREMENT_KINDS = Object.freeze(['response', 'context', 'constraint', 'external_fact', 'external_effect']);
export const GOAL_REQUIREMENT_STATES = Object.freeze(['met', 'missing', 'unavailable']);

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const clip = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const whole = (value, max) => Number.isInteger(value) && value >= 0 ? Math.min(value, max) : 0;

/** Re-checks a review read from a record; anything malformed becomes null, never an error. */
export function normalizeGoalReview(raw) {
  try { return normalized(raw); } catch { return null; }
}
function normalized(raw) {
  const review = object(raw);
  if (!review || review.v !== 1 || !GOAL_REVIEW_DECISIONS.includes(review.decision)) return null;
  const L = GOAL_REVIEW_LIMITS, rows = Array.isArray(review.requirements) ? review.requirements : [];
  const requirements = rows.slice(0, L.requirements).map(object).filter(Boolean).map(row => ({
    text: clip(row.text, L.text),
    kind: GOAL_REQUIREMENT_KINDS.includes(row.kind) ? row.kind : 'external_fact',
    status: GOAL_REQUIREMENT_STATES.includes(row.status) ? row.status : 'missing',
    evidenceIds: (Array.isArray(row.evidenceIds) ? row.evidenceIds : []).filter(id => typeof id === 'string' && id.trim()).slice(0, L.evidence).map(id => id.trim().slice(0, L.id)),
  })).filter(row => row.text);
  return {
    v: 1,
    decision: review.decision,
    reason: typeof review.reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(review.reason) ? review.reason : '',
    corrections: whole(review.corrections, 99),
    correctionLimit: whole(review.correctionLimit, 99),
    explanation: clip(review.explanation, L.explanation),
    requirements,
    omitted: whole(review.omitted, 999) + Math.max(0, rows.length - L.requirements),
  };
}

/** The view of a reviewed goal state (shared/agent/goal.js reviewGoal); read-only. */
export function goalReviewOf(state, correctionLimit = 0) {
  const goal = object(state);
  if (!goal) return null;
  return normalizeGoalReview({ v: 1, decision: goal.decision, reason: goal.reason, corrections: goal.corrections, correctionLimit,
    explanation: goal.explanation, requirements: goal.requirements });
}

/** Counts the gate shows: requirements met, missing, unavailable, and cited evidence. */
export function goalReviewTally(review) {
  const rows = review?.requirements || [];
  const count = status => rows.filter(row => row.status === status).length;
  return { total: rows.length, met: count('met'), missing: count('missing'), unavailable: count('unavailable'),
    evidence: new Set(rows.flatMap(row => row.evidenceIds)).size, passed: ['complete', 'deliver'].includes(review?.decision) };
}
