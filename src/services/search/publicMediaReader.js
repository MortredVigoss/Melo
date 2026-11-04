import {JSDOM} from 'jsdom';
import {mediaLink} from './mediaPermalink.js';
import {instagramCaption,youtubeSubtitles} from './publicMediaBrowser.js';

const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0 Safari/537.36';
function source(link,text,kind,reading='partial') {
  if(typeof text!=='string' || !text.trim()) return null;
  return {url:link.url,text:text.trim(),kind,reading};
}
async function body(response,limit) {
  const parts=[]; let size=0;
  for await(const chunk of response.body) {
    size+=chunk.byteLength;
    if(size>limit) return null;
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}
async function get(url,ctx) {
  return ctx.request(url,{signal:ctx.signal,credentials:'omit',redirect:'manual',
    headers:{'user-agent':ctx.userAgent || UA,'accept-language':'en-US,en;q=0.8'}});
}
async function json(url,ctx) {
  let endpoint=new URL(url);
  const trusted=new Set([endpoint.origin]);
  if(endpoint.hostname==='publish.twitter.com')trusted.add('https://publish.x.com');
  for(let hop=0;hop<3;hop++){
    const r=await get(endpoint,ctx);
    if(r.status>=300 && r.status<400){
      await r.body?.cancel();
      const location=r.headers.get('location');
      if(!location)return null;
      const next=new URL(location,endpoint);
      if(!trusted.has(next.origin)||next.username||next.password)return null;
      endpoint=next;continue;
    }
    if(!r.ok){await r.body?.cancel();return null;}
    try{return JSON.parse(await body(r,2000000));}catch{ctx.signal.throwIfAborted();return null;}
  }
  return null;
}
function samePost(a,b) {
  return a?.id && b?.id===a.id && a.platform.id===b.platform.id;
}
async function pageFor(link,ctx) {
  const platform=link.platform.id;
  let expected=link.id;
  for(let hop=0;hop<5;hop++){
    const r=await get(link.url,ctx);
    if(r.status>=300 && r.status<400){
      await r.body?.cancel();
      const location=r.headers.get('location');
      if(!location) return null;
      const next=mediaLink(new URL(location,link.url).href);
      if(!next || next.platform.id!==platform || (expected && next.id!==expected))return null;
      expected ||= next.id;
      link=next;continue;
    }
    if(!r.ok || !link.id || !/text\/html/i.test(r.headers.get('content-type')||'')){await r.body?.cancel();return null;}
    const html=await body(r,4500000);
    return html?{link,html}:null;
  }
  return null;
}
async function youtube(html,link,ctx) {
  const match=html.match(/(?:var\s+)?ytInitialPlayerResponse\s*=\s*(\{[^\n]+?\});/);
  let player;
  try {player=JSON.parse(match?.[1]);} catch {return null;}
  const video=player.videoDetails;
  if(video?.videoId!==link.id || player.playabilityStatus?.status!=='OK') return null;
  const tracks=player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if(ctx.transcript!==false && tracks.length){
    const track=tracks.find(t=>t.languageCode==='en' && !t.kind) || tracks.find(t=>t.languageCode==='en') || tracks[0];
    let url;
    try{url=new URL(track.baseUrl);}catch{}
    if(url?.origin==='https://www.youtube.com' && url.pathname==='/api/timedtext' && url.searchParams.get('v')===link.id){
      url.searchParams.set('fmt','json3');
      const captions=await json(url,ctx);
      const text=captions?.events?.flatMap(event=>(event.segs||[]).map(segment=>segment.utf8)).filter(s=>typeof s==='string').join(' ').trim();
      if(text) return source(link,text,'subtitles');
    }
  }
  if(ctx.transcript!==false && tracks.length){
    const rendered=await ctx.browserSubtitles(link,ctx.signal);
    if(rendered)return rendered;
  }
  const result=source(link,video.shortDescription,'video-description') || source(link,video.title,'title','snippet');
  return result && {...result,title:video.title,subtitles:'not-read'};
}
function embeddedDetail(html,link) {
  if(link.platform.id==='facebook'){
    for(const script of JSDOM.fragment(html).querySelectorAll('script[type="application/json"]')){
      if(!script.textContent.includes(link.id))continue;
      try{
        const queue=[JSON.parse(script.textContent)];
        for(let i=0;i<queue.length && queue.length<12000;i++){
          const v=queue[i];
          if(!v || typeof v!=='object')continue;
          if(v.__typename==='Video' && String(v.id)===link.id){
            const result=source(link,v.creation_story?.message?.text || v.description?.text,'author-caption');
            if(result)return result;
          }
          for(const child of Object.values(v))if(child && typeof child==='object')queue.push(child);
        }
      }catch{}
    }
  }
  if(link.platform.id==='kuaishou'){
    const scripts=JSDOM.fragment(html).querySelectorAll('script');
    for(const script of scripts){
      const match=script.textContent.trim().match(/^window\.INIT_STATE\s*=\s*(\{[\s\S]*\});?$/);
      if(!match)continue;
      try{
        for(const entry of Object.values(JSON.parse(match[1]))){
          const photo=entry?.photo;
          if(photo && new URLSearchParams(photo.share_info).get('photoId')===link.id){
            const canonical={...link,url:'https://www.kuaishou.com/short-video/'+link.id};
            return source(canonical,photo.caption,'author-caption');
          }
        }
      }catch{}
    }
  }
  if(link.platform.id==='weibo'){
    const scripts=JSDOM.fragment(html).querySelectorAll('script');
    for(const node of scripts){
      const frame=node.textContent.match(/^self\.__next_f\.push\((.*)\);?$/s);
      if(!frame)continue;
      try{
        const payload=JSON.parse(frame[1])[1];
        if(typeof payload!=='string'||!payload.includes(link.id))continue;
        for(const row of payload.split('\n')){
          const colon=row.indexOf(':');
          if(colon<0)continue;
          let tree;try{tree=JSON.parse(row.slice(colon+1));}catch{continue;}
          const queue=[tree];
          for(let i=0;i<queue.length && queue.length<6000;i++){
            const v=queue[i];if(!v || typeof v!=='object')continue;
            if(String(v.id)===link.id && v.header && v.content){
              const text=v.content.textRaw || JSDOM.fragment(v.content.text || '').textContent;
              const item=source(link,text,'post-text','partial');
              if(item)return item;
            }
            for(const child of Object.values(v))if(child && typeof child==='object')queue.push(child);
          }
        }
      }catch{}
    }
  }
  if(link.platform.id==='bilibili') {
    const match=html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[^\n]+?\});/);
    try{
      const data=JSON.parse(match?.[1]).videoData;
      if(data?.bvid===link.id || 'av'+data?.aid===link.id)return source(link,data.desc,'video-description');
    }catch{}
  }
  if(link.platform.id==='tiktok'){
    const node=JSDOM.fragment(html).querySelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
    try{
      const item=JSON.parse(node?.textContent).__DEFAULT_SCOPE__['webapp.video-detail'].itemInfo.itemStruct;
      if(String(item.id)===link.id)return source(link,item.desc,'author-caption');
    }catch{}
  }
  return null;
}
async function apiSource(link,ctx) {
  const platform=link.platform.id;
  if(platform==='bilibili'){
    const key=link.id.startsWith('av')?'aid='+link.id.slice(2):'bvid='+encodeURIComponent(link.id);
    const result=await json('https://api.bilibili.com/x/web-interface/view?'+key,ctx);
    const d=result?.data;
    if(result?.code===0 && (d?.bvid===link.id || 'av'+d?.aid===link.id))
      return source(link,d.desc,'video-description') || source(link,d.title,'title','snippet');
  }
  if(platform==='qqvideo'){
    const url='https://vv.video.qq.com/getinfo?vids='+encodeURIComponent(link.id)+'&platform=101001&otype=json';
    const r=await get(url,ctx);
    if(r.ok){
      const data=await body(r,300000);
      const m=data?.match(/^QZOutputJson=(\{[\s\S]*\});?$/);
      try{
        const record=JSON.parse(m?.[1]).vl?.vi?.find(v=>v.vid===link.id);
        if(record)return source(link,record.desc,'video-description') || source(link,record.ti,'title','snippet');
      }catch{}
    }else await r.body?.cancel();
  }
  if(platform==='weibo'){
    const d=await json('https://weibo.com/ajax/statuses/show?id='+encodeURIComponent(link.id),ctx);
    if(d && [d.idstr,d.mblogid].includes(link.id))
      return source(link,d.text_raw || JSDOM.fragment(d.text || '').textContent,'post-text',d.isLongText?'partial':'extracted');
  }
  const embed={vimeo:'https://vimeo.com/api/oembed.json?url=',tiktok:'https://www.tiktok.com/oembed?url=',x:'https://publish.twitter.com/oembed?omit_script=true&url='}[platform];
  if(embed){
    const d=await json(embed+encodeURIComponent(platform==='x' ? link.url.replace(/^https:\/\/(?:www\.)?x\.com\//,'https://twitter.com/') : link.url),ctx);
    if (platform==='vimeo' && String(d?.video_id)===link.id)
      return source(link,d.description,'video-description') || source(link,d.title,'title','snippet');
    if (d?.html && ['x','tiktok'].includes(platform)){
      const doc=JSDOM.fragment(d.html);
      const quote=doc.querySelector('blockquote');
      const identity=platform==='tiktok'?mediaLink(quote?.getAttribute('cite')):mediaLink(d.url);
      if(!samePost(link,identity))return null;
      return source(link,quote?.querySelector('p')?.textContent || (platform==='tiktok'?d.title:''),'author-caption');
    }
  }
  return null;
}
function pageMetadata(html,link){
  const doc=JSDOM.fragment(html);
  for(const script of doc.querySelectorAll('script[type="application/ld+json"]')){
    try{
      const root=JSON.parse(script.textContent);
      for(const row of [root].flat().flatMap(n=>n?.['@graph'] || [n])){
        const url=row?.url || row?.['@id'] || row?.mainEntityOfPage?.['@id'];
        if(!samePost(link,mediaLink(url)) || !['VideoObject','SocialMediaPosting'].includes(row?.['@type']))continue;
        const item=source(link,row.articleBody || row.description,'description');
        if(item)return item;
      }
    }catch{}
  }
  const identity=doc.querySelector('meta[property="og:url"]')?.content || doc.querySelector('link[rel="canonical"]')?.href;
  if(!samePost(link,mediaLink(identity)))return null;
  const text=doc.querySelector('meta[property="og:description"]')?.content || doc.querySelector('meta[name="description"]')?.content;
  if(!text || /(?:log in (?:to|or)|sign up to|登录后|登录即可|登录查看更多|验证后继续)/i.test(text))return null;
  return source(link,text,'page-preview','snippet');
}
export async function readMediaPost(href,{signal,request=fetch,transcript=true,browserCaption=instagramCaption,browserSubtitles=youtubeSubtitles}={}) {
  const initial=mediaLink(href);
  if(!initial)return null;
  const timeout=AbortSignal.timeout(26000);
  const ctx={request,transcript,browserSubtitles,
    userAgent:initial.platform.id==='kuaishou'?'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 Version/17.6 Mobile/15E148 Safari/604.1':UA,
    signal:signal?AbortSignal.any([signal,timeout]):timeout};
  try {
    ctx.signal.throwIfAborted();
    if(initial.id){
      const fromApi=await apiSource(initial,ctx);
      if(fromApi)return fromApi;
      if(initial.platform.id==='instagram'){
        const caption=await browserCaption(initial,ctx.signal);
        if(caption)return caption;
      }
    }
    const page=await pageFor(initial,ctx);
    if(!page)return null;
    if(!initial.id){const fromApi=await apiSource(page.link,ctx);if(fromApi)return fromApi;}
    if(page.link.platform.id==='youtube'){
      const result=await youtube(page.html,page.link,ctx);
      if(result)return result;
    }
    return embeddedDetail(page.html,page.link) || pageMetadata(page.html,page.link);
  }catch{signal?.throwIfAborted();return null;}
}
