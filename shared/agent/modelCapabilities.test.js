import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFromMetadata, resolvedModelCapabilities, connectionForModel } from './modelCapabilities.js';
import { normalizeReasoningEffort } from '../../src/shared/modelCatalog.js';
import { createOpenAICompatibleReply } from '../../src/openai.js';
test('opaque model metadata is independent of provider/model name; explicit overrides win', () => {
  const meta = capabilitiesFromMetadata({input_modalities:['text','image'], output_modalities:['text'], supported_reasoning_levels:[{effort:'none'},{effort:'high'}], default_reasoning_level:'none'});
  assert.deepEqual(meta,{vision:true,imageGen:false,reasoning:true,reasoningEfforts:['none','high'],defaultReasoningEffort:'none'});
  const connection={modelMetadata:{opaque:meta}, visionTest:{requestedModel:'other',ok:false}, modelCapabilities:{opaque:{vision:false}}};
  assert.equal(resolvedModelCapabilities(connection,'opaque').vision,false);
  assert.deepEqual(resolvedModelCapabilities(connection,'vision-gpt-999'),{});
  assert.equal(normalizeReasoningEffort('anything','medium','medium',meta),'none');
  assert.equal(normalizeReasoningEffort('gpt-6-luna','high','medium',{reasoning:false}),null);
});
test('same model on a foreign connection cannot inherit capabilities', () => {
  const profile={model:'opaque',authMode:'api-key',baseUrl:'https://one.example/v1',modelCapabilities:{opaque:{vision:true}}};
  const config={...profile,modelCapabilities:undefined,activeLlmProfileId:'one',llmProfiles:{one:profile},baseUrl:'https://two.example/v1'};
  assert.deepEqual(resolvedModelCapabilities(connectionForModel(config),'opaque'),{});
  assert.equal(resolvedModelCapabilities(connectionForModel({...config,baseUrl:profile.baseUrl}),'opaque').vision,true);
});
test('explicitly disabled image input rejects before provider request and preserves original attachments', async t => {
  let requests=0; t.mock.method(globalThis,'fetch',async()=>{requests++;throw new Error('must not reach provider');});
  const messages=[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,YQ=='}}]}];
  const original=JSON.stringify(messages);
  await assert.rejects(createOpenAICompatibleReply({model:'opaque',modelCapabilities:{vision:false},messages}),{code:'MODEL_VISION_DISABLED'});
  assert.equal(JSON.stringify(messages),original); assert.equal(requests,0);
});

test('direct callers also enforce the connection registry instead of needing a pre-resolved flag',async t=>{
 let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw new Error('must not reach provider');});
 const options={authMode:'api-key',model:'opaque',baseUrl:'https://fixture.invalid/v1',modelCapabilities:{opaque:{vision:false}},messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,YQ=='}}]}]};
 const original=JSON.stringify(options);await assert.rejects(createOpenAICompatibleReply(options),{code:'MODEL_VISION_DISABLED'});
 assert.equal(requests,0);assert.equal(JSON.stringify(options),original);
});

import { visionConnection } from '../../src/images/imageSettings.js';
test('selected vision connection owns declarations even when endpoints, models and keys match', async t => {
  const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push(options.headers);return Response.json({choices:[{message:{content:'seen'},finish_reason:'stop'}]});});
  const messages=[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,YQ=='}}]}];
  for (const sharedKey of [false,true]) for (const allowed of [false,true]) {
    const a={id:'a',authMode:'api-key',apiProtocol:'chat-completions',baseUrl:'https://fixture.invalid/v1',model:'opaque',apiKey:'a-key',modelCapabilities:{opaque:{vision:!allowed}}};
    const b={...a,id:'b',apiKey:sharedKey?'a-key':'b-key',modelCapabilities:{opaque:{vision:allowed}}};
    const config={...a,activeLlmProfileId:'a',llmProfiles:{a,b},imageSettings:{visionProfileId:'b'}};
    const selected=visionConnection(config); const before=requests.length;
    assert.equal(resolvedModelCapabilities(connectionForModel(selected),'opaque').vision,allowed);
    if(allowed) { await createOpenAICompatibleReply({...selected,messages}); assert.equal(requests.length,before+1); assert.equal(requests.at(-1).authorization,`Bearer ${b.apiKey}`); }
    else { await assert.rejects(createOpenAICompatibleReply({...selected,messages}),{code:'MODEL_VISION_DISABLED'}); assert.equal(requests.length,before); }
    assert.equal(connectionForModel({...config,...b}).id,'b','explicit connection snapshot wins over stale active id');
  }
});
test('failed vision probes are unknown and cannot override declared support',()=>{
  for (const error of ['timeout','401','429','incorrect recognition']) {
    const visionTest={requestedModel:'opaque',ok:false,error};
    assert.deepEqual(resolvedModelCapabilities({visionTest},'opaque'),{});
    assert.equal(resolvedModelCapabilities({visionTest,modelMetadata:{opaque:{vision:true}}},'opaque').vision,true);
    assert.equal(resolvedModelCapabilities({visionTest:{...visionTest,ok:true},modelCapabilities:{opaque:{vision:false}}},'opaque').vision,false);
  }
});
