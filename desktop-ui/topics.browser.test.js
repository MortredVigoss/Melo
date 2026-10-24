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

// A → B → C → back to A in one chat: thin topic markers appear, the return links
// back to where the topic started, and every turn sends the same instructions
// (the cacheable prefix), including the turn routed to web search.
test('topic markers follow the conversation and the instructions stay a stable prefix', {timeout:120000}, async t=>{
 const home=await mkdtemp(join(tmpdir(),'melo-topics-'));let browser;
 const proof='.tmp/test-evidence/conversation-topics';await mkdir(proof,{recursive:true});
 const requests=[];
 const model=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};
  if(!String(body.instructions||'').includes('- factual: asking for facts'))requests.push(body);
  res.setHeader('content-type','text/event-stream');
  res.end(`data: ${JSON.stringify({type:'response.completed',response:{id:'r',model:'fixture-model',status:'completed',output:[{type:'message',role:'assistant',id:'m',status:'completed',content:[{type:'output_text',text:'好的，已回答。',annotations:[]}]}]}})}\n\n`);
 });model.listen(0,'127.0.0.1');await once(model,'listening');
 await writeFile(join(home,'config.json'),JSON.stringify({authMode:'api-key',apiProtocol:'responses',apiKey:'fixture-key',model:'fixture-model',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,conversationModelSelected:true}));
 const child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env:{...process.env,MELO_HOME:home,MELO_TEST_MODE:'1',MELO_MEMORY_RUNTIME:'0',MELO_DREAMING_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
 const closed=once(child,'exit');
 t.after(async()=>{await browser?.close();model.closeAllConnections();model.close();child.kill('SIGTERM');await closed;await rm(home,{recursive:true,force:true});});
 const base=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(Error('Startup timeout '+log)),15000);child.stdout.on('data',chunk=>{log+=chunk;const m=log.match(/listening at (http:\/\/[^\s]+)/i);if(m){clearTimeout(timer);resolve(m[1].replace(/\/$/,''));}});child.stderr.on('data',chunk=>{log+=chunk;});});
 const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200,path);return r.json();};
 const chatId=(await post('/api/chats',{projectId:null,mode:'chat'})).activeChat.id;
 await post('/api/settings',{activeMode:'chat',activeView:'chat',selectedChatId:chatId});
 browser=await launchTestChrome(chromium);
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 // This fixture asserts Chinese labels; set the preference explicitly, independent of the host locale.
    assert.equal((await fetch(base + '/api/settings/local', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({preferences:{interfaceLanguage:'zh-CN'}})})).status,200);
    await page.goto(base);
 const composer=page.locator('#composer');await composer.waitFor();
 const questions=['帮我写一个 Python 爬虫，抓取豆瓣电影 Top250 的片名和评分','爬虫遇到 403 怎么办','明天北京天气怎么样','推荐几本科幻小说','那个爬虫怎么加代理'];
 for(const [index,question] of questions.entries()){
  await composer.fill(question);await composer.press('Enter');
  await page.waitForFunction(count=>document.querySelectorAll('.message.assistant:not(.is-streaming)').length>=count,index+1,{timeout:20000});
 }
 const dividers=await page.locator('.topic-divider').allInnerTexts();
 assert.deepEqual(dividers.map(text=>text.trim()),['话题：明天北京天气怎么样','话题：推荐几本科幻小说','回到话题：帮我写一个 Python 爬虫，抓取…']);
 await page.locator('[data-action=jump-to-topic]').click();
 await page.locator('.message.is-highlighted').filter({hasText:'Top250'}).waitFor();
 await page.screenshot({path:join(proof,'topic-dividers.png')});
 // Only the chat turns (background memory extraction also calls the model).
 const turns=requests.filter(body=>!String(body.instructions).includes('memory extraction assistant'));
 assert.equal(turns.length,5);
 assert.equal(new Set(turns.map(body=>body.instructions)).size,1,'every turn sends the same instructions');
 assert.deepEqual(errors,[]);
});
