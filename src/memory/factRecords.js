import { recordMemoryRejection } from './store.js';
import { iterateMemoryRecords, getMemoriesByIds, upsertMemory, withTransaction, isEntryInvalidated } from './store.js';
import { factId, factNamespace, normalizedFact, canRecallMemory, isLocalChat } from './factPolicy.js';
import { extractFactsRuleBased } from './offline/extractor.js';
import { writeAutoBookRow, normalizeSection, BOOK_SECTIONS } from './projectBook.js';

// Personal profile (design 2B): only these categories render in the stable
// personal block; anything else promoted to personal is a preference.
export const PERSONAL_PROFILE_CATEGORIES = Object.freeze(['user_preference', 'identity', 'correction']);

// Session facts are a checkpoint of extraction; the store owns validity and
// user overrides. Replaying an old checkpoint must not undo edits or forgetting.
export function reconcileChatFacts(chat, agentId=chat?.agentId || 'main') {
  if (!chat?.id) return [];
  const stored=[...iterateMemoryRecords({chatId:chat.id})];
  const results=[];
  return withTransaction(()=>{
    const latestFacts = new Map((chat.sessionMemory || []).filter(f=>f?.fact).map(f=>[normalizedFact(f.fact),f]));
    for (const fact of latestFacts.values()) {
      if (!fact?.fact?.trim()) continue;
      const original=normalizedFact(fact.fact);
      const prior=stored.find(r=>normalizedFact(r.metadata.originalFact || r.text)===original);
      if (prior?.metadata.userEdited || prior?.metadata.forgotten) { results.push(prior); continue; }
      const source=chat.messages?.find(m=>m.id===fact.sourceMessageId);
      let text=fact.fact;
      // Repair only the provable old Chinese polarity bug, with the original
      // user sentence retained as evidence. Never guess about an LLM fact.
      let polaritySource;
      if (!fact.sourceMessageId && /^User prefers /i.test(text)) {
        for (const message of chat.messages || []) {
          if (message.role!=='user') continue;
          const match=extractFactsRuleBased([message]).find(f=>/^User dislikes /i.test(f.fact) && normalizedFact(f.fact.replace('User dislikes ','User prefers '))===original);
          if (match) polaritySource=match;
        }
        if (polaritySource) text=polaritySource.fact;
      }
      const scope=prior?.metadata.scope || 'chat';
      const metadata={...prior?.metadata, category:fact.category || 'general', originalFact:fact.fact,
        chatId:chat.id, chatTitle:chat.title || '', projectId:chat.projectId || null, agentId,
        scope, audience:isLocalChat(chat)?'local':'remote', source:chat.source || 'desktop',
        sourceMessageId:fact.sourceMessageId || polaritySource?.sourceMessageId || null,
        sourceSenderId:fact.sourceSenderId || source?.senderId || null,
        sourceRole:fact.sourceRole || source?.role || polaritySource?.sourceRole || null,
        subjectKey:fact.subjectKey || null, sourceText:fact.sourceText || polaritySource?.sourceText || null,
        validFrom:fact.validFrom || fact.extractedAt || null, validTo:fact.validTo || (Date.parse(fact.validFrom || '') > Date.parse(prior?.metadata.validFrom || '') ? null : prior?.metadata.validTo) || null,
        supersededByFact:fact.supersededByFact || null, polarityRepaired:!!polaritySource,
      };
      const entry={id:prior?.id || factId(chat.id,fact.fact),namespace:factNamespace(chat,scope,agentId),kind:'session-fact',sourceId:chat.id,text,
        searchText:normalizedFact(text),createdAt:prior?.createdAt || fact.extractedAt || new Date().toISOString(),
        updatedAt:prior?.updatedAt || fact.extractedAt || new Date().toISOString(),metadata};
      if (!prior || prior.text!==entry.text || prior.namespace!==entry.namespace || JSON.stringify(prior.metadata)!==JSON.stringify(metadata)) upsertMemory(entry);
      results.push(entry);
      // Project memory book (design 2B): the single exception to "automatic
      // facts stay in their chat". A decision / project_context fact of a
      // local chat that belongs to a project is mirrored as an `[auto]` book
      // row (id `book:<factId>`); replaying an old checkpoint never rewrites it.
      if (!prior && scope==='chat' && chat.projectId && isLocalChat(chat)) {
        try { writeAutoBookRow(entry, chat); }
        catch (error) { console.warn(`[memory.book] auto row skipped: ${error.message}`); }
      }
    }
    return results;
  });
}

export function resolveSessionFacts(chat, agentId=chat?.agentId || 'main') {
  if (!chat?.id) return [];
  return [...iterateMemoryRecords({chatId:chat.id})].filter(r=>!isEntryInvalidated(r.metadata) && canRecallMemory(r,{chat,agentId,projectId:chat.projectId}))
    .map(r=>({fact:r.text,category:r.metadata.category,extractedAt:r.createdAt,validTo:r.metadata.validTo,id:r.id}));
}

