import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLoopLimits } from './loopLimits.js';
import { selectRouting, escalateRouting } from './modelRouting.js';
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

test('only classified smart deep tasks enlarge limits; tier escalation does not reset budgets', () => {
  const candidate={connectionId:'local',model:'opaque',capabilities:{tools:true}};
  const input={mode:'smart',connectionId:'local',candidates:[candidate],policy:{allowEscalation:true,tiers:{light:[candidate],standard:[candidate],strong:[candidate]}}};
  for (const route of [selectRouting({...input,text:'deep research'}),selectRouting({...input,text:'analyze',judgment:{complexity:4,risk:'low',needs:{}}})]) {
    assert.deepEqual(resolveLoopLimits({route}),{maxIterations:64,minIterations:10,maxRounds:64,maxToolCalls:300,deadlineMs:2700000});
  }
  assert.equal(resolveLoopLimits({route:selectRouting({...input,text:'deep research',fixedModel:'opaque'})}).maxIterations,40);
  const ordinary=selectRouting({...input,text:'hi'});
  assert.equal(resolveLoopLimits({route:escalateRouting({...input,previous:ordinary,requested:true,sideEffects:true})}).maxIterations,40);
  let now=100;
  const budget=createRunBudget({now:()=>now}); recordUsage(budget,{providerCalls:1,inputTokens:50}); now+=3000;
  extendBudget(budget,{deadlineMs:budget.startedAt+2700000-now,maxToolCalls:300});
  assert.equal(budget.deadlineAt,2700100); assert.equal(budget.maxInputTokens,400000); assert.equal(budget.used.inputTokens,50);
});

test('300 tool observations remain displayable under the deep-task budget', () => {
  let scene=executionScene({action:'create',runId:'deep',chatId:'chat',query:'research',at:'2026-10-27T00:00:00Z'});
  for(let i=0;i<300;i++) scene=executionScene({action:'event',scene,event:{id:`tool-${i}`,kind:'operation',name:'read',status:'completed',output:`result ${i}`},at:'2026-10-27T00:00:01Z'});
  assert.equal(scene.operations.length,300);
  assert.ok(sessionEvents(scene).some(row=>JSON.stringify(row).includes('tool-299')));
});
