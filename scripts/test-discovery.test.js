import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverTests,discoverRunnableTests } from './test-discovery.js';
test('new nested tests enter discovery without editing package or a hand-maintained list',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'melo-discovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,'src/new/feature'),{recursive:true});
  await writeFile(join(dir,'src/new/feature/regression.test.js'),'');
  await writeFile(join(dir,'src/new/feature/implementation.js'),'');
  assert.deepEqual(await discoverTests(dir,['src']),['src/new/feature/regression.test.js']);
});
test('ordinary gate invokes discovery and the new architecture, sync and UI tests are included',async()=>{
  const {files}=await discoverRunnableTests();
  for(const path of ['src/state/residentState.test.js','src/runtime/derivedIndexing.test.js','src/http/bootstrapTransport.test.js','mobile-sync/audit-round3.test.js','mobile-sync/http.test.js','mobile-sync/taskProtocol.test.js','desktop-ui/bootstrapPatch.test.js'])assert.ok(files.includes(path),path);
  const pkg=JSON.parse(await readFile('package.json','utf8'));
  assert.equal(pkg.scripts['test:unit'],'node scripts/run-unit-tests.js');
  assert.match(await readFile('scripts/verify-red-green.js','utf8'),/runCommand\('npm', \['run', 'test:unit'\]\)/);
});
