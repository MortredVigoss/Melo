import test from 'node:test';
import assert from 'node:assert/strict';
import { preloadMobileScenes, verifiedMobileScenes } from './mobileSyncRoutes.js';
import { refreshPortableWorkspace } from '../services/chat/portableWorkspace.js';
import { createExecutionScene } from '../shared/executionScene.js';

test('scene preload bounds I/O and rejects concurrent message or sync changes', async () => {
  const messages = Array.from({length: 12}, (_, i) => ({ id: `m${i}`, role: 'assistant', content: 'answer', metadata: { runId: `r${i}` } }));
  const state = { chats: [{ id: 'c', messages }] };
  let running = 0, peak = 0;
  const prepared = await preloadMobileScenes(state, '/captured', async (home, runId) => {
    assert.equal(home, '/captured'); running++; peak = Math.max(peak, running);
    await new Promise(resolve => setImmediate(resolve)); running--;
    return {runId, status:'completed'};
  });
  assert.equal(peak, 4);
  assert.equal(verifiedMobileScenes(state, prepared).size, 12);
  state.chats[0].messages[0].content = 'new';
  state.mobileWorkspaceSync = {records:[{kind:'message',id:'m1',versions:[{clock:{desktop:2},value:{scene:{runId:'r1'}}}]}]};
  const verified = verifiedMobileScenes(state, prepared);
  assert.equal(verified.size, 10);
  assert.equal(verified.has('r0'), false);
  assert.equal(verified.has('r1'), false);
});
test('a scene omitted due to a stale preload does not erase the newer synced scene', () => {
  const scene = {...createExecutionScene({runId:'run',chatId:'chat',query:'query'}),status:'completed'};
  const state={chats:[{id:'chat',messages:[{id:'reply',role:'assistant',metadata:{runId:'run'}}]}]};
  refreshPortableWorkspace(state,{scenes:new Map([['run',scene]])});
  const before=structuredClone(state.mobileWorkspaceSync.records.find(r=>r.kind==='message'));
  refreshPortableWorkspace(state);
  assert.deepEqual(state.mobileWorkspaceSync.records.find(r=>r.kind==='message'),before);
});

test('legacy local messages without timestamps survive import and deterministic re-export',async()=>{
 const {importMobileSnapshot,exportMobileSnapshot}=await import('./mobileSyncRoutes.js');
 const stamp='2026-01-01T00:00:00.000Z';
 const state={chats:[{id:'legacy',title:'old',createdAt:stamp,updatedAt:stamp,messages:[{id:'local',role:'user',content:'preserved'},{id:'system',role:'system',content:'hidden'}]}]};
 const incoming={version:1,chats:[{id:'legacy',title:'old',createdAt:stamp,updatedAt:stamp,messages:[{id:'new',role:'assistant',content:'remote',createdAt:stamp}]}]};
 importMobileSnapshot(state,incoming);const first=exportMobileSnapshot(state);importMobileSnapshot(state,incoming);
 assert.deepEqual(exportMobileSnapshot(state),first);assert.equal(state.chats[0].messages.length,3);
});
