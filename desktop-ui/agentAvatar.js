import { ui } from './i18n.js';
export function renderAgentAvatar(agent, escape, size=32) {
  const data=agent?.avatarData;
  size = [22,24,28,32,40,88].includes(size) ? size : 32;
  return typeof data==='string' && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data) && data.length<500000
    ? ui`<img class="agent-photo" src="${escape(data)}" width="${size}" height="${size}" alt="${escape(agent.name||'Agent')}头像">`
    : `<span class="agent-photo agent-photo-fallback" data-avatar-size="${size}" aria-hidden="true">${escape((agent?.name||'M').slice(0,1))}</span>`;
}
export async function readAgentAvatar(file) {
  if (!file || file.size>20*1024*1024 || !/^image\/(?:png|jpeg|webp)$/.test(file.type)) throw new Error('请选择 20 MB 以内的 PNG、JPEG 或 WebP 图片。');
  const url=URL.createObjectURL(file);
  try {
    const img=new Image();img.src=url;await img.decode();
    const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
    const context=canvas.getContext('2d'),scale=Math.max(256/img.naturalWidth,256/img.naturalHeight);
    context.drawImage(img,(256-img.naturalWidth*scale)/2,(256-img.naturalHeight*scale)/2,img.naturalWidth*scale,img.naturalHeight*scale);
    return canvas.toDataURL('image/jpeg',.82);
  } finally { URL.revokeObjectURL(url); }
}
