import test from 'node:test';
import assert from 'node:assert/strict';
import { exportMobileSnapshot, importMobileSnapshot } from '../src/http/mobileSyncRoutes.js';
const date = '2026-10-06T12:00:00.000Z';
function state() { return { chats: [{id:'desktop',title:'Desktop',createdAt:date,updatedAt:date,projectId:'private-project',messages:[{id:'m1',role:'user',content:'hello',createdAt:date,attachments:[{path:'/private'}],toolResults:[{private:true}]}]}] }; }
test('desktop exports text without attachment paths, project bindings or external-channel chats', () => {
 const source=state(); source.chats.push({...source.chats[0],id:'external',externalThreadKey:'private-channel'});
 const out=exportMobileSnapshot(source);
 assert.equal(out.chats.length,1); assert.ok(!JSON.stringify(out).includes('private'));
});
test('mobile import preserves desktop-only metadata and retry is idempotent', () => {
 const source=state(); const remote=exportMobileSnapshot(source);
 remote.chats[0].messages.push({id:'m2',role:'assistant',content:'reply',createdAt:date});
 importMobileSnapshot(source,remote); importMobileSnapshot(source,remote);
 assert.equal(source.chats[0].projectId,'private-project');
 assert.equal(source.chats[0].messages.length,2);
 assert.equal(source.chats[0].messages[0].attachments[0].path,'/private');
});
test('new phone conversation keeps IDs and can be exported unchanged', () => {
 const source=state(); const remote=exportMobileSnapshot(state()); remote.chats[0].id='phone';
 importMobileSnapshot(source,remote);
 assert.equal(source.chats.length,2);
 assert.equal(source.chats.find(chat=>chat.id==='phone').source,'iphone');
 assert.deepEqual(exportMobileSnapshot(source).chats.find(chat=>chat.id==='phone'),remote.chats[0]);
});
