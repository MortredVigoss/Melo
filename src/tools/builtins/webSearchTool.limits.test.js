import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { webSearchTool, clearCache, getSearchCacheDbPath, _resetWebSearchCacheForTests } from './webSearchTool.js';

const query='auditcachefixture';
const rows=Array.from({length:8},(_,i)=>({title:`Page ${i}`,url:`https://fixture.invalid/page${i}`,snippet:'auditcachefixture source'}));
const bodies=Object.fromEntries(rows.map((row,i)=>[row.url,(`auditcachefixture ${i} abcdefghijklmnopqrstuvwxyz `).repeat(150).slice(0,6000)]));
const config=(count,chars)=>({agentRuntime:{search:{maxResults:count}},operationalLimits:{search:{contentMaxChars:chars}}});
function bounded(value,count,chars) {
  assert.equal(value.ok,true);assert.equal(value.meta.resultCount,count);
  assert.equal(value.meta.results.length,count);assert.equal(value.meta.contentFetched,count);
  assert.equal(value.completionSources.length,count);assert.equal(value.meta.contentItems.length,count);
  assert.deepEqual(value.completionSources.map(s=>s.url),value.meta.results.map(r=>r.url));
  for(const source of value.completionSources) assert.equal(source.content.length,chars);
  for(const item of value.meta.contentItems) assert.equal(item.characters,chars);
  assert.ok(value.output.length<count*(chars+600),'formatted output also uses current limits');
}
test('fresh, stale and URL caches apply current limits without destroying reusable originals',async t=>{
  const home=await mkdtemp(join(tmpdir(),'melo-cache-limits-'));let network=0;
  t.mock.method(globalThis,'fetch',async()=>{network++;throw new Error('unexpected network');});
  try {await runWithRequestContext(createRequestContext({home,env:{MELO_DEBUG:''}}),async()=>{
    clearCache('all');const db=new DatabaseSync(getSearchCacheDbPath());
    try {
      db.prepare('INSERT INTO web_search_cache (query_norm,query_raw,provider,results,content_map,created_at,intent_kind,time_sensitive) VALUES (?,?,?,?,?,?,?,?)').run('general|S|'+query,query,'fixture',JSON.stringify(rows),JSON.stringify(bodies),Date.now(),'general',0);
      const deps={_tryApiDirect:async()=>null,_isPlaywrightCliAvailable:async()=>false,_searchViaDdg:async()=>[],_searchViaPlaywright:async()=>[],_fetchViaJina:async()=>{throw new Error('unexpected content fetch');}};
      for(const [count,chars] of [[1,1000],[8,6000],[2,1500]]) {
        const value=await webSearchTool.run({query,num_results:8},{...deps,config:config(count,chars)});
        assert.equal(value.meta.timings.cacheHit,true);bounded(value,count,chars);
      }
      const original=JSON.stringify(bodies);
      assert.equal(db.prepare('SELECT content_map FROM web_search_cache').get().content_map,original);
      db.prepare('UPDATE web_search_cache SET created_at=?').run(Date.now()-7200001);
      const stale=await webSearchTool.run({query,num_results:8},{...deps,config:config(1,1000)});
      assert.equal(stale.meta.timings.swr,true);bounded(stale,1,1000);
      for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
      assert.equal(db.prepare('SELECT content_map FROM web_search_cache').get().content_map,original);
      db.prepare('DELETE FROM web_search_cache').run();
      db.prepare('INSERT INTO url_content_cache (url,content,fetched_at) VALUES (?,?,?)').run(rows[0].url,bodies[rows[0].url],Date.now());
      for(const chars of [1000,6000]) {
        const value=await webSearchTool.run({query,num_results:1,noCache:true},{...deps,_searchViaDdg:async()=>[rows[0]],_searchViaPlaywright:async()=>[rows[0]],config:config(1,chars)});
        bounded(value,1,chars);assert.equal(value.meta.contentFromCache,1);
      }
      // Conditional 304 reuse must apply the same projection and retain full stored text.
      db.prepare('UPDATE url_content_cache SET fetched_at=?,etag=?').run(Date.now()-7200001,'fixture-etag');
      let conditional=0;
      const reused=await webSearchTool.run({query,num_results:1,noCache:true},{...deps,_searchViaDdg:async()=>[rows[0]],_searchViaPlaywright:async()=>[rows[0]],_fetchViaJina:async()=>{conditional++;return {url:rows[0].url,notModified:true};},config:config(1,1000)});
      bounded(reused,1,1000);assert.equal(conditional,1);
      assert.equal(db.prepare('SELECT content FROM url_content_cache').get().content,bodies[rows[0].url]);
      assert.equal(network,0);
    } finally {db.close();_resetWebSearchCacheForTests();}
  });}finally{await rm(home,{recursive:true,force:true});}
});