export function reconcileLegacyFacts(state) {
  for (const chat of state.chats || []) reconcileChatFacts(chat);
  // Facts whose source chat was deleted have no safe audience to infer. Keep
  // their text available in management, but exclude them from automatic recall.
  const chats=new Set((state.chats || []).map(c=>c.id));
  const projects=new Set((state.projects || []).map(p=>p.id));
  for (const row of iterateMemoryRecords()) {
    // Hand-written project-book rows (design 2B) have no source chat; their
    // source is the project itself.
    if (row.metadata.bookStatus==='user' && !row.metadata.chatId) {
      if (!projects.has(row.metadata.projectId) && !row.metadata.sourceDeleted) upsertMemory({...row,metadata:{...row.metadata,quarantined:true,sourceDeleted:true}});
      continue;
    }
    if (!chats.has(row.metadata.chatId) && !row.metadata.sourceDeleted) upsertMemory({...row,metadata:{...row.metadata,scope:row.metadata.scope || 'chat',quarantined:true,sourceDeleted:true}});
  }
}

export function quarantineDeletedChatFacts(chatIds) {
  withTransaction(() => {
    for (const chatId of chatIds) for (const row of iterateMemoryRecords({chatId})) {
      if (!row.metadata.sourceDeleted || !row.metadata.quarantined) upsertMemory({...row,metadata:{...row.metadata,quarantined:true,sourceDeleted:true}});
    }
  });
}

export const FACT_CATEGORIES=Object.freeze(['user_preference','project_context','technical_detail','decision','correction','identity']);

export function editMemoryFact(id, patch={}) {
  const row=getMemoriesByIds([id]).find(r=>r.kind==='session-fact');
  if (!row) throw new Error('这条记忆不存在。');
  if (row.metadata.sourceDeleted && patch.forgotten === false) throw new Error('来源对话已删除，这条记忆不能重新启用。');
  // Cross-device conflict (design 2026-10-17 §3.4): 'desktop' keeps the row's
  // own text, 'mobile' takes the phone version stored under metadata.conflict;
  // both clear the conflict (and the workspace-level flag).
  if (patch.resolveConflict!==undefined) {
    if (!['desktop','mobile'].includes(patch.resolveConflict)) throw new Error('冲突处理方式无效。');
    const conflict=row.metadata.conflict;
    if (!conflict || typeof conflict!=='object') throw new Error('这条记忆没有待处理的冲突。');
    if (patch.resolveConflict==='mobile') patch={...patch,text:conflict.text,scope:conflict.scope || row.metadata.scope || 'chat'};
  }
  const text=patch.text===undefined?row.text:String(patch.text).trim();
  if (!text || text.length>2000) throw new Error('记忆内容需要在 1–2000 字之间。');
  const scope=patch.scope || row.metadata.scope || 'chat';
  if (!['chat','project','agent','personal'].includes(scope)) throw new Error('记忆使用范围无效。');
  if (scope!=='chat' && row.metadata.audience!=='local') throw new Error('频道记忆仅用于原对话。');
  if (scope==='project' && !row.metadata.projectId) throw new Error('原对话尚未关联项目。');
  const metadata={...row.metadata,scope,userEdited:true,editedAt:new Date().toISOString()};
  // 2026-10-17 (design audit M4): the two switches that keep a fact in the
  // always-on Hot Attic — category correction/decision and pinned — were not
  // editable anywhere. Both are now user-settable.
  if (patch.category!==undefined) {
    const category=String(patch.category||'').trim();
    if (!FACT_CATEGORIES.includes(category)) throw new Error('记忆类别无效。');
    metadata.category=category;
  }
  if (patch.pinned!==undefined) metadata.pinned=patch.pinned===true;
  // Project memory book / personal profile (design 2B).
  if (patch.section!==undefined) {
    const section=String(patch.section||'').trim();
    if (!BOOK_SECTIONS.includes(section)) throw new Error('记忆本分节无效。');
    metadata.section=section;
  }
  if (patch.bookStatus!==undefined) {
    // Only confirmation is user-settable; `user` is reserved for hand-written rows.
    if (patch.bookStatus!=='confirmed') throw new Error('记忆本状态只能改为已确认。');
    metadata.bookStatus='confirmed'; metadata.needsConfirmation=false;
  }
  if (scope==='project') {
    if (patch.scope==='project' && metadata.bookStatus!=='user') { metadata.bookStatus='confirmed'; metadata.needsConfirmation=false; }
    metadata.bookStatus=metadata.bookStatus || 'confirmed';
    metadata.section=normalizeSection(metadata.section,metadata.category);
  } else if (metadata.bookStatus && patch.scope && patch.scope!=='project') {
    delete metadata.bookStatus; delete metadata.section; delete metadata.needsConfirmation;
  }
  if (scope==='personal' && !PERSONAL_PROFILE_CATEGORIES.includes(metadata.category)) metadata.category='user_preference';
  if (patch.resolveConflict!==undefined) { delete metadata.conflict; metadata.mobileSyncConflict=false; }
  if (patch.forgotten===true) { metadata.forgotten=true; metadata.validTo=metadata.editedAt; recordMemoryRejection(id); }
  if (patch.forgotten===false) { metadata.forgotten=false; metadata.validTo=null; metadata.quarantined=false; }
  const updated={...row,text,searchText:normalizedFact(text),updatedAt:metadata.editedAt,
    namespace:factNamespace({id:metadata.chatId,source:metadata.source,projectId:metadata.projectId},scope,metadata.agentId),metadata};
  upsertMemory(updated);
  return updated;
}
