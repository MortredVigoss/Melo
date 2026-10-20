import { createHash } from 'node:crypto';
import { createRepeatGuard as portableGuard, toolCallFingerprint as canonicalCall } from '../../shared/agent/repeatGuard.js';

// Keep the original Node fingerprint API; the Host owns crypto, Core owns policy.
export function toolCallFingerprint(name, args) {
  return createHash('sha1').update(canonicalCall(name, args)).digest('hex').slice(0, 24);
}
export function createRepeatGuard(options = {}) {
  return portableGuard({ ...options, fingerprint: toolCallFingerprint });
}
