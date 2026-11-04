import {searchPublicIndex} from './publicPlatformIndex.js';
import {instagramProfilePosts} from './publicMediaBrowser.js';

// Limit traversal to the result sections; suggestions and sidebar recommendations
// in the same HTML must not become search results.
export function youtubeCards(html,limit) {
  const match=html.match(/(?:var\s+)?ytInitialData\s*=\s*(\{[^\n]+?\});/);
  if(!match)return [];
  let sections;
  try{sections=JSON.parse(match[1]).contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;}catch{return [];}
  const rows=new Map();
  for(const section of sections ?? []){
    for(const item of section.itemSectionRenderer?.contents ?? []){
      const video=item.videoRenderer;
      if(!video || !/^[\w-]{11}$/.test(video.videoId || ''))continue;
      const title=video.title?.runs?.map(t=>t.text).join('') || video.title?.simpleText;
      if(!title)continue;
      rows.set(video.videoId,{title:title.slice(0,300),url:'https://www.youtube.com/watch?v='+video.videoId,snippet:''});
      if(rows.size>=limit)return [...rows.values()];
    }
  }
  return [...rows.values()];
}
export async function discoverPlatformPosts(platform,query,signal,{request=fetch,index=searchPublicIndex,profile=instagramProfilePosts}={}) {
  if(platform.id==='youtube'){
    try{
      const timeout=AbortSignal.timeout(6500);
      const res=await request('https://www.youtube.com/results?search_query='+encodeURIComponent(query),{
        signal:signal?AbortSignal.any([signal,timeout]):timeout,credentials:'omit',redirect:'error',
        headers:{'user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'}});
      if(res.ok){
        const chunks=[];let size=0;
        for await(const part of res.body){size+=part.byteLength;if(size>4000000)break;chunks.push(part);}
        if(size<=4000000){const rows=youtubeCards(Buffer.concat(chunks).toString('utf8'),6);if(rows.length)return rows;}
      }else await res.body?.cancel();
    }catch{signal?.throwIfAborted();}
  }
  if(platform.id==='instagram'){
    const account=query.match(/^@([a-z0-9_.]{1,30})(?:\s+([\s\S]*))?$/i);
    if(account){
      const timeout=AbortSignal.timeout(18500);
      const rows=await profile(account[1],account[2]||'',signal?AbortSignal.any([signal,timeout]):timeout);
      return rows || [];
    }
  }
  return index('site:'+platform.site+' '+query,6,signal);
}
