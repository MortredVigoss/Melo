import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLoopLimits } from './loopLimits.js';
import { normalizeCollaboration } from '../../src/domain/agent/capabilities.js';
import { createRunBudget, extendBudget, recordUsage } from './runBudget.js';
import { executionScene } from './execution.js';
import { sessionEvents } from '../../src/shared/sessionEvents.js';

test('main, member and skill defaults are independent; saved smaller limits survive', () => {
  assert.deepEqual(resolveLoopLimits(), {maxIterations:40,minIterations:10,maxRounds:64,maxToolCalls:200,deadlineMs:1800000});
  assert.equal(normalizeCollaboration().maxIterations,20);
  assert.equal(normalizeCollaboration({maxTaskIterations:16,maxIterations:8}).maxIterations,8);
  assert.equal(resolveLoopLimits({maxIterations:16}).maxIterations,16);
  assert.equal(resolveLoopLimits({maxIterations:2}).maxIterations,2);
  assert.equal(resolveLoopLimits({maxIterations:999}).maxIterations,64);
  assert.equal(normalizeCollaboration({maxTaskIterations:64}).maxTaskIterations,64);
});

test('nothing but the configured maximum changes the limits; a budget that is extended keeps what was used', () => {
  // A `route` used to enlarge the limits for a task that automatic model selection had classified as deep.
  // That selection is retired on every host (2026-11-14): the input is ignored.
  const ordinary = {maxIterations:40,minIterations:10,maxRounds:64,maxToolCalls:200,deadlineMs:1800000};
  assert.deepEqual(resolveLoopLimits({route:{mode:'smart',deepTask:true}}), ordinary);
  assert.deepEqual(resolveLoopLimits({maxIterations:16,route:{mode:'smart',deepTask:true}}), {...ordinary,maxIterations:16});
  // Extending a root budget (a team plan still does this) never resets what the run has spent.
  let now=100;
  const budget=createRunBudget({now:()=>now}); recordUsage(budget,{providerCalls:1,inputTokens:50}); now+=3000;
  extendBudget(budget,{deadlineMs:budget.startedAt+2700000-now,maxToolCalls:300});
  assert.equal(budget.deadlineAt,2700100); assert.equal(budget.maxInputTokens,400000); assert.equal(budget.used.inputTokens,50);
});

test('300 tool observations remain displayable', () => {
  let scene=executionScene({action:'create',runId:'deep',chatId:'chat',query:'research',at:'2026-10-27T00:00:00Z'});
  for(let i=0;i<300;i++) scene=executionScene({action:'event',scene,event:{id:`tool-${i}`,kind:'operation',name:'read',status:'completed',output:`result ${i}`},at:'2026-10-27T00:00:01Z'});
  assert.equal(scene.operations.length,300);
  assert.ok(sessionEvents(scene).some(row=>JSON.stringify(row).includes('tool-299')));
});
