import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inferImageTask } from './imageTask.js';
import { validateChatRequest } from './requestContract.js';
import { handleImageAction, consumeImageTask, renderImageTaskControls, restoreImageTask } from '../../../desktop-ui/imageControls.js';
const fixtures = JSON.parse(readFileSync(new URL('../../../ios/Tests/Fixtures/image-natural-intent.json', import.meta.url)));
for (const fixture of fixtures) test(`natural image request: ${fixture.prompt}`, () => {
  const messages = [{ role: 'user', content: fixture.hasImage ? [{type:'text',text:fixture.prompt},{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}] : fixture.prompt }];
  for (const options of [null, { action:'auto', references:[], quality:'high' }]) {
    assert.equal(inferImageTask(fixture.prompt, messages, options)?.action ?? 'analyze', fixture.action);
  }
});
test('opening image options does not force ordinary text into image generation', async () => {
  restoreImageTask(null);
  await handleImageAction('image-task-toggle', {config:{}, attachments:[], render(){}});
  const html = renderImageTaskControls([]);
  assert.doesNotMatch(html, /data-image-task="action"|本次任务<select/);
  const draft = consumeImageTask(); assert.equal(draft.action, 'auto');
  const request = validateChatRequest({chatId:'test',content:'今天有什么安排',imageTask:draft});
  assert.equal(inferImageTask(request.content,[],request.imageTask).action,'analyze');
  assert.equal(inferImageTask('做一个 logo',[],draft).action,'generate');
  assert.equal(inferImageTask('生成 3 张图片',[],request.imageTask).count,3);
});

test("natural color follow-up retains only this conversation's recent image", async () => {
  const { imageFollowUpAttachments } = await import('./imageTurnState.js');
  const image = {id:'photo',kind:'image',url:'data:image/png;base64,AAAA'};
  const chat = {id:'local',messages:[{role:'user',content:'看一下',attachments:[image]}]};
  const options = {chat,attachments:[],content:'增加一些对比度 粉色更粉 蓝色更蓝一点点',home:'/unused'};
  assert.deepEqual(await imageFollowUpAttachments(options),[image]);
  assert.deepEqual(await imageFollowUpAttachments({...options,content:'如何增加对比度'}),[]);
  assert.deepEqual(await imageFollowUpAttachments({...options,chat:{id:'other',messages:[]}}),[]);
});

const batchFixtures = JSON.parse(readFileSync(new URL('../../../ios/Tests/Fixtures/image-batch-intent.json', import.meta.url)));
for (const fixture of batchFixtures) test(`several photos: ${fixture.prompt} (${fixture.photos})`, () => {
  const parts = Array.from({ length: fixture.photos }, () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }));
  const task = inferImageTask(fixture.prompt, [{ role: 'user', content: [{ type: 'text', text: fixture.prompt }, ...parts] }], null);
  assert.equal(task?.action, 'edit');
  assert.equal(task?.separately === true, fixture.separately);
});
