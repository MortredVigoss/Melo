import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {openPublicMediaTransport} from './publicMediaServer.js';
import {readMediaPost} from '../services/search/publicMediaReader.js';
import {mediaLink} from '../services/search/mediaPermalink.js';
import {platformSite} from '../services/search/publicPlatformIndex.js';
import {planRequest} from '../../shared/agent/search.js';
import {requestAllowsTool} from '../../shared/agent/retrieval/requestPolicy.js';
import {toolCapabilityAllowed} from '../domain/agent/capabilities.js';
import {addSocialReads} from './socialPresets.js';

const guestUrls=[
  'https://www.instagram.com/nasa/p/DayIkFmDwlb/', 'https://youtu.be/jNQXAC9IVRw',
  'https://vimeo.com/12345','https://www.bilibili.com/video/BV1e6JwzaEkq/',
  'https://www.tiktok.com/@nasa/video/12345678','https://twitter.com/jack/status/20',
  'https://www.facebook.com/watch/?v=123456','https://weibo.com/2/detail/5340436731265687',
  'https://v.qq.com/x/page/q326831cny0.html','https://www.kuaishou.com/short-video/3x5pf8ia4zc76tc',
];
test('all public platforms have a matching post grammar and search domain',()=>{
  assert.equal(new Set(guestUrls.map(url=>mediaLink(url).platform.id)).size,10);
  for (const url of guestUrls) assert.equal(platformSite('site:'+mediaLink(url).platform.site+' nature'),mediaLink(url).platform.site);
  for (const invalid of ['https://x.com.evil.test/nasa/status/20','https://u:p@instagram.com/p/a','https://youtube.com:9443/watch?v=jNQXAC9IVRw','https://instagram.com/accounts/login/','https://youtube.com/watch?v=bad'])assert.equal(mediaLink(invalid),null);
});
test('Youtube caption evidence requires both the correct video and a nonempty track or rendered subtitles',async()=>{
  const id='jNQXAC9IVRw',url=guestUrls[1];
  const player={playabilityStatus:{status:'OK'},videoDetails:{videoId:id,shortDescription:'author description'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{languageCode:'en',baseUrl:'https://www.youtube.com/api/timedtext?v='+id}]}}};
  const html=()=>new Response('<script>var ytInitialPlayerResponse = '+JSON.stringify(player)+';</script>',{headers:{'content-type':'text/html'}});
  let captionURL,rendered=0;
  const read=(payload)=>readMediaPost(url,{request:async(u,init)=>{
    assert.equal(init.credentials,'omit');assert.equal(init.headers.Cookie,undefined);
    if(String(u).includes('timedtext')){captionURL=new URL(u);return new Response(payload);}
    return html();
  },browserSubtitles:async()=>{rendered++;return null;}});
  const first=await read('{"events":[{"segs":[{"utf8":"spoken words"}]}]}');
  assert.equal(first.kind,'subtitles');assert.equal(first.text,'spoken words');assert.equal(captionURL.searchParams.get('v'),id);
  const partial=await read('');assert.equal(partial.kind,'video-description');assert.equal(partial.subtitles,'not-read');assert.equal(rendered,1);
  player.videoDetails.videoId='aaaaaaaaaaa';assert.equal(await read('{}'),null);
});
test('redirects and page metadata may never substitute a different work, domain or login page',async()=>{
  const initial='https://www.facebook.com/reel/12345678/';
  let count=0;const miss=await readMediaPost(initial,{request:async()=>{count++;return new Response(null,{status:302,headers:{location:'http://localhost/secret'}});}});
  assert.equal(miss,null);assert.equal(count,1);
  const get=html=>readMediaPost(initial,{request:async()=>new Response(html,{headers:{'content-type':'text/html'}})});
  const tags=(url,text)=>'<meta property="og:url" content="'+url+'"><meta property="og:description" content="'+text+'">';
  assert.equal(await get(tags(initial.replace('12345678','12345999'),'wrong post')),null);
  assert.equal(await get(tags(initial,'Log in to Facebook')),null);
  assert.equal((await get(tags(initial,'public preview'))).reading,'snippet');
  await assert.rejects(readMediaPost(initial,{signal:AbortSignal.abort(),request:()=>assert.fail('cancelled')}),{name:'AbortError'});
});
test('real MCP protocol roundtrip returns graded public sources and respects SDK cancellation',async t=>{
  let cancelled=false;
  const transport=await openPublicMediaTransport({
    search:async()=>[{title:'A',url:guestUrls[0],snippet:'card'}],
    read:async(url,{signal})=>{
      if(url==='wait') return new Promise(resolve=>signal.addEventListener('abort',()=>{cancelled=true;resolve(null);},{once:true}));
      return {url,text:'owner caption',kind:'author-caption',reading:'partial'};
    },
  });
  const client=new Client({name:'gate',version:'1'});t.after(()=>client.close());await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['search_posts','read_post']);
  const search=await client.callTool({name:'search_posts',arguments:{query:'museum',platform:'instagram'}});
  assert.equal(search.structuredContent.sources[0].reading,'snippet');
  const detail=await client.callTool({name:'read_post',arguments:{url:guestUrls[0]}});
  assert.equal(detail.structuredContent.sources[0].reading,'partial');
  const abort=new AbortController();const waiting=client.callTool({name:'read_post',arguments:{url:'wait'}},{signal:abort.signal});
  await new Promise(r=>setTimeout(r,30));abort.abort();await assert.rejects(waiting);
  for(let i=0;i<20&&!cancelled;i++)await new Promise(r=>setTimeout(r,5));
  assert.ok(cancelled);
});
test('public readers inherit network and search limits; upgrades do not restore revoked v1 readers',()=>{
  const read='mcp:melo-public-media:read_post',find='mcp:melo-public-media:search_posts',ids=[read,find];
  const plan=text=>planRequest({text,capabilities:{executors:ids,grants:ids}});
  assert.deepEqual(plan('不用登录，在 IG 搜两篇 NASA 的帖子').tools,[find,read]);
  assert.equal(requestAllowsTool(read,{fetchForbidden:true}),false);assert.equal(requestAllowsTool(find,{searchForbidden:true}),false);
  assert.equal(requestAllowsTool(read,{publicSocialOnly:true}),true);
  assert.equal(toolCapabilityAllowed(read,{network:false,mcpServers:['melo-public-media']}),false);
  const p={enabledMcpServerIds:[],capabilities:{network:false,mcpServers:[]}};
  assert.deepEqual(addSocialReads(p,1).capabilities,{network:false,mcpServers:['melo-public-media']});
});
test('Kuaishou mobile share binds the caption to the requested share ID and drops unrelated works',async()=>{
  const id='3x1234',url='https://v.kuaishou.com/abc';
  const run=photoId=>readMediaPost(url,{request:async u=>{
    if(String(u)===url)return new Response(null,{status:302,headers:{location:'https://v.m.chenzhongtech.com/fw/photo/'+id}});
    const photo={caption:'public caption',share_info:'photoId='+photoId};
    return new Response('<script>window.INIT_STATE = '+JSON.stringify({detail:{photo}})+'</script>',{headers:{'content-type':'text/html'}});
  }});
  assert.equal((await run(id)).kind,'author-caption');assert.equal(await run('another'),null);
});
test('Tencent title-only responses never count as subtitles or video contents',async()=>{
  const url='https://v.qq.com/x/page/n35636p6ba6.html';
  const r=await readMediaPost(url,{request:async()=>new Response('QZOutputJson={"vl":{"vi":[{"vid":"n35636p6ba6","ti":"Public title","ul":"secret media URL"}]}};')});
  assert.equal(r.kind,'title');assert.equal(r.reading,'snippet');assert.doesNotMatch(JSON.stringify(r),/secret media/);
});
test('Facebook reads only a matching Video object; guest shells and adjacent recommendations have no source',async()=>{
  const url='https://www.facebook.com/reel/12345678/';
  const html=id=>'<script type="application/json">'+JSON.stringify({data:{__typename:'Video',id,creation_story:{message:{text:'Creator text'}}}})+'</script>';
  const read=id=>readMediaPost(url,{request:async()=>new Response(html(id),{headers:{'content-type':'text/html'}})});
  assert.equal((await read('12345678')).text,'Creator text');assert.equal(await read('88889999'),null);
});
test('YouTube discovery only signs native result cards and Instagram only opens an explicitly named profile',async()=>{
 const {discoverPlatformPosts,youtubeCards}=await import('../services/search/publicMediaDiscovery.js');
 const row={videoRenderer:{videoId:'jNQXAC9IVRw',title:{runs:[{text:'Actual result'}]}}};
 const data={contents:{twoColumnSearchResultsRenderer:{primaryContents:{sectionListRenderer:{contents:[{itemSectionRenderer:{contents:[row]}}]}}}},sidebar:{videoRenderer:{videoId:'otherOther1'}}};
 assert.deepEqual(youtubeCards('var ytInitialData = '+JSON.stringify(data)+';',6).map(r=>r.title),['Actual result']);
 let args; const rows=await discoverPlatformPosts({id:'instagram',site:'instagram.com'},'@nasa orbit',undefined,{profile:async(...s)=>{args=s;return [];},index:()=>assert.fail('explicit profile must remain scoped')});
 assert.deepEqual(rows,[]);assert.deepEqual(args.slice(0,2),['nasa','orbit']);
});
test('foreign URLs mentioning a platform stay articles; a media permalink selects its actual platform',()=>{
 const ids=['fetch_url','web_search','mcp:melo-public-media:read_post','mcp:melo-public-media:search_posts'];
 const route=text=>planRequest({text,capabilities:{executors:ids,grants:ids}});
 assert.equal(route('读取关于 YouTube 的文章 https://example.com/article').route,'fetch-url');
 assert.equal(route('Read the YouTube support page https://www.youtube.com/howyoutubeworks/').route,'fetch-url');
 assert.equal(route('Compare IG https://www.instagram.com/p/abc123/ with https://example.com/article').route,'fetch-url');
 const actual=route('Instagram 对比里的原链接 https://youtu.be/jNQXAC9IVRw');
 assert.equal(actual.reason,'public-media');assert.match(actual.instructions,/public youtube/);
});
test('the same long subtitle tail is reachable through the real reader, fetch_url and MCP pagination',async t=>{
 const {fetchUrlTool}=await import('../tools/builtins/fetchUrlTool.js');
 const url='https://www.youtube.com/watch?v=jNQXAC9IVRw',tail='UNIQUE FINAL SPOKEN FACT',text='spoken text '.repeat(4200)+tail;
 const player={playabilityStatus:{status:'OK'},videoDetails:{videoId:'jNQXAC9IVRw'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{languageCode:'en',baseUrl:'https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw'}]}}};
 const read=(url,opts)=>readMediaPost(url,{...opts,request:async u=>String(u).includes('timedtext')?new Response(JSON.stringify({events:[{segs:[{utf8:text}]}]})):new Response('<script>var ytInitialPlayerResponse = '+JSON.stringify(player)+';</script>',{headers:{'content-type':'text/html'}})});
 const client=new Client({name:'paging-test',version:'1'});await client.connect(await openPublicMediaTransport({read}));t.after(()=>client.close());
 let joined='',offset=0;
 do {
   const r=await client.callTool({name:'read_post',arguments:{url,offset}});
   const page=r.structuredContent;
   assert.equal(page.offset,offset);assert.equal(page.totalChars,text.length);assert.ok(page.sources[0].text.length<=8000);
   joined+=page.sources[0].text;offset=page.nextOffset;
 } while(offset!==null);
 assert.equal(joined,text);
 const first=await fetchUrlTool.run({url},{_readMediaPost:read});assert.ok(first.meta.nextOffset>0);assert.doesNotMatch(first.output,/UNIQUE FINAL/);
 let last=first;
 while(last.meta.nextOffset!==null) last=await fetchUrlTool.run({url,offset:last.meta.nextOffset},{_readMediaPost:read});
 assert.ok(last.output.endsWith(tail));assert.equal(last.meta.reading,'partial');
 const invalid=await client.callTool({name:'read_post',arguments:{url,offset:text.length}});assert.equal(invalid.isError,true);
});
