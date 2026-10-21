import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStageRunner} from './test-stage-runner.js';

test('stage runner saves complete output, reports time and executes identical inputs again',async()=>{
  const root=await mkdtemp(join(tmpdir(),'melo-stage-'));
  try {
    const messages=[];const runner=await createStageRunner({root,emit:s=>messages.push(s),env:{...process.env,TEST_MARKER:'bound'}});
    for(let i=0;i<2;i++)await runner.run('fixture',process.execPath,['-e','console.log(process.env.TEST_MARKER); console.log("x".repeat(20000)); console.error("stderr")']);
    const {records}=JSON.parse(await readFile(join(runner.directory,'report.json'),'utf8'));
    assert.equal(records.length,2);assert.ok(records.every(r=>r.code===0&&r.seconds>=0));
    for(const record of records) {const log=await readFile(record.log,'utf8');assert.ok(log.length>20000);assert.match(log,/bound/);assert.match(log,/stderr/);}
    assert.ok(messages.join('\n').length<1500,'successful output stays in log');
    await assert.rejects(runner.run('failure',process.execPath,['-e','console.error("regression detail");process.exit(9)']),/failed \(9\)/);
    assert.ok(messages.some(s=>s.includes('regression detail')));
    assert.equal(JSON.parse(await readFile(join(runner.directory,'report.json'),'utf8')).records.at(-1).code,9);
  } finally {await rm(root,{recursive:true,force:true});}
});
