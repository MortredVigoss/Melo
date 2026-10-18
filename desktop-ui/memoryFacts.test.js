import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMemoryFacts } from './memoryFacts.js';
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
