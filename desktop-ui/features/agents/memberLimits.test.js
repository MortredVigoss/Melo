import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_LIMIT_FLOORS, memberWorkTokens, memberWrapUpSeconds } from './memberLimits.js';
import * as domain from '../../../src/domain/agent/capabilities.js';
import { AGENT_LOOP_CONTRACT as C } from '../../../shared/agent/loopContract.js';

// The page cannot import the server's validation module, so it carries the same
// floors and the same arithmetic. They must never drift apart: the page would
// offer a minimum the server raises, or state a number the run does not get.
test('the page mirrors the server floors and the run budget arithmetic', () => {
  assert.deepEqual(MEMBER_LIMIT_FLOORS, domain.MEMBER_LIMIT_FLOORS);
  for (const total of [MEMBER_LIMIT_FLOORS.maxTokens, 32000, 64000, 200000]) assert.equal(memberWorkTokens(total), domain.memberWorkTokens(total), String(total));
  assert.equal(memberWorkTokens(32000), 19760);
  assert.equal(memberWrapUpSeconds() * 1000, C.delivery.deadlineMs);
  assert.equal(domain.memberWorkMs(MEMBER_LIMIT_FLOORS.timeoutMs) > 0, true);
});
