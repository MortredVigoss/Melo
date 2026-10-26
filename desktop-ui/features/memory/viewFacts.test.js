// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from '../../i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMemoryFacts, defaultCategory } from './viewFacts.js';
test('memory management shows source, reversible forgetting and safe scope options',()=>{
  const data={records:[{id:'a',text:'<script>attack</script>',scope:'chat',status:'active',sourceTitle:'来源',sourceText:'用户原话',local:false}],total:1,offset:0,turns:[]};
  const html=renderMemoryFacts(data,{editing:'a'});
  assert.ok(!html.includes('<script>'));assert.match(html,/用户原话/);assert.match(html,/memory-fact-save/);assert.doesNotMatch(html,/<option value="personal"/);
  assert.match(renderMemoryFacts(data),/memory-fact-forget/);
  assert.match(renderMemoryFacts({...data,records:[{...data.records[0],status:'forgotten'}]}),/memory-fact-restore/);
});
test('cross-device conflict renders a 冲突 badge with both texts and 采用桌面版 / 采用手机版 actions',()=>{
  const record={id:'c1',text:'桌面写的 <b>版本</b>',scope:'chat',status:'conflict',sourceTitle:'来源',sourceText:'原句',local:true,
    conflict:{text:'手机写的 <i>版本</i>',scope:'personal',editedAt:'2026-10-17T02:00:00.000Z',source:'mobile'}};
  const html=renderMemoryFacts({records:[record],total:1,offset:0,turns:[]});
  assert.match(html,/memory-conflict-badge[^>]*>冲突</);
  assert.ok(!html.includes('<b>') && !html.includes('<i>'),'both texts are escaped');
  assert.match(html,/桌面版[\s\S]*桌面写的 &lt;b&gt;版本&lt;\/b&gt;/);
  assert.match(html,/手机版[\s\S]*我的全部本地对话[\s\S]*手机写的 &lt;i&gt;版本&lt;\/i&gt;/);
  assert.match(html,/data-action="memory-fact-resolve-desktop" data-id="c1"[^>]*>采用桌面版</);
  assert.match(html,/data-action="memory-fact-resolve-mobile" data-id="c1"[^>]*>采用手机版</);
  assert.match(renderMemoryFacts({records:[record],total:1,offset:0,turns:[]},{busy:true}),/memory-fact-resolve-mobile" data-id="c1" disabled/);
  const plain=renderMemoryFacts({records:[{...record,status:'active',conflict:null}],total:1,offset:0,turns:[]});
  assert.doesNotMatch(plain,/memory-conflict|采用手机版/);
});
test('bug audit M1/M5: a row without a source chat offers no 仅原对话; a legacy category starts the editor on a valid category',()=>{
  const base={id:'u',text:'手写的行',scope:'personal',status:'active',sourceTitle:'项目页手写',sourceText:null,local:true,projectId:'P',sourceChatId:null,category:'general'};
  const html=renderMemoryFacts({records:[base],total:1,offset:0,turns:[]},{editing:'u'});
  assert.doesNotMatch(html,/<option value="chat"/,'no original chat to limit to');
  assert.match(html,/<option value="personal" selected/);
  assert.match(html,/<option value="technical_detail" selected/,'general is not selectable; editor starts on technical_detail');
  assert.equal(defaultCategory('general'),'technical_detail'); assert.equal(defaultCategory(''),'technical_detail'); assert.equal(defaultCategory('decision'),'decision');
  // a chat-scoped row whose source chat was deleted keeps its current option
  const orphan=renderMemoryFacts({records:[{...base,scope:'chat'}],total:1,offset:0,turns:[]},{editing:'u'});
  assert.match(orphan,/<option value="chat" selected/);
  // ordinary rows still offer 仅原对话
  const normal=renderMemoryFacts({records:[{...base,sourceChatId:'c1',scope:'project'}],total:1,offset:0,turns:[]},{editing:'u'});
  assert.match(normal,/<option value="chat"/);
});
