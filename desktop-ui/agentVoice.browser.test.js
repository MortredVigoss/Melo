import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {launchTestChrome} from '../src/testSupport/testChrome.js';
import {createServer} from 'node:http';

// Per-Agent voice on the desktop (2026-10-22): with auto read-aloud on, an
// Agent in 'summary' mode is not streamed sentence by sentence — the whole
// reply is collected, the server is asked what the Agent says out loud, and
// that is spoken with the Agent's voice; 'full' streams as before with the
// Agent named; 'off' speaks nothing. The TTS routes are intercepted in the
// page (no audio is played), the chat runs against a fixture model.
test('desktop read-aloud follows the Agent card: summary waits and rewrites, full streams, off is silent', {timeout:150000}, async t=>{
 const home=await mkdtemp(join(tmpdir(),'melo-agent-voice-'));let browser;
 const model=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;
  res.setHeader('content-type','text/event-stream');
  for(const content of ['今天的结论是：','带伞。','原因是下午有雨，','气温二十度。'])res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{content}}]})}\n\n`);
  res.end('data: [DONE]\n\n');
 });model.listen(0,'127.0.0.1');await once(model,'listening');
 const baseUrl=`http://127.0.0.1:${model.address().port}/v1`;
 await writeFile(join(home,'config.json'),JSON.stringify({authMode:'api-key',apiKey:'fixture-key',model:'fixture-model',baseUrl}));
 const child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env:{...process.env,MELO_HOME:home,MELO_TEST_MODE:'1',MELO_MEMORY_RUNTIME:'0',MELO_DREAMING_ENABLED:'0',
  MELO_AUTH_MODE:'api-key',MELO_BASE_URL:baseUrl,MELO_API_KEY:'fixture-key',MELO_MODEL:'fixture-model'},stdio:['ignore','pipe','pipe']});
 const closed=once(child,'exit');
 t.after(async()=>{try{await browser?.close();}finally{model.closeAllConnections();model.close();const kill=setTimeout(()=>child.kill('SIGKILL'),5000);child.kill('SIGTERM');await closed;clearTimeout(kill);await rm(home,{recursive:true,force:true});}});
 const base=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(Error('Startup timeout '+log)),15000);child.stdout.on('data',chunk=>{log+=chunk;const m=log.match(/listening at (http:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.stderr.on('data',chunk=>{log+=chunk;});});
 const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200,path);return r.json();};
 browser=await launchTestChrome(chromium);
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 // Auto read-aloud through the API engine, chosen before the app loads.
 await page.addInitScript(()=>{localStorage.setItem('melo-tts-autoplay','1');localStorage.setItem('melo-tts-engine','api');});
 const tts=[];
 await page.route('**/api/tts/**',async route=>{
  const url=new URL(route.request().url());const body=route.request().postDataJSON?.()||{};
  tts.push({path:url.pathname.replace('/api/tts/',''),body});
  if(url.pathname.endsWith('/voice-text')){const response=await route.fetch();const json=await response.json();tts.at(-1).response=json;await route.fulfill({response,json});return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,chunks:1})});
 });
 const run=async(mode,text)=>{
  await post('/api/agents/update',{agentId:'main',patch:{voiceReplyMode:mode},scope:'global'});
  const chatId=(await post('/api/chats',{projectId:null,mode:'chat',agentId:'main'})).activeChat.id;
  await post('/api/settings',{activeMode:'chat',activeView:'chat',selectedChatId:chatId});
  tts.length=0;
  await page.goto(base);
  const composer=page.locator('#composer');await composer.waitFor();
  await composer.fill(text);await composer.press('Enter');
  await page.locator('[data-action=stop-send]').waitFor({timeout:15000});
  await page.locator('[data-action=stop-send]').waitFor({state:'detached',timeout:30000});
  // The flush runs before the turn is marked done; give queued requests a beat.
  await page.waitForTimeout(500);
  return tts.filter(r=>!['speak-stop','queue-clear'].includes(r.path));
 };

 const summary=await run('summary','明天要带伞吗');
 const voiceText=summary.filter(r=>r.path==='voice-text');
 assert.equal(voiceText.length,1,`summary mode asks what the Agent says out loud once: ${JSON.stringify(summary.map(r=>r.path))}`);
 assert.equal(voiceText[0].body.agentId,'main');
 assert.match(voiceText[0].body.text,/带伞/);
 assert.equal(voiceText[0].response.mode,'summary');
 assert.equal(summary.some(r=>r.path==='queue-add'),false,'nothing is streamed sentence by sentence before the reply is complete');
 const spoken=summary.filter(r=>r.path==='speak-text');
 assert.equal(spoken.length,1,'the spoken summary is read once');
 assert.equal(spoken[0].body.agentId,'main','read with the Agent\'s voice');
 assert.equal(spoken[0].body.text,voiceText[0].response.text,'what the server returned is what is spoken');
 assert.ok(summary.indexOf(voiceText[0])<summary.indexOf(spoken[0]));

 const full=await run('full','明天要带伞吗');
 assert.equal(full.some(r=>r.path==='voice-text'),false,'full mode never rewrites');
 const streamed=full.filter(r=>['queue-add','speak-text'].includes(r.path));
 assert.ok(streamed.length>=1,`full mode reads the reply: ${JSON.stringify(full.map(r=>r.path))}`);
 assert.ok(streamed.every(r=>r.body.agentId==='main'),'every request names the Agent so its voice is used');

 const off=await run('off','明天要带伞吗');
 assert.deepEqual(off.map(r=>r.path),[],'off mode reads nothing automatically');
 assert.deepEqual(errors,[]);
});
