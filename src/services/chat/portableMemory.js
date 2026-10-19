import { createHash } from 'node:crypto';
import { iterateMemoryRecords, getMemoriesByIds, upsertMemory, withTransaction } from '../../memory/store.js';
import { quarantineDeletedChatFacts, PERSONAL_PROFILE_CATEGORIES } from '../../memory/factRecords.js';
import { factNamespace, normalizedFact } from '../../memory/factPolicy.js';
import { putWorkspace, stableJSON, mergeWorkspaces } from '../../../mobile-sync/workspaceProtocol.js';
import { BOOK_SECTIONS, BOOK_STATUSES, normalizeSection } from '../project/projectMemoryBook.js';

export const portableMemoryID = id => 'memory_' + createHash('sha256').update(id).digest('hex');
// Older clients omit validity. Preserve the real timestamp unless they
// explicitly change state; newer clients transmit validTo, including null.
function portableValidTo(v, prior) {
  if (Object.hasOwn(v, 'validTo')) return v.validTo || (['historical','forgotten'].includes(v.status) ? prior?.metadata.validTo || v.updatedAt : null);
  if (v.status === 'active' && (prior?.metadata.forgotten || prior?.metadata.quarantined)) return null;
  return prior?.metadata.validTo || (['historical','forgotten'].includes(v.status) ? v.updatedAt : null);
}
export function portableMemoryValue(row) {
  const m=row.metadata || {};
  return {id:portableMemoryID(row.id),memoryID:row.id,text:row.text,originalFact:m.originalFact || row.text,
    scope:m.scope || 'chat',status:m.mergedInto?'historical':m.forgotten?'forgotten':m.quarantined?'unconfirmed':m.validTo && Date.parse(m.validTo)<=Date.now()?'historical':'active',
    chatId:m.origin==='project'?'':m.chatId,...(m.origin==='project'?{origin:'project'}:{}),messageId:m.sourceMessageId || '',projectId:m.projectId || '',agentId:m.agentId || 'main',
    sourceText:String(m.sourceText || '').slice(0,1600),category:m.category || 'general',updatedAt:row.updatedAt,userEdited:m.userEdited===true,validTo:m.validTo || null,
    ...(m.mergedInto ? {mergedInto:m.mergedInto} : {}),
    // Project memory book projection (design 2B): optional on the wire.
    ...(m.scope==='project' && BOOK_SECTIONS.includes(m.section) ? {section:m.section} : {}),
    ...(m.scope==='project' && BOOK_STATUSES.includes(m.bookStatus) ? {bookStatus:m.bookStatus} : {})};
}
export function refreshPortableMemory(state) {
  const live=new Set(state.chats.filter(c=>!c.externalThreadKey).map(c=>c.id)), expected=new Map();
  for(const row of iterateMemoryRecords()) {
    if(!live.has(row.metadata.chatId) || row.metadata.audience==='remote')continue;
    const v=portableMemoryValue(row); if(!v.text || v.text.length>2000 || v.originalFact.length>2000)continue;
    expected.set(row.id,stableJSON(v));
    putWorkspace(state.mobileWorkspaceSync,'memory',v.id,v,state.mobileWorkspaceDevice);
  }
  return expected;
}

