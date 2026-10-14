import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cachedWorkspaceTree,closeWorkspaceTreeCaches } from './workspaceTreeCache.js';
import { listWorkspaceEntries,writeWorkspaceFile } from './workspaceFiles.js';
test('tree reads coalesce, return owned results and invalidate after internal and external writes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'melo-tree-cache-'));
  t.after(async()=>{closeWorkspaceTreeCaches();await rm(root,{recursive:true,force:true});});
  let scans=0;const load=()=>{scans++;return listWorkspaceEntries(root);};
  const [a,b]=await Promise.all([cachedWorkspaceTree(root,load),cachedWorkspaceTree(root,load)]);
  assert.equal(scans,1);a.filePaths.push('fake');assert.equal(b.filePaths.includes('fake'),false);
  await writeWorkspaceFile(root,'internal.txt','hello');
  assert.ok((await cachedWorkspaceTree(root,load)).filePaths.includes('internal.txt'));
  await writeFile(join(root,'external.txt'),'changed outside Melo');
  let found=false;
  for(let n=0;n<30;n++){if((await cachedWorkspaceTree(root,load)).filePaths.includes('external.txt')){found=true;break;}await delay(50);}
  assert.ok(found,'recursive watcher or TTL must observe external changes');
});
