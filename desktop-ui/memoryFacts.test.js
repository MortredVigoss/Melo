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
