import { loadState } from '../../state/stateStore.js';
import { listMemoryRecords, isEntryInvalidated } from '../../memory/store.js';
import { editMemoryFact } from '../../memory/factRecords.js';
import { requestEnvironment, runWithRequestContext } from '../../runtime/requestScope.js';

export async function memoryFacts({query='',offset=0}={}) {
  const env={...requestEnvironment()};
  return runWithRequestContext({env},async()=>{
    const state=await loadState();
    const q=String(query || '').trim().toLowerCase();
    const rows=listMemoryRecords({limit:10000}).filter(r=>!q || `${r.text} ${r.metadata.chatTitle || ''}`.toLowerCase().includes(q));
    const start=Math.max(0,Number(offset)||0);
    const records=rows.slice(start,start+50).map(r=>{
      const chat=state.chats.find(c=>c.id===r.metadata.chatId);
      const source=chat?.messages.find(m=>m.id===r.metadata.sourceMessageId);
      return {id:r.id,text:r.text,scope:r.metadata.scope || 'chat',category:r.metadata.category,pinned:Boolean(r.metadata.pinned),
        status:r.metadata.forgotten?'forgotten':r.metadata.quarantined?'unconfirmed':isEntryInvalidated(r.metadata)?'historical':'active',
        sourceChatId:chat?.id || null,sourceMessageId:source?.id || null,sourceTitle:chat?.title || r.metadata.chatTitle || '来源对话已删除',
        sourceText:typeof source?.content==='string'?source.content.slice(0,1600):r.metadata.sourceText || null,
        projectId:r.metadata.projectId,local:r.metadata.audience==='local',updatedAt:r.updatedAt,
        supersededBy:r.metadata.supersededByFact || null};
    });
    const turns=state.chats.flatMap(c=>(c.messages || []).filter(m=>m.role==='assistant' && Array.isArray(m.metadata?.memoryUsage)).map(m=>({chatId:c.id,title:c.title,messageId:m.id,createdAt:m.createdAt,memories:m.metadata.memoryUsage})))
      .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,10);
    return {records,total:rows.length,offset:start,turns};
  });
}

export function updateMemoryFact({id,patch}={}) {return editMemoryFact(String(id || ''),patch || {});}
