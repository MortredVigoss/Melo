import test from 'node:test';
import { generateAgentLoopContract, swiftCopyAvailable } from './generate-agent-loop-contract.js';

// The iPhone copy of shared/protocol/agent-loop.json must match the checked-in file.
test('the Swift agent-loop contract embeds the current shared JSON', async t => {
  if (!await swiftCopyAvailable()) return t.skip('ios/ sources are not part of this checkout');
  await generateAgentLoopContract({ check: true });
});
