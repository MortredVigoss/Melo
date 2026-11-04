import {mediaPlatformForHost} from '../../../shared/agent/media/publicPlatforms.js';

const paths = {
  instagram: /^\/(?:[^/]+\/)?(?:p|reels?)\/([\w-]+)\/?$/,
  vimeo: /^\/(?:video\/)?(\d+)(?:\/[\da-f]+)?\/?$/,
  bilibili: /^\/video\/(BV[\da-zA-Z]+|av\d+)\/?$/,
  tiktok: /^\/(?:@[\w.-]+\/(?:video|photo)|v)\/(\d+)(?:\.html)?\/?$/,
  x: /^\/(?:[\w]+|i\/web)\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/,
  facebook: /^\/(?:reels?|videos?|[^/]+\/videos)\/(?:[^/]+\/)?(\d+)\/?$/,
  weibo: /^\/(?:\d+\/detail\/|\d+\/|detail\/|status\/|tv\/show\/)([\w:-]+)\/?$/,
  qqvideo: /^\/x\/(?:cover\/[^/]+\/|page\/)([a-zA-Z0-9]+)\.html$/,
  kuaishou: /^\/(?:short-video|fw\/photo|f|@[^/]+\/video)\/([\w-]+)\/?$/,
};

export function mediaLink(input) {
  let url;
  try { url=new URL(input); } catch { return null; }
  if (!['http:','https:'].includes(url.protocol) || url.port || url.username || url.password) return null;
  const kwaiShare=/^[a-z0-9-]+\.m\.chenzhongtech\.com$/.test(url.hostname);
  const platform=mediaPlatformForHost(kwaiShare?'kuaishou.com':url.hostname);
  if (!platform) return null;
  url.protocol='https:';
  url.hash='';
  const {id:family}=platform;
  let id;
  if (family==='youtube') {
    id=url.pathname==='/watch' ? url.searchParams.get('v') :
      (url.hostname==='youtu.be' ? /^\/([\w-]+)\/?$/ : /^\/(?:shorts|live|embed)\/([\w-]+)\/?$/).exec(url.pathname)?.[1];
    if (!/^[\w-]{11}$/.test(id || '')) return null;
    url=new URL('https://www.youtube.com/watch?v='+id);
  } else {
    id=paths[family].exec(url.pathname)?.[1];
    if(family==='facebook' && /^\/(?:watch\/?|video\.php)$/.test(url.pathname)) {
      const video=url.searchParams.get('v');
      if (/^\d+$/.test(video || '')) id=video;
    }
    if (!id) {
      const shortHost=['b23.tv','vm.tiktok.com','vt.tiktok.com','v.kuaishou.com','fb.watch'].includes(url.hostname);
      const shortPath=family==='tiktok' && /^\/t\/[\w-]+\/?$/.test(url.pathname);
      if (!(shortHost && /^\/[\w-]+\/?$/.test(url.pathname)) && !shortPath) return null;
      return {platform,id:null,url:url.href};
    }
  }
  return {platform,id,url:url.href};
}
