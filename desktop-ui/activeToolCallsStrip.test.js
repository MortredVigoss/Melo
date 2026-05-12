/**
 * desktop-ui/activeToolCallsStrip.test.js
 *
 * Pure render-string tests for the G-1f tool-call strip (with evidence
 * trail).  No DOM — same pattern as advancedPage.test.js.
 *
 * The display heuristic for the trail mirrors `_shouldEmitEvidenceTrail`
 * in src/tools/parser.js (G-1e prompt-side).  These tests lock both
 * sides of that mirror at the UI layer + the rendering format itself
 * so a future "simplify by always showing" or "drop the trail UI"
 * refactor breaks loudly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderActiveToolCallsStrip, _internalsForTests } from './activeToolCallsStrip.js';

// Minimal escapeHtml shim — matches the app.js production shape
// closely enough that escape failures are observable via `&lt;` / `&amp;`.
function escapeHtml(value = '') {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const TERMINAL_ICON = '<svg class="terminal"></svg>'; // stand-in

function render(calls) {
  return renderActiveToolCallsStrip(calls, { escapeHtml, terminalIcon: TERMINAL_ICON });
}

// ─── empty / no trail ───────────────────────────────────────────────────────

test('empty calls array → empty string', () => {
  assert.equal(render([]), '');
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
});

test('single running call, no trail → existing pill markup (regression)', () => {
  const html = render([{ id: 'c1', name: 'bash', status: 'running' }]);
  assert.match(html, /class="tool-calls-strip"/);
  assert.match(html, /class="tool-call-pill is-running"/);
  assert.match(html, /tool-call-pill-name">bash<\/span>/);
  assert.match(html, /tool-call-spinner/);
  assert.doesNotMatch(html, /tool-call-trail/, 'no trail data → no trail block');
});

// ─── Layout contract (C-gate closeout 2026-05-12) ──────────────────────────
//
// The first-row pill content (icon / name / spinner / check / cross) MUST
// be wrapped in `.tool-call-pill-main` so it stays horizontal even after
// the outer `.tool-call-pill` becomes a column-flex container (for trail
// stacking).  The C-grade Codex regression hit was that an earlier draft
// of this commit had icon/name/spinner as DIRECT children of the
// column-flex pill, producing vertical-stack pills even when no trail
// was present.  These tests pin the wrapper presence + structural
// ordering so a future "simplify by removing the wrapper" refactor
// breaks loudly.

test('layout: first-row content wrapped in .tool-call-pill-main (running, no trail)', () => {
  const html = render([{ id: 'c1', name: 'bash', status: 'running' }]);
  // The wrapper must exist AND contain icon + name + spinner.
  assert.match(html, /<div class="tool-call-pill-main">[\s\S]*?<svg/, 'icon inside main wrapper');
  assert.match(html, /<div class="tool-call-pill-main">[\s\S]*?tool-call-pill-name">bash/, 'name inside main wrapper');
  assert.match(html, /<div class="tool-call-pill-main">[\s\S]*?tool-call-spinner[\s\S]*?<\/div>/, 'spinner inside main wrapper');
});

test('layout: no trail → .tool-call-pill has ONLY a .tool-call-pill-main child (no trail leak)', () => {
  // Three status variants — all must wrap first-row content uniformly,
  // and none should produce a `.tool-call-trail` element when no trail data.
  for (const status of ['running', 'ok', 'error']) {
    const html = render([{ id: 'c1', name: 'fetch_url', status }]);
    assert.match(html, /<div class="tool-call-pill [\w-]+">\s*<div class="tool-call-pill-main">/,
      `${status} chip: .tool-call-pill-main must be the direct child of .tool-call-pill`);
    assert.doesNotMatch(html, /tool-call-trail/, `${status} chip without trail data must not emit any .tool-call-trail markup`);
  }
});

test('layout: trail present → .tool-call-pill has main + trail in that order', () => {
  const html = render([{
    id: 'c1', name: 'fetch_url', status: 'error',
    evidenceTrail: [{ tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' }],
  }]);
  // Pill main wrapper must appear BEFORE the trail in document order
  // (so column flex stacks correctly: row 1 = main, row 2 = trail).
  const mainIdx = html.indexOf('class="tool-call-pill-main"');
  const trailIdx = html.indexOf('class="tool-call-trail"');
  assert.ok(mainIdx >= 0, 'main wrapper must be present');
  assert.ok(trailIdx >= 0, 'trail must be present (error status forces show)');
  assert.ok(mainIdx < trailIdx, 'main wrapper must precede trail in DOM order');
});

test('layout: status indicators (spinner/check/cross) live INSIDE main wrapper, not outside', () => {
  // Each status's distinguishing element must sit inside the
  // .tool-call-pill-main wrapper so the C-gate regression
  // ("indicator stacked under name on column-flex pill") can't recur.
  const running = render([{ id: 'r', name: 'bash', status: 'running' }]);
  const ok = render([{ id: 'o', name: 'bash', status: 'ok' }]);
  const err = render([{ id: 'e', name: 'bash', status: 'error' }]);
  // Use a non-greedy match between main wrapper open and its matching close.
  // We approximate the close by looking for the trail's `<ul>` or the pill's `</div>` — whichever comes first.
  function mainContent(html) {
    const m = html.match(/<div class="tool-call-pill-main">([\s\S]*?)<\/div>/);
    return m ? m[1] : '';
  }
  assert.match(mainContent(running), /tool-call-spinner/, 'spinner must be inside .tool-call-pill-main');
  assert.match(mainContent(ok), /tool-call-check/, 'check must be inside .tool-call-pill-main');
  assert.match(mainContent(err), /tool-call-x/, 'cross must be inside .tool-call-pill-main');
});

// ─── inclusion heuristic (mirrors G-1e prompt rules) ────────────────────────

test('ok status + single-tier trail → trail NOT rendered (noise gate)', () => {
  const html = render([{
    id: 'c1', name: 'fetch_url', status: 'ok',
    evidenceTrail: [{ tier: 'jina', outcome: 'ok', latencyMs: 220 }],
  }]);
  assert.doesNotMatch(html, /tool-call-trail<\/ul>|tool-call-trail">/);
});

test('ok status + multi-tier trail → trail rendered (fallback informative)', () => {
  const html = render([{
    id: 'c1', name: 'fetch_url', status: 'ok',
    evidenceTrail: [
      { tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' },
      { tier: 'direct', outcome: 'ok', latencyMs: 220 },
    ],
  }]);
  assert.match(html, /<ul class="tool-call-trail">/);
  assert.match(html, /tool-call-trail-tier">jina<\/span>/);
  assert.match(html, /tool-call-trail-outcome is-fail">fail<\/span>/);
  assert.match(html, /tool-call-trail-tier">direct<\/span>/);
});

test('error status + single-tier trail → trail rendered (failure must show)', () => {
  const html = render([{
    id: 'c1', name: 'fetch_url', status: 'error',
    evidenceTrail: [{ tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' }],
  }]);
  assert.match(html, /<ul class="tool-call-trail">/);
  assert.match(html, /tool-call-trail-tier">jina<\/span>/);
});

test('error status + empty trail → no trail block (defensive)', () => {
  const html = render([{ id: 'c1', name: 'x', status: 'error', evidenceTrail: [] }]);
  assert.doesNotMatch(html, /tool-call-trail/);
});

// ─── trail item detail formatting ───────────────────────────────────────────

test('trail item with reason + latency → "reason · Nms" detail', () => {
  const html = render([{
    id: 'c1', name: 'fetch_url', status: 'error',
    evidenceTrail: [{ tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' }],
  }]);
  assert.match(html, /tool-call-trail-detail">timeout · 3500ms<\/span>/);
});

test('trail item with only latency → "Nms" detail', () => {
  const html = render([{
    id: 'c1', name: 'fetch_url', status: 'error',
    evidenceTrail: [{ tier: 'jina', outcome: 'fail', latencyMs: 220 }],
  }]);
  assert.match(html, /tool-call-trail-detail">220ms<\/span>/);
});

test('trail item with only reason → "reason" detail', () => {
  const html = render([{
    id: 'c1', name: 'fetch_url', status: 'error',
    evidenceTrail: [{ tier: 'yt-dlp', outcome: 'fail', reason: 'http-403' }],
  }]);
  assert.match(html, /tool-call-trail-detail">http-403<\/span>/);
});

test('trail item with neither reason nor latency → no detail span', () => {
  const html = render([{
    id: 'c1', name: 'fetch_url', status: 'error',
    evidenceTrail: [{ tier: 'jina', outcome: 'aborted' }],
  }]);
  assert.doesNotMatch(html, /tool-call-trail-detail/);
  // But the tier + outcome are still present
  assert.match(html, /tool-call-trail-tier">jina<\/span>/);
  assert.match(html, /tool-call-trail-outcome is-aborted">aborted<\/span>/);
});

test('latency is rounded to integer (no noisy decimals)', () => {
  const html = render([{
    id: 'c1', name: 'fetch_url', status: 'error',
    evidenceTrail: [{ tier: 'jina', outcome: 'fail', latencyMs: 234.789, reason: 'timeout' }],
  }]);
  assert.match(html, /timeout · 235ms/);
  assert.doesNotMatch(html, /234\.789/);
});

// ─── outcome → CSS class mapping ────────────────────────────────────────────

test('outcome classes: ok / fail / aborted / skip / unknown', () => {
  const html = render([{
    id: 'c1', name: 'fetch_url', status: 'error',
    evidenceTrail: [
      { tier: 'a', outcome: 'ok' },
      { tier: 'b', outcome: 'fail' },
      { tier: 'c', outcome: 'aborted' },
      { tier: 'd', outcome: 'skip' },
      { tier: 'e', outcome: 'novel-future-outcome' },
    ],
  }]);
  assert.match(html, /tool-call-trail-outcome is-ok">ok<\/span>/);
  assert.match(html, /tool-call-trail-outcome is-fail">fail<\/span>/);
  assert.match(html, /tool-call-trail-outcome is-aborted">aborted<\/span>/);
  assert.match(html, /tool-call-trail-outcome is-skip">skip<\/span>/);
  // unrecognized outcome → no `is-*` modifier (graceful neutral styling)
  assert.match(html, /tool-call-trail-outcome ">novel-future-outcome<\/span>/);
});

// ─── XSS defense ────────────────────────────────────────────────────────────

test('escapeHtml is applied to tier / outcome / reason', () => {
  const html = render([{
    id: 'c1', name: 'fetch_url', status: 'error',
    evidenceTrail: [{ tier: 'a<b&c', outcome: 'fail', reason: '<script>x</script>' }],
  }]);
  // Tier escaped
  assert.match(html, /a&lt;b&amp;c/);
  // Reason escaped
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  // No literal <script> tag in output (XSS check)
  assert.doesNotMatch(html, /<script>x<\/script>/);
});

test('call.name itself is escapeHtml\'d (pre-existing behavior, regression guard)', () => {
  const html = render([{ id: 'c1', name: '<img onerror=x>', status: 'running' }]);
  assert.match(html, /&lt;img onerror=x&gt;/);
  assert.doesNotMatch(html, /<img onerror=x>/);
});

// ─── multi-call composition ─────────────────────────────────────────────────

test('multiple calls: each call gets its own trail decision', () => {
  const html = render([
    {
      id: 'a', name: 'fetch_url', status: 'ok',
      evidenceTrail: [{ tier: 'jina', outcome: 'ok', latencyMs: 220 }], // single-tier success → no trail
    },
    {
      id: 'b', name: 'web_search', status: 'error',
      evidenceTrail: [{ tier: 'serp', outcome: 'fail', reason: 'http-503' }], // error → trail shown
    },
  ]);
  // First pill exists, no trail
  assert.match(html, /tool-call-pill-name">fetch_url/);
  // Second pill exists, with trail
  assert.match(html, /tool-call-pill-name">web_search/);
  assert.match(html, /tool-call-trail-tier">serp<\/span>/);
  // The trail mention applies to the second call — check the trail list
  // appears AFTER web_search in the document order.
  const fetchUrlIdx = html.indexOf('fetch_url');
  const trailIdx = html.indexOf('tool-call-trail');
  assert.ok(trailIdx > fetchUrlIdx, 'trail must follow the call name in DOM order');
});

// ─── malformed trail items ──────────────────────────────────────────────────

test('malformed trail items (non-object) → silently dropped, valid items still render', () => {
  const html = render([{
    id: 'c1', name: 'fetch_url', status: 'error',
    evidenceTrail: [null, undefined, 'string', { tier: 'jina', outcome: 'fail' }],
  }]);
  // The valid item rendered
  assert.match(html, /tool-call-trail-tier">jina<\/span>/);
  // Only ONE <li> rendered (not 4)
  const liCount = (html.match(/<li class="tool-call-trail-item">/g) || []).length;
  assert.equal(liCount, 1, 'malformed items must not produce empty <li>s');
});

test('all-malformed trail (no valid items) → no <ul class="tool-call-trail"> emitted', () => {
  const html = render([{
    id: 'c1', name: 'fetch_url', status: 'error',
    evidenceTrail: [null, undefined, 'string'],
  }]);
  assert.doesNotMatch(html, /tool-call-trail/);
});

// ─── internals smoke ────────────────────────────────────────────────────────

test('_internalsForTests.shouldRenderTrail mirrors G-1e prompt heuristic', () => {
  const { shouldRenderTrail } = _internalsForTests;
  assert.equal(shouldRenderTrail({ status: 'ok' }), false, 'no trail');
  assert.equal(shouldRenderTrail({ status: 'ok', evidenceTrail: [] }), false, 'empty trail');
  assert.equal(
    shouldRenderTrail({ status: 'ok', evidenceTrail: [{ tier: 'jina', outcome: 'ok' }] }),
    false,
    'single-tier success → noise gate',
  );
  assert.equal(
    shouldRenderTrail({
      status: 'ok',
      evidenceTrail: [
        { tier: 'jina', outcome: 'fail' },
        { tier: 'direct', outcome: 'ok' },
      ],
    }),
    true,
    'multi-tier success → fallback informative',
  );
  assert.equal(
    shouldRenderTrail({ status: 'error', evidenceTrail: [{ tier: 'x', outcome: 'fail' }] }),
    true,
    'error → always show',
  );
});

test('_internalsForTests.formatTrailDetail edge cases', () => {
  const { formatTrailDetail } = _internalsForTests;
  assert.equal(formatTrailDetail({}), '');
  assert.equal(formatTrailDetail({ reason: 'timeout' }), 'timeout');
  assert.equal(formatTrailDetail({ latencyMs: 220 }), '220ms');
  assert.equal(formatTrailDetail({ reason: 'timeout', latencyMs: 220 }), 'timeout · 220ms');
  // Non-numeric latency: skip
  assert.equal(formatTrailDetail({ latencyMs: 'oops' }), '');
  // Infinity: skip
  assert.equal(formatTrailDetail({ latencyMs: Infinity }), '');
});
