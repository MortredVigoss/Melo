import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreTurn } from './sharedAgentCore.js';
import { createRunBudget, reserveDelivery, remainingMs } from './runBudget.js';
import { extendForMember } from '../services/chat/execution/internalMembers.js';
test('member budget extensions reach core, preserve elapsed/rounds, and stop at host hard deadline',()=>{
 let now=1000000;
 const budget=reserveDelivery(createRunBudget({now:()=>now}));
 budget.hardDeadlineAt=now+45*60000;
 const core=createCoreTurn({budget,allowedTools:['calculator'],limits:{timeoutMs:30*60000},clock:()=>now});
 core.update('request');core.update('calls',{calls:[{id:'a',name:'calculator',arguments:{expression:'1+1'}}]});
 core.results([{call:{id:'a',name:'calculator',arguments:{}},result:{ok:true,output:'2'}}]);
 extendForMember(budget,null,{index:1});now+=31*60000;
 assert.equal(remainingMs(budget),4*60000);assert.equal(core.update('request'),'running');
 assert.equal(core.routingProgress.rounds,1,'extension does not reset rounds');core.update('feedback');
 for(let i=0;i<5;i++)extendForMember(budget,null,{index:i+2});
 assert.equal(budget.deadlineAt,budget.hardDeadlineAt);assert.equal(budget.routingDeadlineExtension,15*60000);
 now=budget.hardDeadlineAt;assert.equal(core.update('request'),'blocked');assert.equal(core.reason,'DEADLINE_EXCEEDED');
});
