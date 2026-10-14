import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { mergeSnapshots, validateSnapshot } from './protocol.js';
import { createSyncServer } from './server.js';
const stamp = '2026-10-06T12:00:00.000Z';
const snapshot = (id, content = id) => ({ version: 1, chats: [{ id: 'conversation', title: 'Test', createdAt: stamp, updatedAt: stamp, messages: [{ id, role: 'user', content, createdAt: stamp }] }] });
test('offline additions converge and retries do not duplicate messages', () => {
  const a = snapshot('a'), b = snapshot('b');
  const merged = mergeSnapshots(a,b);
  assert.equal(merged.chats[0].messages.length,2);
  assert.deepEqual(merged,mergeSnapshots(b,a));
  assert.deepEqual(merged,mergeSnapshots(merged,a));
});
test('identity conflicts fail without overwriting either side', () => {
  const a = snapshot('a');
  assert.throws(() => mergeSnapshots(a,snapshot('a','changed')), /conflict/);
  assert.equal(a.chats[0].messages[0].content,'a');
});
test('invalid payloads are rejected and private fields stripped', () => {
  const a = snapshot('a'); a.chats[0].apiKey = 'private'; a.chats[0].messages[0].attachments = ['private'];
  assert.ok(!JSON.stringify(validateSnapshot(a)).includes('private'));
  a.chats[0].messages.push(a.chats[0].messages[0]);
  assert.throws(() => validateSnapshot(a));
});
test('authenticated service persists concurrent offline updates, rejects unauthorized writes and survives restart', async t => {
  const directory = await mkdtemp(join(tmpdir(),'melo-sync-test-'));
  const token = 'test-only-'.repeat(5);
  let server;
  async function start() { server = createSyncServer({ token, directory }); server.listen(0,'127.0.0.1'); await once(server,'listening'); return `http://127.0.0.1:${server.address().port}/v1/sync`; }
  async function stop() { await new Promise(resolve => server.close(resolve)); }
  t.after(async () => { await stop(); await rm(directory,{recursive:true,force:true}); });
  let url = await start();
  const post = (body, auth = token) => fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${auth}`},body:JSON.stringify(body)});
  assert.equal((await post(snapshot('bad'),'bad')).status,401);
  assert.equal((await post({version:99})).status,400);
  const results = await Promise.all([post(snapshot('a')),post(snapshot('b'))]);
  assert.ok(results.every(result => result.status === 200));
  assert.equal((await (await post({version:1,chats:[]})).json()).chats[0].messages.length,2);
  assert.equal((await post(snapshot('a','conflict'))).status,409);
  assert.equal(JSON.parse(await readFile(join(directory,'conversations.json'))).chats[0].messages.length,2);
  await stop(); url = await start();
  assert.equal((await (await post(snapshot('a'))).json()).chats[0].messages.length,2);
  const deleted=await post({version:1,chats:[],deletedChats:[{id:'conversation',deletedAt:stamp}]});
  assert.equal(deleted.status,200);
  await stop(); url=await start();
  const stale=await(await post(snapshot('a'))).json();
  assert.deepEqual(stale.chats,[]);assert.equal(stale.deletedChats[0].id,'conversation');
});
test('merged capacity returns 413 and retains the previous server file intact',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'melo-sync-capacity-')),token='fixture-capacity-token-'.repeat(3);
  const server=createSyncServer({token,directory});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const post=body=>fetch(`http://127.0.0.1:${server.address().port}/v1/sync`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post(snapshot('a','a'.repeat(4_200_000)))).status,200);
  const before=await readFile(join(directory,'conversations.json'));
  assert.equal((await post(snapshot('b','b'.repeat(4_200_000)))).status,413);
  assert.deepEqual(await readFile(join(directory,'conversations.json')),before);
});
