// Upstream can report a successful JSON-RPC call containing a platform
// verification interstitial. Only actual stable item identifiers form results.
export function socialSearch(name, raw) {
  if (raw?.isError || !['search_feeds','search_videos'].includes(name)) return null;
  let doc=raw.structuredContent;
  if(!doc) for(const b of raw.content || []) {try{doc=JSON.parse(b.text);break;} catch{}}
  const queue=[doc],cards=new Map(); let visited=0;
  for(let i=0;i<queue.length && visited<6000 && cards.size<24;i++){
    const v=queue[i]; if(!v || typeof v!=='object')continue; visited++;
    if(name==='search_feeds' && v.noteCard && /^[\da-f]{12,32}$/i.test(v.id || '') && typeof v.xsecToken==='string' && v.xsecToken) {
      cards.set(v.id,{feed_id:v.id,xsec_token:v.xsecToken,title:String(v.noteCard.displayTitle || v.noteCard.title || '').slice(0,250),url:'https://www.xiaohongshu.com/explore/'+v.id});
    } else if(name==='search_videos' && /^\d{8,25}$/.test(v.aweme_id || '') && typeof v.desc==='string') {
      cards.set(String(v.aweme_id),{video:String(v.aweme_id),description:v.desc.slice(0,300),url:'https://www.douyin.com/video/'+v.aweme_id});
    }
    if(queue.length<6000) for(const child of Object.values(v)) if(child && typeof child==='object' && queue.length<6000)queue.push(child);
  }
  if(!cards.size) return {ok:false,error:'NO_PLATFORM_ITEMS',output:'No verifiable platform items returned. Use allowed web search for public permalinks and fetch the actual pages; sign-in is optional for restricted surfaces. Do not cite this as a page read.'};
  const items=[...cards.values()];
  return {ok:true,output:JSON.stringify({reading:'snippet',items,next:name==='search_feeds'?'get_feed_detail':'get_video_detail',cursor:doc?.cursor??doc?.offset??null}),completionSources:items.map(item=>({url:item.url,text:item.title||item.description||'',reading:'snippet'}))};
}
