import { createHash } from 'node:crypto';
import { buildMemoryStoreEntries } from './snapshotBuilder.js';
import { patchMemories, replaceMemories } from './store.js';
import { applyMemoryContinuity } from './lifecycle.js';
import { enabledTiers } from './attic.js';
import { reconcileChatFacts } from './factRecords.js';
import { createRequestContext } from '../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../runtime/requestScope.js';

const indexed = new Map();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Persisted checkpoints already hash message bodies, extraction and media. Reuse
// that content identity: same-count edits and imported revisions cannot be missed.
// Only changed chats rebuild prompt/frame/scene rows. Namespace continuity still
// considers every cached source sharing that namespace (including other chats).
export function syncDerivedSnapshot(state, ctx, { throwOnError = false } = {}) {
  if (ctx.home && currentRequestContext()?.home !== ctx.home) return runWithRequestContext(createRequestContext({...currentRequestContext(),home:ctx.home}), () => syncDerivedSnapshot(state,ctx,{throwOnError}));
  const old = indexed.get(ctx.storePath), segments = new Map(), affected = new Set(), changedChats = [], factSignatures = new Map();
  const tiers = [...enabledTiers()].sort().join(',');
  let changed = !old;
  function segment(key, signature, build) {
    const prior = old?.segments.get(key);
    if (prior?.signature === signature) { segments.set(key,prior); return; }
    changed = true;
    const entries = build();
    for (const row of [...(prior?.entries || []), ...entries]) affected.add(row.namespace);
    segments.set(key,{signature,entries});
  }
  for (const chat of state.chats) {
    const sessionMemory = chat.sessionMemory;
    const metadata = Object.fromEntries(Object.keys(chat).filter(key => key !== 'messages' && key !== 'sessionMemory').map(key => [key,chat[key]]));
    const factSignature = hash({sessionMemory,id:chat.id,title:chat.title,agentId:chat.agentId,projectId:chat.projectId,source:chat.source});
    factSignatures.set(chat.id,factSignature);
    if (old?.factSignatures.get(chat.id) !== factSignature) changedChats.push(chat);
    // Legacy callers without a committed checkpoint still get content-based
    // invalidation; timestamps or counts alone would miss edits in place.
    const signature = hash({metadata, content:chat.checkpointId || {messages:chat.messages,sessionMemory}, tiers});
    segment(`chat:${chat.id}`,signature,()=>{
      return buildMemoryStoreEntries({...state,chats:[chat]}, {includeGlobals:false,continuity:false});
    });
  }
  const globals = {promptHistory:state.settings?.promptHistory,tasks:state.tasks,approvals:state.approvals,agentProfiles:state.agentProfiles,
    chatProjects:state.chats.map(chat=>[chat.id,chat.projectId])};
  segment('global',hash(globals),()=>buildMemoryStoreEntries(state,{includeChats:false,continuity:false}));
  for (const [key,prior] of old?.segments || []) if (!segments.has(key)) {
    changed=true;for(const row of prior.entries)affected.add(row.namespace);
  }
  if (!changed) return false;
  const rows = new Map();
  // Preserve the snapshot's deterministic winner for IDs shared by speakers.
  for(const {entries} of segments.values())for(const row of entries)rows.set(row.id,row);
  const fresh = applyMemoryContinuity([...rows.values()].filter(row=>!old || affected.has(row.namespace)));
  try {
    if (!old) replaceMemories(fresh,{storePath:ctx.storePath});
    else patchMemories(fresh,{storePath:ctx.storePath,deleteIds:[...old.ids].filter(id=>!rows.has(id))});
    // Canonical facts are reconciled on writes, never during prompt retrieval.
    for (const chat of changedChats) reconcileChatFacts(chat);
    indexed.set(ctx.storePath,{segments,ids:new Set(rows.keys()),factSignatures});
    return true;
  } catch (error) {
    if (throwOnError) throw error;
    // Retain the last committed cache, so the identical failed update retries.
    console.warn(`Derived memory update deferred: ${error.message}`);
    return false;
  }
}
export function resetDerivedMemoryCacheForTests() { indexed.clear(); }
