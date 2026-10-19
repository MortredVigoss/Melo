import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('new-chat action clears unsent attachments only after successful creation', async () => {
  const source = await readFile(new URL('./features/chat/controller.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('async function handleCreateChat('), source.indexOf('// A supplement for the reply running in this chat.'));
  const uiState = {bootstrap:{settings:{}},composer:'draft',composerAttachments:[{id:'private-file'}]};
  let reject = true;
  const context=vm.createContext({uiState,resetComposerHistoryNavigation(){},applyBootstrap(){},api:async()=>{if(reject)throw new Error('offline');return {};}});
  vm.runInContext(code,context);
  await assert.rejects(vm.runInContext('handleCreateChat()',context),/offline/);
  assert.equal(uiState.composerAttachments.length,1);
  reject=false;
  await vm.runInContext('handleCreateChat()',context);
  assert.equal(uiState.composerAttachments.length,0);
  assert.equal(uiState.composer,'');
});
