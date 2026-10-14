import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportLocalArchive, importLocalArchive, validateLocalArchive, extractionCache } from './localData.js';
import { updateStateAtomically, loadState } from '../../state/stateStore.js';
import { matchesDomainRoute } from '../../http/domainRoutes.js';

test('portable import is idempotent, preserves local grants and excludes provider secrets',async()=>{
 const home=await mkdtemp(join(tmpdir(),'melo-archive-')),before=process.env.MELO_HOME;process.env.MELO_HOME=home;
 try {
  await updateStateAtomically(s=>{
   s.chats=[{id:'local-chat',title:'Hello',createdAt:'2026-10-10T00:00:00.000Z',updatedAt:'2026-10-10T00:00:00.000Z',messages:[{id:'msg-1',role:'user',content:'hello',createdAt:'2026-10-10T00:00:00.000Z'}]}];
   s.agentProfiles.main.channels={telegram:{botToken:'do-not-export-telegram'}};
   s.settings.localProfile={name:'Private device name',avatarData:''};return s;
  });
  const archive=await exportLocalArchive(),raw=JSON.stringify(archive);
  assert.ok(!raw.includes('do-not-export-telegram'));
  assert.ok(!raw.includes('Private device name'));
  assert.equal(validateLocalArchive(archive).summary.chats,1);
  const incoming=structuredClone(archive);incoming.snapshot.chats[0].messages.push({id:'msg-2',role:'assistant',content:'world',createdAt:'2026-10-10T01:00:00.000Z'});
  await importLocalArchive(incoming);await importLocalArchive(incoming);
  const state=await loadState();assert.equal(state.chats[0].messages.length,2);
  assert.equal(state.settings.localProfile.name,'Private device name');
  assert.equal(state.agentProfiles.main.channels.telegram.botToken,'do-not-export-telegram');
  assert.throws(()=>validateLocalArchive({format:'not-melo',version:1,snapshot:archive.snapshot}));
 } finally {before===undefined?delete process.env.MELO_HOME:process.env.MELO_HOME=before;await rm(home,{recursive:true,force:true});}
});
test('cache clearing removes only generated cache files and never follows symlinks',async()=>{
 const home=await mkdtemp(join(tmpdir(),'melo-clear-'));
 try{
  const dir=join(home,'media-cache','ab');await mkdir(dir,{recursive:true});
  const hash='c'.repeat(62)+'.json';await writeFile(join(dir,hash),'cached');await writeFile(join(dir,'notes.json'),'keep');
  const outside=join(home,'outside');await mkdir(outside);await writeFile(join(outside,hash),'private');await symlink(outside,join(home,'media-cache','cd'));
  const result=await extractionCache({home,clear:true});assert.equal(result.removed,1);assert.equal(await readFile(join(dir,'notes.json'),'utf8'),'keep');assert.equal(await readFile(join(outside,hash),'utf8'),'private');
 }finally{await rm(home,{recursive:true,force:true});}
});
test('all local settings routes are wired to the server dispatcher',()=>{
 for(const [method,path] of [['POST','local'],['GET','export'],['POST','import-preview'],['POST','import'],['GET','cache'],['POST','cache/clear']]) assert.equal(matchesDomainRoute({method},new URL('http://localhost/api/settings/'+path)),true,path);
});
