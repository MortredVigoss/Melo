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

test('C1: unknown effects repeat for the same actor after they finish, never while pending or for another actor; writes still never repeat',()=>{
 const ledger=createTurnEffects();ledger.active=true;
 const click={id:'mcp:playwright:browser_click'};const lead={id:'lead'},member={id:'member'};
 const run=(tool,args,actor,result={ok:true,meta:{executionStarted:true}})=>{const ticket=reserveTurnEffect(ledger,tool,args,'/ws',actor);if(ticket?.result)return ticket.result;ticket?.finish(result);return result;};
 assert.equal(run(click,{ref:'e12'},member).ok,true);
 assert.equal(run(click,{ref:'e12'},member).ok,true,'the same member may click the same ref again once the first click finished');
 assert.equal(run(click,{ref:'e12'},lead).error,'TURN_EFFECT_ALREADY_ATTEMPTED','another actor cannot replay an unknown effect');
 const pending=reserveTurnEffect(ledger,click,{ref:'e13'},'/ws',member);
 assert.equal(reserveTurnEffect(ledger,click,{ref:'e13'},'/ws',member).result.meta.priorStatus,'pending','an in-flight duplicate is refused even for the same actor');
 pending.finish({ok:false,meta:{executionStarted:true}});
 assert.equal(run(click,{ref:'e13'},member).ok,true,'an uncertain unknown effect may be retried by its own actor');
 const write={id:'file_write',effect:'write'};
 assert.equal(run(write,{path:'a',content:'x'},member).ok,true);
 assert.equal(run(write,{path:'a',content:'x'},member).error,'TURN_EFFECT_ALREADY_ATTEMPTED','a declared write never repeats, same actor or not');
 const bash={id:'bash',effectFor:args=>/^(ls|cat [^\s]+)$/.test(String(args.command||''))?'read':'unknown'};
 assert.equal(reserveTurnEffect(ledger,bash,{command:'ls'},'/ws',lead),null,'a read-only bash form is never ledgered');
 assert.equal(run(bash,{command:'git status --short'},member).ok,true);
 assert.equal(run(bash,{command:'git status --short'},lead).error,'TURN_EFFECT_ALREADY_ATTEMPTED');
});
test('C1: the bash tool classifies only its own served read-only forms as read',async()=>{
 const {readOnlyCommandForm}=await import('../tools/builtins/readOnlyCommand.js');
 const {bashTool}=await import('../tools/builtins/bashTool.js');
 for(const command of ['ls','ls -la','cat notes.txt','cat "my file.txt"'])assert.equal(readOnlyCommandForm(command),true,command);
 for(const command of ['cat ~/.ssh/id_rsa','cat -','ls | head','cat a.txt b.txt','rm -rf x','echo hi > f','',undefined])assert.equal(readOnlyCommandForm(command),false,String(command));
 assert.equal(bashTool.effectFor({command:'ls'}),'read');assert.equal(bashTool.effectFor({command:'npm test'}),'unknown');assert.equal(bashTool.effectFor({}),'unknown');
});
