import test from 'node:test';import assert from 'node:assert/strict';
import {mergeSnapshots,validateSnapshot} from './protocol.js';
const task={id:'task',title:'task',status:'blocked',owner:'builder',checkpoint:'检查已完成的改动',revision:1,sourceDevice:'desktop',updatedAt:'2026-10-08T00:00:00.000Z',chatId:null,needsApproval:true};
test('checkpoints and handoff requests converge without carrying grants or executing tools',()=>{
 const desktop={version:1,chats:[],tasks:[{...task,permissionRules:['secret'],workspacePath:'/private'}],handoffs:[]};
 const phone={version:1,chats:[],tasks:[task],handoffs:[{id:'request',taskId:'task',fromDevice:'phone',revision:1,requestedAt:task.updatedAt,granted:true}]};
 const merged=mergeSnapshots(desktop,phone);assert.equal(merged.handoffs.length,1);assert.ok(!JSON.stringify(merged).includes('secret'));assert.ok(!JSON.stringify(merged).includes('granted'));assert.deepEqual(merged,mergeSnapshots(merged,phone));assert.deepEqual(merged,mergeSnapshots(phone,desktop));
});
test('conflicting same revision never silently overwrites either device',()=>{
 const a={version:1,chats:[],tasks:[task]};assert.throws(()=>mergeSnapshots(a,{...a,tasks:[{...task,status:'done'}]}),/conflict/);assert.equal(a.tasks[0].status,'blocked');
 const b=mergeSnapshots(a,{...a,tasks:[{...task,status:'review',revision:2}]});assert.equal(b.tasks[0].status,'review');assert.equal(validateSnapshot({version:1,chats:[]}).version,1);
});
