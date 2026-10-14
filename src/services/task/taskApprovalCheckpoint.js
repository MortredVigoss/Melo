import { updateStateAtomically } from '../../state/stateStore.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
export async function recordTaskApproval(context, taskId, operationId, operation, waiting) {
  if(!context || !taskId) return;
  return runWithRequestContext(context,()=>updateStateAtomically(state=>{
    const task=state.tasks.find(t=>t.id===taskId && t.execution?.runId===context.runId && t.status==='running');
    if(!task) return;
    task.execution.pendingApprovals ||= {};
    if(waiting) task.execution.pendingApprovals[operationId]=String(operation).slice(0,100);
    else delete task.execution.pendingApprovals[operationId];
    task.syncRevision=(task.syncRevision || 1)+1;
    task.updatedAt=new Date().toISOString();
  }));
}
