import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyCapabilities,normalizeCapabilities,intersectCapabilities,toolCapabilityAllowed,migrateLegacyCapabilities} from './capabilities.js';
import {executeTool} from '../../testSupport/directAgentFixture.js';
import {runSubAgent} from '../../testSupport/directAgentFixture.js';
import {runSkill} from '../../testSupport/directAgentFixture.js';
import {buildNewCustomAgent} from '../../services/agent/agentProfileService.js';
import {normalizeAgentProfile,effectiveAgentProfile} from '../../state/agentProfiles.js';
import {capabilityMigrationPreview} from '../../services/agent/capabilityMigration.js';

test('new custom Agent denies tools and intersections never widen parent permissions',()=>{
 const c=buildNewCustomAgent({}).profile.capabilities;assert.deepEqual(c,emptyCapabilities());
 assert.equal(toolCapabilityAllowed('file_write',c),false);
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
