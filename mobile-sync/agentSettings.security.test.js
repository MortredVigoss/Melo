import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshAgentSettings,applyAgentSettings,confirmAgentSettings} from './agentSettings.js';
import {emptyCapabilities,normalizeCollaboration} from '../src/domain/agent/capabilities.js';
import {applyPortableWorkspace} from '../src/services/chat/portableWorkspace.js';
import {putWorkspace} from './workspaceProtocol.js';

const fixture=()=>({mobileWorkspaceDevice:'desktop',agentProfiles:{main:{capabilities:{...emptyCapabilities(),readFiles:true,mcpServers:['safe']},collaboration:normalizeCollaboration({}),contextSources:{projects:true,knowledge:false,memory:false}}},projectAgentOverrides:{}});
test('remote settings tighten immediately but never grant command, MCP, delegation or context access',()=>{
 const local=fixture(), remote=structuredClone(local);remote.mobileWorkspaceDevice='phone';refreshAgentSettings(local);refreshAgentSettings(remote);
 Object.assign(remote.agentProfiles.main.capabilities,{readFiles:false,runCommands:true,mcpServers:['unsafe']});
 remote.agentProfiles.main.collaboration=normalizeCollaboration({canDelegate:true,delegateTargets:['builder'],maxDelegationDepth:3});
 remote.agentProfiles.main.contextSources.memory=true;
 applyAgentSettings(local,refreshAgentSettings(remote));
 assert.equal(local.agentProfiles.main.capabilities.readFiles,false);
 assert.equal(local.agentProfiles.main.capabilities.runCommands,false);
 assert.deepEqual(local.agentProfiles.main.capabilities.mcpServers,[]);
 assert.equal(local.agentProfiles.main.collaboration.canDelegate,false);
 assert.equal(local.agentProfiles.main.contextSources.memory,false);
 assert.equal(Object.keys(local.agentSettingsPending).length,1);
 // A normal sync/read must not discard the pending proposal or accept it.
 refreshAgentSettings(local);applyAgentSettings(local,local.agentSettingsSync);
 assert.equal(local.agentProfiles.main.capabilities.runCommands,false);
 assert.equal(Object.keys(local.agentSettingsPending).length,1);
});
test('desktop confirms exact proposals, stale edits fail, rejection survives sync and deletion cannot resurrect',()=>{
 const local=fixture(),remote=structuredClone(local);refreshAgentSettings(remote);
 remote.agentProfiles.main.capabilities.runCommands=true;
 applyAgentSettings(local,refreshAgentSettings(remote));
 const pending=Object.values(local.agentSettingsPending)[0];
 assert.throws(()=>confirmAgentSettings(local,{id:pending.id,expected:'stale',accept:true}),{statusCode:409});
 const changed=structuredClone(local);changed.agentProfiles.main.capabilities.readFiles=false;
 assert.throws(()=>confirmAgentSettings(changed,{id:pending.id,expected:pending.fingerprint,accept:true}),{statusCode:409});
 confirmAgentSettings(local,{id:pending.id,expected:pending.fingerprint,accept:true});
 assert.equal(local.agentProfiles.main.capabilities.runCommands,true);assert.deepEqual(local.agentSettingsPending,{});
 const denied=fixture();applyAgentSettings(denied,refreshAgentSettings(remote));
 const proposal=Object.values(denied.agentSettingsPending)[0];
 confirmAgentSettings(denied,{id:proposal.id,expected:proposal.fingerprint,accept:false});
 applyAgentSettings(denied,refreshAgentSettings(denied));assert.equal(denied.agentProfiles.main.capabilities.runCommands,false);assert.deepEqual(denied.agentSettingsPending,{});
 delete denied.agentProfiles.main;applyAgentSettings(denied,refreshAgentSettings(remote));assert.equal(denied.agentProfiles.main,undefined);
});
test('project proposal approval never exceeds the global ceiling and legacy profiles require desktop migration',()=>{
 const local=fixture();local.agentProfiles.main.capabilities=emptyCapabilities();local.projectAgentOverrides.p={main:{...structuredClone(local.agentProfiles.main)}};
 const remote=structuredClone(local);refreshAgentSettings(remote);remote.projectAgentOverrides.p.main.capabilities.runCommands=true;
 applyAgentSettings(local,refreshAgentSettings(remote));const pending=Object.values(local.agentSettingsPending)[0];
 confirmAgentSettings(local,{id:pending.id,expected:pending.fingerprint,accept:true});assert.equal(local.projectAgentOverrides.p.main.capabilities.runCommands,false);
 const legacy=fixture();legacy.agentProfiles.main.capabilities=null;
 applyAgentSettings(legacy,refreshAgentSettings(remote));const proposal=Object.values(legacy.agentSettingsPending)[0];
 assert.equal(legacy.agentProfiles.main.capabilities,null);
 assert.throws(()=>confirmAgentSettings(legacy,{id:proposal.id,expected:proposal.fingerprint,accept:true}),{statusCode:409});
});
test('old persona sync cannot remove project permission restrictions by omitting an override',()=>{
 const local=fixture();local.projects=[{id:'p',name:'Project'}];local.chats=[];local.artifacts=[];
 local.projectAgentOverrides.p={main:{instructions:'Old project persona',capabilities:emptyCapabilities(),collaboration:normalizeCollaboration({})}};
 const workspace={version:1,records:[]};putWorkspace(workspace,'project','p',{name:'Project',agentOverrides:{}},'phone');
 applyPortableWorkspace(local,workspace);
 assert.deepEqual(local.projectAgentOverrides.p.main.capabilities,emptyCapabilities());
 assert.equal(local.projectAgentOverrides.p.main.instructions,undefined);
});
