import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

test('parallel syntax check covers all selected JS/MJS files and propagates a worker failure', async () => {
  const root=await mkdtemp(join(tmpdir(),'melo-syntax-'));
  const script=fileURLToPath(new URL('./check-syntax.js',import.meta.url));
  const files=['a.mjs','b.js','c.js','d.js','e.js'];
  const run=()=>execFileSync(process.execPath,[script,'--files',...files,'deleted.js'],{cwd:root,encoding:'utf8',stdio:'pipe'});
  try {
    for(const file of files) await writeFile(join(root,file),'const value = 1;');
    assert.match(run(),/Syntax checked 5 files/);
    await writeFile(join(root,'e.js'),'const broken = ;');
    assert.throws(run,error=>error.status===1&&/e\.js/.test(error.stderr));
  } finally {await rm(root,{recursive:true,force:true});}
});