// The workspace and its redo journal must reach the state manifest before the
// separate memory database is touched. Replaying after a crash is idempotent.
export function stagePortableMemory(state, expected, baseline) {
  for (const r of state.mobileWorkspaceSync?.records || []) {
    if (r.kind !== 'memory') continue;
    for (const {value:v} of r.versions) {
      const prior = getMemoriesByIds([v.memoryID])[0];
      if (r.id !== portableMemoryID(v.memoryID) || v.id !== r.id) throw new Error('Memory identity mismatch');
      if (prior && (prior.kind !== 'session-fact' || prior.metadata.chatId !== v.chatId || prior.metadata.audience === 'remote')) throw new Error('Memory source mismatch');
      if (v.mergedInto !== undefined && v.mergedInto !== prior?.metadata.mergedInto) throw new Error('Memory merge source mismatch');
    }
  }
  state.mobileMemoryPending = {
    expected: [...expected],
    clocks: Object.fromEntries((baseline?.records || []).filter(r => r.kind === 'memory').map(r => [r.id,
      r.versions.reduce((clock, v) => { for (const [device,n] of Object.entries(v.clock)) clock[device] = Math.max(clock[device] || 0,n); return clock; }, {})])),
  };
  attachMemoryFacts(state);
}
function attachMemoryFacts(state) {
  for (const r of state.mobileWorkspaceSync?.records || []) {
    if (r.kind !== 'memory' || r.versions.length !== 1) continue;
    const v = r.versions[0].value;
    const chat = state.chats.find(c => c.id === v.chatId && !c.externalThreadKey);
    if (!chat) continue;
    if (r.id !== portableMemoryID(v.memoryID) || v.id !== r.id) throw new Error('Memory identity mismatch');
    chat.sessionMemory ||= [];
    if (!chat.sessionMemory.some(f => normalizedFact(f.fact) === normalizedFact(v.originalFact))) chat.sessionMemory.push({fact:v.originalFact,category:v.category,sourceMessageId:v.messageId,sourceRole:'user',sourceText:v.sourceText,extractedAt:v.updatedAt});
  }
}
export function replayPortableMemory(state) {
  const pending = state.mobileMemoryPending;
  if (!pending) return;
  const expected = new Map(pending.expected);
  for (const r of state.mobileWorkspaceSync?.records || []) {
    if (r.kind !== 'memory') continue;
    const v = r.versions[0].value, prior = getMemoriesByIds([v.memoryID])[0];
    if (!prior || stableJSON(portableMemoryValue(prior)) === expected.get(v.memoryID) || r.versions.some(x => stableJSON(x.value) === stableJSON(portableMemoryValue(prior)))) continue;
    // A desktop edit after the durable handoff is a concurrent version, never
    // an excuse to overwrite either edit. This actor only advances on recovery.
    const clock = {...pending.clocks[r.id]};
    clock['memory-recovery'] = (clock['memory-recovery'] || 0) + 1;
    state.mobileWorkspaceSync = mergeWorkspaces(state.mobileWorkspaceSync, {version:1,records:[{kind:'memory',id:r.id,versions:[{clock,value:portableMemoryValue(prior)}]}]});
  }
  applyPortableMemory(state, null, { clocks: pending.clocks || {} });
  state.mobileMemoryPending = null;
}
// Row-level conflict (design 2026-10-17 §3.4): the phone's edit arrives as a
// single version although the desktop row was edited by the user more
// recently than the phone's edit (both sides edited the same fact). The
// desktop row stays active; the phone version waits under `metadata.conflict`
// for 采用桌面版 / 采用手机版 (`editMemoryFact(id,{resolveConflict})`).
export const memoryConflict = v => ({text:v.text,scope:v.scope,editedAt:v.updatedAt,source:'mobile'});
const clockDominates = (a, b) => Object.entries(b || {}).every(([id, n]) => (a?.[id] || 0) >= n);
const clockAdvanced = (next, base, skip) => Object.entries(next || {}).some(([id, n]) => id !== skip && n > (base?.[id] || 0));
/**
 * Bug audit M16: wall clocks on two devices are not comparable, so the
 * timestamp rule alone is only a last resort. When the register clocks are
 * known (`clock` = the incoming version, `baseClock` = the version this
 * desktop last put, `device` = this desktop's actor id):
 *   - a version concurrent with the desktop's own is a conflict outright;
 *   - a version that advanced no non-desktop actor is not a phone edit at all;
 *   - otherwise (the phone built on the desktop's version) fall back to the
 *     timestamp rule, which still needs both sides to be user edits.
 */
