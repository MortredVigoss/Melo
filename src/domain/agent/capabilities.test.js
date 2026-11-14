import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCapabilities, normalizeCapabilities, intersectCapabilities, toolCapabilityAllowed } from './capabilities.js';
import {executeTool} from '../../testSupport/directAgentFixture.js';
import {runSubAgent} from '../../testSupport/directAgentFixture.js';
import {buildNewCustomAgent} from '../../services/agent/agentProfileService.js';
import {normalizeAgentProfile,effectiveAgentProfile} from '../../state/agentProfiles.js';
import {capabilityMigrationPreview} from '../../services/agent/capabilityMigration.js';

test('new custom Agent starts with every base ability except delegation; intersections never widen parent permissions',()=>{
 // User decision 2026-10-22: files, commands, network, knowledge & memory and media by default; delegation and MCP stay per Agent.
 const c=buildNewCustomAgent({}).profile.capabilities;
 assert.deepEqual(c,normalizeCapabilities({readFiles:true,writeFiles:true,runCommands:true,network:true,knowledgeMemory:true,generateMedia:true}));
 for (const id of ['file_read','file_write','bash','web_search','fetch_url']) assert.equal(toolCapabilityAllowed(id,c),true,id);
 assert.equal(toolCapabilityAllowed('image',c,{action:'generate'}),true);
 assert.equal(toolCapabilityAllowed('delegate',c),false,'delegation is switched on per Agent');
 assert.equal(toolCapabilityAllowed('mcp:any:tool',c),false);
 const a=normalizeCapabilities({readFiles:true,mcpServers:['safe'],skills:['s']}),b=normalizeCapabilities({readFiles:true,writeFiles:true,mcpServers:['safe','evil'],skills:['other']});
 assert.deepEqual(intersectCapabilities(a,b),normalizeCapabilities({readFiles:true,mcpServers:['safe']}));
 assert.equal(toolCapabilityAllowed('mcp:safe/evil:tool',a),false);
 assert.equal(toolCapabilityAllowed('unclassified_plugin_tool',a),false);
});
test('execution rejects forbidden and forged calls before any side effect or permission prompt',async()=>{
 let runs=0,permissions=0;const tool={id:'file_write',run:()=>{runs++;return{ok:true,output:'wrote'};}};
 for (const options of [{capabilities:emptyCapabilities()},{allowedToolIds:[]},{allowedToolIds:['file_read'],capabilities:normalizeCapabilities({writeFiles:true})}]) {
  const result=await executeTool(tool,{}, {...options,sseEmitter:()=>permissions++});assert.equal(result.error,'CAPABILITY_DENIED');
 }
 assert.equal(runs,0);assert.equal(permissions,0);
 const result=await executeTool({...tool,requiresPermission:false},{},{capabilities:normalizeCapabilities({writeFiles:true})});
 assert.equal(result.ok,true);assert.equal(runs,1);
});
test('mixed file tools check actual actions, URL reads and skill index access',()=>{
 const c=normalizeCapabilities({readFiles:true,knowledgeMemory:true});
 assert.ok(toolCapabilityAllowed('pdf',c,{action:'read',path:'/tmp/a'}));
 assert.equal(toolCapabilityAllowed('pdf',c,{action:'read',url:'https://example.com/a.pdf'}),false);
 assert.equal(toolCapabilityAllowed('pdf',c,{action:'write'}),false);
 assert.equal(toolCapabilityAllowed('image',c,{action:'generate'}),false);
 assert.equal(toolCapabilityAllowed('clipboard',c,{action:'write'}),false);
 const media=normalizeCapabilities({generateMedia:true});
 assert.ok(toolCapabilityAllowed('image',media,{action:'generate'}));
 assert.equal(toolCapabilityAllowed('image',media,{action:'generate',output:'/tmp/a.png'}),false);
 assert.equal(toolCapabilityAllowed('knowledge',emptyCapabilities(),{action:'index'}),false);
});
test('migration preview is stable, literal, and changes when permissions change',()=>{
 const p=normalizeAgentProfile('main',{tools:['local-files'],enabledMcpServerIds:['safe']});
 const preview=capabilityMigrationPreview(p,{tools:[{id:'bash'},{id:'image'}]});
 assert.deepEqual(preview.lostTools,['bash']);assert.ok(preview.lostActions.includes('image.generate'));assert.equal(preview.proposed.runCommands,false);
 assert.notEqual(capabilityMigrationPreview({...p,tools:['local-command']}).fingerprint,preview.fingerprint);
 const state={agentProfiles:{main:{capabilities:preview.proposed}},projectAgentOverrides:{p:{main:{capabilities:emptyCapabilities()}}}};
 assert.deepEqual(effectiveAgentProfile(state,'main','p').capabilities,emptyCapabilities());
});
test('sub-agent native network and image features respect inherited capability snapshot',async()=>{
 let seen;const result=await runSubAgent({task:'Answer only',config:{model:'test'},capabilities:emptyCapabilities(),replyFn:async request=>{seen=request;return 'Done';}});
 assert.equal(result.ok,true);assert.equal(seen.nativeWebSearchEnabled,false);assert.equal(seen.nativeImageGenerationEnabled,false);
});

