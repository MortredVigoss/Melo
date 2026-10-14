import { buildImagePromptText } from './imagePrompts.js';
import sharp from 'sharp';
import { normalizeLlmBaseUrl } from '../shared/llmProviders.js';

export async function generateApiImage({
  connection,
  prompt,
  images = [],
  mask,
  action = images.length ? 'edit' : 'generate',
  referenceRoles = images.map(image => image.role || 'reference'),
  quality = 'auto',
  size = 'auto',
  previews = false,
  signal,
  onPreview,
  fetchImpl = fetch,
}) {
  const visualBrief = buildImagePromptText({ userPrompt: prompt, action, referenceRoles, masked: !!mask });
  const base = normalizeLlmBaseUrl(connection.baseUrl);
  if (!connection.apiKey || !connection.model) throw new Error('图像 API 缺少密钥或模型。');
  let body,
    headers = { Authorization: `Bearer ${connection.apiKey}` };
  if (mask) {
    if (!images.length) throw new Error('局部编辑必须提供原图。');
    const a = await sharp(images[0].buffer).metadata(),
      b = await sharp(mask).metadata();
    if (a.width !== b.width || a.height !== b.height || !b.hasAlpha || b.format !== 'png')
      throw new Error('遮罩必须与第一张原图同尺寸，并包含透明通道。');
  }
  const options = { model: connection.model, prompt: visualBrief, n: 1, quality, size };
  if (previews) Object.assign(options, { stream: true, partial_images: 2 });
  if (images.length) {
    body = new FormData();
    for (const [k, v] of Object.entries(options)) body.append(k, String(v));
    for (const [i, img] of images.entries())
      body.append(
        'image[]',
        new Blob([img.buffer], { type: img.mimeType }),
        `reference-${i + 1}.png`,
      );
    if (mask) body.append('mask', new Blob([mask], { type: 'image/png' }), 'mask.png');
  } else {
    body = JSON.stringify(options);
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetchImpl(`${base}/images/${images.length ? 'edits' : 'generations'}`, {
    method: 'POST',
    headers,
    body,
    redirect: 'error',
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(180000)]),
  });
  if (!response.ok) {
    const text = (await response.text()).split(connection.apiKey).join('[redacted]').slice(0, 600);
    throw new Error(`图像 API 请求失败 (${response.status})：${text}`);
  }
  let encoded,
    usage,
    reportedModel = '';
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let pending = '',
      bytes = 0;
    const consume = async (block) => {
      const raw = block
        .split('\n')
        .filter((s) => s.startsWith('data:'))
        .map((s) => s.slice(5).trim())
        .join('\n');
      if (!raw || raw === '[DONE]') return;
      const e = JSON.parse(raw);
      if (e.type === 'error' || e.error)
        throw new Error(
          `图像生成失败：${String(e.error?.message || e.message || '供应商错误').slice(0, 300)}`,
        );
      if (/^(image_generation|image_edit)\.partial_image$/.test(e.type) && e.b64_json)
        await onPreview?.(e.b64_json, e.partial_image_index);
      if (/^(image_generation|image_edit)\.completed$/.test(e.type)) {
        encoded = e.b64_json;
        usage = e.usage;
        reportedModel = e.model || '';
      }
    };
    try {
      while (true) {
        signal?.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 64 * 1024 * 1024) throw new Error('图像流超过容量限制。');
        pending += decoder.decode(value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(pending))) {
          const block = pending.slice(0, match.index);
          pending = pending.slice(match.index + match[0].length);
          await consume(block);
        }
      }
      pending += decoder.decode();
      if (pending.trim()) await consume(pending);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    const data = await response.json();
    encoded = data.data?.[0]?.b64_json;
    usage = data.usage;
    reportedModel = data.model || '';
  }
  if (!encoded) throw new Error('服务未返回完整图像；中间预览不会作为最终成果。');
  signal?.throwIfAborted();
  const buffer = await sharp(Buffer.from(encoded, 'base64'), { limitInputPixels: 80_000_000 })
    .png()
    .toBuffer();
  return { buffer, mimeType: 'image/png', requestedModel: connection.model, reportedModel, usage };
}
