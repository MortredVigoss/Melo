import { recordMemoryRejection } from './store.js';
import { iterateMemoryRecords, getMemoriesByIds, upsertMemory, withTransaction, isEntryInvalidated } from './store.js';
import { factId, factNamespace, normalizedFact, canRecallMemory, isLocalChat } from './factPolicy.js';
import { extractFactsRuleBased } from './offline/extractor.js';
import { writeAutoBookRow, moveAutoBookRow, retireSupersededBookRows, isProjectOriginRow, normalizeSection, BOOK_SECTIONS, BOOK_ID_PREFIX, BOOK_ROW_MAX_CHARS } from './projectBook.js';

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
      } else if (prior && scope==='chat' && chat.projectId && isLocalChat(chat) && (prior.metadata.projectId || null)!==chat.projectId) {
        // Bug audit M12: the chat joined or changed project after the fact was
        // extracted — the mirror row follows (written if missing, moved if active).
        try { moveAutoBookRow(entry, chat); }
        catch (error) { console.warn(`[memory.book] auto row move skipped: ${error.message}`); }
      }
    }
    return results;
  });
}

export function resolveSessionFacts(chat, agentId=chat?.agentId || 'main') {
  if (!chat?.id) return [];
  return [...iterateMemoryRecords({chatId:chat.id})].filter(r=>!isEntryInvalidated(r.metadata) && canRecallMemory(r,{chat,agentId,projectId:chat.projectId}))
    .map(r=>({fact:r.text,category:r.metadata.category,extractedAt:r.createdAt,validTo:r.metadata.validTo,id:r.id,scope:r.metadata.scope || 'chat',projectId:r.metadata.projectId || null}));
}

export function reconcileLegacyFacts(state) {
  for (const chat of state.chats || []) reconcileChatFacts(chat);
  // Facts whose source chat was deleted have no safe audience to infer. Keep
  // their text available in management, but exclude them from automatic recall.
  const chats=new Set((state.chats || []).map(c=>c.id));
  const projects=new Set((state.projects || []).map(p=>p.id));
  for (const row of iterateMemoryRecords()) {
    // Hand-written project-book rows (design 2B) have no source chat; their
    // source is the project itself. Bug audit M1: the exemption follows the
    // row whatever scope the user moved it to (origin/sourceId, not
    // bookStatus, which is dropped when the row leaves the book); only a row
    // still in project scope is tied to the project's existence.
    if (isProjectOriginRow(row)) {
      if ((row.metadata.scope || 'project')==='project' && !projects.has(row.metadata.projectId) && !row.metadata.sourceDeleted) upsertMemory({...row,metadata:{...row.metadata,quarantined:true,sourceDeleted:true}});
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
  // Bug audit M1: a row without a source chat (hand-written on the project
  // page) has no "original chat" to be limited to.
  if (scope==='chat' && !row.metadata.chatId) throw new Error('这条记忆来自项目页，没有原对话可以限定。');
  // Bug audit M3: hand-written / promoted project rows are rendered on every
  // turn of the project; cap the text when it is being set or promoted.
  if (scope==='project' && (patch.text!==undefined || patch.scope==='project') && text.length>BOOK_ROW_MAX_CHARS) throw new Error(`记忆本内容需要在 ${BOOK_ROW_MAX_CHARS} 字以内。`);
  // Bug audit M4: promoting a chat fact whose auto mirror (`book:<id>`) is
  // already in the book confirms that mirror instead of creating a second
  // project record; the chat row keeps its chat scope (other fields still apply).
  if (patch.scope==='project' && (row.metadata.scope || 'chat')!=='project' && !String(id).startsWith(BOOK_ID_PREFIX)) {
    const twin=getMemoriesByIds([`${BOOK_ID_PREFIX}${id}`]).find(r=>r.kind==='session-fact' && r.metadata.projectId===row.metadata.projectId && !r.metadata.quarantined);
    if (twin) {
      const {scope:_scope,...rest}=patch;
      if (Object.keys(rest).length) editMemoryFact(id,rest);
      // The user's promotion is authoritative: a mirror retired by a later auto
      // fact on the same subject comes back (and retires that fact below).
      if (twin.metadata.validTo || twin.metadata.forgotten) {
        const {validTo:_v,supersededByFact:_f,supersededById:_i,validToBeforeForget:_b,...kept}=twin.metadata;
        upsertMemory({...twin,metadata:{...kept,validTo:twin.metadata.forgotten ? twin.metadata.validTo : null}});
      }
      return editMemoryFact(twin.id,{bookStatus:'confirmed',...(patch.text!==undefined ? {text} : {}),...(twin.metadata.forgotten ? {forgotten:false} : {})});
    }
  }
  const metadata={...row.metadata,scope,userEdited:true,editedAt:new Date().toISOString()};
  // 2026-10-17 (design audit M4): the two switches that keep a fact in the
  // always-on Hot Attic — category correction/decision and pinned — were not
  // editable anywhere. Both are now user-settable.
  if (patch.category!==undefined) {
    const category=String(patch.category||'').trim();
    // Bug audit M5: an unchanged legacy category ('general', '' from the
    // phone) must not block saving the other fields.
    if (!FACT_CATEGORIES.includes(category) && category!==String(row.metadata.category||'').trim()) throw new Error('记忆类别无效。');
    metadata.category=category || row.metadata.category;
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
  let confirming=false;
  if (scope==='project') {
    if (patch.scope==='project' && metadata.bookStatus!=='user') { metadata.bookStatus=isProjectOriginRow(row) ? 'user' : 'confirmed'; metadata.needsConfirmation=false; confirming=metadata.bookStatus==='confirmed'; }
    if (patch.bookStatus==='confirmed') confirming=true;
    metadata.bookStatus=metadata.bookStatus || 'confirmed';
    metadata.section=normalizeSection(metadata.section,metadata.category);
  } else if (metadata.bookStatus && patch.scope && patch.scope!=='project') {
    delete metadata.bookStatus; delete metadata.section; delete metadata.needsConfirmation;
  }
  if (scope==='personal' && !PERSONAL_PROFILE_CATEGORIES.includes(metadata.category)) metadata.category='user_preference';
  if (patch.resolveConflict!==undefined) { delete metadata.conflict; metadata.mobileSyncConflict=false; }
  // Bug audit M11: forgetting remembers the validity it replaced so that
  // 恢复使用 only clears the validTo the forget itself wrote — a row that had
  // already been superseded stays historical.
  if (patch.forgotten===true) { metadata.validToBeforeForget=row.metadata.forgotten ? (row.metadata.validToBeforeForget ?? null) : (row.metadata.validTo || null); metadata.forgotten=true; metadata.validTo=metadata.editedAt; recordMemoryRejection(id); }
  if (patch.forgotten===false) {
    metadata.forgotten=false; metadata.quarantined=false;
    if (Object.hasOwn(metadata,'validToBeforeForget')) metadata.validTo=metadata.validToBeforeForget || null;
    else if (!(metadata.supersededByFact || metadata.supersededById)) metadata.validTo=null;
    delete metadata.validToBeforeForget;
  }
  const updated={...row,text,searchText:normalizedFact(text),updatedAt:metadata.editedAt,
    namespace:factNamespace({id:metadata.chatId,source:metadata.source,projectId:metadata.projectId},scope,metadata.agentId),metadata};
  return withTransaction(()=>{
    upsertMemory(updated);
    // Bug audit M4: a confirmation (or promotion) is a user statement about the
    // subject — it retires the other book rows on the same subject.
    if (confirming && !isEntryInvalidated(metadata)) retireSupersededBookRows(updated);
    return updated;
  });
}
