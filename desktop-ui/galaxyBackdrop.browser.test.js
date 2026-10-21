import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';

// The working panel's galaxy (galaxyBackdrop.js/.css) on the real page: drawn,
// behind the content, turning; still mode and the system's reduced motion stop it.
test('the working panel carries a turning galaxy that still mode and reduced motion stop', {timeout:90000}, async t=>{
 const home=await mkdtemp(join(tmpdir(),'melo-galaxy-'));let browser;
 const proof='.tmp/galaxy-20261021/screenshots';await mkdir(proof,{recursive:true});
 const child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env:{...process.env,MELO_HOME:home,MELO_TEST_MODE:'1',MELO_MEMORY_RUNTIME:'0',MELO_DREAMING_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
 const closed=once(child,'exit');
 t.after(async()=>{await browser?.close();child.kill('SIGTERM');await closed;await rm(home,{recursive:true,force:true});});
 const base=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(Error('Startup timeout '+log)),15000);child.stdout.on('data',chunk=>{log+=chunk;const m=log.match(/listening at (http:\/\/[^\s]+)/i);if(m){clearTimeout(timer);resolve(m[1].replace(/\/$/,''));}});child.stderr.on('data',chunk=>{log+=chunk;});});
 const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200,path);return r.json();};
 const chatId=(await post('/api/chats',{projectId:null,mode:'chat'})).activeChat.id;
 await post('/api/settings',{activeMode:'chat',activeView:'chat',selectedChatId:chatId});
 browser=await chromium.launch({executablePath:process.env.MELO_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);
 await page.waitForFunction(()=>document.documentElement.dataset.meloGalaxy==='ready',null,{timeout:15000});
 await page.locator('.neural-shell:not(.is-overview) .neural-dashboard.workspace').waitFor();
 const layer=()=>page.evaluate(()=>{const ws=document.querySelector('.neural-shell:not(.is-overview) .neural-dashboard.workspace');const b=getComputedStyle(ws,'::before');return {image:b.backgroundImage.slice(0,21),animation:b.animationName,z:b.zIndex,events:b.pointerEvents,transform:b.transform};});
 const first=await layer();
 assert.equal(first.image,'url("data:image/png;b','the galaxy image is drawn and applied');
 assert.equal(first.animation,'melo-galaxy-turn');
 assert.equal(first.z,'-1','behind the content');
 assert.equal(first.events,'none','never takes clicks');
 await page.waitForTimeout(1500);
 assert.notEqual((await layer()).transform,first.transform,'it turns');
 // Clicks still reach the composer over the galaxy.
 await page.locator('#composer').click();
 assert.equal(await page.evaluate(()=>document.activeElement?.id),'composer');
 await page.waitForTimeout(1200);
 await page.screenshot({path:join(proof,'galaxy-chat.png')});
 // 静态模式 (the same flag the bottom-left switch sets).
 await page.evaluate(()=>{document.documentElement.dataset.meloReduced='true';});
 assert.equal((await layer()).animation,'none','still mode stops the turning');
 // System reduced motion (localSettings reads it at start).
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.reload();
 await page.locator('.neural-shell:not(.is-overview) .neural-dashboard.workspace').waitFor();
 assert.equal((await layer()).animation,'none','reduced motion keeps the sky still');
 assert.deepEqual(errors,[]);
});
