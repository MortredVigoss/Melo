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

// 2026-11-14: the two native builds run as one batch. The log name used to be
// taken from the number of finished stages, so two stages started together
// wrote into the same file.
test('two stages started together keep their own logs and both are recorded',async()=>{
  const root=await mkdtemp(join(tmpdir(),'melo-stage-'));
  try {
    const runner=await createStageRunner({root,emit:()=>{}});
    const say=word=>['-e',`setTimeout(()=>console.log(${JSON.stringify(word)}),${word==='slow'?150:10})`];
    const [slow,fast]=await Promise.all([runner.run('slow',process.execPath,say('slow')),runner.run('fast',process.execPath,say('fast'))]);
    assert.notEqual(slow.log,fast.log);
    assert.equal((await readFile(slow.log,'utf8')).trim(),'slow');assert.equal((await readFile(fast.log,'utf8')).trim(),'fast');
    const {records}=JSON.parse(await readFile(join(runner.directory,'report.json'),'utf8'));
    assert.deepEqual(records.map(record=>record.label).sort(),['fast','slow']);
    // One of them failing does not hide the other; the caller decides (allowFailure).
    const [bad,good]=await Promise.all([runner.run('bad',process.execPath,['-e','process.exit(3)'],{allowFailure:true}),runner.run('good',process.execPath,['-e','0'],{allowFailure:true})]);
    assert.deepEqual([bad.code,good.code],[3,0]);
  } finally {await rm(root,{recursive:true,force:true});}
});
