import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBehavior, behaviorEnvironment } from '../../shared/agent/runtimeBehavior.js';
test('typed flags preserve defaults and explicit false environment overrides', () => {
  for (const flag of ['0','false','FALSE']) {
    assert.equal(resolveBehavior({behavior:{browserControl:true}}, {MELO_CDP_ENABLED:flag}).browserControl.value, false);
  }
  assert.equal(resolveBehavior({}, {MELO_CDP_ENABLED:'true'}).browserControl.value,true);
  assert.equal(resolveBehavior({behavior:{mediaExtraction:true}}, {MELO_DISABLE_MEDIA:'1'}).mediaExtraction.value,false);
  assert.equal(resolveBehavior({}, {MELO_CDP_ENABLED:'invalid'}).browserControl.source,'config');
  assert.equal(behaviorEnvironment({toolChainHistory:true},{}).MELO_TOOL_CHAIN_HISTORY,'1');
  assert.equal(behaviorEnvironment({behavior:{toolChainHistory:false}},{}).MELO_TOOL_CHAIN_HISTORY,'0');
});