export function hasMemoryConflict(prior, v, { clock = null, baseClock = null, device = null } = {}) {
  if (!prior || !v || v.status!=='active' || prior.metadata.forgotten || prior.metadata.mergedInto) return false;
  if (prior.text===v.text && (prior.metadata.scope || 'chat')===v.scope) return false;
  if (!v.userEdited || !prior.metadata.userEdited) return false;
  if (clock && baseClock) {
    if (!clockDominates(clock, baseClock)) return true;
    if (!clockAdvanced(clock, baseClock, device)) return false;
  }
  const desktopEditedAt = Date.parse(prior.metadata.editedAt || '');
  return Number.isFinite(desktopEditedAt) && desktopEditedAt > Date.parse(v.updatedAt);
}
// Sync-path counterpart of editMemoryFact's scope rules (bug audit M13): a
// row leaving project scope drops its book fields, a personal row outside the
// profile categories becomes a preference, and `bookStatus:'user'` is reserved
// for rows hand-written on the project page (which never sync).
function portableBookMetadata(v, prior) {
  if (v.scope!=='project') return {section:undefined,bookStatus:undefined,needsConfirmation:undefined};
  const priorStatus = prior?.metadata.bookStatus;
  const status = v.bookStatus==='user' ? (priorStatus==='user' || v.origin==='project' ? 'user' : 'confirmed')
    : BOOK_STATUSES.includes(v.bookStatus) ? v.bookStatus
    : BOOK_STATUSES.includes(priorStatus) ? priorStatus : 'confirmed';
  return {section:normalizeSection(v.section || prior?.metadata.section, v.category),bookStatus:status};
}
export function applyPortableMemory(state, expected=null, { clocks=null, projectSources=false } = {}) {
  const rows=(state.mobileWorkspaceSync?.records || []).filter(r=>r.kind==='memory');
  const local=new Map(state.chats.filter(c=>!c.externalThreadKey).map(c=>[c.id,c]));
  withTransaction(()=>{
    const deleted=new Set((state.mobileDeletedChats || []).map(r=>r.id));
    quarantineDeletedChatFacts(deleted);
    for(const register of rows) {
      const v=register.versions[0].value;
      if(register.id!==portableMemoryID(v.memoryID) || v.id!==register.id)throw new Error('Memory identity mismatch');
      const projectSource=projectSources && v.origin==='project' && !v.chatId && state.projects?.some(p=>p.id===v.projectId&&!p.deletedAt);
      if(!projectSource&&!local.has(v.chatId))continue;
      const prior=getMemoriesByIds([v.memoryID])[0];
      if(prior && (prior.kind!=='session-fact' || (projectSource ? prior.metadata.origin!=='project'||prior.metadata.projectId!==v.projectId : prior.metadata.chatId!==v.chatId) || prior.metadata.audience==='remote'))throw new Error('Memory source mismatch');
      if(v.mergedInto!==undefined && v.mergedInto!==prior?.metadata.mergedInto)throw new Error('Memory merge source mismatch');
      if(expected && (prior ? stableJSON(portableMemoryValue(prior)) : undefined)!==expected.get(v.memoryID))throw Object.assign(new Error('记忆在同步期间变化，请重新同步；新内容未被覆盖。'),{statusCode:409});
      if(register.versions.length>1) {
        // Concurrent desktop/phone edits (design 2026-10-17 §3.4 冲突): keep
        // the workspace-level conflict and expose the phone version on the row
        // so the memory page can offer 采用桌面版 / 采用手机版.
        if(prior) {
          const mine=stableJSON(portableMemoryValue(prior));
          const other=register.versions.map(x=>x.value).find(x=>stableJSON(x)!==mine) || null;
          const conflict=other ? memoryConflict(other) : prior.metadata.conflict || null;
          if(!prior.metadata.mobileSyncConflict || stableJSON(conflict)!==stableJSON(prior.metadata.conflict || null)) upsertMemory({...prior,metadata:{...prior.metadata,mobileSyncConflict:true,...(conflict ? {conflict} : {})}});
        }
        continue;
      }
      if(prior && stableJSON(portableMemoryValue(prior))===stableJSON(v)) {
        // The register settled on the desktop version (sync conflict UI): lift
        // the workspace flag; a pending row-level conflict stays until resolved.
        if(prior.metadata.mobileSyncConflict) { const metadata={...prior.metadata,mobileSyncConflict:false}; delete metadata.conflict; upsertMemory({...prior,metadata}); }
        continue;
      }
      if(prior && hasMemoryConflict(prior,v,{clock:register.versions[0].clock,baseClock:clocks?.[register.id] || null,device:state.mobileWorkspaceDevice || null})) {
        const conflict=memoryConflict(v);
        if(stableJSON(prior.metadata.conflict || null)!==stableJSON(conflict)) upsertMemory({...prior,metadata:{...prior.metadata,conflict}});
        continue;
      }
      const chat=local.get(v.chatId);
      const category=v.scope==='personal' && !PERSONAL_PROFILE_CATEGORIES.includes(v.category) ? 'user_preference' : v.category;
      const metadata={...prior?.metadata,originalFact:v.originalFact,chatId:projectSource?null:v.chatId,...(projectSource?{origin:'project'}:{}),chatTitle:chat?.title || '',projectId:v.projectId || null,agentId:v.agentId,
        sourceMessageId:v.messageId || null,sourceText:v.sourceText,sourceRole:'user',source:chat?.source || 'desktop',audience:'local',category,
        scope:v.scope,userEdited:v.userEdited,forgotten:v.status==='forgotten',quarantined:v.status==='unconfirmed',validTo:portableValidTo(v, prior),mobileSyncConflict:false,
        ...portableBookMetadata({...v,category}, prior)};
      for (const key of ['conflict','section','bookStatus','needsConfirmation']) if (metadata[key]===undefined) delete metadata[key];
      upsertMemory({id:v.memoryID,namespace:factNamespace({id:v.chatId,projectId:v.projectId},v.scope,v.agentId),kind:'session-fact',sourceId:projectSource?`project:${v.projectId}`:v.chatId,text:v.text,searchText:normalizedFact(v.text),createdAt:prior?.createdAt || v.updatedAt,updatedAt:v.updatedAt,metadata});
    }
  });
  attachMemoryFacts(state);
}
