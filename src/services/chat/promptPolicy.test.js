import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLanguageConstraint, buildOutputHardConstraints } from './systemPrompt.js';
import { classifyIntent, intentRequiresVerification } from '../../retrieval/intentRouter.js';
import { applyVerificationToReply } from '../../retrieval/selfVerification.js';

test('language default yields to explicit translation and persona language requests', () => {
  const prompt = buildLanguageConstraint('请把这段翻译成英文');
  assert.match(prompt, /explicit.*(?:language|translation)/i);
  assert.doesNotMatch(prompt, /NO EXCEPTIONS|ENTIRELY|Do NOT mix languages/);
});

test('desktop output permits requested formatting without weakening safety', () => {
  const prompt = buildOutputHardConstraints();
  assert.match(prompt, /explicit.*format/i);
  assert.match(prompt, /safety|approval/i);
  assert.doesNotMatch(prompt, /no \*\*|highest priority/);
});

test('risk is independent of writing and coding intent', async () => {
  assert.equal(await classifyIntent('帮我写一份药物剂量说明'), 'creative');
  assert.equal(intentRequiresVerification({ taskType: 'creative', riskLevel: 'high' }), true);
  assert.equal(intentRequiresVerification({ taskType: 'coding', riskLevel: 'high' }), true);
  assert.equal(intentRequiresVerification({ taskType: 'creative', riskLevel: 'normal' }), false);
});

test('self correction replaces the wrong claim instead of appending a contradiction', () => {
  const reply = applyVerificationToReply('The date is 2025. Keep the receipt.', {
    verdict: 'CORRECTED', correction: 'The date is 2024.', originalClaim: 'The date is 2025.',
  });
  assert.equal(reply, 'The date is 2024. Keep the receipt.');
});

test('unverified facts remain labelled on remote channels', () => {
  assert.match(applyVerificationToReply('答案尚不确定。', { verdict: 'UNVERIFIED' }, { channelKind: 'remote' }), /未能核实/);
});
