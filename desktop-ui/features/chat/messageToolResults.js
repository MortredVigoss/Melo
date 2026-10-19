/**
 * desktop-ui/messageToolResults.js
 *
 * Render the persisted tool execution metadata under an assistant
 * message in chat history (G-1d slice 2, 2026-05-12).
 *
 * Extracted from app.js for the same reason as advancedPage.js / etc:
 * pure string render, no DOM, no `uiState` global — so `node --test`
 * can exercise it without scaffolding.  Caller (app.js) supplies the
 * `escapeHtml` util as a dep.
 *
 * Display rule mirrors the G-1f live-chip strip + G-1e in-prompt block:
 * per `toolResults[i]`, only emit a row when the trail is informative
 * — failure OR multi-tier fallback.  A pure-text tool call (no
 * `evidenceTrail`) or a single-tier success silently produces nothing,
 * so a message with 5 tool calls but only 1 informative trail renders
 * exactly 1 row instead of 5 cluttering shells.
 */

import {
  shouldShowEvidenceTrail,
  renderEvidenceTrailList,
} from './evidenceTrailMarkup.js';

/**
 * @param {{ toolResults?: Array<{ toolCallId?:string, toolName?:string, ok?:boolean, evidenceTrail?:Array }> }} message
 * @param {(s:string) => string} escapeHtml
 * @returns {string} — full `.message-tool-results` block, or '' if nothing to render
 */
export function renderMessageToolResults(message, escapeHtml) {
  if (!Array.isArray(message?.toolResults) || message.toolResults.length === 0) {
    return '';
  }
  const rows = message.toolResults
    .map(tr => renderOneRow(tr, escapeHtml))
    .filter(Boolean);
  if (!rows.length) return '';
  return `<div class="message-tool-results">${rows.join('')}</div>`;
}

function renderOneRow(tr, escapeHtml) {
  if (!tr || typeof tr !== 'object') return '';
  const ok = tr.ok !== false;
  const trailHtml = shouldShowEvidenceTrail(tr.evidenceTrail, ok)
    ? renderEvidenceTrailList(tr.evidenceTrail, escapeHtml)
    : '';
  if (!trailHtml) return '';
  const okClass = ok ? 'is-ok' : 'is-error';
  const okSymbol = ok ? '✓' : '✗';
  const toolName = typeof tr.toolName === 'string' ? tr.toolName : 'tool';
  return `
    <div class="message-tool-result ${okClass}">
      <div class="message-tool-result-head">
        <span class="message-tool-result-name">${escapeHtml(toolName)}</span>
        <span class="message-tool-result-status">${okSymbol}</span>
      </div>
      ${trailHtml}
    </div>
  `;
}
