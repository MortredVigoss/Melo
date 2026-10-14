import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile,readFile,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {previewRestore,confirmRestore} from './restorePreview.js';import {snapshotBeforeWrite} from './backup.js';
import {createRequestContext} from '../runtime/requestContext.js';import {runWithRequestContext} from '../runtime/requestScope.js';
test('restore previews exact content, rejects stale state, and preserves reversible backup',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'melo-restore-preview-')));try{await runWithRequestContext(createRequestContext({home:join(dir,'home')}),async()=>{
 const file=join(dir,'document.txt');await writeFile(file,'before');const backup=await snapshotBeforeWrite(file);await writeFile(file,'after');
 const preview=await previewRestore(backup.operationId);assert.equal(preview.currentPreview,'after');assert.equal(preview.restoredPreview,'before');await writeFile(file,'newer');await assert.rejects(confirmRestore(preview.token),/修改/);assert.equal(await readFile(file,'utf8'),'newer');
 const next=await previewRestore(backup.operationId), restored=await confirmRestore(next.token);assert.equal(await readFile(file,'utf8'),'before');assert.ok(restored.safetyBackupId);await assert.rejects(confirmRestore(next.token),/过期/);
 });}finally{await rm(dir,{recursive:true,force:true});}
});
