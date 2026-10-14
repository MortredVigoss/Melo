import { randomUUID, createHash } from 'node:crypto';
import { currentRequestContext } from '../runtime/requestScope.js';

const epoch = randomUUID();
let sequence = 0, retainedBytes = 0;
const snapshots = new Map();
const MAX_BYTES = 32 * 1024 * 1024;
const isBootstrap = value => value && value.settings && value.customize && Array.isArray(value.chats);

// Deltas are opt-in; old native clients keep receiving complete bootstraps.
// Baselines are scoped to home and bounded by bytes, never by client-supplied IDs.
export function encodeBootstrap(payload, { home, baseToken } = {}) {
  if (!isBootstrap(payload)) return payload?.bootstrap
    ? { ...payload, bootstrap: encodeBootstrap(payload.bootstrap, { home, baseToken }) } : payload;
  const base = snapshots.get(baseToken);
  const validBase = base?.home === home ? base : null;
  const hashes = {}, set = {};
  let bytes = 0;
  for (const [key,value] of Object.entries(payload)) {
    if (key === '_snapshot') continue;
    const json = JSON.stringify(value);
    hashes[key] = createHash('sha256').update(json ?? 'null').digest('hex');
    bytes += Buffer.byteLength(json ?? 'null');
    if (validBase?.hashes[key] !== hashes[key]) set[key] = value;
  }
  const token = randomUUID();
  const meta = { token, epoch, sequence: ++sequence, stateRevision: payload.stateRevision || 0 };
  snapshots.set(token,{home,hashes,bytes}); retainedBytes += bytes;
  while (snapshots.size > 64 || retainedBytes > MAX_BYTES) {
    const key = snapshots.keys().next().value;
    retainedBytes -= snapshots.get(key).bytes; snapshots.delete(key);
  }
  if (!validBase) return { ...payload, _snapshot: meta };
  return { kind: 'bootstrap-patch', baseToken, _snapshot: meta, set,
    remove: Object.keys(validBase.hashes).filter(key => !Object.hasOwn(hashes,key)) };
}

export function encodeResponse(payload) {
  const context = currentRequestContext();
  if (!context) return payload;
  return encodeBootstrap(payload,{home:context.home,baseToken:context.bootstrapBase});
}
