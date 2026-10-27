import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequestContext} from '../runtime/requestContext.js';
import {runWithRequestContext} from '../runtime/requestScope.js';
import {skillFromMarkdown,getSkillsDiskRoot,saveSkillToDisk,loadSkillsFromDisk,removeSkillFromDisk} from './skillsDisk.js';
test('skill disk operations capture their request home and never share another home',async t=>{
 const base=await mkdtemp(join(tmpdir(),'melo-skills-homes-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const a=createRequestContext({home:join(base,'a')}),b=createRequestContext({home:join(base,'b')});
 const skill={id:'same-id',name:'Same',description:'fixture',systemPrompt:'A'};
 await Promise.all([runWithRequestContext(a,()=>saveSkillToDisk(skill)),runWithRequestContext(b,()=>saveSkillToDisk({...skill,systemPrompt:'B'}))]);
 assert.equal(await runWithRequestContext(a,async()=>{assert.equal(getSkillsDiskRoot(),join(a.home,'desktop','skills'));return (await loadSkillsFromDisk())[0].systemPrompt;}),'A');
 assert.equal((await runWithRequestContext(b,()=>loadSkillsFromDisk()))[0].systemPrompt,'B');
 await runWithRequestContext(a,()=>removeSkillFromDisk('same-id'));await assert.rejects(access(join(a.home,'desktop','skills','same-id')));
 assert.equal((await runWithRequestContext(b,()=>loadSkillsFromDisk()))[0].systemPrompt,'B');
});

test('reloading the active home retains saved legacy skill records without scanning their old directory',async t=>{const home=await mkdtemp(join(tmpdir(),'melo-legacy-skills-'));t.after(()=>rm(home,{recursive:true,force:true}));const {mergeDiskSkillsIntoState}=await import('../state/diskSkills.js');await runWithRequestContext(createRequestContext({home}),async()=>{await saveSkillToDisk({id:'new-skill',name:'New',systemPrompt:'New instructions'});const state={settings:{customSkills:[{id:'legacy-skill',name:'Legacy',origin:'disk',diskPath:'/legacy/skills/legacy-skill',systemPrompt:'Keep legacy instructions'}]}};await mergeDiskSkillsIntoState(state);assert.equal(state.settings.customSkills.find(s=>s.id==='legacy-skill').systemPrompt,'Keep legacy instructions');assert.ok(state.settings.customSkills.some(s=>s.id==='new-skill'));});});

test("disk skill defaults use the shared allowance without replacing an explicit saved limit", () => {
 assert.equal(skillFromMarkdown("new", "# New\nInstructions", "/fixture").maxIterations, 12);
 assert.equal(skillFromMarkdown("old", "---\nmax-iterations: 6\n---\nInstructions", "/fixture").maxIterations, 6);
});
