import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile,realpath} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createRequestContext} from '../runtime/requestContext.js';import {runWithRequestContext} from '../runtime/requestScope.js';
import {persistPermissionRule,checkPermissionRule} from '../tools/permissions.js';import {addFileSafetyRule,findMatchingFileSafetyRule,removeFileSafetyRule} from './fileSafetyAllowlist.js';
import {commandTemplate,saveCommandRule,findCommandRule,removeCommandRule} from './commandRules.js';import {listPermissionAudit} from './permissionAudit.js';
test('role/project scope prevents reuse; revoke applies immediately and command changes invalidate',async()=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),'melo-scoped-')));const base=createRequestContext({home});const a={...base,permissionScope:{role:'builder',project:'a',workspace:{path:home,inode:'1',device:'1'}}};try{
 await runWithRequestContext(a,async()=>{
   await persistPermissionRule('fixture','allow');assert.equal(await checkPermissionRule('fixture'),'allow');
   const rule=await addFileSafetyRule({operation:'read',scope:'file',realPath:join(home,'f')});assert.ok(await findMatchingFileSafetyRule('read',join(home,'f')));await removeFileSafetyRule(rule.id);assert.equal(await findMatchingFileSafetyRule('read',join(home,'f')),null);
   await writeFile(join(home,'package.json'),'{"scripts":{"test":"fixture"}}');const template=await commandTemplate('npm test',home);await saveCommandRule(template);const grant=await findCommandRule(template);assert.ok(grant);await writeFile(join(home,'package.json'),'{"scripts":{"test":"changed"}}');assert.equal(await findCommandRule(await commandTemplate('npm test',home)),null);assert.equal(await commandTemplate('npm test; echo unsafe',home),null);await removeCommandRule(grant.id);assert.equal(await findCommandRule(template),null);
 });
 await runWithRequestContext({...a,permissionScope:{...a.permissionScope,role:'research'}},async()=>assert.equal(await checkPermissionRule('fixture'),'ask'));
 await runWithRequestContext({...a,permissionScope:{...a.permissionScope,workspace:{...a.permissionScope.workspace,inode:'2'}}},async()=>assert.equal(await checkPermissionRule('fixture'),'ask'));
 assert.ok(listPermissionAudit(home).some(e=>e.reason.includes('角色')));
 }finally{await rm(home,{recursive:true,force:true});}
});
