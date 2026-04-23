// Unit tests for the citation service.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCitationInstructions,
  extractCitations,
  CITATION_TAG_GLOBAL_PATTERN,
} from './citation.js';

// ─── buildCitationInstructions ──────────────────────────────────────────────

test('buildCitationInstructions is empty when Demon is off', () => {
  assert.equal(buildCitationInstructions({ enabled: false }), '');
  assert.equal(buildCitationInstructions(), '');
});

test('buildCitationInstructions is empty for remote channels', () => {
  assert.equal(
    buildCitationInstructions({ enabled: true, isRemoteChannel: true, hasProjectFiles: true }),
    '',
  );
});

test('buildCitationInstructions is empty when the project has no files', () => {
  assert.equal(
    buildCitationInstructions({ enabled: true, isRemoteChannel: false, hasProjectFiles: false }),
    '',
  );
});

test('buildCitationInstructions names the tag shape and the gating rules', () => {
  const text = buildCitationInstructions({
    enabled: true,
    isRemoteChannel: false,
    hasProjectFiles: true,
  });
  assert.ok(text.includes('<cite'));
  assert.ok(text.includes('src='));
  assert.ok(text.includes('lines='));
  // Rejection rules must be present so the model knows NOT to cite general
  // knowledge or prior chat turns.
  assert.ok(/General knowledge|common sense/i.test(text));
  assert.ok(/Chat history|prior user messages/i.test(text));
});

// ─── extractCitations ───────────────────────────────────────────────────────

test('extractCitations returns empty citations for plain text', () => {
  const { text, citations } = extractCitations('Just a reply.');
  assert.equal(text, 'Just a reply.');
  assert.deepEqual(citations, []);
});

test('extractCitations parses a single well-formed tag', () => {
  const raw = 'According to <cite src="docs/a.md" lines="10-12">the spec</cite> this holds.';
  const { text, citations } = extractCitations(raw);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].src, 'docs/a.md');
  assert.equal(citations[0].startLine, 10);
  assert.equal(citations[0].endLine, 12);
  assert.equal(citations[0].quote, 'the spec');
  assert.ok(text.includes('data-cite-id="c1"'));
  assert.ok(text.includes('src="docs/a.md"'));
  assert.ok(text.includes('lines="10-12"'));
});

test('extractCitations collapses single-line citations', () => {
  const raw = 'Claim <cite src="x.md" lines="7">fact</cite> here.';
  const { citations } = extractCitations(raw);
  assert.equal(citations[0].startLine, 7);
  assert.equal(citations[0].endLine, 7);
});

test('extractCitations accepts en-dash and colon line separators', () => {
  const a = extractCitations('<cite src="f.md" lines="3–9">q</cite>').citations[0];
  const b = extractCitations('<cite src="f.md" lines="3:9">q</cite>').citations[0];
  assert.equal(a.startLine, 3);
  assert.equal(a.endLine, 9);
  assert.equal(b.startLine, 3);
  assert.equal(b.endLine, 9);
});

test('extractCitations caps a runaway line span', () => {
  const { citations } = extractCitations('<cite src="f.md" lines="1-99999">q</cite>');
  // End line capped — we just require it to be much less than 99999.
  assert.ok(citations[0].endLine < 500);
  assert.equal(citations[0].startLine, 1);
});

test('extractCitations assigns sequential ids across multiple tags', () => {
  const raw = [
    'A <cite src="a.md" lines="1">q1</cite>',
    'B <cite src="b.md" lines="2">q2</cite>',
    'C <cite src="c.md" lines="3">q3</cite>',
  ].join(' and ');
  const { citations } = extractCitations(raw);
  assert.equal(citations.length, 3);
  assert.deepEqual(citations.map(c => c.id), ['c1', 'c2', 'c3']);
});

test('extractCitations strips tags on remote channels, preserving inner text', () => {
  const raw = 'The <cite src="a.md" lines="1">important claim</cite> is here.';
  const { text, citations } = extractCitations(raw, { isRemoteChannel: true });
  assert.equal(text, 'The important claim is here.');
  assert.deepEqual(citations, []);
});

test('extractCitations drops malformed tags to inner text (no broken markup)', () => {
  const missingSrc = extractCitations('<cite lines="1">q</cite>');
  assert.deepEqual(missingSrc.citations, []);
  assert.equal(missingSrc.text, 'q');

  const missingLines = extractCitations('<cite src="f.md">q</cite>');
  assert.deepEqual(missingLines.citations, []);
  assert.equal(missingLines.text, 'q');

  const emptyInner = extractCitations('<cite src="f.md" lines="1"></cite>');
  assert.deepEqual(emptyInner.citations, []);
  assert.equal(emptyInner.text, '');
});

test('extractCitations rejects absolute and traversal paths', () => {
  const abs = extractCitations('<cite src="/etc/passwd" lines="1">leak</cite>');
  assert.deepEqual(abs.citations, []);
  assert.equal(abs.text, 'leak');

  const traversal = extractCitations('<cite src="../secrets.env" lines="1">leak</cite>');
  assert.deepEqual(traversal.citations, []);
  assert.equal(traversal.text, 'leak');

  const windowsAbs = extractCitations('<cite src="C:/etc/hosts" lines="1">leak</cite>');
  assert.deepEqual(windowsAbs.citations, []);
  assert.equal(windowsAbs.text, 'leak');
});

test('extractCitations strips leading ./ from src for consistency', () => {
  const { citations } = extractCitations('<cite src="./docs/a.md" lines="1">q</cite>');
  assert.equal(citations[0].src, 'docs/a.md');
});

test('extractCitations collapses whitespace in inner quote', () => {
  const raw = '<cite src="a.md" lines="1">a\n  \tmulti-line   quote</cite>';
  const { citations } = extractCitations(raw);
  assert.equal(citations[0].quote, 'a multi-line quote');
});

test('extractCitations truncates very long inner quote', () => {
  const long = 'x'.repeat(1000);
  const { citations } = extractCitations(`<cite src="a.md" lines="1">${long}</cite>`);
  assert.ok(citations[0].quote.length <= 400);
});

test('extractCitations is immune to attribute order', () => {
  const a = extractCitations('<cite src="a.md" lines="1">q</cite>').citations[0];
  const b = extractCitations('<cite lines="1" src="a.md">q</cite>').citations[0];
  assert.equal(a.src, b.src);
  assert.equal(a.startLine, b.startLine);
});

test('extractCitations re-emits tags in a canonical, stable attribute order', () => {
  const a = extractCitations('<cite src="a.md" lines="1">q</cite>').text;
  const b = extractCitations('<cite lines="1" src="a.md">q</cite>').text;
  assert.equal(a, b);
});

test('CITATION_TAG_GLOBAL_PATTERN finds every tag in the reply', () => {
  const raw = '<cite src="a" lines="1">q</cite> ... <cite src="b" lines="2">r</cite>';
  const matches = raw.match(CITATION_TAG_GLOBAL_PATTERN);
  assert.equal(matches.length, 2);
});
