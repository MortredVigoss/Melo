import { mediaPlatformForHost } from './publicPlatforms.js';

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

function queryValue(query,key) {
  for(const entry of query.split('&')){
    const split=entry.indexOf('=');
    if(split>0 && entry.slice(0,split)===key){
      try{return decodeURIComponent(entry.slice(split+1));}catch{return null;}
    }
  }
  return null;
}
// JavaScriptCore and the Android JS engine need no browser URL globals.
export function mediaPostRef(input) {
  const match=/^https?:\/\/([a-z0-9.-]+)(?::(443|80))?(\/[^?#\s]*)?(?:\?([^#\s]*))?(?:#[^\s]*)?$/i.exec(String(input||''));
  if(!match)return null;
  if(match[2] && match[2]!==(/^https:/i.test(input)?'443':'80'))return null;
  const host=match[1].toLowerCase(),path=match[3]||'/',query=match[4]||'';
  const kwaiShare=/^[a-z0-9-]+\.m\.chenzhongtech\.com$/.test(host);
  const platform=mediaPlatformForHost(kwaiShare?'kuaishou.com':host);
  if (!platform) return null;
  const {id:family}=platform;
  let id;
  if (family==='youtube') {
    id=path==='/watch' ? queryValue(query,'v') :
      (host==='youtu.be' ? /^\/([\w-]+)\/?$/ : /^\/(?:shorts|live|embed)\/([\w-]+)\/?$/).exec(path)?.[1];
    if (!/^[\w-]{11}$/.test(id || '')) return null;
  } else {
    id=paths[family].exec(path)?.[1];
    if(family==='facebook' && /^\/(?:watch\/?|video\.php)$/.test(path)) {
      const video=queryValue(query,'v');
      if (/^\d+$/.test(video || '')) id=video;
    }
    if (!id) {
      const shortHost=['b23.tv','vm.tiktok.com','vt.tiktok.com','v.kuaishou.com','fb.watch'].includes(host);
      const shortPath=family==='tiktok' && /^\/t\/[\w-]+\/?$/.test(path);
      if (!(shortHost && /^\/[\w-]+\/?$/.test(path)) && !shortPath) return null;
      return {platform,id:null};
    }
  }
  return {platform,id};
}
