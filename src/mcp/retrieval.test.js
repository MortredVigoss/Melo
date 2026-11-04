import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {connectMcpServer,disconnectMcpServer,getActiveMcpServers} from './manager.js';
import {getMcpTool} from '../tools/mcpRegistry.js';
import {mcpResultToToolResult,httpEndpoint} from './client.js';
import {socialSource} from './socialResult.js';
import {socialLogin} from './socialLogin.js';
import {hydrateState,createDefaultState} from '../state/stateHydration.js';
import {completionObservation} from '../../shared/agent/completion.js';
import {requestAllowsTool} from '../../shared/agent/retrieval/requestPolicy.js';
import {toolCapabilityAllowed} from '../domain/agent/capabilities.js';
import {socialIds} from './socialPresets.js';

const schema={type:'object',properties:{}};
const def=name=>({name,inputSchema:schema});
const init={protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{listChanged:true}}};
const eventual=async fn=>{for(let n=0;n<200;n++){if(await fn())return;await wait(10);} assert.fail('condition did not become true');};
test('stdio: later catalog pages, change/exit invalidation and cancellation reach the real child',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'melo-mcp-')); const id='mcp-regression-stdio';
 t.after(async()=>{disconnectMcpServer(id);await rm(dir,{recursive:true,force:true});});
 const script=`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
 const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));let changed=false,timer;
 createInterface({input:process.stdin}).on('line', l=>{const q=JSON.parse(l),ok=result=>send({id:q.id,result});
 if(q.method==='initialize')ok(${JSON.stringify(init)});
 if(q.method==='tools/list')ok(q.params?.cursor?{tools:[${JSON.stringify(def('second'))}]}:{tools:[{name:changed?'new':'first',inputSchema:{type:'object'}}],nextCursor:'two'});
 if(q.method==='tools/call'){if(q.params.name==='second'){appendFileSync('events','started\\n');timer=setTimeout(()=>appendFileSync('events','effect\\n'),500);}
 else if(q.params.name==='first'){ok({content:[{type:'text',text:'changed'}]});changed=true;send({method:'notifications/tools/list_changed'});}
 else {ok({content:[{type:'text',text:'closing'}]});setTimeout(()=>process.exit(0),20);}}
 if(q.method==='notifications/cancelled'){clearTimeout(timer);appendFileSync('events','cancelled\\n');}
 });`;
 await writeFile(join(dir,'server.mjs'),script);
 const conn=await connectMcpServer(id,{command:process.execPath,args:['server.mjs'],cwd:dir});assert.equal(conn.connected,true,conn.error);
 const tool=name=>getMcpTool('mcp:'+id+':'+name), old=tool('first');
 const ctrl=new AbortController();
 const task=tool('second').run({}, {signal:ctrl.signal});
 await eventual(async()=> (await readFile(join(dir,'events'),'utf8').catch(()=>'' )).includes('started'));
 ctrl.abort();await assert.rejects(task);await wait(550);
 assert.equal(await readFile(join(dir,'events'),'utf8'),'started\ncancelled\n');
 await old.run({});await eventual(()=>tool('new')&&!tool('first'));
 assert.equal((await old.run({})).ok,false);
 await tool('new').run({});await eventual(()=>!getActiveMcpServers().includes(id)&&!tool('new')&&!tool('second'));
});
test('Streamable HTTP negotiates a 2025 session, accepts SSE, authenticates and lists every page',async t=>{
 const id='mcp-http-fixture', dir=await mkdtemp(join(tmpdir(),'melo-http-'));
 const seen=[];const srv=createServer(async(req,res)=>{
   if(req.headers.authorization!=='Bearer fixture'){res.writeHead(403).end();return;}
   if(req.method!=='POST'){res.writeHead(405).end();return;}
   let body='';for await(const b of req)body+=b;
   const q=JSON.parse(body); seen.push(q.method);
   const msg={jsonrpc:'2.0',id:q.id};
   if(q.method==='initialize'){msg.result=init;res.setHeader('mcp-session-id','sample');}
   else if(q.method==='server/discover'){msg.error={code:-32601,message:'Unknown method'};}
   else if(req.headers['mcp-session-id']!=='sample'){res.writeHead(400).end();return;}
   else if(q.method==='notifications/initialized'){res.writeHead(202).end();return;}
   else if(q.method==='tools/list'){msg.result=q.params?.cursor?{tools:[def('details')]}:{tools:[def('search')],nextCursor:'p2'};}
   else if(q.method==='tools/call'){msg.result={content:[{type:'resource',resource:{uri:'https://example.org/page',text:'actual body',mimeType:'text/plain'}}],structuredContent:{score:8}};}
   else{msg.error={code:-32601,message:'Unknown'};}
   if(q.method==='tools/call'){res.writeHead(200,{'content-type':'text/event-stream'}).end('event: message\ndata: '+JSON.stringify(msg)+'\n\n');}
   else res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(msg));
 });
 await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{disconnectMcpServer(id);srv.closeAllConnections();await new Promise(resolve=>srv.close(resolve));await rm(dir,{recursive:true,force:true});});
 const conn=await connectMcpServer(id,{url:'http://127.0.0.1:'+srv.address().port+'/mcp',cwd:dir,headers:{Authorization:'Bearer fixture'}});
 assert.equal(conn.connected,true,conn.error);assert.equal(conn.toolCount,2);
 const r=await getMcpTool('mcp:'+id+':details').run({});assert.match(r.output,/actual body/);assert.match(r.output,/"score":8/);
 assert.equal(r.completionSources[0].reading,'extracted');
 assert.equal(seen.filter(m=>m==='tools/list').length,2);
 assert.throws(()=>httpEndpoint('http://external.test/mcp'));assert.throws(()=>httpEndpoint('https://u:p@external.test/'));
});
test('rich results, snippets and partial body evidence stay distinct',()=>{
 const result=mcpResultToToolResult({content:[{type:'image',mimeType:'image/png',data:'AA=='},{type:'resource_link',uri:'https://example.org/a'}],structuredContent:{body:'正文'}});
 assert.match(result.output,/正文/);assert.doesNotMatch(result.output,/AA==/);assert.equal(result.meta.modelImage,'data:image/png;base64,AA==');
 for(const [name,data,sources,expected] of [
   ['fetch_url',{url:'https://a.test',text:'only preview',reading:'snippet'},[],'snippet'],
   ['fetch_url',{url:'https://a.test',text:'long excerpt',truncated:true},[],'partial'],
   ['mcp:fixture:read',{},result.completionSources,'snippet'],
 ]) assert.equal(completionObservation({id:'one',name,ok:true,executed:true,data,sources})[1].reading,expected);
 assert.equal(socialSource('search_videos',{structuredContent:{aweme_id:'123456789',desc:'card'}}),null);
 assert.equal(socialSource('get_video_detail',{structuredContent:{aweme_detail:{aweme_id:'123456789',desc:'clip description'}}}).reading,'partial');
 assert.equal(socialSource('get_feed_detail',{structuredContent:{data:{note:{noteId:'1234abcd',desc:'actual note'}}}}).reading,'extracted');
 assert.equal(socialSource('get_feed_detail',{content:[{type:'text',text:'Please log in'}]}),null);
});
test('all Agent defaults; migrate once, keep revocations, network prohibitions and unrelated configuration',()=>{
 const orig=createDefaultState();delete orig.settings.socialReaderVersion;
 orig.agentProfiles.main.capabilities.mcpServers=['manual'];orig.agentProfiles.main.capabilities.runCommands=false;
 const next=hydrateState(orig);
 for(const p of Object.values(next.agentProfiles))for(const id of socialIds)assert.ok(p.capabilities.mcpServers.includes(id));
 assert.ok(next.agentProfiles.main.capabilities.mcpServers.includes('manual'));assert.equal(next.agentProfiles.main.capabilities.runCommands,false);
 next.agentProfiles.main.capabilities.mcpServers=['manual'];assert.deepEqual(hydrateState(next).agentProfiles.main.capabilities.mcpServers,['manual']);
 const tool='mcp:melo-douyin:search_videos'; assert.equal(requestAllowsTool(tool,{fetchForbidden:true}),false);assert.equal(requestAllowsTool(tool,{searchForbidden:true}),false);assert.equal(toolCapabilityAllowed(tool,{mcpServers:socialIds,network:false}),false);
});
test('platform QR token stays in host memory, raw login/account contents never reach UI',async()=>{
 let token; const fake={callTool:async(name,args)=>{if(name==='check_login_qrcode')token=args.token;
 return {structuredContent:name==='get_login_qrcode'?{data:{qrcode:'iVBORw0KGgoAAA==',token:'qr-secret'}}:name==='check_login_status'?{logged_in:true,uid:'private'}:{data:{status:'confirmed'}}};}};
 const start=await socialLogin(fake,'melo-douyin','start');assert.equal(start.status,'scan');assert.doesNotMatch(JSON.stringify(start),/qr-secret/);
 assert.deepEqual(await socialLogin(fake,'melo-douyin','status',async()=>true),{status:'authenticated'});assert.equal(token,'qr-secret');
});
test('a site lookup uses the authorized platform tools instead of a phone operation; a real phone instruction remains a phone operation',async()=>{
 const {planRequest}=await import('../../shared/agent/search.js');
 const ids=['phone_use','fetch_url','mcp:melo-xiaohongshu:search_feeds','mcp:melo-xiaohongshu:get_feed_detail'];
 const plan=text=>planRequest({text,capabilities:{executors:ids,grants:ids}});
 assert.equal(plan('在小红书搜上海公园，读两篇笔记').reason,'platform-reader');
 assert.equal(plan('在手机上打开小红书').route,'phone');
 assert.notEqual(plan('不要联网，在小红书查上海公园').reason,'platform-reader');
 const {socialSearch}=await import('./socialSearch.js');
 assert.equal(socialSearch('search_videos',{content:[{type:'text',text:'{"data":[],"status_msg":"login required"}'}]}).ok,false);
 const result=socialSearch('search_videos',{structuredContent:{data:[{aweme_info:{aweme_id:'123456789',desc:'recommendation card'}}]}});
 assert.equal(result.completionSources[0].reading,'snippet');assert.match(result.output,/get_video_detail/);
});

