import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverRunnableTests } from './test-discovery.js';

const capturedEnv={...process.env};
// Reduce parallel browser pressure on constrained release hosts without
// changing discovery, assertions, timeouts or failure propagation.
const concurrency = capturedEnv.MELO_TEST_CONCURRENCY ?? '4';
if (!/^[1-9]\d*$/.test(concurrency) || !Number.isSafeInteger(Number(concurrency))) {
  throw new Error('MELO_TEST_CONCURRENCY must be a positive integer');
}
const { files, excluded }=await discoverRunnableTests();
if(process.argv.includes('--list')) {console.log(JSON.stringify({files,excluded},null,2));}
else {
  const home=await mkdtemp(join(tmpdir(),'melo-unit-gate-'));
  try {
    console.log(`Discovered ${files.length} test files; quarantined ${Object.keys(excluded).length}`);
    for(const [path,entry] of Object.entries(excluded))console.log(`QUARANTINED ${path}: ${entry.reason} (expires ${entry.expires})`);
    const child=spawn(process.execPath,['--test',`--test-concurrency=${concurrency}`,'--test-timeout=120000',...files],{
      stdio:'inherit',env:{...capturedEnv,MELO_HOME:home,MELO_TEST_MODE:'1'},
    });
    process.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>resolve(code??1));});
  } finally {await rm(home,{recursive:true,force:true});}
}
