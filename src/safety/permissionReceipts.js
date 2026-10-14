// A lost HTTP response must not make an already-applied decision look failed.
// Scope by home, expire quickly, and bound memory independently of task history.
import { resolveRuntimePaths } from '../runtime/paths.js';
const receipts = new Map();
const key = requestId => JSON.stringify([resolveRuntimePaths().home, requestId]);
export function permissionReceipt(requestId) {
  const receipt = receipts.get(key(requestId));
  if (!receipt || receipt.expires < Date.now()) return null;
  return { ok: true, alreadyResolved: true };
}
export function rememberPermissionDecision(requestId) {
  receipts.set(key(requestId), { expires: Date.now() + 5 * 60_000 });
  while (receipts.size > 256) receipts.delete(receipts.keys().next().value);
}
