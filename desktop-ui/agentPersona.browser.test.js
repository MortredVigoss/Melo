import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';

test('built-in Agent persona saves once, failed saves retain drafts, and Markdown import stays a draft', {timeout:60000}, async t => {
  const home=await mkdtemp(join(tmpdir(),'melo-agent-ui-'));
  const child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env:{...process.env,MELO_HOME:home,MELO_TEST_MODE:'1',MELO_MEMORY_RUNTIME:'0',MELO_DREAMING_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
  const closed=once(child,'exit'); let browser;
  t.after(async()=>{await browser?.close();child.kill('SIGTERM');await closed;await rm(home,{recursive:true,force:true});});
  const base=await new Promise((resolve,reject)=>{
    let logs='';const timer=setTimeout(()=>reject(new Error('Server startup timed out')),15000);
    child.stdout.on('data',chunk=>{logs+=chunk;const match=logs.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Server exited before startup'));});
  });
  const post=async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
  const saved=async()=>{const response=await fetch(base+'/api/bootstrap');return (await response.json()).customize.agents.find(agent=>agent.id==='main');};
  await post('/api/settings',{activeView:'agent',selectedAgentId:'main'});
  browser=await launchTestChrome(chromium);
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  // This fixture asserts Chinese labels; set the preference explicitly, independent of the host locale.
    assert.equal((await fetch(base + '/api/settings/local', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({preferences:{interfaceLanguage:'zh-CN'}})})).status,200);
    await page.goto(base);
  const consent=page.getByRole('dialog',{name:'Productivity MCP consent'});
  if(await consent.isVisible())await consent.getByRole('button',{name:/暂不启用/}).click();
  const form=page.locator('form[data-form=agent-profile-update]').first();
  await form.waitFor();
  assert.equal(await form.locator('[name=instructions]').isDisabled(),true);
  await form.locator('[data-action=form-settings-edit]').click();
  await form.locator('[name=name]').fill('可编辑的内置 Agent');
  await form.locator('[name=instructions]').fill('## 身份\n测试身份\n\n## 风格\n简明');
  await form.locator('[data-action=form-settings-save]').click();
  await form.locator('[data-edit-status=saved]').waitFor();
  assert.equal((await saved()).name,'可编辑的内置 Agent');
  const before=(await saved()).instructions;
  await form.locator('[data-action=form-settings-edit]').click();
  await form.locator('[name=instructions]').fill('失败后仍保留的文档');
  await page.route('**/api/agents/update',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'fixture unavailable'})}),{times:1});
  await form.locator('[data-action=form-settings-save]').click();await form.locator('[data-edit-status=error]').waitFor();
  assert.equal(await form.locator('[name=instructions]').inputValue(),'失败后仍保留的文档');
  assert.equal((await saved()).instructions,before);
  await form.locator('[data-agent-document]').setInputFiles({name:'AGENT.md',mimeType:'text/markdown',buffer:Buffer.from('导入的人设\n保留换行')});
  await page.waitForFunction(()=>document.querySelector('[name=instructions]')?.value==='导入的人设\n保留换行');
  assert.equal((await saved()).instructions,before);
  const download=page.waitForEvent('download');await form.locator('[data-action=export-agent-document]').click();
  assert.equal(await readFile(await (await download).path(),'utf8'),'导入的人设\n保留换行');
  // Exercise the real app handler and nativeSettings correlation protocol.
  await page.evaluate(()=>{
    window.agentExportRequests=[];
    window.webkit={messageHandlers:{meloVoice:{postMessage:payload=>window.agentExportRequests.push(payload)}}};
  });
  for (const outcome of [{}, {cancelled:true}, {error:'fixture save failed'}]) {
    await page.evaluate(()=>{window.agentExportRequests=[];});
    await form.locator('[data-action=export-agent-document]').click();
    await page.waitForFunction(()=>window.agentExportRequests.some(r=>r.action==='savePortableArchive'));
    const request=await page.evaluate(()=>window.agentExportRequests.find(r=>r.action==='savePortableArchive'));
    assert.equal(request.name,'AGENT.md');
    assert.equal(request.text,'导入的人设\n保留换行');
    await page.evaluate(({request,outcome})=>window.dispatchEvent(new CustomEvent('melo-local-settings',{detail:{requestID:request.requestID,...outcome}})),{request,outcome});
    const notice=outcome.error || (outcome.cancelled ? '已取消导出。' : '已导出 Markdown。');
    await page.getByText(notice,{exact:true}).waitFor();
    assert.equal(await form.locator('[name=instructions]').inputValue(),'导入的人设\n保留换行');
    assert.equal((await saved()).instructions,before);
  }
  await page.evaluate(()=>{delete window.webkit;});
  await form.locator('[data-action=form-settings-save]').click();await form.locator('[data-edit-status=saved]').waitFor();
  await page.reload();assert.equal(await form.locator('[name=instructions]').inputValue(),'导入的人设\n保留换行');
  await form.locator('[data-action=form-settings-edit]').click();await form.locator('[name=instructions]').fill('');
  await form.locator('[data-action=form-settings-save]').click();await form.locator('[data-edit-status=saved]').waitFor();
  assert.equal((await saved()).instructions,'');
  const pendingText='此 Agent 的新版人设尚未同步。全文已保留在本机，其他对话继续同步。';
  const longDocument='不可拆分的新文档'.repeat(8000);
  await form.locator('[data-action=form-settings-edit]').click();await form.locator('[name=instructions]').fill(longDocument);
  await form.locator('[data-action=form-settings-save]').click();await form.locator('[data-edit-status=saved]').waitFor();
  await page.getByText(pendingText,{exact:true}).first().waitFor();
  await page.reload();await form.waitFor();assert.equal(await form.locator('[name=instructions]').inputValue(),longDocument);
  await page.getByText(pendingText,{exact:true}).first().waitFor();
  const proof=resolve('.tmp/agent-evolution-proof');await mkdir(proof,{recursive:true});await page.screenshot({path:join(proof,'builtin-persona.png')});
  assert.deepEqual(errors,[]);
});
