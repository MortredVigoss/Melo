import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { sendChatMessage } from './sendChatMessage.js';
import { drainPostTurnTasks } from '../../runtime/postTurnTasks.js';
import { loadState, updateStateAtomically } from '../../state/stateStore.js';
import { readExecutionScene, saveExecutionScene, selectSceneImage } from './executionScenes.js';
import { imageFollowUpAttachments, restoreImageRetry } from './imageTurnState.js';

const png = color => sharp({create:{width:512,height:512,channels:4,background:color}}).png().toBuffer();
const red = await png('#ff0000'), blue = await png('#0000ff');
const dataUrl = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
async function fixture(t, respond = () => ({bytes:blue})) {
  const home = await mkdtemp(join(tmpdir(),'melo-image-turn-'));
  const workspace = join(home,'workspace');
  await mkdir(join(home,'desktop'),{recursive:true});
  await mkdir(workspace);
  const requests = [];
  const server = createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    const raw=Buffer.concat(chunks), type=req.headers['content-type'];
    let input;
    if(type?.startsWith('multipart/')) {
      const form=await new Response(raw,{headers:{'content-type':type}}).formData();
      input={prompt:form.get('prompt'),images:await Promise.all(form.getAll('image[]').map(async file=>Buffer.from(await file.arrayBuffer())))};
    } else input=JSON.parse(raw.toString());
    requests.push({url:req.url,...input});
    const result=await respond(requests.length,input);
    if(res.destroyed)return;
    res.setHeader('content-type','application/json');
    res.statusCode=result.status || 200;
    res.end(JSON.stringify(result.status ? {error:'fixture failure'} : {model:'fixture-image',data:[{b64_json:result.bytes.toString('base64')}]}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await drainPostTurnTasks(home);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});});
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  await writeFile(join(home,'config.json'),JSON.stringify({authMode:'local',model:'fixture-vision',baseUrl,apiKey:'fixture',
    imageSettings:{engine:'openai-api',profileId:'fixture',model:'fixture-image'},
    llmProfiles:{fixture:{id:'fixture',name:'Fixture',authMode:'api-key',apiProtocol:'chat-completions',baseUrl,apiKey:'fixture',model:'fixture-image'}},
  }));
  await writeFile(join(home,'desktop/state.json'),JSON.stringify({chats:[{id:'chat',title:'Audit',projectId:'project',messages:[]}],projects:[{id:'project',title:'Audit',workspacePath:workspace}]}));
  const env={MELO_TEST_MODE:'1',MELO_DREAMING_ENABLED:'0',MELO_MOCK_RESPONSE:'fixture reply',MELO_AUTH_MODE:'local',MELO_BASE_URL:baseUrl,OPENAI_BASE_URL:baseUrl,MELO_API_KEY:'fixture',OPENAI_API_KEY:'fixture',MELO_MODEL:'fixture-vision'};
  const context=(requestId,signal)=>createRequestContext({home,chatId:'chat',requestId,signal,env});
  const scope=context('read');
  const state=()=>runWithRequestContext(scope,()=>loadState({home}));
  const scene=runId=>runWithRequestContext(scope,()=>readExecutionScene(home,runId));
  const send=(requestId,options={})=>sendChatMessage({chatId:'chat',requestId,content:'生成一张海报',imageTask:{action:'generate'},skipBootstrap:true,...options,context:context(requestId,options.signal)});
  return {home,workspace,requests,context,scope,state,scene,send};
}

test('follow-up edit uses the last generated result, including text-only generation', async t=>{
  const f=await fixture(t);
  await f.send('first',{content:'把图片换背景',imageTask:{action:'edit'},attachments:[{id:'original',kind:'image',url:dataUrl(red)}]});
  await f.send('second',{content:'把刚才的图片换背景，改成白色背景',imageTask:null});
  assert.equal(f.requests.length,2);
  assert.ok(f.requests[1].images[0].equals(blue),'second edit must use the generated blue image, not red upload');
  await f.send('third',{imageTask:null});
  assert.equal(f.requests[2].url,'/v1/images/generations','new generation must not inherit an old reference');
  await f.send('fourth',{content:'把刚才的图片换背景',imageTask:null});
  assert.equal(f.requests.length,4,'a text-only generation must also be editable');
  assert.ok(f.requests[3].images[0].equals(blue));
});

test('selected candidate is the editing source; expired presentation URLs are not the identity', async t=>{
  const f=await fixture(t,n=>({bytes:n===1?red:blue}));
  const first=await f.send('first',{imageTask:{action:'generate',count:1}});
  const scene=await f.scene(first.runId);
  const path=join(f.workspace,'generated','candidate.png');await writeFile(path,blue);
  scene.artifacts.push({...scene.artifacts[0],id:'candidate',path,url:'http://127.0.0.1/expired.png'});
  selectSceneImage(scene,'candidate');
  await runWithRequestContext(f.scope,()=>saveExecutionScene(f.home,scene));
  await f.send('second',{content:'把刚才的图片换背景',imageTask:null});
  assert.ok(f.requests[1].images[0].equals(blue));
});