test('collaboration.jobModels keeps only known internal jobs with valid connection ids, and a project override wins', async () => {
  const { normalizeCollaboration, intersectCollaboration, INTERNAL_JOB_ROLES } = await import('./capabilities.js');
  assert.deepEqual(INTERNAL_JOB_ROLES, ['research', 'social', 'lookup', 'calculate', 'execute']);
  const normalized = normalizeCollaboration({ canDelegate: false, jobModels: { research: 'fast-openrouter', social: 'fast-openrouter', planner: 'x', execute: 'bad id!', lookup: '' } });
  assert.deepEqual(normalized.jobModels, { research: 'fast-openrouter', social: 'fast-openrouter' });
  assert.equal('jobModels' in normalizeCollaboration({ canDelegate: false }), false, 'absent when empty');
  assert.equal('jobModels' in normalizeCollaboration({ jobModels: { planner: 'x' } }), false);
  const global = normalizeCollaboration({ canDelegate: true, jobModels: { research: 'a' } });
  assert.deepEqual(intersectCollaboration(global, normalizeCollaboration({ canDelegate: true })).jobModels, { research: 'a' }, 'inherits the global choice');
  assert.deepEqual(intersectCollaboration(global, normalizeCollaboration({ canDelegate: true, jobModels: { research: 'b' } })).jobModels, { research: 'b' }, 'the project override wins');
  const { normalizeAgentProfile } = await import('../../state/agentProfiles.js');
  assert.deepEqual(normalizeAgentProfile('main', { collaboration: { canDelegate: false, jobModels: { calculate: 'cheap' } } }).collaboration.jobModels, { calculate: 'cheap' });
});

// Settings audit 2026-11-10: a member's token cap and timeout are totals, and a
// fixed part is held back for wrapping up. A saved cap of 10 922 tokens or
// less (or 60 000 ms or less) left the member nothing to work with: it handed
// back without one step, and the page accepted 1. The run budget's own
// functions say what is left; the floor keeps real work possible.
test('a member token cap or timeout at or below the wrap-up reserve is raised to the floor', async () => {
  const { normalizeCollaboration, intersectCollaboration, MEMBER_LIMIT_FLOORS, memberWorkTokens, memberWorkMs } = await import('./capabilities.js');
  const { createRunBudget, memberTokenLimit, reserveDelivery, budgetExhausted, workRemainingMs } = await import('../../../shared/agent/runBudget.js');
  for (const low of [1, 5000, 10922, 19999]) assert.equal(normalizeCollaboration({ maxTokens: low }).maxTokens, MEMBER_LIMIT_FLOORS.maxTokens, String(low));
  for (const low of [1, 60000, 119999]) assert.equal(normalizeCollaboration({ timeoutMs: low }).timeoutMs, MEMBER_LIMIT_FLOORS.timeoutMs, String(low));
  // Defaults, values in range and the ceilings are untouched.
  assert.deepEqual([normalizeCollaboration({}).maxTokens, normalizeCollaboration({}).timeoutMs], [32000, 180000]);
  assert.deepEqual([normalizeCollaboration({ maxTokens: 150000 }).maxTokens, normalizeCollaboration({ maxTokens: 999999 }).maxTokens], [150000, 200000]);
  assert.deepEqual([normalizeCollaboration({ timeoutMs: 300000 }).timeoutMs, normalizeCollaboration({ timeoutMs: 9999999 }).timeoutMs], [300000, 900000]);
  assert.equal(normalizeCollaboration({ maxIterations: 1 }).maxIterations, 1, 'other limits keep their own minimum');
  // A project override below the floor cannot bring the old behaviour back.
  assert.equal(intersectCollaboration({ maxTokens: 32000 }, { maxTokens: 3 }).maxTokens, MEMBER_LIMIT_FLOORS.maxTokens);
  // The helper is the run budget's own arithmetic: one token less than it says still runs, exactly that many does not.
  const member = total => reserveDelivery(memberTokenLimit(createRunBudget({ overrides: { maxInputTokens: 10_000_000 } }), total));
  for (const total of [MEMBER_LIMIT_FLOORS.maxTokens, 32000, 200000]) {
    const work = memberWorkTokens(total);
    assert.equal(budgetExhausted(member(total), undefined, { phase: 'work', inputTokens: work - 1 }), null, `${total}: ${work - 1} still runs`);
    assert.equal(budgetExhausted(member(total), undefined, { phase: 'work', inputTokens: work })?.reason, 'total-tokens', `${total}: ${work} is the limit`);
  }
  assert.equal(memberWorkTokens(32000), 19760);
  assert.equal(memberWorkTokens(10922), 0, 'the old lowest accepted values left nothing');
  assert.equal(budgetExhausted(member(10922), undefined, { phase: 'work', inputTokens: 1 })?.reason, 'total-tokens');
  assert.equal(memberWorkTokens(MEMBER_LIMIT_FLOORS.maxTokens) >= 8000, true, 'the floor leaves room for a first request and its answer');
  // Time: the floor leaves a minute of work after the wrap-up minute.
  const timed = ms => reserveDelivery(createRunBudget({ now: 0, overrides: { deadlineMs: ms } }));
  assert.equal(workRemainingMs(timed(MEMBER_LIMIT_FLOORS.timeoutMs), 0), memberWorkMs(MEMBER_LIMIT_FLOORS.timeoutMs));
  assert.equal(memberWorkMs(MEMBER_LIMIT_FLOORS.timeoutMs), 60000);
  assert.equal(workRemainingMs(timed(60000), 0), 0, 'the old lowest accepted timeout left no working time');
});
