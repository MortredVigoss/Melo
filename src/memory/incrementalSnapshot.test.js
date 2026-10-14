import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { syncDerivedSnapshot,resetDerivedMemoryCacheForTests } from '../state/derivedSnapshot.js';
import { buildMemoryStoreEntries } from '../state/memorySnapshot.js';
import { _resetStoreForTests,getMemoriesByIds,recordMemoryHit,getHitStats } from './store.js';
import { resolveSessionFacts } from './factRecords.js';
import { updateStateAtomically,loadState } from '../state/stateStore.js';
import { persistSessionMemorySnapshot } from '../services/chat/derivedState.js';
let home,ctx,conn,prior;
test.beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),'melo-incremental-index-'));prior=process.env.MELO_HOME;process.env.MELO_HOME=home;
 ctx={home,storePath:join(home,'desktop/store.sqlite')};_resetStoreForTests();resetDerivedMemoryCacheForTests();
});
test.afterEach(()=>{conn?.close();conn=null;_resetStoreForTests();resetDerivedMemoryCacheForTests();if(prior===undefined)delete process.env.MELO_HOME;else process.env.MELO_HOME=prior;rmSync(home,{recursive:true,force:true});});
const chat=(id,text)=>({id,title:id,agentId:'main',source:'desktop',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',sessionMemory:[],messages:[{id:`${id}-m1`,role:'user',content:text,createdAt:'2026-01-01T00:00:00Z'}]});
const state=()=>({chats:[chat('a','rareword alpha'),chat('b','rareword beta')],settings:{promptHistory:[]},tasks:[],approvals:[],agentProfiles:{}});
function observe(){conn=new DatabaseSync(ctx.storePath);conn.exec(`CREATE TABLE audit_updates(id TEXT,op TEXT);
 CREATE TRIGGER observe_update AFTER UPDATE ON memories BEGIN INSERT INTO audit_updates VALUES(new.id,'update'); END;
 CREATE TRIGGER observe_insert AFTER INSERT ON memories BEGIN INSERT INTO audit_updates VALUES(new.id,'insert'); END;
 CREATE TRIGGER observe_delete AFTER DELETE ON memories BEGIN INSERT INTO audit_updates VALUES(old.id,'delete'); END;`);}

test('unchanged snapshots make no row writes; same-count edits only change affected sources and preserve hits',()=>{
 const s=state();assert.equal(syncDerivedSnapshot(s,ctx),true);observe();
 const id=conn.prepare("SELECT id FROM memories WHERE kind='prompt' AND namespace='chat:a'").get().id;
 recordMemoryHit({memoryId:id,queryHash:'q'});
 assert.equal(syncDerivedSnapshot(s,ctx),false);
 assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM audit_updates').get().n,0);
 s.chats[0].messages[0].content='rareword edited at same timestamp and count';
 assert.equal(syncDerivedSnapshot(s,ctx),true);
 assert.match(getMemoriesByIds([id])[0].text,/edited at same/);
 assert.equal(getHitStats({memoryIds:[id]})[0].hits,1);
 const writes=conn.prepare('SELECT * FROM audit_updates').all();
 assert.ok(writes.length>0);assert.ok(writes.every(r=>!r.id.includes('chat:b')),'unmodified chat rows must not be touched');
 assert.ok(writes.every(r=>r.op!=='delete'),'edited IDs are updated, not deleted/reinserted');
});

test('failed patch rolls back and retries identical source version instead of advancing cache',()=>{
 const s=state();syncDerivedSnapshot(s,ctx);conn=new DatabaseSync(ctx.storePath);
 const old=conn.prepare("SELECT text FROM memories WHERE kind='prompt' AND namespace='chat:a'").get().text;
 conn.exec("CREATE TRIGGER injected_failure BEFORE UPDATE ON memories WHEN new.namespace='chat:a' BEGIN SELECT RAISE(ABORT,'injected patch failure'); END");
 s.chats[0].messages[0].content='changed';assert.equal(syncDerivedSnapshot(s,ctx),false);
 assert.equal(conn.prepare("SELECT text FROM memories WHERE kind='prompt' AND namespace='chat:a'").get().text,old);
 conn.exec('DROP TRIGGER injected_failure');assert.equal(syncDerivedSnapshot(s,ctx),true);
 assert.equal(conn.prepare("SELECT text FROM memories WHERE kind='prompt' AND namespace='chat:a'").get().text,'changed');
});

test('source deletion removes stale derived IDs but preserves other chats and their hit history',()=>{
 const s=state();syncDerivedSnapshot(s,ctx);conn=new DatabaseSync(ctx.storePath);
 const id=conn.prepare("SELECT id FROM memories WHERE kind='prompt' AND namespace='chat:b'").get().id;
 recordMemoryHit({memoryId:id});s.chats.shift();syncDerivedSnapshot(s,ctx);
 assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM memories WHERE namespace='chat:a'").get().n,0);
 assert.equal(getHitStats({memoryIds:[id]})[0].hits,1);
 assert.equal(conn.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('incremental namespace continuity matches full build across shared speaker sources',()=>{
 const s=state();s.chats.forEach(c=>{c.source='telegram';c.messages[0].senderId='same-speaker';});
 s.chats[0].messages[0].content='I live in Melbourne';syncDerivedSnapshot(s,ctx);
 s.chats[1].messages[0].content='I moved and now live in Sydney';s.chats[1].messages[0].createdAt='2026-02-01T00:00:00Z';syncDerivedSnapshot(s,ctx);
 const expected=buildMemoryStoreEntries(s).filter(r=>r.kind==='fact');
 assert.ok(expected.length>0);
 for(const row of expected){const [actual]=getMemoriesByIds([row.id]);assert.equal(actual.text,row.text);assert.equal(actual.metadata.status,row.metadata.status);}
});

test('persisting extracted facts creates canonical rows; recall is indexed and read-only',async()=>{
 const s=state();await updateStateAtomically(current=>{current.chats=s.chats;},{home});
 const snapshot=(await loadState({home})).chats.find(c=>c.id==='a');
 snapshot.sessionMemory=[{fact:'prefers nebula purple',category:'preference',extractedAt:'2026-01-02T00:00:00Z'}];snapshot.memoryLastExtractedAtCount=1;
 assert.equal(await persistSessionMemorySnapshot(snapshot,{home}),true);
 observe();const facts=resolveSessionFacts(snapshot);assert.equal(facts[0].fact,'prefers nebula purple');
 assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM audit_updates').get().n,0);
 const plan=conn.prepare("EXPLAIN QUERY PLAN SELECT * FROM memories WHERE json_extract(metadata_json,'$.chatId')=? AND kind='session-fact'").all('a');
 assert.match(JSON.stringify(plan),/idx_memories_chat_kind/);
});
