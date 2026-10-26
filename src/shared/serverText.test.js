import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_TEXT, serverText } from './serverText.js';
import { RUNTIME_MESSAGES, runtimeMessage, runtimeStageName, runtimeStageOutput } from '../../shared/agent/runtimeMessages.js';
import { replyLocale } from '../../shared/agent/locale.js';
import { createRequestContext } from '../runtime/requestContext.js';
import { runWithRequestContext } from '../runtime/requestScope.js';
import { createExecutionScene, applyExecutionEvent } from './executionScene.js';

test('reply language follows agent, latest user language, channel and interface in order', () => {
  const chat={messages:[{role:'user',content:'明日の天気を教えてください'},{role:'assistant',content:'请查阅网站'}]};
  assert.equal(replyLocale(chat,'',{interfaceLanguage:'en'}),'ja');
  assert.equal(replyLocale(chat,'Please explain this',{agentLanguage:'ko',interfaceLanguage:'es'}),'ko');
  assert.equal(replyLocale(chat,'Please explain this',{interfaceLanguage:'es'}),'en');
  assert.equal(replyLocale({},'',{channelLanguage:'es',interfaceLanguage:'ko'}),'es');
  assert.equal(replyLocale({},'',{interfaceLanguage:'ko-KR'}),'ko');
  assert.equal(replyLocale({},'https://example.com/a.js',{interfaceLanguage:'ja'}),'ja');
});
test('request languages survive async boundaries and do not leak between concurrent requests', async () => {
  const result=await Promise.all(['ja','ko','es','en','zh'].map(interfaceLanguage=>runWithRequestContext(createRequestContext({interfaceLanguage}),async()=>{
    await new Promise(resolve=>setImmediate(resolve));
    const child=createRequestContext();
    assert.equal(child.interfaceLanguage,interfaceLanguage);
    return runWithRequestContext(child,()=>serverText('noActiveReply'));
  })));
  assert.deepEqual(result,['ja','ko','es','en','zh'].map(locale=>SERVER_TEXT.noActiveReply[locale]));
  assert.equal(serverText('noActiveReply'),SERVER_TEXT.noActiveReply.en);
  assert.equal(runWithRequestContext(createRequestContext({interfaceLanguage:'ja',replyLocale:'ko'}),()=>serverText('noActiveReply')),SERVER_TEXT.noActiveReply.ko);
});
test('all runtime and error messages cover five locales with the same parameter contract', () => {
  for(const [id,row] of Object.entries({...RUNTIME_MESSAGES,...SERVER_TEXT})) {
    const parameters=value=>[...value.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();
    for(const locale of ['zh','en','ja','ko','es']) {
      assert.equal(typeof row[locale],'string',`${id}.${locale}`);
      assert.deepEqual(parameters(row[locale]),parameters(row.en),`${id}.${locale} placeholders`);
    }
  }
});
test('event IDs survive scene persistence, nested values translate and opaque summaries stay intact', () => {
  const scene=createExecutionScene({runId:'localized'});
  applyExecutionEvent(scene,{kind:'pipeline',id:'model:1',messageId:'stage.model',status:'completed',outputMessageId:'output.modelCompleted',outputMessageParams:{characters:45,tools:2,model:{messageId:'value.unreported',unsafe:'ignored'}}});
  const saved=JSON.parse(JSON.stringify(scene)).pipeline[0];
  assert.equal(runtimeStageName(saved,'ja'),'モデルリクエスト');
  assert.match(runtimeStageOutput(saved,'en'),/45 characters.*2 pending tool calls.*Not reported/);
  assert.doesNotMatch(runtimeStageOutput(saved,'en'),/[\p{Script=Han}]|\{\w+\}/u);
  assert.equal(saved.outputMessageParams.model.unsafe,undefined);
  applyExecutionEvent(scene,{kind:'operation',id:'image',name:'image',status:'completed',outputMessageId:'output.imageQuality',outputMessageParams:{quality:'high',reportedQuality:{messageId:'value.unreported'}}});
  assert.match(runtimeStageOutput(scene.operations[0],'es'),/high.*No informado/);
  assert.equal(runtimeStageOutput({output:'模型原文 한국어 <script>'},'en'),'模型原文 한국어 <script>');
  assert.equal(runtimeMessage('stage.summary','ko',{round:3}),'3회 · 공개 추론 요약');
});

test('frozen v1 sync keeps readable fallbacks and re-localizes authored events on return', async () => {
  const {portableScene}=await import('../../mobile-sync/workspaceProtocol.js');
  const scene=createExecutionScene({runId:'sync-localized'});
  applyExecutionEvent(scene,{kind:'pipeline',id:'member:model',messageId:'stage.model',actorName:'我的 Agent',status:'completed',outputMessageId:'output.modelCompleted',outputMessageParams:{characters:27,tools:0,model:{messageId:'value.unreported'}}});
  applyExecutionEvent(scene,{kind:'pipeline',id:'opaque',messageId:'stage.supplement',status:'completed',output:'已中止。'});
  scene.status='completed';
  const [stage,supplement]=portableScene(scene).pipeline;
  assert.equal(stage.messageId,undefined,'v1 wire remains unchanged');
  assert.equal(stage.name,'我的 Agent · Model request');
  assert.match(stage.output,/27 characters/);
  assert.equal(runtimeStageName(stage,'es'),'我的 Agent · Solicitud al modelo');
  assert.match(runtimeStageOutput(stage,'es'),/27 caracteres.*No informado/);
  assert.equal(runtimeStageOutput(supplement,'en'),'已中止。');
});
