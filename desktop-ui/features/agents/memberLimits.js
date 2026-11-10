// The member limits on the Agent page. A member's token cap and timeout are
// totals for its whole run; part of each is held back for wrapping up, so a
// value at or below that part left the member nothing to work with.
// The floors mirror MEMBER_LIMIT_FLOORS in src/domain/agent/capabilities.js
// (that module is not served to the browser) and the arithmetic mirrors
// shared/agent/runBudget.js; memberLimits.test.js keeps all three equal.
import { AGENT_LOOP_CONTRACT as C } from '../../../shared/agent/loopContract.js';

export const MEMBER_LIMIT_FLOORS = Object.freeze({ maxTokens: 20000, timeoutMs: 120000 });

// Tokens a member can spend on the work itself out of a total cap.
export function memberWorkTokens(total) {
  const held = Math.min(C.delivery.inputTokens, Math.floor(total / 4), Math.floor(total / 16)) + C.delivery.outputTokens + C.delivery.checkOutputTokens;
  return Math.max(0, total - held);
}

// Seconds of a member's timeout kept for wrapping up.
export const memberWrapUpSeconds = () => Math.round(C.delivery.deadlineMs / 1000);
