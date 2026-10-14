import sharp from 'sharp';
import { extractImageContent } from './extractors/imageExtractor.js';

export async function prepareVisionInputs(
  messages,
  { readResource, detail = 'auto', signal, onObservation } = {},
) {
  const result = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      result.push(message);
      continue;
    }
    const content = [];
    for (const part of message.content) {
      if (part.type !== 'image_url') {
        content.push(part);
        continue;
      }
      signal?.throwIfAborted();
      const source = part.image_url?.url || '';
      if (
        source.startsWith('data:image/') &&
        !part.image_url.crop &&
        !part.image_url.ocr &&
        !part.image_url.role &&
        (!part.image_url.detail || part.image_url.detail === 'auto') &&
        detail === 'auto'
      ) {
        content.push(part);
        continue;
      }
      let buffer;
      const match = source.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s);
      if (match) buffer = Buffer.from(match[1], 'base64');
      else buffer = (await readResource?.(source, { signal, timeoutMs: 30000 }))?.buffer;
      if (!buffer?.length) throw new Error('图片内容无法读取，未将不可访问的本机链接发送给模型。');
      if (buffer.length > 20 * 1024 * 1024) throw new Error('图片超过 20 MB，请先压缩。');
      const selectedDetail = part.image_url.detail || detail;
      const metadata = await sharp(buffer, { limitInputPixels: 80_000_000 }).metadata();
      let pipeline = sharp(buffer, { limitInputPixels: 80_000_000 }).rotate();
      const crop = part.image_url.crop;
      if (crop) {
        const rotated = await pipeline.toBuffer({ resolveWithObject: true });
        const w = rotated.info.width,
          h = rotated.info.height;
        pipeline = sharp(rotated.data).extract({
          left: Math.floor((w * crop.x) / 100),
          top: Math.floor((h * crop.y) / 100),
          width: Math.max(1, Math.floor((w * crop.width) / 100)),
          height: Math.max(1, Math.floor((h * crop.height) / 100)),
        });
      }
      // Bound the payload without losing aspect ratio. Dense originals retain
      // more pixels than normal photos; the provider may apply its own limits.
      const max = selectedDetail === 'original' ? 5000 : 2560;
      const prepared = await pipeline
        .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${prepared.toString('base64')}`,
          detail: selectedDetail,
        },
      });
      if (part.image_url.role)
        content.push({ type: 'text', text: `上方参考图用途：${part.image_url.role}` });
      if (part.image_url.ocr) {
        const extracted = await extractImageContent(
          { url: `data:image/png;base64,${prepared.toString('base64')}` },
          { signal },
        );
        if (extracted?.text)
          content.push({
            type: 'text',
            text: `以下是实际 OCR 提取的文字，仅供与图片交叉核对，可能识别错误：\n${extracted.text}`,
          });
        onObservation?.({
          name: 'OCR 交叉核对',
          output: extracted?.text
            ? `提取 ${extracted.text.length} 字符；OCR 置信度 ${Number.isFinite(extracted.metadata?.confidence) ? Math.round(extracted.metadata.confidence) : '未提供'}，不代表视觉理解准确率`
            : '未提取到可用文字',
        });
      }
      onObservation?.({
        name: '图片输入准备',
        output: `原图 ${metadata.width} × ${metadata.height}${crop ? ' · 使用指定裁切区域' : ''} · 精度 ${selectedDetail}；图片准备完成不等于已验证理解正确`,
      });
    }
    result.push({ ...message, content });
  }
  return result;
}
