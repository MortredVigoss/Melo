import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {refreshAgentSettings,applyAgentSettings,validateAgentSettings,settingsID} from './agentSettings.js';
import {mergeWorkspaces,resolveWorkspace,stableJSON} from './workspaceProtocol.js';
import {emptyCapabilities} from '../src/domain/agent/capabilities.js';
import {createSyncServer} from './server.js';
const fixture=device=>({mobileWorkspaceDevice:device,agentProfiles:{main:{capabilities:emptyCapabilities(),instructions:'persona',channelToken:'never transport'}},projectAgentOverrides:{p:{main:{capabilities:{...emptyCapabilities(),readFiles:true}}}}});
test('Agent settings round-trip independently, reject secrets and preserve offline conflicts',()=>{
 const a=fixture('desktop');const base=refreshAgentSettings(a);assert.equal(base.records.length,2);assert.doesNotMatch(JSON.stringify(base),/persona|channelToken|never transport/);
 const b=fixture('phone');applyAgentSettings(b,base);
 a.agentProfiles.main.capabilities.network=true;b.agentProfiles.main.capabilities.runCommands=true;
 const merged=mergeWorkspaces(refreshAgentSettings(a),refreshAgentSettings(b));const row=merged.records.find(r=>r.id===settingsID(null,'main'));assert.equal(row.versions.length,2);
 applyAgentSettings(a,merged);assert.equal(a.agentProfiles.main.capabilities.network,true);assert.equal(a.agentProfiles.main.capabilities.runCommands,false);
 const resolved=resolveWorkspace(merged,'knowledge',row.id,0,'desktop');applyAgentSettings(a,resolved);assert.equal(stableJSON(refreshAgentSettings(a)),stableJSON(resolved));assert.equal(a.agentProfiles.main.instructions,'persona');
 const bad=structuredClone(base);const value=JSON.parse(bad.records[0].versions[0].value.content);value.token='secret';bad.records[0].versions[0].value.content=JSON.stringify(value);assert.throws(()=>validateAgentSettings(bad));
 const deleted=fixture('phone');delete deleted.agentProfiles.main;applyAgentSettings(deleted,base);assert.equal(deleted.agentProfiles.main,undefined);
});
test('optional settings HTTP channel is authenticated, independent of v1 and durable',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'melo-settings-sync-'));const token='x'.repeat(40), server=createSyncServer({token,directory});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const endpoint=`http://127.0.0.1:${server.address().port}`;const post=(path,body,auth=token)=>fetch(endpoint+path,{method:'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:JSON.stringify(body)});
 try {const outgoing=refreshAgentSettings(fixture('desktop'));assert.equal((await post('/v1/agent-settings',outgoing,'bad')).status,401);let response=await post('/v1/agent-settings',outgoing);assert.equal(response.status,200);assert.deepEqual(await response.json(),outgoing);response=await post('/v1/sync',{version:1,chats:[]});assert.equal(response.status,200);assert.equal((await response.json()).workspace,undefined);response=await post('/v1/agent-settings',{version:1,records:[]});assert.deepEqual(await response.json(),outgoing);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
