// A site-qualified web_search may use the public HTML search index. Never
// silently forward a platform-only MCP query to a different provider.
const queryDomain = /(?:^|\s)site:(?:(?:www|jingxuan)\.)?(douyin\.com|xiaohongshu\.com|rednote\.com|xhslink\.(?:cn|com))(?=\/|\s|$)/i;
export const platformSite = query => queryDomain.exec(query)?.[1]?.toLowerCase();
export async function searchPublicIndex(query,limit,signal,request=fetch){
  const site=platformSite(query);if(!site)return [];
  const end=AbortSignal.timeout(5500),combined=signal?AbortSignal.any([signal,end]):end;
  let response;
  try{
    response=await request('https://html.duckduckgo.com/html/?q='+encodeURIComponent(query),{signal:combined,credentials:'omit',redirect:'error',headers:{'user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0 Safari/537.36'}});
    if(!response.ok){await response.body?.cancel();return [];}
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>650000)return [];chunks.push(chunk);}
    const {JSDOM}=await import('jsdom');const dom=new JSDOM(Buffer.concat(chunks).toString('utf8'));
    try{
      const results=[],seen=new Set();
      for(const a of dom.window.document.querySelectorAll('.result__a')){
        let url;try{url=new URL(a.getAttribute('href'),'https://html.duckduckgo.com');if(['duckduckgo.com','html.duckduckgo.com'].includes(url.hostname)&&url.pathname==='/l/')url=new URL(url.searchParams.get('uddg'));}catch{continue;}
        if(url.protocol!=='https:' || url.username || url.password || url.port || !(url.hostname===site || url.hostname.endsWith('.'+site)))continue;
        if(!(/\/video\/\d{8,25}(?:\/|$)|\/(?:explore|discovery\/item)\/[a-f0-9]{24}(?:\/|$)/i.test(url.pathname)||(/^xhslink\./.test(site)&&/^\/(?:o\/|a\/)?[a-z0-9]+\/?$/i.test(url.pathname))))continue;
        if(seen.has(url.href))continue;seen.add(url.href);
        results.push({title:a.textContent.trim().slice(0,300),url:url.href,snippet:(a.closest('.result')?.querySelector('.result__snippet')?.textContent||'').trim().slice(0,500)});
        if(results.length>=limit)break;
      }return results;
    }finally{dom.window.close();}
  }catch{signal?.throwIfAborted();return [];}
}
