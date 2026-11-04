// Public media hosts recognized by Melo's video-link detector. The desktop
// index and the portable planner use the same names and preferred domains.
export const PUBLIC_MEDIA_SERVER = 'melo-public-media';
export const MEDIA_PLATFORMS = Object.freeze([
  {id:'instagram', site:'instagram.com', hosts:['www.instagram.com','instagram.com'], names:/instagram|(?:^|[^a-z])ig(?:$|[^a-z])/i},
  {id:'youtube', site:'youtube.com', hosts:['www.youtube.com','youtube.com','m.youtube.com','youtu.be'], names:/youtube|youtu\.be|油管/i},
  {id:'vimeo', site:'vimeo.com', hosts:['www.vimeo.com','vimeo.com','player.vimeo.com'], names:/vimeo/i},
  {id:'bilibili', site:'bilibili.com', hosts:['www.bilibili.com','bilibili.com','m.bilibili.com','b23.tv'], names:/bilibili|哔哩哔哩|B站/i},
  {id:'tiktok', site:'tiktok.com', hosts:['www.tiktok.com','tiktok.com','m.tiktok.com','vm.tiktok.com','vt.tiktok.com'], names:/tiktok/i},
  {id:'x', site:'x.com', hosts:['x.com','www.x.com','twitter.com','www.twitter.com','mobile.twitter.com'], names:/twitter|推特|(?:^|[^a-z])x\.com|(?:在|上|用)\s*X\s*(?:上|搜|找|查)|\bon x\b/i},
  {id:'facebook', site:'facebook.com', hosts:['facebook.com','www.facebook.com','m.facebook.com','fb.watch'], names:/facebook|脸书|臉書|\bfb\b/i},
  {id:'weibo', site:'weibo.com', hosts:['weibo.com','www.weibo.com','m.weibo.cn','weibo.cn'], names:/weibo|微博/i},
  {id:'qqvideo', site:'v.qq.com', hosts:['v.qq.com','m.v.qq.com'], names:/v\.qq\.com|腾讯视频|騰訊視頻/i},
  {id:'kuaishou', site:'kuaishou.com', hosts:['kuaishou.com','www.kuaishou.com','v.kuaishou.com','www.kwai.com','kwai.com'], names:/kuaishou|kwai|快手/i},
]);
export function mediaPlatformInText(text) {
  return MEDIA_PLATFORMS.find(platform=>platform.names.test(text));
}
export function mediaPlatformForHost(host) {
  return MEDIA_PLATFORMS.find(platform=>platform.hosts.includes(host));
}
