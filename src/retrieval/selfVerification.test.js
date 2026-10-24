import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyVerificationToReply,
  buildUncertaintySignalingRules,
  parseUncertaintyMarker,
  verifyUncertainClaim,
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

test('applyVerificationToReply replaces supported corrections or adds an uncertainty warning', () => {
  assert.equal(
    applyVerificationToReply('Base answer', {
      verdict: 'CORRECTED',
      correction: 'The correct version was 2.1.',
      originalClaim: 'Base answer',
    }),
    'The correct version was 2.1.',
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

test('verifier gets fresh tool evidence even when background context is huge', async () => {
  let received;
  const result = await verifyUncertainClaim({
    userMessage: 'When did it ship?', assistantReply: 'It shipped in 2025. Keep the receipt.', uncertainClaim: 'release year',
    config: { authMode: 'codex', model: 'configured-model' }, model: 'configured-model',
    contextBlocks: ['old memory '.repeat(10000)],
    toolEvidence: [{ id: 'tool:1', ok: true, source: 'https://example.test/release', text: 'Release year: 2024.' }],
    _createReply: async options => {
      received = options;
      return JSON.stringify({ verdict: 'CORRECTED', evidenceId: 'tool:1', evidenceQuote: 'Release year: 2024.', originalClaim: 'It shipped in 2025.', correction: 'It shipped in 2024.' });
    },
  });
  assert.equal(result.verdict, 'CORRECTED');
  assert.equal(received.model, 'configured-model');
  assert.equal(received.nativeWebSearchEnabled, false);
  assert.match(received.messages.at(-1).content, /Release year: 2024/);
  assert.equal(applyVerificationToReply('It shipped in 2025. Keep the receipt.', result), 'It shipped in 2024. Keep the receipt.');
});

for (const [name, payload, ok] of [
  ['missing evidence', { verdict: 'VERIFIED' }, true],
  ['invented quote', { verdict: 'VERIFIED', evidenceId: 'tool:1', evidenceQuote: 'invented fact' }, true],
  ['failed tool', { verdict: 'VERIFIED', evidenceId: 'tool:1', evidenceQuote: 'Observed fact' }, false],
  ['unlocatable correction', { verdict: 'CORRECTED', evidenceId: 'tool:1', evidenceQuote: 'Observed fact', originalClaim: 'Not in answer', correction: 'Replacement' }, true],
]) {
  test(`verifier fails closed for ${name}`, async () => {
    const result = await verifyUncertainClaim({
      assistantReply: 'Original answer', config: {},
      toolEvidence: [{ id: 'tool:1', ok, text: 'Observed fact' }],
      _createReply: async () => JSON.stringify(payload),
    });
    assert.equal(result.verdict, 'UNVERIFIED');
  });
}

test('verifier no-context does not call a model; abort propagates', async () => {
  const result = await verifyUncertainClaim({ config: {}, _createReply: () => { throw new Error('must not call'); } });
  assert.equal(result.reason, 'no-context-available');
  const controller = new AbortController();
  await assert.rejects(verifyUncertainClaim({
    config: {}, contextBlocks: ['some evidence'], signal: controller.signal,
    _createReply: async () => { controller.abort(new Error('user stopped')); throw controller.signal.reason; },
  }), /user stopped/);
});

test('verification honors the actual answering model even with an active connection default', async () => {
  let received;
  await verifyUncertainClaim({userMessage:'release?',assistantReply:'2024',uncertainClaim:'year',
    config:{activeLlmProfileId:'connection',model:'default-model',apiKey:'test-key',baseUrl:'https://example.test/v1'},model:'agent-model',
    toolEvidence:[{id:'source',ok:true,text:'Release year: 2024.'}],
    _createReply:async request=>{received=request;return '{"verdict":"UNVERIFIED"}';}});
  assert.equal(received.model,'agent-model');
  assert.equal(received.baseUrl,'https://example.test/v1');
  assert.equal(received.apiKey,'test-key');
});
