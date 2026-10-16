// Project defaults for the Agent and the team: validated on save, kept on
// disk and across later edits, and never placed in the sync payload.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequestContext} from '../../runtime/requestContext.js';
import {runWithRequestContext} from '../../runtime/requestScope.js';
import {updateStateAtomically,readStateSnapshot} from '../../state/stateStore.js';
import {updateProject} from './projectMutations.js';
import {normalizeProjectTeamPlan} from '../../domain/project/projectService.js';
import {refreshPortableWorkspace} from '../chat/portableWorkspace.js';

async function fixture(t,work){
 const home=await mkdtemp(join(tmpdir(),'melo-project-agents-'));t.after(()=>rm(home,{recursive:true,force:true}));
 return runWithRequestContext(createRequestContext({home}),async()=>{
  await updateStateAtomically(s=>{s.projects=[{id:'p',name:'P',workspacePath:home}];s.chats=[];return s;},{home});
  return work(home);
 });
}

test('default Agent and team are validated, persisted and survive unrelated edits',t=>fixture(t,async home=>{
 await assert.rejects(updateProject('p',{defaultAgentId:'nobody'}),/默认 Agent 不存在/);
 await assert.rejects(updateProject('p',{teamPlan:{templateId:'research-build-review',members:['research','ghost']}}),/ghost/);
 await assert.rejects(updateProject('p',{teamPlan:{templateId:'review-loop',members:['research']}}),/两个成员/);
 let s=await readStateSnapshot({home});assert.equal(s.projects[0].defaultAgentId,'');assert.equal(s.projects[0].teamPlan,null);
 await updateProject('p',{defaultAgentId:'research',teamPlan:{templateId:'parallel-research',members:['research','reviewer'],mode:'sequential',maxTokens:5}});
 await updateProject('p',{name:'Renamed'});
 s=await readStateSnapshot({home});
 assert.equal(s.projects[0].name,'Renamed');assert.equal(s.projects[0].defaultAgentId,'research');
 // Only the template and members are stored; run-time limits come from the template.
 assert.deepEqual(s.projects[0].teamPlan,{templateId:'parallel-research',members:['research','reviewer']});
 await updateProject('p',{teamPlan:null,defaultAgentId:''});
 s=await readStateSnapshot({home});assert.equal(s.projects[0].teamPlan,null);assert.equal(s.projects[0].defaultAgentId,'');
 await updateProject('p',{defaultAgentId:'research',teamPlan:{templateId:'review-loop',members:['builder','reviewer']}});
 s=await readStateSnapshot({home});
 const record=refreshPortableWorkspace(s).records.find(row=>row.kind==='project'&&row.id==='p');
 assert.ok(record,'project still syncs');
 const value=JSON.stringify(record.versions.map(v=>v.value));
 assert.doesNotMatch(value,/defaultAgentId|teamPlan/);
}));

test('stored team shape is coerced, and project defaults stay out of the sync payload',()=>{
 assert.equal(normalizeProjectTeamPlan({templateId:'unknown',members:['a']}),null);
 assert.equal(normalizeProjectTeamPlan({templateId:'review-loop',members:[]}),null);
 assert.deepEqual(normalizeProjectTeamPlan({templateId:'review-loop',members:['a','a','bad id',3,'b']}),{templateId:'review-loop',members:['a','b']});
});
