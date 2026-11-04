import {chromium} from 'playwright-core';
import {mediaLink} from './mediaPermalink.js';

let active = 0;
const allowedHosts = {
  instagram: /(^|\.)(instagram\.com|cdninstagram\.com|fbcdn\.net)$/,
  youtube: /(^|\.)(youtube\.com|ytimg\.com|gstatic\.com|googlevideo\.com)$/,
};

// Only an isolated, disposable browser may render public embeds. Page scripts
// cannot reach localhost or arbitrary destinations. No account profile is used.
async function inGuestBrowser(platform, signal, work) {
  if (active >= 2) return null;
  active++;
  let browser;
  const close = () => { browser?.close().catch(()=>{}); };
  try {
    signal.throwIfAborted();
    browser = await chromium.launch({channel:'chrome',headless:true,timeout:8000});
    signal.throwIfAborted();
    signal.addEventListener('abort',close,{once:true});
    const page = await browser.newPage({locale:'en-US',serviceWorkers:'block'});
    await page.route('**/*', route => {
      const req=route.request(), url=new URL(req.url());
      const readMethod=['GET','HEAD'].includes(req.method()) ||
        (req.method()==='POST' && (platform==='instagram' && url.hostname==='www.instagram.com' && /^\/(?:api\/)?graphql\/?/.test(url.pathname)
        || platform==='youtube' && url.hostname==='www.youtube.com' && /^\/youtubei\/v1\/(?:get_transcript|player|next|browse|get_panel|get_engagement_panel)$/.test(url.pathname)));
      if (url.protocol!=='https:' || url.port || !allowedHosts[platform].test(url.hostname) || !readMethod ||
        req.resourceType()==='media' || url.hostname.endsWith('googlevideo.com')) return route.abort();
      return route.continue();
    });
    return await work(page);
  } catch { signal.throwIfAborted(); return null; }
  finally {
    signal.removeEventListener('abort',close);
    try { await browser?.close(); } finally { active--; }
  }
}
export function instagramCaption(link,signal) {
  return inGuestBrowser('instagram',signal,async page=>{
    await page.goto('https://www.instagram.com/p/'+link.id+'/embed/captioned/',{waitUntil:'domcontentloaded',timeout:10000});
    await page.locator('.Caption').first().waitFor({state:'attached',timeout:6500});
    const data=await page.evaluate(()=>{
      const caption=document.querySelector('.Caption')?.cloneNode(true);
      if (!caption) return null;
      caption.querySelectorAll('.CaptionUsername,button').forEach(el=>el.remove());
      caption.querySelectorAll('br').forEach(el=>el.replaceWith('\n'));
      return {url:document.querySelector('a.EmbeddedMedia')?.href,text:caption.textContent.trim()};
    });
    if(new URL(page.url()).origin!=='https://www.instagram.com' || mediaLink(data?.url)?.id!==link.id || !data?.text) return null;
    return {url:link.url,text:data.text,kind:'author-caption',reading:'partial'};
  });
}
export function youtubeSubtitles(link,signal) {
  return inGuestBrowser('youtube',signal,async page=>{
    await page.goto(link.url+'&hl=en',{waitUntil:'domcontentloaded',timeout:10000});
    const expand=page.locator('#description-inline-expander #expand').first();
    await expand.click({timeout:3500}).catch(()=>{});
    await page.getByRole('button',{name:/show transcript/i}).first().click({timeout:4500});
    const segments=page.locator('[target-id*="transcript"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"] transcript-segment-view-model [role="text"],ytd-transcript-segment-renderer .segment-text');
    await segments.first().waitFor({state:'attached',timeout:6500});
    const canonical=await page.locator('link[rel=canonical]').first().getAttribute('href');
    if(mediaLink(page.url())?.id!==link.id || mediaLink(canonical)?.id!==link.id)return null;
    const text=(await segments.allTextContents()).map(s=>s.trim()).filter(Boolean).join('\n');
    return text?{url:link.url,text,kind:'subtitles',reading:'partial'}:null;
  });
}

export function instagramProfilePosts(handle,keywords,signal) {
  if(!/^[a-z0-9_.]{1,30}$/i.test(handle))return [];
  return inGuestBrowser('instagram',signal,async page=>{
    const path='/'+handle+'/';
    await page.goto('https://www.instagram.com'+path,{waitUntil:'domcontentloaded',timeout:11000});
    const cards=page.locator('main a[href*="/p/"],main a[href*="/reel/"]');
    await cards.first().waitFor({state:'attached',timeout:6500});
    const current=new URL(page.url());
    if(current.origin!=='https://www.instagram.com' || current.pathname.toLowerCase()!==path.toLowerCase())return [];
    const rows=await cards.evaluateAll(nodes=>nodes.slice(0,36).map(n=>({url:n.href,title:n.querySelector('img')?.alt || n.innerText || ''})));
    const terms=keywords.toLowerCase().split(/\s+/).filter(Boolean);
    const found=new Map();
    for(const row of rows){
      const post=mediaLink(row.url);
      if(post?.platform.id!=='instagram' || !new URL(row.url).pathname.toLowerCase().startsWith(path.toLowerCase()))continue;
      if(terms.length && !terms.every(term=>row.title.toLowerCase().includes(term)))continue;
      found.set(post.id,{url:post.url,title:row.title.slice(0,300) || '@'+handle,snippet:''});
    }
    return [...found.values()].slice(0,6);
  });
}
