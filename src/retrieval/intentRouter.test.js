import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIntent,
  classifyRequest,
  intentAllowsUncertaintyMarker,
  intentRequiresVerification,
} from './intentRouter.js';

test('classifyIntent handles obvious casual and factual turns with rules only', async () => {
  assert.equal(await classifyIntent('hi'), 'casual');
  assert.equal(await classifyIntent('What is Singapore?'), 'factual');
  assert.equal(await classifyIntent('什么是向量数据库？'), 'factual');
});

test('short confirmations inherit previous factual task and risk, not standalone-greeting policy', async () => {
  const request = await classifyRequest('好', { contextMessages: [
    { role: 'user', content: '帮我写一份药物剂量说明' },
    { role: 'assistant', content: '需要核实一下，可以吗？' },
    { role: 'user', content: '好' },
  ] });
  assert.equal(request.taskType, 'creative');
  assert.equal(request.riskLevel, 'high');
  assert.equal(request.requiresVerification, true);
});

test('classifyIntent handles coding, creative, and high-stakes turns with rules', async () => {
  assert.equal(await classifyIntent('Please debug this Python function'), 'coding');
  assert.equal(await classifyIntent('帮我写一首诗'), 'creative');
  assert.equal(await classifyIntent('What dosage should I take?'), 'high-stakes');
});

test('intent verification gates stay narrow', () => {
  assert.equal(intentRequiresVerification('factual'), true);
  assert.equal(intentRequiresVerification('high-stakes'), true);
  assert.equal(intentRequiresVerification('coding'), false);
  assert.equal(intentAllowsUncertaintyMarker('creative'), false);
  assert.equal(intentAllowsUncertaintyMarker('factual'), true);
});

// 2026-11-14: four tests left here with the code they covered. The intent
// cache had no reader and no writer since classification became rules only
// (2026-10-24), so `lruGet` / `lruSet` had no caller either, and the test
// "classifyIntent cache is isolated" cleared an empty map and then asserted
// something the rules decide: it could not fail for the reason in its title.

test('short task instructions and long unclassified text are never labelled casual by length', async () => {
  const { classifyByRules, isStandaloneGreeting } = await import('./intentRouter.js');
  for (const text of ['一直查','今天的新闻','換背景','x'.repeat(100)]) {
    assert.equal(classifyByRules(text),null);
    assert.equal(await classifyIntent(text),'factual');
  }
  for(const text of ['hello','你好','hola','こんにちは','안녕하세요','ok']) {
    assert.equal(isStandaloneGreeting({text,messages:[{role:'user',content:text}]}),true);
    assert.equal(isStandaloneGreeting({text,messages:[{role:'assistant',content:'pending task'},{role:'user',content:text}]}),false);
    assert.equal(isStandaloneGreeting({text,messages:[{role:'user',attachments:[{kind:'image'}]}]}),false);
  }
});
