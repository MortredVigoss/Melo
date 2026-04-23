// Unit tests for the frontend citation renderer. Covers the pure
// parse/render helpers; the drawer DOM + global click plumbing needs a real
// document and is covered by the browser integration harness.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCiteSegments,
  renderInlineSegmentWithCites,
  collectCitationsByMessageId,
} from './citationRenderer.js';

function escapeHtml(s = '') {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── parseCiteSegments ──────────────────────────────────────────────────────

test('parseCiteSegments returns a single text segment when there are no cites', () => {
  const segs = parseCiteSegments('Just a sentence.');
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { kind: 'text', text: 'Just a sentence.' });
});

test('parseCiteSegments splits a text/cite/text sequence', () => {
  const raw =
    'Per the spec, <cite data-cite-id="c1" src="a.md" lines="3-5">the rule holds</cite> in all cases.';
  const segs = parseCiteSegments(raw);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].kind, 'text');
  assert.equal(segs[1].kind, 'cite');
  assert.equal(segs[1].src, 'a.md');
  assert.equal(segs[1].startLine, 3);
  assert.equal(segs[1].endLine, 5);
  assert.equal(segs[1].quote, 'the rule holds');
  assert.equal(segs[2].kind, 'text');
});

test('parseCiteSegments handles a single-line cite', () => {
  const segs = parseCiteSegments('<cite src="f.md" lines="9">q</cite>');
  assert.equal(segs[0].kind, 'cite');
  assert.equal(segs[0].startLine, 9);
  assert.equal(segs[0].endLine, 9);
});

test('parseCiteSegments degrades malformed tags to inner text', () => {
  // Missing lines → no pill, inner text kept
  const segs = parseCiteSegments('<cite src="a.md">bare claim</cite>');
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { kind: 'text', text: 'bare claim' });
});

test('parseCiteSegments handles multiple cites in one chunk', () => {
  const raw =
    'A <cite src="a.md" lines="1">q1</cite> and B <cite src="b.md" lines="2-4">q2</cite>.';
  const segs = parseCiteSegments(raw);
  assert.equal(segs.filter(s => s.kind === 'cite').length, 2);
});

// ─── renderInlineSegmentWithCites ──────────────────────────────────────────

test('renderInlineSegmentWithCites emits pills with numeric indices', () => {
  const html = renderInlineSegmentWithCites(
    'A <cite src="a.md" lines="1">q1</cite> B <cite src="b.md" lines="2">q2</cite>',
    escapeHtml,
  );
  assert.match(html, /class="cite-pill"/);
  assert.match(html, /data-cite-pill/);
  assert.match(html, /data-cite-src="a.md"/);
  assert.match(html, /data-cite-src="b.md"/);
  assert.match(html, /<span class="cite-pill-num">1<\/span>/);
  assert.match(html, /<span class="cite-pill-num">2<\/span>/);
});

test('renderInlineSegmentWithCites escapes text surrounding pills', () => {
  const html = renderInlineSegmentWithCites(
    '<b>not html</b> <cite src="a.md" lines="1">q</cite>',
    escapeHtml,
  );
  // The surrounding text is HTML-escaped; the pill HTML is untouched.
  assert.ok(html.includes('&lt;b&gt;not html&lt;/b&gt;'));
  assert.match(html, /data-cite-pill/);
});

test('renderInlineSegmentWithCites passes quote through to the pill dataset', () => {
  const html = renderInlineSegmentWithCites(
    '<cite src="a.md" lines="1">claim with spaces</cite>',
    escapeHtml,
  );
  assert.match(html, /data-cite-quote="claim with spaces"/);
});

// ─── collectCitationsByMessageId ───────────────────────────────────────────

test('collectCitationsByMessageId indexes only messages with citations', () => {
  const map = collectCitationsByMessageId([
    { id: 'm1', citations: [{ id: 'c1', src: 'a.md', startLine: 1, endLine: 1, quote: 'q' }] },
    { id: 'm2' },
    { id: 'm3', citations: [] },
    null,
  ]);
  assert.deepEqual(Object.keys(map), ['m1']);
  assert.equal(map.m1.length, 1);
});

test('collectCitationsByMessageId tolerates bad inputs', () => {
  assert.deepEqual(collectCitationsByMessageId(null), {});
  assert.deepEqual(collectCitationsByMessageId(undefined), {});
  assert.deepEqual(collectCitationsByMessageId([]), {});
});
