/**
 * desktop-ui/messageToolResults.test.js
 *
 * Pure render-string tests for the G-1d slice 2 chat-history trail
 * renderer.  Delegated heavy lifting (per-item HTML, escape, gating)
 * lives in evidenceTrailMarkup.js and is independently covered there —
 * these tests focus on the OUTER wrapping logic specific to message
 * history rendering: empty-array handling, per-tool-result row
 * construction, ok/error status class mapping, and the silent
 * filter-out behavior for uninformative entries.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessageToolResults } from './messageToolResults.js';

function escapeHtml(value = '') {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ─── empty / missing inputs ─────────────────────────────────────────────────

test('returns empty string when message has no toolResults', () => {
  assert.equal(renderMessageToolResults({}, escapeHtml), '');
  assert.equal(renderMessageToolResults({ toolResults: null }, escapeHtml), '');
  assert.equal(renderMessageToolResults({ toolResults: [] }, escapeHtml), '');
  assert.equal(renderMessageToolResults(null, escapeHtml), '');
  assert.equal(renderMessageToolResults(undefined, escapeHtml), '');
});

test('all entries uninformative (single-tier successes) → empty string (no empty wrapper)', () => {
  const html = renderMessageToolResults({
    toolResults: [
      { toolCallId: 'a', toolName: 'fetch_url', ok: true,
        evidenceTrail: [{ tier: 'jina', outcome: 'ok', latencyMs: 220 }] },
      { toolCallId: 'b', toolName: 'web_search', ok: true,
        evidenceTrail: [{ tier: 'serp', outcome: 'ok', latencyMs: 800 }] },
    ],
  }, escapeHtml);
  assert.equal(html, '', 'all single-tier successes → nothing to render → no outer wrapper');
});

test('mix of informative + uninformative → only informative entries render', () => {
  const html = renderMessageToolResults({
    toolResults: [
      // uninformative single-tier success → silent skip
      { toolCallId: 'a', toolName: 'fetch_url_easy', ok: true,
        evidenceTrail: [{ tier: 'jina', outcome: 'ok', latencyMs: 220 }] },
      // informative failure
      { toolCallId: 'b', toolName: 'fetch_url_hard', ok: false,
        evidenceTrail: [
          { tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'parse-empty' },
          { tier: 'direct', outcome: 'fail', latencyMs: 120, reason: 'parse-empty' },
        ] },
    ],
  }, escapeHtml);
  // Outer wrapper present
  assert.match(html, /<div class="message-tool-results">/);
  // The uninformative tool name must NOT appear (silently skipped)
  assert.doesNotMatch(html, /fetch_url_easy/);
  // The informative one IS rendered
  assert.match(html, /fetch_url_hard/);
  assert.match(html, /tool-call-trail-tier">jina<\/span>/);
  assert.match(html, /tool-call-trail-tier">direct<\/span>/);
  // Status badge: failure → is-error class + ✗ symbol
  assert.match(html, /class="message-tool-result is-error"/);
  assert.match(html, /class="message-tool-result-status">✗</);
});

// ─── single-tool informative cases ─────────────────────────────────────────

test('single failing tool: full row with name + ✗ + trail', () => {
  const html = renderMessageToolResults({
    toolResults: [{
      toolCallId: 'c1', toolName: 'fetch_url', ok: false,
      evidenceTrail: [
        { tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' },
        { tier: 'direct', outcome: 'fail', latencyMs: 120, reason: 'http-403' },
        { tier: 'playwright', outcome: 'fail', latencyMs: 2200, reason: 'timeout' },
      ],
    }],
  }, escapeHtml);
  assert.match(html, /class="message-tool-result is-error"/);
  assert.match(html, /class="message-tool-result-name">fetch_url<\/span>/);
  assert.match(html, /class="message-tool-result-status">✗</);
  // Trail items in order
  const jinaIdx = html.indexOf('>jina<');
  const dirIdx = html.indexOf('>direct<');
  const pwIdx = html.indexOf('>playwright<');
  assert.ok(jinaIdx < dirIdx && dirIdx < pwIdx, 'trail items render in given order');
});

test('multi-tier success (fallback happened, ok=true) → row rendered with ✓ + trail', () => {
  const html = renderMessageToolResults({
    toolResults: [{
      toolCallId: 'c1', toolName: 'fetch_url', ok: true,
      evidenceTrail: [
        { tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' },
        { tier: 'direct', outcome: 'ok', latencyMs: 220 },
      ],
    }],
  }, escapeHtml);
  assert.match(html, /class="message-tool-result is-ok"/);
  assert.match(html, /class="message-tool-result-status">✓</);
  // Trail still surfaced because multi-tier — fallback informative
  assert.match(html, /tool-call-trail-tier">jina<\/span>/);
  assert.match(html, /tool-call-trail-tier">direct<\/span>/);
});

// ─── multiple tools, mixed status ──────────────────────────────────────────

test('multiple informative tools: render in given order, each as its own row', () => {
  const html = renderMessageToolResults({
    toolResults: [
      { toolCallId: 'c1', toolName: 'fetch_url', ok: false,
        evidenceTrail: [{ tier: 'jina', outcome: 'fail', reason: 'timeout' }] },
      { toolCallId: 'c2', toolName: 'web_search', ok: false,
        evidenceTrail: [{ tier: 'serp', outcome: 'fail', reason: 'http-503' }] },
    ],
  }, escapeHtml);
  const rowCount = (html.match(/class="message-tool-result is-/g) || []).length;
  assert.equal(rowCount, 2);
  const fetchIdx = html.indexOf('>fetch_url<');
  const searchIdx = html.indexOf('>web_search<');
  assert.ok(fetchIdx < searchIdx, 'tool order preserved');
});

// ─── XSS defense ───────────────────────────────────────────────────────────

test('escapeHtml applied to toolName + delegates trail-item escape to shared module', () => {
  const html = renderMessageToolResults({
    toolResults: [{
      toolCallId: 'c1', toolName: '<img onerror=x>', ok: false,
      evidenceTrail: [{ tier: 'a<b&c', outcome: 'fail', reason: '<script>boom</script>' }],
    }],
  }, escapeHtml);
  assert.match(html, /&lt;img onerror=x&gt;/);
  assert.doesNotMatch(html, /<img onerror=x>/);
  assert.match(html, /a&lt;b&amp;c/);
  assert.match(html, /&lt;script&gt;boom&lt;\/script&gt;/);
});

// ─── defensive ─────────────────────────────────────────────────────────────

test('malformed toolResult entries (null / non-object) silently dropped', () => {
  const html = renderMessageToolResults({
    toolResults: [
      null,
      undefined,
      'string',
      { toolCallId: 'c1', toolName: 'fetch_url', ok: false,
        evidenceTrail: [{ tier: 'jina', outcome: 'fail' }] },
    ],
  }, escapeHtml);
  const rowCount = (html.match(/class="message-tool-result is-/g) || []).length;
  assert.equal(rowCount, 1, 'only the valid entry renders');
});

test('missing toolName fallback to literal "tool" (no NaN / undefined leak)', () => {
  const html = renderMessageToolResults({
    toolResults: [{
      ok: false, evidenceTrail: [{ tier: 'jina', outcome: 'fail' }],
    }],
  }, escapeHtml);
  assert.match(html, /class="message-tool-result-name">tool<\/span>/);
});

test('ok defaults to true when omitted (matches stateHydration normalize default)', () => {
  // Old state files may lack ok; renderer should pair with hydration default
  // (=true) so the row shows ✓ not ✗.  Real informativeness gate kicks in
  // via shouldShowEvidenceTrail — needs trail.length >= 2 OR explicit ok=false.
  const html = renderMessageToolResults({
    toolResults: [{
      toolName: 'fetch_url',
      // ok omitted → defaults to true via `tr.ok !== false`
      evidenceTrail: [
        { tier: 'jina', outcome: 'fail' },
        { tier: 'direct', outcome: 'ok' },
      ],
    }],
  }, escapeHtml);
  assert.match(html, /class="message-tool-result is-ok"/);
  assert.match(html, /class="message-tool-result-status">✓</);
});