test('new upload wins; an unrelated turn does not inherit generated images', async t=>{
  const f=await fixture(t);
  await f.send('first');
  await f.send('second',{content:'把这张图片换背景',imageTask:{action:'edit'},attachments:[{id:'new',kind:'image',url:dataUrl(red)}]});
  assert.ok(f.requests[1].images[0].equals(red));
  await f.send('third',{content:'你好',imageTask:null});
  const state=await f.state();
  assert.equal(state.chats[0].messages.find(m=>m.role==='user'&&m.content==='你好').attachments.length,0);
});

test('cancelling inspection keeps the delivered image and cancellation state in chat', async t=>{
  const f=await fixture(t), controller=new AbortController();
  let finish;
  const finished=new Promise(resolve=>{finish=resolve;});
  let snapshotAtDelivery;
  await assert.rejects(f.send('cancel',{imageTask:{action:'generate',count:2,inspect:true},signal:controller.signal,
    onDelta:async()=>{snapshotAtDelivery=await f.state();},
    sseEmitter:(kind,event)=>{
      if(kind==='execution_event'&&event.name==='核对图片结果'&&event.status==='running')controller.abort();
      if(kind==='execution_scene'&&event.scene.status==='cancelled')finish(event.scene);
    },
  }),{name:'AbortError'});
  const scene=await finished;
  const stored=await f.state();
  const assistant=stored.chats[0].messages.filter(m=>m.role==='assistant');
  assert.equal(snapshotAtDelivery.chats[0].messages.filter(m=>m.role==='assistant').length,1,'save before display');
  assert.equal(assistant.length,1);
  assert.match(assistant[0].content,/1\/2/);
  assert.match(assistant[0].content,/取消|停止/);
  assert.equal(scene.messageId,assistant[0].id);
  assert.equal(stored.chatRuns.find(r=>r.requestId==='cancel').status,'cancelled');
  assert.equal(f.requests.length,1);
  await assert.rejects(f.send('cancel',{imageTask:{action:'generate',count:2,inspect:true}}),{code:'REQUEST_INTERRUPTED'});
  assert.equal(f.requests.length,1,'retry of same request cannot regenerate');
});

test('missing-image retry restores full original text and inferred task, ignoring shortened UI summary', async t=>{
  const f=await fixture(t,n=>n===2?{status:500}:{bytes:blue});
  const content='生成两张海报。'+'保持柔和光线和清晰布局。'.repeat(370)+'最终必须写出 TAIL-KEEP。';
  const first=await f.send('first',{content,imageTask:null});
  const scene=await f.scene(first.runId);
  assert.ok(scene.query.length<content.length);
  await f.send('retry',{content:scene.query,imageTask:{action:'generate',count:1,retryOf:first.runId}});
  assert.equal(f.requests.length,3);
  assert.match(f.requests[2].prompt,/TAIL-KEEP/);
  const state=await f.state();
  assert.equal(state.chats[0].messages.filter(m=>m.role==='user').at(-1).content,content);
  assert.equal(state.chats[0].messages[0].metadata.imageTask.count,2);
});

test('a missing selected artifact fails clearly instead of editing the old upload', async t=>{
  const f=await fixture(t);
  const first=await f.send('first',{content:'把图片换背景',imageTask:{action:'edit'},attachments:[{id:'original',kind:'image',url:dataUrl(red)}]});
  const scene=await f.scene(first.runId);
  await rm(scene.artifacts[0].path);
  await assert.rejects(f.send('second',{content:'把刚才的图片换背景',imageTask:null}),/不会退回更早的原图/);
  assert.equal(f.requests.length,1);
});

test('an artifact in another chat cannot be inherited through a forged run reference', async t=>{
  const f=await fixture(t);
  const first=await f.send('first');
  const state=await f.state();
  const assistant=state.chats[0].messages.find(m=>m.role==='assistant');
  const attachments=await runWithRequestContext(f.scope,()=>imageFollowUpAttachments({chat:{id:'other',messages:[assistant]},home:f.home,content:'把刚才的图片换背景',attachments:[],imageTask:null}));
  assert.deepEqual(attachments,[]);
  assert.ok(first.runId);
});

test('retry preserves source references, mask and inspection instead of caller overrides', ()=>{
  const original={action:'edit',count:3,inspect:true,mask:'original-mask',references:[{attachmentId:'source',role:'subject'}]};
  const attachment={id:'source',kind:'image',url:dataUrl(red)};
  const result=restoreImageRetry({messages:[{role:'user',content:'完整原请求',attachments:[attachment],metadata:{runId:'first',imageTask:original}}]},
    {action:'generate',count:1,retryOf:'first',inspect:false,references:[]});
  assert.equal(result.content,'完整原请求');
  assert.deepEqual(result.attachments,[attachment]);
  assert.deepEqual(result.imageTask,{...original,count:1,retryOf:'first'});
});

test('stopping between images without inspection saves one reply without retrying remaining outputs', async t=>{
  const f=await fixture(t), controller=new AbortController();
  let finish;const finished=new Promise(resolve=>{finish=resolve;});
  await assert.rejects(f.send('stop',{imageTask:{action:'generate',count:3},signal:controller.signal,
    onDelta:()=>controller.abort(),
    sseEmitter:(kind,event)=>{if(kind==='execution_scene'&&event.scene.status==='cancelled')finish();},
  }),{name:'AbortError'});
  await finished;
  const state=await f.state();
  const replies=state.chats[0].messages.filter(m=>m.role==='assistant');
  assert.equal(replies.length,1);assert.match(replies[0].content,/1\/3/);
  assert.equal(f.requests.length,1);
});
