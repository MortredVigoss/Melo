import {randomUUID} from 'node:crypto';
import {iterateMemoryRecords,getMemoriesByIds,withMemoryHome} from '../../memory/store.js';
import {portableMemoryValue,applyPortableMemory} from './portableMemory.js';
import {projectMemoryEnvelope,projectMemoryPayload,validateProjectMemory} from '../../../mobile-sync/projectMemoryProtocol.js';
import {putWorkspace,mergeWorkspaces,stableJSON} from '../../../mobile-sync/workspaceProtocol.js';

export function refreshProjectMemory(state) {
  state.mobileWorkspaceDevice ||= randomUUID();
  const workspace=validateProjectMemory(state.projectMemorySync||{version:1,records:[]});
  const projects=new Set((state.projects||[]).filter(p=>!p.deletedAt).map(p=>p.id));
  const expected=new Map();
  for(const row of iterateMemoryRecords()) {
    if(row.metadata.origin!=='project'||!projects.has(row.metadata.projectId)||row.metadata.audience==='remote')continue;
    const value=portableMemoryValue(row);
    expected.set(row.id,stableJSON(value));
    const existing=workspace.records.find(r=>r.id===value.id);
    if(existing?.versions.length>1||existing?.versions.length===1&&stableJSON(projectMemoryPayload(existing.versions[0].value))===stableJSON(value))continue;
    putWorkspace(workspace,'knowledge',value.id,projectMemoryEnvelope(value),state.mobileWorkspaceDevice);
  }
  state.projectMemorySync=validateProjectMemory(workspace);
  return expected;
}
export function stageProjectMemory(state,incoming) {
  const expected=refreshProjectMemory(state), baseline=state.projectMemorySync;
  const merged=mergeWorkspaces(baseline,validateProjectMemory(incoming));
  for(const row of merged.records)for(const version of row.versions) {
    const value=projectMemoryPayload(version.value), prior=getMemoriesByIds([value.memoryID])[0];
    if(prior&&(prior.kind!=='session-fact'||prior.metadata.origin!=='project'||prior.metadata.projectId!==value.projectId||prior.metadata.audience==='remote'))throw new Error('Project memory source mismatch');
    if(value.mergedInto!==undefined&&value.mergedInto!==prior?.metadata.mergedInto)throw new Error('Memory merge source mismatch');
  }
  state.projectMemorySync=merged;
  state.projectMemoryPending={expected:[...expected],clocks:Object.fromEntries(baseline.records.map(row=>[row.id,row.versions.reduce((clock,v)=>{for(const [id,n] of Object.entries(v.clock))clock[id]=Math.max(clock[id]||0,n);return clock;},{})]))};
}
// The state journal commits first, as with portableMemory. A crash can replay
// the memory database transaction; concurrent desktop edits remain versions.
export function replayProjectMemory(state) {
  const pending=state.projectMemoryPending;
  if(!pending)return;
  const expected=new Map(pending.expected);
  for(const row of state.projectMemorySync.records) {
    const value=projectMemoryPayload(row.versions[0].value), prior=getMemoriesByIds([value.memoryID])[0];
    if(!prior)continue;
    const mine=portableMemoryValue(prior);
    if(stableJSON(mine)===expected.get(prior.id)||row.versions.some(v=>stableJSON(projectMemoryPayload(v.value))===stableJSON(mine)))continue;
    const clock={...pending.clocks[row.id]};clock['project-memory-recovery']=(clock['project-memory-recovery']||0)+1;
    state.projectMemorySync=mergeWorkspaces(state.projectMemorySync,{version:1,records:[{kind:'knowledge',id:row.id,versions:[{clock,value:projectMemoryEnvelope(mine)}]}]});
  }
  const records=state.projectMemorySync.records.map(row=>({...row,kind:'memory',versions:row.versions.map(v=>({...v,value:projectMemoryPayload(v.value)}))}));
  applyPortableMemory({...state,mobileWorkspaceSync:{version:1,records}},null,{clocks:pending.clocks,projectSources:true});
  state.projectMemoryPending=null;
}

export function projectMemoryFor(home) {
  return {
    refresh: state => withMemoryHome(home,()=>refreshProjectMemory(state)),
    stage: (state,incoming) => withMemoryHome(home,()=>stageProjectMemory(state,incoming)),
    replay: state => withMemoryHome(home,()=>replayProjectMemory(state)),
  };
}
