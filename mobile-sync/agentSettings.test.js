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

test('v1 wire remains accepted by installed 882eba7 while device job connections survive refresh/apply',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {syncSchema}=await import('./syncContract.generated.js');const {validateSchema}=await import('./schemaValidator.js');
 const schema=structuredClone(syncSchema);schema.$defs.agentCollaboration=JSON.parse(await readFile(new URL('./fixtures/agent-collaboration-882eba7.json',import.meta.url)));
 const a=fixture('desktop');a.agentProfiles.main.collaboration={jobModels:{research:'desktop-local'}};
 const outgoing=refreshAgentSettings(a);
 for(const row of outgoing.records)for(const v of row.versions)validateSchema(JSON.parse(v.value.content),schema.$defs.agentSettings,schema);
 assert.doesNotMatch(JSON.stringify(outgoing),/jobModels|desktop-local/);
 const phone=fixture('phone');phone.agentProfiles.main.collaboration={jobModels:{research:'phone-local'}};
 applyAgentSettings(phone,outgoing);assert.equal(phone.agentProfiles.main.collaboration.jobModels.research,'phone-local');
 applyAgentSettings(a,refreshAgentSettings(phone));assert.equal(a.agentProfiles.main.collaboration.jobModels.research,'desktop-local');
 // A previously published incompatible version is superseded with a new clock,
 // including when another device made an independent permission change.
 const legacy=structuredClone(outgoing),row=legacy.records.find(r=>r.id===settingsID(null,'main'));
 const p=JSON.parse(row.versions[0].value.content);p.collaboration.jobModels={execute:'old-local'};row.versions[0].value.content=stableJSON(p);
 const second=structuredClone(row.versions[0]);second.clock={offline:1};const q=JSON.parse(second.value.content);q.capabilities.network=true;second.value.content=stableJSON(q);row.versions.push(second);
 const repaired=validateAgentSettings(legacy),repairRow=repaired.records.find(r=>r.id===row.id);
 assert.equal(repairRow.versions.length,2,'permission conflict remains unresolved');
 for(const v of repairRow.versions){validateSchema(JSON.parse(v.value.content),schema.$defs.agentSettings,schema);assert.equal(v.clock['agent-settings-local-routing-v1'],1);}
 assert.deepEqual(validateAgentSettings(repaired),repaired,'migration is idempotent');
 assert.equal(mergeWorkspaces(legacy,repaired).records.find(r=>r.id===row.id).versions.length,2,'old payload does not reappear');
});