test('public posts must match the detail ID; guest redirects, gates, recommendations and failures cannot sign evidence',async()=>{
 const {publicPostSource,readPublicPost}=await import('./publicPost.js');
 const id='1234567890123456789',url='https://www.douyin.com/video/'+id;
 const state={data:{storeState:{detail:{videoData:{result:{gid:id,title:'Author caption only.'}}},recommend:{gid:'1111111111',title:'Other post'}}}};
 const html='<script>window._SSR_DATA = '+JSON.stringify(state)+';</script>';
 const req=async (u,init)=>{assert.equal(u.hostname,'jingxuan.douyin.com');assert.equal(init.credentials,'omit');assert.equal(init.headers.cookie,undefined);return new Response(html,{headers:{'content-type':'text/html'}});};
 const source=await readPublicPost(url,{request:req});assert.equal(source.text,'Author caption only.');assert.equal(source.reading,'partial');
 assert.equal(publicPostSource(html,url.replace(id,'1111111111')),null);
 const x='671234567890123456789abc',xurl='https://www.xiaohongshu.com/explore/'+x;
 const xs='<script>window.__INITIAL_STATE__={"extra":undefined,"note":{"noteDetailMap":{"'+x+'":{"note":{"noteId":"'+x+'","desc":"note with undefined in text"}}}}};</script>';
 assert.equal(publicPostSource(xs,xurl).text,'note with undefined in text');
 assert.equal(publicPostSource('<meta property="og:description" content="search snippet">',xurl),null);
 let calls=0; const blocked=await readPublicPost('https://xhslink.com/o/public',{request:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://example.com/steal'}});}});assert.equal(blocked,null);assert.equal(calls,1);
 await assert.rejects(readPublicPost(url,{signal:AbortSignal.abort(),request:()=>assert.fail('cancelled')}),{name:'AbortError'});
});
test('public search sends only explicit site-qualified web searches; drops ads, other domains, and non-post results',async()=>{
 const {searchPublicIndex}=await import('../services/search/publicPlatformIndex.js');let calls=0;
 const url='https://www.douyin.com/video/1234567890123456789',doc='<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg='+encodeURIComponent(url)+'">Post</a><span class="result__snippet">card</span></div><a class="result__a" href="https://notdouyin.com/video/987654321">Other</a><a class="result__a" href="https://www.douyin.com/search/query">Search page</a>';
 const req=async(u,opts)=>{calls++;assert.equal(opts.credentials,'omit');return new Response(doc);};
 assert.deepEqual(await searchPublicIndex('上海公园',5,undefined,req),[]);assert.equal(calls,0);
 assert.deepEqual(await searchPublicIndex('site:douyin.com 上海公园',5,undefined,req),[{title:'Post',url,snippet:'card'}]);
 const {planRequest}=await import('../../shared/agent/search.js');const ids=['web_search','phone_use','fetch_url','mcp:melo-xiaohongshu:search_feeds','mcp:melo-xiaohongshu:get_feed_detail'];
 const plan=text=>planRequest({text,capabilities:{executors:ids,grants:ids}});
 assert.deepEqual(plan('不用登录在小红书搜上海公园').tools,['web_search','fetch_url']);
 assert.ok(!plan('不要搜索，读这个小红书链接 https://www.xiaohongshu.com/explore/671234567890123456789abc').tools.includes('web_search'));
});
test('fetch_url retains the end of a long non-HTML response across actual HTTP pages',async t=>{
 const {fetchUrlTool}=await import('../tools/builtins/fetchUrlTool.js');
 const body='first page '.repeat(3200)+'\nLAST PAGE UNIQUE MARK';
 const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end(body);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port+'/public.txt';
 const run=offset=>fetchUrlTool.run({url,extract_mode:'direct',offset},{});
 const first=await run(0);assert.ok(first.ok&&first.meta.nextOffset>0);assert.equal(first.meta.reading,'partial');assert.doesNotMatch(first.output,/LAST PAGE/);
 const last=await run(first.meta.nextOffset);assert.ok(last.ok);assert.match(last.output,/LAST PAGE UNIQUE MARK/);assert.equal(last.meta.nextOffset,null);assert.equal(last.meta.reading,'partial');assert.equal((await run(90000)).error,'OFFSET_OUT_OF_RANGE');
});
test('an explicit guest-only turn cannot fall back to a signed-in platform reader',async()=>{
 const {getRequestNetworkPolicy,requestAllowsTool}=await import('../../shared/agent/retrieval/requestPolicy.js');
 const {fetchUrlTool}=await import('../tools/builtins/fetchUrlTool.js');
 const policy=getRequestNetworkPolicy('不用登录在小红书搜上海公园');
 assert.equal(requestAllowsTool('mcp:melo-xiaohongshu:get_feed_detail',policy),false);
 assert.equal(requestAllowsTool('web_search',policy),true);
 let signed=0,guest=0;const r=await fetchUrlTool.run({url:'https://www.douyin.com/video/123456789',extract_mode:'cdp-chrome',cookies:'test=do-not-send'},{
   requestContext:{requestToolPolicy:policy},_readPublicPost:async(url,opts)=>{guest++;assert.deepEqual(Object.keys(opts),['signal']);return null;},_readSocialLink:()=>{signed++;},_tryCdpChrome:()=>{signed++;}});
 assert.equal(r.error,'PUBLIC_POST_UNAVAILABLE');assert.equal(guest,1);assert.equal(signed,0);
});
