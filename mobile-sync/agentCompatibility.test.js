import test from 'node:test';
import assert from 'node:assert/strict';
import { syncSchema as oldSchema } from './fixtures/v1/syncContract.generated.js';
import { encodeV1Persona, decodeV1Persona } from './agentCompatibility.js';
import { portableAgent, putWorkspace, mergeWorkspaces, stableJSON } from './workspaceProtocol.js';
import { validateSchema } from './schemaValidator.js';
import { refreshPortableWorkspace, applyPortableWorkspace, pendingPersonaRecords } from '../src/services/chat/portableWorkspace.js';
const legacy = fields => portableAgent({name:'Legacy',subtitle:'Same meaning',...fields});
const state = () => ({agentProfiles:{},projects:[],artifacts:[],chats:[],mobileWorkspaceDevice:'desktop'});

test('old v1 long fields round-trip without changing wire bytes or vector clocks', () => {
  for (const fields of [
    {instructions:'a'.repeat(30000),identity:'b'.repeat(30000)},
    {instructions:'a'.repeat(50000),identity:'b'.repeat(50000),soul:'c'.repeat(50000),systemPrompt:'d'.repeat(50000)},
    {instructions:' 🧪\n ',identity:' 身份\n',soul:'  ',systemPrompt:''},
    {instructions:'',identity:'',soul:'',systemPrompt:''},
  ]) {
    const wire=legacy(fields), workspace={version:1,records:[]};
    putWorkspace(workspace,'agent','custom',wire,'oldPhone');
    putWorkspace(workspace,'project','p',{name:'Project',agentOverrides:{custom:wire}},'oldPhone');
    const local=state();applyPortableWorkspace(local,workspace);
    assert.equal(local.agentProfiles.custom.instructions,decodeV1Persona(wire));
    const exported=refreshPortableWorkspace(local);
    for (const kind of ['agent','project']) {
      const before=workspace.records.find(r=>r.kind===kind), after=exported.records.find(r=>r.kind===kind&&r.id===before.id);
      assert.deepEqual(after,before);
    }
    validateSchema({version:1,chats:[],workspace:exported},oldSchema.$defs.snapshot,oldSchema);
  }
});

test('only exact reversible documents are encoded; UTF-16 and whitespace are preserved',()=>{
  for (const doc of ['', '全文\n\n🧪\n', '🧪'.repeat(25000)]) assert.equal(decodeV1Persona(encodeV1Persona(doc)),doc);
  assert.equal(encodeV1Persona('🧪'.repeat(25001)),null);
  const doc=decodeV1Persona(legacy({instructions:'a'.repeat(30000),identity:'b'.repeat(30000)}));
  assert.equal(decodeV1Persona(encodeV1Persona(doc)),doc);
  assert.equal(encodeV1Persona(doc+'\n'),null,'cannot trim a new document to force it onto v1');
});

test('held local personas survive restart/import; concurrent remote edits remain conflicts on release',()=>{
  let local=state();local.agentProfiles.custom={instructions:'Before',name:'Local'};
  refreshPortableWorkspace(local);
  const original=structuredClone(local.mobileWorkspaceSync);
  local.agentProfiles.custom.instructions='x'.repeat(50001);
  local.projectAgentOverrides={p:{custom:{instructions:'p'.repeat(50001)}}};local.projects=[{id:'p',name:'Project'}];
  local.chats=[{id:'c',title:'Still sync',agentId:'custom',projectId:'p',messages:[]}];
  refreshPortableWorkspace(local);
  const before=stableJSON(local.mobileWorkspaceSync);
  local=JSON.parse(JSON.stringify(local));refreshPortableWorkspace(local);
  assert.equal(stableJSON(local.mobileWorkspaceSync),before);
  assert.ok(pendingPersonaRecords(local).some(r=>r.kind==='project'));
  assert.ok(pendingPersonaRecords(local).some(r=>r.kind==='conversation'));
  const remote=structuredClone(original);putWorkspace(remote,'agent','custom',legacy({instructions:'Remote edit'}),'phone');
  applyPortableWorkspace(local,mergeWorkspaces(local.mobileWorkspaceSync,remote));
  assert.equal(local.agentProfiles.custom.instructions,'x'.repeat(50001));
  local.agentProfiles.custom.instructions='Local shortened intentionally';
  refreshPortableWorkspace(local);
  const row=local.mobileWorkspaceSync.records.find(r=>r.kind==='agent'&&r.id==='custom');
  assert.equal(row.versions.length,2);
  assert.deepEqual(new Set(row.versions.map(v=>decodeV1Persona(v.value))),new Set(['Remote edit','Local shortened intentionally']));
  applyPortableWorkspace(local,local.mobileWorkspaceSync);
  assert.equal(local.agentProfiles.custom.instructions,'Local shortened intentionally');
  assert.equal(local.projectAgentOverrides.p.custom.instructions,'p'.repeat(50001));
});

