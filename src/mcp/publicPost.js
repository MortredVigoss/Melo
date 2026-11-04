// Public post permalinks only. Never use browser sessions, cookies, a proxy, or
// a service API key. A page can contain dozens of recommended posts: require
// the requested ID in the detail record, not just in the HTML or page title.
const mobile = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const domains = {xiaohongshu:['xiaohongshu.com','xhslink.com','xhslink.cn','rednote.com'],douyin:['douyin.com','iesdouyin.com']};
const family = host => Object.keys(domains).find(k => domains[k].some(d => host===d || host.endsWith('.'+d)));
const postId = (url, platform) => platform==='douyin' ? url.pathname.match(/\/(?:video|note)\/(\d{8,25})(?:\/|$)/)?.[1] :
  url.pathname.match(/\/(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/i)?.[1];
function assigned(html, name) {
  const parts=html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi);
  for (const [,code] of parts) {
    const m=code.trim().match(/^window\.([A-Z_]+)\s*=\s*([\s\S]+?)\s*;?$/);
    if(!m || m[1]!==name) continue;
    // A few public XHS hydration fields are literally undefined. Preserve quoted text.
    const json=m[2].replace(/"(?:[^"\\]|\\.)*"|\bundefined\b/g, token=>token==='undefined'?'null':token);
    try{return JSON.parse(json);}catch{return null;}
  }
  return null;
}
export function isPublicPostHost(href){try{return !!family(new URL(href).hostname);}catch{return false;}}
export function publicPostSource(html, href) {
  const u=new URL(href), platform=family(u.hostname), id=postId(u,platform);
  if (!platform || !id) return null;
  if(platform==='douyin'){
    const v=assigned(html,'_SSR_DATA')?.data?.storeState?.detail?.videoData?.result;
    if(!v || String(v.gid)!==id || typeof v.title!=='string' || !v.title.trim()) return null;
    return {url:'https://jingxuan.douyin.com/m/video/'+id,text:v.title.trim(),reading:'partial',kind:'author-caption'};
  }
  const state=assigned(html,'__INITIAL_STATE__');
  const note=state?.note?.noteDetailMap?.[id]?.note || state?.noteData?.data?.noteData || state?.noteData?.data?.note;
  if(!note || (note.noteId || note.id)!==id || typeof note.desc!=='string' || !note.desc.trim()) return null;
  return {url:'https://www.xiaohongshu.com/explore/'+id,text:note.desc.trim(),reading:'extracted',kind:'note-text'};
}
export async function readPublicPost(href,{signal,request=fetch}={}) {
  const timeout=AbortSignal.timeout(6500);
  const deadline=signal?AbortSignal.any([signal,timeout]):timeout;
  try{
    let u=new URL(href); const platform=family(u.hostname);
    if(!platform) return null;
    const allowed=x=>['http:','https:'].includes(x.protocol) && !x.username && !x.password && !x.port && family(x.hostname)===platform;
    if(!allowed(u)) return null;
    let expected=postId(u,platform);
    if(!expected && !['xhslink.cn','xhslink.com','v.douyin.com'].includes(u.hostname)) return null;
    for(let n=0;n<5;n++){
      deadline.throwIfAborted();
      if(!allowed(u) || /\/(?:404|login|captcha|verify)(?:\/|$)/i.test(u.pathname))return null;
      u.protocol='https:'; const current=postId(u,platform);
      if(current && expected && current!==expected)return null;
      expected ||= current;
      if(platform==='douyin' && current)u=new URL('https://jingxuan.douyin.com/m/video/'+current);
      const r=await request(u,{redirect:'manual',credentials:'omit',headers:{'user-agent':mobile,'accept':'text/html','accept-language':'zh-CN,zh;q=0.9'},signal:deadline});
      if(r.status>=300 && r.status<400){await r.body?.cancel();const loc=r.headers.get('location');if(!loc)return null;u=new URL(loc,u);continue;}
      if(!r.ok || !current || !/text\/html/i.test(r.headers.get('content-type')||'')){await r.body?.cancel();return null;}
      const chunks=[];let bytes=0;
      for await(const chunk of r.body){bytes+=chunk.length;if(bytes>1800000)return null;chunks.push(chunk);}
      return publicPostSource(Buffer.concat(chunks).toString('utf8'),u.href);
    }
  } catch {signal?.throwIfAborted();}
  return null;
}
