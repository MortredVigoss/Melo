import {PUBLIC_MEDIA_SERVER} from '../../shared/agent/media/publicPlatforms.js';
export const socialPresets = Object.freeze({
  'melo-xiaohongshu': {
    platform: 'xiaohongshu', flag: 'enableXiaohongshuMcp', repo: 'xpzouying/xiaohongshu-mcp', tag: 'v2.7.2',
    description: '小红书 · 搜索笔记，打开详情和评论。', tools: ['search_feeds','get_feed_detail'],
    hashes: { 'darwin-arm64':'e3068363fc4d6572d1e4cf2aeccda7e1d37844191aa8ce0944706f73700a4130', 'linux-amd64':'269a79a48d7310f6a2ef015f6b835af4300ae6cbfe8eb254237c3006a05869fc', 'windows-amd64.exe':'1f62e1fe137d0293595197b3a76e280e4114293b425e9c4082a334d1f7fb5316' },
  },
  'melo-douyin': {
    platform: 'douyin', flag: 'enableDouyinMcp', repo: 'yunsur/douyin-mcp', tag: 'v0.1.0',
    description: '抖音 · 搜索作品，阅读描述和评论。', tools: ['search_videos','get_video_detail','get_video_comments'],
    hashes: { 'darwin-arm64':'6ce2e0cfbc1ef787c23f4e6eae50aa09431d8ac01baca10b2ba9ce7e6764aa43','darwin-amd64':'65eb5a32b6b2ff17f0a6292a505f0c11d266fc1e5c509b9992e3f5c021d136d0','linux-amd64':'55ba8fea01c2c5c4d8ac2fb5c7a53e514c19bc963568630cc452c1c52683c410','linux-arm64':'c1f892ee987f7db41834bd4fc5ff453273cde4b6c418109b097cd33cde4296df','windows-amd64.exe':'0795584ff1343ff3d6c963a23ec2098b96cc9cea7bfd73eac4c33149b9963134' },
  },
});
export const socialIds = Object.freeze(Object.keys(socialPresets));
export function socialSpec(id) { return Object.hasOwn(socialPresets,id) ? socialPresets[id] : null; }

// One-time backfill, never continuously union defaults onto a user's edits.
export const SOCIAL_READER_VERSION=2;
export function addSocialReads(profile,previousVersion=0) {
  const additions=previousVersion<1 ? [...socialIds,PUBLIC_MEDIA_SERVER] : [PUBLIC_MEDIA_SERVER];
  const merge = ids => [...new Set([...(ids || []), ...additions])];
  return { ...profile, enabledMcpServerIds: merge(profile.enabledMcpServerIds),
    ...(profile.capabilities ? {capabilities:{...profile.capabilities, mcpServers:merge(profile.capabilities.mcpServers)}} : {}) };
}
