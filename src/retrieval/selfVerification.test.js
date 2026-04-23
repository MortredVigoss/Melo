import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyVerificationToReply,
  buildUncertaintySignalingRules,
  parseUncertaintyMarker,
} from './selfVerification.js';

test('buildUncertaintySignalingRules mentions the explicit marker contract', () => {
  const text = buildUncertaintySignalingRules();
  assert.match(text, /\[UNCERTAIN:/);
  assert.match(text, /VERY LAST line/);
});

test('parseUncertaintyMarker extracts explicit marker and strips it from reply', () => {
  const parsed = parseUncertaintyMarker('Answer body.\n[UNCERTAIN: release date]');
  assert.deepEqual(parsed, {
    hasMarker: true,
    uncertainClaim: 'release date',
    cleanReply: 'Answer body.',
    source: 'explicit',
  });
});

test('parseUncertaintyMarker falls back to fuzzy uncertainty language', () => {
  const parsed = parseUncertaintyMarker('I am not entirely sure, but I think it shipped in 2025.');
  assert.equal(parsed.hasMarker, true);
  assert.equal(parsed.source, 'fuzzy');
  assert.match(parsed.uncertainClaim, /not entirely sure/i);
});

test('applyVerificationToReply appends correction or warning only when needed', () => {
  assert.match(
    applyVerificationToReply('Base answer', {
      verdict: 'CORRECTED',
      correction: 'The correct version was 2.1.',
    }),
    /Self-check correction: The correct version was 2\.1\./,
  );
  assert.match(
    applyVerificationToReply('Base answer', {
      verdict: 'UNVERIFIED',
      correction: '',
    }),
    /could not fully verify/i,
  );
  assert.equal(
    applyVerificationToReply('Base answer', {
      verdict: 'VERIFIED',
      correction: '',
    }),
    'Base answer',
  );
});
