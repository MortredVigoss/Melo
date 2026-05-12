/**
 * desktop-ui/evidenceTrailMarkup.js
 *
 * Shared evidence-trail UI markup used by:
 *   - the live tool-call chip strip (G-1f, activeToolCallsStrip.js)
 *   - the historical message render (G-1d slice 2, app.js renderMessageList)
 *
 * Why a shared helper now: G-1f put the per-trail-item DOM shape inline
 * in activeToolCallsStrip.js (renderTrailItem etc).  Slice 2 adds a
 * second consumer (message history) that needs the SAME visual styling
 * (so chip trail and history trail look identical — they're the same
 * data after all).  Rather than duplicate the per-item logic, extract.
 *
 * Caller responsibility: the outer wrapper (`.tool-call-pill` vs
 * `.message-tool-results-row`) lives at the call site.  This module
 * owns the `<ul class="tool-call-trail">` and its `<li>` children only.
 */

const VALID_OUTCOMES = new Set(['ok', 'fail', 'aborted', 'skip']);

/**
 * Decide whether the trail is informative enough to render.
 * Same heuristic as G-1e's `_shouldEmitEvidenceTrail` in src/tools/parser.js:
 *   - empty trail → false
 *   - single-tier success → false (a clean one-shot doesn't need surfacing)
 *   - multi-tier OR failure → true (fallback is interesting; failure is essential)
 *
 * @param {Array} trail
 * @param {boolean} ok — the tool's overall success flag (true for success)
 */
export function shouldShowEvidenceTrail(trail, ok) {
  if (!Array.isArray(trail) || trail.length === 0) return false;
  if (ok === false) return true;
  return trail.length >= 2;
}

/**
 * Build the "<reason> · <Nms>" detail substring for one trail item.
 * Returns '' if neither reason nor latency is present — caller skips
 * the wrapping `<span>` in that case to avoid empty-element artifacts.
 */
export function formatEvidenceTrailDetail(item) {
  if (!item || typeof item !== 'object') return '';
  const parts = [];
  if (item.reason) parts.push(String(item.reason));
  if (typeof item.latencyMs === 'number' && Number.isFinite(item.latencyMs)) {
    parts.push(`${Math.round(item.latencyMs)}ms`);
  }
  return parts.join(' · ');
}

/**
 * Render one trail item as a `<li>`.  Returns '' for malformed items
 * so callers can pass any array shape and we silently filter the noise.
 */
export function renderEvidenceTrailItem(item, escapeHtml) {
  if (!item || typeof item !== 'object') return '';
  const tier = String(item.tier || '?');
  const outcomeRaw = String(item.outcome || '?');
  // Allowlisted outcomes get a colored class.  Anything else falls back to
  // the bare class so a future producer that emits a novel outcome
  // doesn't crash styling.
  const outcomeClass = VALID_OUTCOMES.has(outcomeRaw) ? `is-${outcomeRaw}` : '';
  const detail = formatEvidenceTrailDetail(item);
  return `<li class="tool-call-trail-item">`
    + `<span class="tool-call-trail-tier">${escapeHtml(tier)}</span>`
    + `<span class="tool-call-trail-outcome ${outcomeClass}">${escapeHtml(outcomeRaw)}</span>`
    + (detail ? `<span class="tool-call-trail-detail">${escapeHtml(detail)}</span>` : '')
    + `</li>`;
}

/**
 * Render the full trail as a `<ul class="tool-call-trail">` block.
 * Empty / malformed trails produce '' so the caller's outer wrapper
 * doesn't get a stray empty list.
 *
 * @param {Array} trail
 * @param {(s:string) => string} escapeHtml — caller's escape util (no module-level
 *   dep so this stays import-free for tests).
 */
export function renderEvidenceTrailList(trail, escapeHtml) {
  if (!Array.isArray(trail) || trail.length === 0) return '';
  const items = trail
    .map(item => renderEvidenceTrailItem(item, escapeHtml))
    .filter(Boolean);
  if (!items.length) return '';
  return `<ul class="tool-call-trail">${items.join('')}</ul>`;
}
