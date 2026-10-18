import { loadState, updateStateAtomically } from '../../state/stateStore.js';
import { resolveWorkspace } from '../../../mobile-sync/workspaceProtocol.js';
import { portableMemoryID } from '../chat/portableMemory.js';
import { listMemoryRecords, isEntryInvalidated } from '../../memory/store.js';
import { editMemoryFact } from '../../memory/factRecords.js';
import { requestEnvironment, runWithRequestContext } from '../../runtime/requestScope.js';
import { BOOK_SECTIONS, projectBookRecords, createUserBookRow } from '../project/projectMemoryBook.js';

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
        section:r.metadata.section || null,bookStatus:r.metadata.bookStatus || null,
        status:r.metadata.conflict?'conflict':r.metadata.forgotten?'forgotten':r.metadata.quarantined?'unconfirmed':isEntryInvalidated(r.metadata)?'historical':'active',
        conflict:r.metadata.conflict?{text:r.metadata.conflict.text,scope:r.metadata.conflict.scope || null,editedAt:r.metadata.conflict.editedAt || null,source:r.metadata.conflict.source || 'mobile'}:null,
        sourceChatId:chat?.id || null,sourceMessageId:source?.id || null,sourceTitle:chat?.title || r.metadata.chatTitle || (r.metadata.bookStatus==='user'?'项目页手写':'来源对话已删除'),
        sourceText:typeof source?.content==='string'?source.content.slice(0,1600):r.metadata.sourceText || null,
        projectId:r.metadata.projectId,local:r.metadata.audience==='local',updatedAt:r.updatedAt,
        supersededBy:r.metadata.supersededByFact || null};
    });
    const turns=state.chats.flatMap(c=>(c.messages || []).filter(m=>m.role==='assistant' && Array.isArray(m.metadata?.memoryUsage)).map(m=>({chatId:c.id,title:c.title,messageId:m.id,createdAt:m.createdAt,memories:m.metadata.memoryUsage})))
      .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,10);
    return {records,total:rows.length,offset:start,turns};
  });
}

export async function updateMemoryFact({id,patch}={}) {
  const updated=editMemoryFact(String(id || ''),patch || {});
  // Resolving a cross-device conflict must also settle the workspace register,
  // otherwise the next sync re-flags the row and the phone never converges.
  if (patch?.resolveConflict) {
    const registerId=portableMemoryID(updated.id);
    await updateStateAtomically(state=>{
      const row=state.mobileWorkspaceSync?.records?.find(r=>r.kind==='memory'&&r.id===registerId);
      if (row && row.versions.length>1 && state.mobileWorkspaceDevice) {
        const index=Math.max(0,row.versions.findIndex(v=>v.value.text===updated.text&&v.value.scope===(updated.metadata.scope || 'chat')));
        state.mobileWorkspaceSync=resolveWorkspace(state.mobileWorkspaceSync,'memory',registerId,index,state.mobileWorkspaceDevice);
      }
      return state;
    });
  }
  return updated;
}

// Project memory book (design 2B): the project page lists the book and can
// add a hand-written row. Confirm / 改节 / 停止使用 go through updateMemoryFact.
export async function projectMemoryBook({projectId}={}) {
  const env={...requestEnvironment()};
  return runWithRequestContext({env},async()=>{
    const state=await loadState();
    const id=String(projectId || '');
    if (!state.projects.some(p=>p.id===id)) throw new Error('项目不存在。');
    return {projectId:id,sections:BOOK_SECTIONS,records:projectBookRecords(id,{state})};
  });
}
export function createProjectMemoryBookEntry({projectId,text,section}={}) {
  const row=createUserBookRow({projectId:String(projectId || ''),text,section});
  return {id:row.id,text:row.text,section:row.metadata.section,bookStatus:row.metadata.bookStatus};
}
