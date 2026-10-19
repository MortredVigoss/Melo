import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {launchTestChrome} from '../src/testSupport/testChrome.js';
import {createServer} from 'node:http';

// While a reply runs: the steps show in the chat, Agent/model stay changeable, and
// text typed into the composer is a supplement. A plain one-step reply has no next
// model call, so the supplement comes back and is sent as the next message.
test('a running reply shows its steps, keeps controls usable and takes a supplement', {timeout:120000}, async t=>{
 const home=await mkdtemp(join(tmpdir(),'melo-live-run-'));let browser;
 const proof='.tmp/live-run-20261017/screenshots';await mkdir(proof,{recursive:true});
 const requests=[];
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 // Fixture model: streams slowly enough for the browser to act mid-reply.
 const model=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};
  requests.push({path:req.url,body:JSON.stringify(body),toolResults:(body.input||[]).filter(item=>item.type==='function_call_output').length});
  res.setHeader('content-type','text/event-stream');
  const pieces=['床前','明月','光，','疑是','地上','霜。'];
  if(req.url.endsWith('/responses')&&raw.includes('查一下以前的诗')&&raw.includes('search_history')&&!(body.input||[]).some(item=>item.type==='function_call_output')){
   // Step 1 of a two-step turn: a slow tool call, so the browser can add a supplement mid-turn.
   await sleep(3000);
   res.end(`data: ${JSON.stringify({type:'response.completed',response:{id:'fixture-tool',model:'fixture-model',status:'completed',output:[{type:'function_call',id:'item-poems',call_id:'call_poems',name:'search_history',arguments:JSON.stringify({query:'诗'}),status:'completed'}]}})}\n\n`);
  } else if(req.url.endsWith('/responses')){
   for(const delta of pieces){res.write(`data: ${JSON.stringify({type:'response.output_text.delta',delta})}\n\n`);await sleep(700);}
   res.end(`data: ${JSON.stringify({type:'response.completed',response:{id:'fixture',model:'fixture-model',status:'completed',output:[{type:'message',role:'assistant',id:'m',status:'completed',content:[{type:'output_text',text:pieces.join(''),annotations:[]}]}]}})}\n\n`);
  } else {
   for(const content of pieces){res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{content}}]})}\n\n`);await sleep(700);}
   res.end('data: [DONE]\n\n');
  }
 });model.listen(0,'127.0.0.1');await once(model,'listening');
 // The Responses protocol carries native tool calls (chat completions would use the text tool loop).
 await writeFile(join(home,'config.json'),JSON.stringify({authMode:'api-key',apiProtocol:'responses',apiKey:'fixture-key',model:'fixture-model',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,conversationModelSelected:true}));
 const child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env:{...process.env,MELO_HOME:home,MELO_TEST_MODE:'1',MELO_MEMORY_RUNTIME:'0',MELO_DREAMING_ENABLED:'0',
  MELO_AUTH_MODE:'api-key',MELO_BASE_URL:`http://127.0.0.1:${model.address().port}/v1`,MELO_API_KEY:'fixture-key',MELO_MODEL:'fixture-model'},stdio:['ignore','pipe','pipe']});
 const closed=once(child,'exit');
 // The server is stopped (and awaited) even when closing the browser fails, so a failed run never orphans it.
 t.after(async()=>{try{await browser?.close();}finally{model.closeAllConnections();model.close();const kill=setTimeout(()=>child.kill('SIGKILL'),5000);child.kill('SIGTERM');await closed;clearTimeout(kill);await rm(home,{recursive:true,force:true,maxRetries:5});}});
 const base=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(Error('Startup timeout '+log)),15000);child.stdout.on('data',chunk=>{log+=chunk;const m=log.match(/listening at (http:\/\/[^\s]+)/i)||log.match(/(http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1].replace(/\/$/,''));}});child.stderr.on('data',chunk=>{log+=chunk;});});
 const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200,path);return r.json();};
 const chatId=(await post('/api/chats',{projectId:null,mode:'chat'})).activeChat.id;
 await post('/api/settings',{activeMode:'chat',activeView:'chat',selectedChatId:chatId});
 browser=await launchTestChrome(chromium);
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);
 const composer=page.locator('#composer');await composer.waitFor();
 await composer.fill('写一首关于月亮的诗');await composer.press('Enter');
 // Mid-reply: the stop button is there, steps render in the chat, and the controls are not locked.
 await page.locator('[data-action=stop-send]').waitFor();
 await page.locator('.run-steps .run-step').first().waitFor({timeout:10000});
 assert.ok(await page.locator('.run-steps').isVisible()&&await page.locator('.run-steps').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),'steps are in view');
 assert.equal(await page.locator('[data-action=toggle-agent-selector]').isDisabled(),false,'Agent selector stays usable');
 assert.equal(await page.locator('[data-action=toggle-voice-input]').isDisabled(),false,'voice input stays usable');
 assert.match(await composer.getAttribute('placeholder'),/补充/);
 await page.screenshot({path:join(proof,'live-steps.png')});
 const mainRequests=()=>requests.filter(r=>r.body.includes('写一首关于月亮的诗')||r.body.includes('改成五言'));
 const before=mainRequests().length;
 await composer.fill('改成五言');await composer.press('Enter');
 await page.locator('.run-steps-note').filter({hasText:'改成五言'}).waitFor({timeout:5000});
 await page.locator('.run-steps-note').scrollIntoViewIfNeeded();
 assert.equal(await composer.inputValue(),'','the composer is cleared after a supplement');
 await page.screenshot({path:join(proof,'supplement-sent.png')});
 // The reply had no further step, so the supplement is sent as the next message.
 const boot=async()=>(await fetch(base+'/api/bootstrap')).json();
 let chat;for(let i=0;i<200;i++){chat=(await boot()).activeChat;assert.equal(chat?.id,chatId);if((chat?.messages||[]).length>=4)break;await sleep(100);}
 assert.deepEqual(chat.messages.map(m=>m.role),['user','assistant','user','assistant']);
 assert.equal(chat.messages[2].content,'改成五言');
 assert.ok(mainRequests().length>before,'the supplement reached the model');
 assert.ok(mainRequests().at(-1).body.includes('改成五言'));
 await page.locator('[data-action=stop-send]').waitFor({state:'detached',timeout:15000});
 // Two-step turn: a supplement typed during the tool step reaches the next model request
 // in the same turn and is saved with the question.
 await composer.fill('查一下以前的诗');await composer.press('Enter');
 await page.locator('[data-action=stop-send]').waitFor();
 await composer.fill('只要五言');await composer.press('Enter');
 await page.locator('.run-steps-note').filter({hasText:'只要五言'}).waitFor({timeout:5000});
 for(let i=0;i<200;i++){chat=(await boot()).activeChat;if((chat?.messages||[]).length>=6)break;await sleep(100);}
 assert.deepEqual(chat.messages.map(m=>m.role),['user','assistant','user','assistant','user','assistant'],'used in the same turn, not sent as another message');
 assert.equal(chat.messages[4].content,'查一下以前的诗\n\n补充：只要五言');
 const turn=requests.filter(r=>r.body.includes('查一下以前的诗'));
 assert.equal(turn.length,2,'tool step plus one follow-up request');
 assert.equal(turn[0].body.includes('只要五言'),false);assert.equal(turn[0].toolResults,0);
 assert.ok(turn[1].body.includes('只要五言')&&turn[1].toolResults===1,'the follow-up request carries the tool result and the supplement');
 await page.locator('[data-action=stop-send]').waitFor({state:'detached',timeout:15000});
 assert.deepEqual(errors,[]);
});
