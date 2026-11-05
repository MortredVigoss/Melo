import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnEffects, reserveTurnEffect } from './turnEffects.js';
const tool={id:'fixture_write',effect:'write'};
test('turn ledger shares pending, success and uncertainty without blocking read-only work or denied retries',()=>{
 const ledger=createTurnEffects();let calls=0;
 const execute=result=>{const ticket=reserveTurnEffect(ledger,tool,{x:1},'/workspace');if(ticket?.result)return ticket.result;calls++;ticket?.finish(result);return result;};
 execute({ok:true,meta:{executionStarted:true}});ledger.active=true;
 assert.equal(execute({ok:true}).error,'TURN_EFFECT_ALREADY_ATTEMPTED');assert.equal(calls,1,'lead to child replay blocked');
 assert.equal(reserveTurnEffect(ledger,{id:'read',effect:'read'},{},'/workspace'),null);
 const pending=reserveTurnEffect(ledger,tool,{x:2},'/workspace');
 assert.equal(reserveTurnEffect(ledger,tool,{x:2},'/workspace').result.meta.priorStatus,'pending');
 pending.finish({ok:false,meta:{executionStarted:true}});
 assert.equal(reserveTurnEffect(ledger,tool,{x:2},'/workspace').result.meta.priorStatus,'uncertain');
 const denied=reserveTurnEffect(ledger,tool,{x:3},'/workspace');denied.finish({ok:false,meta:{executionStarted:false}});
 assert.equal(reserveTurnEffect(ledger,tool,{x:3},'/workspace').result,undefined);
 assert.equal(reserveTurnEffect(ledger,tool,{x:1},'/other-workspace').result,undefined);
 assert.equal(reserveTurnEffect(createTurnEffects(),tool,{x:1},'/workspace').result,undefined,'no cross-turn state');
});
