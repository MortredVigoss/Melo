/**
 * desktop-ui/evidenceTrailMarkup.test.js
 *
 * Pure render-string tests for the shared trail markup module (G-1d
 * slice 2 + G-1f).  Two consumers (active chip strip + chat history)
 * both lean on this module, so its contract is the visual stability
 * anchor: change here means change to BOTH UI surfaces.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldShowEvidenceTrail,
  formatEvidenceTrailDetail,
  renderEvidenceTrailItem,
  renderEvidenceTrailList,
} from './evidenceTrailMarkup.js';

function escapeHtml(value = '') {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ─── shouldShowEvidenceTrail ────────────────────────────────────────────────

test('shouldShowEvidenceTrail: empty/missing trail → false', () => {
  assert.equal(shouldShowEvidenceTrail(undefined, true), false);
  assert.equal(shouldShowEvidenceTrail(null, true), false);
  assert.equal(shouldShowEvidenceTrail([], true), false);
  assert.equal(shouldShowEvidenceTrail([], false), false, 'empty + ok=false still false (no items to show)');
});

test('shouldShowEvidenceTrail: ok=true + single tier → false (noise gate)', () => {
  assert.equal(
    shouldShowEvidenceTrail([{ tier: 'jina', outcome: 'ok' }], true),
    false,
  );
});

test('shouldShowEvidenceTrail: ok=true + multi-tier → true (fallback informative)', () => {
  assert.equal(
    shouldShowEvidenceTrail(
      [
        { tier: 'jina', outcome: 'fail' },
        { tier: 'direct', outcome: 'ok' },
      ],
      true,
    ),
    true,
  );
});

test('shouldShowEvidenceTrail: ok=false + single tier → true (failure must surface)', () => {
  assert.equal(
    shouldShowEvidenceTrail([{ tier: 'jina', outcome: 'fail' }], false),
    true,
  );
});

// ─── formatEvidenceTrailDetail ──────────────────────────────────────────────

test('formatEvidenceTrailDetail: reason + latency → "reason · Nms"', () => {
  assert.equal(
    formatEvidenceTrailDetail({ reason: 'timeout', latencyMs: 3500 }),
    'timeout · 3500ms',
  );
});

test('formatEvidenceTrailDetail: only latency → "Nms"', () => {
  assert.equal(formatEvidenceTrailDetail({ latencyMs: 220 }), '220ms');
});

test('formatEvidenceTrailDetail: only reason → "reason"', () => {
  assert.equal(formatEvidenceTrailDetail({ reason: 'http-403' }), 'http-403');
});

test('formatEvidenceTrailDetail: neither → empty string', () => {
  assert.equal(formatEvidenceTrailDetail({}), '');
  assert.equal(formatEvidenceTrailDetail({ tier: 'x', outcome: 'fail' }), '');
});

test('formatEvidenceTrailDetail: latency rounded to integer (no noisy decimals)', () => {
  assert.equal(
    formatEvidenceTrailDetail({ latencyMs: 234.789 }),
    '235ms',
  );
});

test('formatEvidenceTrailDetail: non-finite latency dropped (Infinity / NaN)', () => {
  assert.equal(formatEvidenceTrailDetail({ latencyMs: Infinity }), '');
  assert.equal(formatEvidenceTrailDetail({ latencyMs: NaN }), '');
  assert.equal(formatEvidenceTrailDetail({ latencyMs: 'oops' }), '');
});

// ─── renderEvidenceTrailItem ────────────────────────────────────────────────

test('renderEvidenceTrailItem: full info → tier + outcome + detail spans', () => {
  const html = renderEvidenceTrailItem(
    { tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' },
    escapeHtml,
  );
  assert.match(html, /^<li class="tool-call-trail-item">/);
  assert.match(html, /class="tool-call-trail-tier">jina<\/span>/);
  assert.match(html, /class="tool-call-trail-outcome is-fail">fail<\/span>/);
  assert.match(html, /class="tool-call-trail-detail">timeout · 3500ms<\/span>/);
  assert.match(html, /<\/li>$/);
});

test('renderEvidenceTrailItem: no detail data → no detail span (no empty artifact)', () => {
  const html = renderEvidenceTrailItem({ tier: 'jina', outcome: 'aborted' }, escapeHtml);
  assert.doesNotMatch(html, /tool-call-trail-detail/);
  assert.match(html, /is-aborted">aborted<\/span>/);
});

test('renderEvidenceTrailItem: unrecognized outcome → neutral class (no is-* modifier)', () => {
  const html = renderEvidenceTrailItem({ tier: 'jina', outcome: 'novel' }, escapeHtml);
  assert.match(html, /class="tool-call-trail-outcome ">novel<\/span>/,
    'unrecognized outcome must NOT get a fabricated is-* class');
});

test('renderEvidenceTrailItem: escapeHtml on tier / outcome / reason (XSS defense)', () => {
  const html = renderEvidenceTrailItem(
    { tier: 'a<b&c', outcome: 'fail', reason: '<script>x</script>' },
    escapeHtml,
  );
  assert.match(html, /a&lt;b&amp;c/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>x<\/script>/);
});

test('renderEvidenceTrailItem: malformed item (null / non-object / string) → empty string', () => {
  assert.equal(renderEvidenceTrailItem(null, escapeHtml), '');
  assert.equal(renderEvidenceTrailItem(undefined, escapeHtml), '');
  assert.equal(renderEvidenceTrailItem('string', escapeHtml), '');
  assert.equal(renderEvidenceTrailItem(42, escapeHtml), '');
});

// ─── renderEvidenceTrailList ────────────────────────────────────────────────

test('renderEvidenceTrailList: empty / missing → empty string (caller skips wrapper)', () => {
  assert.equal(renderEvidenceTrailList(null, escapeHtml), '');
  assert.equal(renderEvidenceTrailList(undefined, escapeHtml), '');
  assert.equal(renderEvidenceTrailList([], escapeHtml), '');
});

test('renderEvidenceTrailList: 3-tier failure → ul with 3 li items in order', () => {
  const html = renderEvidenceTrailList(
    [
      { tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' },
      { tier: 'direct', outcome: 'fail', latencyMs: 120, reason: 'http-403' },
      { tier: 'playwright', outcome: 'fail', latencyMs: 2200, reason: 'timeout' },
    ],
    escapeHtml,
  );
  assert.match(html, /^<ul class="tool-call-trail">/);
  // Order matters: jina first, direct second, playwright last
  const jinaIdx = html.indexOf('>jina<');
  const directIdx = html.indexOf('>direct<');
  const pwIdx = html.indexOf('>playwright<');
  assert.ok(jinaIdx < directIdx && directIdx < pwIdx, 'order preserved');
  const liCount = (html.match(/<li class="tool-call-trail-item">/g) || []).length;
  assert.equal(liCount, 3);
});

test('renderEvidenceTrailList: all-malformed items → empty string (no empty <ul>)', () => {
  const html = renderEvidenceTrailList([null, undefined, 'string', 42], escapeHtml);
  assert.equal(html, '');
});

test('renderEvidenceTrailList: mixed valid + malformed → filter to valid only', () => {
  const html = renderEvidenceTrailList(
    [null, { tier: 'jina', outcome: 'fail' }, 'string', { tier: 'direct', outcome: 'ok' }],
    escapeHtml,
  );
  const liCount = (html.match(/<li class="tool-call-trail-item">/g) || []).length;
  assert.equal(liCount, 2, 'two valid items survive, two malformed dropped');
});
