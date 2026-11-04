import {InMemoryTransport,Server} from '@modelcontextprotocol/server';
import {MEDIA_PLATFORMS,PUBLIC_MEDIA_SERVER} from '../../shared/agent/media/publicPlatforms.js';
import {discoverPlatformPosts} from '../services/search/publicMediaDiscovery.js';
import {readMediaPost} from '../services/search/publicMediaReader.js';

const textResult = (payload,isError=false)=>({content:[{type:'text',text:JSON.stringify(payload)}],isError,structuredContent:payload});
const tools=[
  {name:'search_posts',description:'Find public post permalinks through YouTube search, an explicit Instagram @handle, or a public web index. Results are candidates. Read a post to verify its contents.',
    inputSchema:{type:'object',properties:{platform:{type:'string',enum:MEDIA_PLATFORMS.map(p=>p.id)},query:{type:'string',maxLength:500}},required:['platform','query'],additionalProperties:false}},
  {name:'read_post',description:'Read one public post without signing in. The returned kind distinguishes subtitles, author text, a video description and a preview.',
    inputSchema:{type:'object',properties:{url:{type:'string',maxLength:4096},transcript:{type:'boolean',description:'Attempt public captions on YouTube.'}},required:['url'],additionalProperties:false}},
].map(tool=>({...tool,annotations:{readOnlyHint:true,destructiveHint:false}}));

export async function openPublicMediaTransport({search=discoverPlatformPosts,read=readMediaPost}={}) {
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const server=new Server({name:PUBLIC_MEDIA_SERVER,version:'1.0.0'},{capabilities:{tools:{}}});
  server.setRequestHandler('tools/list',async()=>({tools}));
  server.setRequestHandler('tools/call',async({params},ctx)=>{
    const args=params.arguments || {};
    const signal=ctx.mcpReq.signal;
    if(params.name==='search_posts'){
      const platform=MEDIA_PLATFORMS.find(p=>p.id===args.platform);
      if(!platform || typeof args.query!=='string' || !args.query.trim() || args.query.length>500)
        return textResult({error:'INVALID_PLATFORM_QUERY'},true);
      const rows=await search(platform,args.query.trim(),signal);
      if(!rows.length)return textResult({error:'NO_PUBLIC_INDEX_RESULTS',next:'Try the authorized web_search tool or a public post URL.'},true);
      return textResult({kind:'search-cards',sources:rows.map(r=>({url:r.url,text:r.title+' '+r.snippet,reading:'snippet'}))});
    }
    if(params.name!=='read_post' || typeof args.url!=='string' || args.url.length>4096)
      return textResult({error:'INVALID_POST_URL'},true);
    const result=await read(args.url,{signal,transcript:args.transcript!==false});
    if(!result)return textResult({error:'PUBLIC_POST_UNAVAILABLE',next:'Report the page as unverified or try another public source.'},true);
    return textResult({kind:result.kind,subtitles:result.subtitles,sources:[result]});
  });
  await server.connect(serverTransport);
  return clientTransport;
}
