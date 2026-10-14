import test from 'node:test';import assert from 'node:assert/strict';
import {buildTaskAcceptance,assertTaskAcceptable} from './taskAcceptance.js';
import {finishTaskRun} from './taskRunLifecycle.js';
import {reserveTaskOperation} from './operationLedger.js';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('failed tool cannot become successful task from model prose',()=>{
 const state={tasks:[{execution:{status:'running',runId:'r'}}]};finishTaskRun(state,{runId:'r'},{message:{content:'all done',toolResults:[{toolName:'bash',ok:false,errorCode:'TOOL_FAILED'}]}});assert.equal(state.tasks[0].status,'blocked');assert.throws(()=>assertTaskAcceptable(state.tasks[0]));
});
test('file, command and source evidence require explicit human checks',()=>{
 const acceptance=buildTaskAcceptance({toolResults:[{toolName:'file_write',ok:true,backupOperationId:'backup123'},{toolName:'bash',ok:true,exitCode:0},{toolName:'web_search',ok:true}]});const task={acceptance,execution:{status:'review'}};assert.equal(acceptance.criteria.length,4);assert.throws(()=>assertTaskAcceptable(task));acceptance.criteria.forEach(c=>c.checked=true);assert.doesNotThrow(()=>assertTaskAcceptable(task));
});
test('successful external operation replays once; interrupted operation stays uncertain',async()=>{
 const home=await mkdtemp(join(tmpdir(),'melo-ledger-'));try{
 const options={home,taskId:'task',tool:{id:'send',requiresPermission:true},args:{content:'fixture'}};
 const ticket=reserveTaskOperation(options);ticket.finish({ok:true,output:'sent'});assert.equal(reserveTaskOperation(options).result.meta.replayed,true);
 const uncertain={...options,args:{content:'other'}};reserveTaskOperation(uncertain).finish({ok:false});assert.equal(reserveTaskOperation(uncertain).result.error,'OPERATION_UNCERTAIN');
 }finally{await rm(home,{recursive:true,force:true});}
});
