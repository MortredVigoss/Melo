import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReplyLocale } from './locale.js';
import { runtimeMessage, executionMessage, runtimeStageName, runtimeStageOutput } from './runtimeMessages.js';
import { multilingualImageAction } from './imageLanguage.js';
import { inferImageTask } from '../../src/services/chat/imageTask.js';
import { completionReceipt } from './completion.js';

test('reply language prioritizes Agent, user, channel and interface without treating every Han character as Chinese', () => {
  assert.equal(resolveReplyLocale({agentLanguage:'ko',text:'hello',interfaceLanguage:'en'}),'ko');
  for (const [text,lang] of [['天気を教えて','ja'],['날씨 알려줘','ko'],['你好','zh'],['¿Cómo estará el tiempo?','es'],['Tell me more','en']]) assert.equal(resolveReplyLocale({text,interfaceLanguage:'zh-CN'}),lang);
  assert.equal(resolveReplyLocale({text:'BigBang 31',channelLanguage:'es',interfaceLanguage:'ja'}),'es');
  assert.equal(resolveReplyLocale({text:'31',interfaceLanguage:'ja'}),'ja');
  assert.equal(resolveReplyLocale({text:'https://example.com/hello',interfaceLanguage:'ko'}),'ko');
});
test('persisted events translate authored names and static outputs; user and tool text stays exact', () => {
  const event=executionMessage({kind:'pipeline',name:'整理回答与引用',output:'处理返回文字、引用与消息格式'});
  assert.equal(event.messageId,'stage.format');assert.equal(event.outputMessageId,'output.format');
  const restored=JSON.parse(JSON.stringify(event));
  for(const language of ['en','ja','ko','es']) {
    assert.notEqual(runtimeStageName(restored,language),event.name);
    assert.notEqual(runtimeStageOutput(restored,language),event.output);
    assert.notEqual(runtimeMessage('budget',language,{reason:'deadline'}),runtimeMessage('budget','zh',{reason:'deadline'}));
  }
  assert.equal(runtimeStageName({name:'执行已停止'},'en'),'Execution stopped');
  assert.equal(runtimeStageOutput({name:'收到补充',output:'用户输入内容 #123'},'en'),'用户输入内容 #123');
  assert.equal(runtimeStageOutput({name:'Unknown provider stage',output:'provider original'},'ja'),'provider original');
});
test('Japanese, Korean and Spanish image actions reach the actual image workflow; discussions do not spend quota', () => {
  const input=[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,YQ=='}}]}];
  for(const text of ['猫を描いて','고양이를 그려줘','Dibuja un gato']) assert.equal(inferImageTask(text,[],null)?.action,'generate',text);
  for(const text of ['写真の背景を変えて','사진 배경을 바꿔','Cambia el fondo de la foto']) assert.equal(inferImageTask(text,input,null)?.action,'edit',text);
  for(const text of ['画像を生成しないで','이미지를 생성하지 마','No dibuja una imagen','Cómo crear una imagen','「猫を描いて」とは何ですか']) { assert.equal(multilingualImageAction(text,true),null);assert.equal(inferImageTask(text,input,null),null,text); }
  assert.equal(inferImageTask('猫を描いて',[],{action:'analyze'}).action,'analyze');
});

test('an authored message template never translates matching user supplement text',()=>{
 assert.equal(runtimeStageOutput({kind:'pipeline',id:'supplement:x',name:'收到补充',output:'已中止。'},'en'),'已中止。');
 const event=executionMessage({kind:'pipeline',id:'compact:x',name:'压缩早期对话',outputMessageId:'output.compactStart',outputMessageParams:{count:12},output:'legacy'});
 assert.equal(runtimeStageOutput(event,'en'),'Condensing the earliest 12 messages.');
});
