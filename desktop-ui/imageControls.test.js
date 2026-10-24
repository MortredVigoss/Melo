import { PROVIDER_DEFAULTS } from '../shared/agent/providerDefaults.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderImageSettings,
  renderImageTaskControls,
  consumeImageTask,
  restoreImageTask,
  handleImageInput,
  handleImageAction,
  clearImageTask,
} from './imageControls.js';

test('image options keep engine, model and reference choices visible and in sync with submitted task', async () => {
  const config = {
    authMode: 'codex',
    model: 'gpt-6-astra',
    llmConnections: {
      profiles: [
        { id: 'a', name: 'Codex', authMode: 'codex' },
        { id: 'b', name: 'API', authMode: 'api-key', hasKey: true },
      ],
    },
  };
  assert.match(renderImageSettings(config), /value="gpt-6-astra"/);
  restoreImageTask({
    action: 'edit',
    references: [
      { attachmentId: 'removed', role: 'style' },
      { attachmentId: 'original', role: 'subject' },
    ],
    mask: 'old-mask',
    maskSourceId: 'removed',
  });
  const html = renderImageTaskControls([
    { id: 'original', kind: 'image', title: '<img src=x onerror=alert(1)>' },
  ]);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /移除遮罩/);
  const task = consumeImageTask();
  assert.equal(task.mask, undefined);
  assert.deepEqual(task.references, [{ attachmentId: 'original', role: 'subject' }]);
  assert.equal(consumeImageTask(), null);
  await handleImageAction('image-task-toggle', { config, attachments: [], render() {} });
  handleImageInput({ dataset: { imageTask: 'count' }, value: '3' }, config);
  assert.equal(consumeImageTask().count, 3);
  clearImageTask();
});

test('creation and editing expose per-image inspection with honest cost and retry language',()=>{
  for(const action of ['generate','edit']){
    restoreImageTask({action,inspect:true,references:[]});
    const html=renderImageTaskControls([]);
    assert.match(html,/data-image-task="inspect" checked/);assert.match(html,/每张额外一次视觉请求/);assert.match(html,/不自动重生成/);
    assert.equal(consumeImageTask().inspect,true);
  }
  clearImageTask();
});

test('image settings require edit, keep failed drafts, and lock only after save acknowledgement',async()=>{
 const config={imageSettings:{engine:'codex-oauth',codexModel:'gpt-6.1-sol'}};
 let requests=0,fail=true;
 const context={config,attachments:[],render(){},refresh:async()=>{},api:async(_path,{body})=>{requests++;if(fail)throw new Error('offline');assert.equal(body.imageSettings.codexModel,'gpt-6-astra');}};
 const input={dataset:{imageSetting:'codexModel'},value:'gpt-6-astra'};
 assert.match(renderImageSettings(config),/<fieldset[^>]*disabled/);
 handleImageInput(input,config);await handleImageAction('image-settings-save',context);assert.equal(requests,0);
 await handleImageAction('image-settings-edit',context);handleImageInput(input,config);
 assert.match(renderImageSettings(config),/data-edit-status="dirty"/);assert.equal(requests,0);
 await handleImageAction('image-settings-save',context);assert.match(renderImageSettings(config),/data-edit-status="error"/);assert.match(renderImageSettings(config),/value="gpt-6-astra"/);
 fail=false;await handleImageAction('image-settings-save',context);assert.equal(requests,2);assert.match(renderImageSettings(config),/data-edit-status="saved"/);assert.match(renderImageSettings(config),/<fieldset[^>]*disabled/);
});


test('image settings share registry defaults while keeping saved opaque model IDs', () => {
  const codex = renderImageSettings({authMode:'api-key'});
  assert.ok(codex.includes(`value="${PROVIDER_DEFAULTS.chat.codex}"`));
  const api = renderImageSettings({imageSettings:{engine:'openai-api'}});
  assert.ok(api.includes(`value="${PROVIDER_DEFAULTS.media.image}"`));
  assert.match(renderImageSettings({imageSettings:{engine:'openai-api',model:'custom-image-endpoint'}}), /value="custom-image-endpoint"/);
  assert.match(renderImageSettings({imageSettings:{engine:'codex-oauth',codexModel:'custom-language-endpoint'}}), /value="custom-language-endpoint"/);
});
