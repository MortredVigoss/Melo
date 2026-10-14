import sharp from 'sharp';
export async function normalizeAgentAvatar(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) throw new Error('头像必须是 1 MB 以内的 PNG、JPEG 或 WebP 图片。');
  const buffer = Buffer.from(value.split(',')[1], 'base64');
  if (buffer.length > 1024*1024) throw new Error('头像过大，请选择较小的图片。');
  try {
    const image = await sharp(buffer, {limitInputPixels:16_000_000}).rotate().resize(256,256,{fit:'cover'}).jpeg({quality:82}).toBuffer();
    return `data:image/jpeg;base64,${image.toString('base64')}`;
  } catch { throw new Error('无法读取头像，请选择有效图片。'); }
}