test('deleted conversations do not leave pending context holds behind',()=>{
  const local=state();local.agentProfiles.new={name:'New',instructions:'x'.repeat(50001)};
  local.chats=[{id:'gone',title:'Gone',agentId:'new',messages:[]}];refreshPortableWorkspace(local);
  assert.ok(local.mobilePersonaSyncHolds['conversation:gone']);local.chats=[];refreshPortableWorkspace(local);
  assert.equal(local.mobilePersonaSyncHolds['conversation:gone'],undefined);
});

test('explicit conflict choice replaces held global/project personas and retains local recovery through restart', async()=>{
  const {resolveWorkspace}=await import('./workspaceProtocol.js');
  for (const kind of ['agent','project']) {
    let local=state();local.agentProfiles.custom={name:'Local',instructions:'Before',channels:{telegram:{botToken:'must-not-be-copied'}}};
    local.projects=[{id:'p',name:'P'}];local.projectAgentOverrides={p:{custom:{instructions:'Before project'}}};
    refreshPortableWorkspace(local);const remote=structuredClone(local.mobileWorkspaceSync), id=kind==='agent'?'custom':'p';
    const value=kind==='agent'?legacy({instructions:'Chosen remote'}):{name:'Remote project',agentOverrides:{custom:legacy({instructions:'Chosen remote'})}};
    putWorkspace(remote,kind,id,value,'phone');
    if(kind==='agent')local.agentProfiles.custom.instructions='Concurrent';else local.projectAgentOverrides.p.custom.instructions='Concurrent';
    refreshPortableWorkspace(local);local.mobileWorkspaceSync=mergeWorkspaces(local.mobileWorkspaceSync,remote);
    if(kind==='agent')local.agentProfiles.custom.instructions='x'.repeat(50001);else local.projectAgentOverrides.p.custom.instructions='x'.repeat(50001);
    refreshPortableWorkspace(local);
    const row=local.mobileWorkspaceSync.records.find(r=>r.kind===kind&&r.id===id);
    const index=row.versions.findIndex(v=>(kind==='agent'?v.value.instructions:v.value.agentOverrides.custom.instructions)==='Chosen remote');
    const chosen=resolveWorkspace(local.mobileWorkspaceSync,kind,id,index,'desktop');
    applyPortableWorkspace(local,chosen,{resolvedKeys:[`${kind}:${id}`]});
    local=JSON.parse(JSON.stringify(local));refreshPortableWorkspace(local);applyPortableWorkspace(local,local.mobileWorkspaceSync);
    assert.equal(kind==='agent'?local.agentProfiles.custom.instructions:local.projectAgentOverrides.p.custom.instructions,'Chosen remote');
    assert.equal(local.agentPersonaRecoveries.at(-1).agents.custom.instructions,'x'.repeat(50001));
    assert.ok(!JSON.stringify(local.agentPersonaRecoveries).includes('must-not-be-copied'));
    assert.ok(!pendingPersonaRecords(local).some(r=>r.kind===kind&&r.id===id));
    assert.equal(local.mobileWorkspaceSync.records.find(r=>r.kind===kind&&r.id===id).versions.length,1);
  }
});
