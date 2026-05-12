/**
 * desktop-ui/activeToolCallsStrip.js
 *
 * Renders the in-flight tool-call status strip (the row of pills shown
 * during streaming).  Extracted from app.js (2026-05-12, G-1f) so the
 * render logic can be exercised by `node --test` without a DOM —
 * matching the pattern of `advancedPage.js`, `agentDraft.js`, etc.
 *
 * G-1f adds **evidence trail rendering** under each pill when:
 *   - the call failed (`status === 'error'`), OR
 *   - the trail has ≥ 2 tiers (a fallback happened — even on success,
 *     this is informative: agent learns which tiers are flaky).
 * Single-tier successes don't render a trail (would be noise).  The
 * rule mirrors `_shouldEmitEvidenceTrail` in `src/tools/parser.js`
 * (G-1e) so the on-screen and in-prompt visibility stay consistent.
 *
 * The strip's lifetime in `uiState.activeToolCalls` is short (1.8s
 * post-completion before being filtered out — see app.js handler).
 * This MVP renders the trail always-expanded inside that window;
 * `<details>` / click-to-expand isn't worth it for such a short
 * display window.  Historical-message trail visibility is a separate
 * milestone (G-1d slice 2, needs persistence to message metadata).
 */

/**
 * @typedef {Object} ActiveCall
 * @property {string} id
 * @property {string} name
 * @property {Object} [arguments]
 * @property {'running'|'ok'|'error'} status
 * @property {string} [output]
 * @property {Array<{tier:string, outcome:string, latencyMs?:number, reason?:string}>} [evidenceTrail]
 */

const VALID_OUTCOMES = new Set(['ok', 'fail', 'aborted', 'skip']);

/**
 * Mirror of `_shouldEmitEvidenceTrail` from src/tools/parser.js (G-1e).
 * Re-implemented here rather than imported because desktop-ui and src/
 * don't share a package boundary in this codebase (different bundles).
 * Keep the two in sync — both should agree on when the trail is
 * informative enough to show.
 */
function shouldRenderTrail(call) {
  if (!call || !Array.isArray(call.evidenceTrail) || call.evidenceTrail.length === 0) {
    return false;
  }
  if (call.status === 'error') return true;
  return call.evidenceTrail.length >= 2;
}

/**
 * Build the "<reason> · <latencyMs>ms" detail string for one trail
 * item.  Returns empty when neither reason nor latency is present —
 * caller should then omit the `<span class="tool-call-trail-detail">`
 * wrapper entirely (avoid empty span artifacts).
 */
function formatTrailDetail(item) {
  const parts = [];
  if (item.reason) parts.push(String(item.reason));
  if (typeof item.latencyMs === 'number' && Number.isFinite(item.latencyMs)) {
    parts.push(`${Math.round(item.latencyMs)}ms`);
  }
  return parts.join(' · ');
}

/**
 * Render a single trail entry as one `<li>`.  Returns '' for malformed
 * items so the caller can pass any array shape and we filter quietly
 * (mirrors parser.js's _formatEvidenceTrailItem defensiveness).
 */
function renderTrailItem(item, escapeHtml) {
  if (!item || typeof item !== 'object') return '';
  const tier = String(item.tier || '?');
  const outcomeRaw = String(item.outcome || '?');
  // Only allowlisted outcomes get a colored class; anything else falls
  // back to plain (no `is-*` modifier) so a future producer can't break
  // the styling by emitting a novel outcome string.
  const outcomeClass = VALID_OUTCOMES.has(outcomeRaw) ? `is-${outcomeRaw}` : '';
  const detail = formatTrailDetail(item);
  return `<li class="tool-call-trail-item">`
    + `<span class="tool-call-trail-tier">${escapeHtml(tier)}</span>`
    + `<span class="tool-call-trail-outcome ${outcomeClass}">${escapeHtml(outcomeRaw)}</span>`
    + (detail ? `<span class="tool-call-trail-detail">${escapeHtml(detail)}</span>` : '')
    + `</li>`;
}

function renderTrail(call, escapeHtml) {
  if (!shouldRenderTrail(call)) return '';
  const items = call.evidenceTrail
    .map(item => renderTrailItem(item, escapeHtml))
    .filter(Boolean);
  if (!items.length) return '';
  return `<ul class="tool-call-trail">${items.join('')}</ul>`;
}

/**
 * Render the full strip.  `deps` injects the two app-level utilities
 * (`escapeHtml` + `icon.terminal` SVG markup) so the renderer stays
 * import-free in tests.
 *
 * @param {ActiveCall[]} calls
 * @param {{ escapeHtml: (s:string) => string, terminalIcon: string }} deps
 * @returns {string}
 */
export function renderActiveToolCallsStrip(calls, { escapeHtml, terminalIcon } = {}) {
  if (!Array.isArray(calls) || calls.length === 0) return '';
  const esc = typeof escapeHtml === 'function' ? escapeHtml : v => String(v ?? '');
  const iconMarkup = terminalIcon || '';

  return `
    <div class="tool-calls-strip">
      ${calls.map(call => {
        const statusClass =
          call.status === 'running' ? 'is-running'
          : call.status === 'ok' ? 'is-ok'
          : 'is-error';
        const spinner = call.status === 'running' ? '<span class="tool-call-spinner"></span>' : '';
        const check = call.status === 'ok' ? '<span class="tool-call-check">✓</span>' : '';
        const cross = call.status === 'error' ? '<span class="tool-call-x">✗</span>' : '';
        // C-gate fix (2026-05-12): first-row content MUST be wrapped in
        // `.tool-call-pill-main` so the pill can stack `.tool-call-pill-main`
        // + `.tool-call-trail` vertically WITHOUT the original row content
        // (icon / name / status indicator) also stacking.  Prior fix used
        // `.tool-call-pill { flex-direction: column; }` directly which
        // broke the no-trail pill into 3 vertical rows.  Layout-contract
        // tests in the .test.js file pin this wrapper's presence.
        return `
        <div class="tool-call-pill ${statusClass}">
          <div class="tool-call-pill-main">
            <span class="tool-call-pill-icon">${iconMarkup}</span>
            <span class="tool-call-pill-name">${esc(call.name)}</span>
            ${spinner}
            ${check}
            ${cross}
          </div>
          ${renderTrail(call, esc)}
        </div>
      `;
      }).join('')}
    </div>
  `;
}

// Exported for testing only — keeps the rule mirror visible.
export const _internalsForTests = {
  shouldRenderTrail,
  formatTrailDetail,
};
