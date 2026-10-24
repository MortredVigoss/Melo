import { resolvedModelCapabilities } from '../../shared/agent/modelCapabilities.js';
import { DEFAULT_CHAT_MODEL, PROVIDER_DEFAULTS } from '../shared/modelCatalog.js';

// Output sizes offered on both clients. gpt-image-2 accepts edges that are
// multiples of 16 below 3840 px; above 2560x1440 is experimental (OpenAI guide).
// Mirrored by ImageTaskPlan.sizes on the phone.
export const IMAGE_SIZES = Object.freeze(['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2560x1440', '1440x2560', '2816x2816', '3824x2144', '2144x3824']);
export function imageSettings(config = {}) {
  const source = config.imageSettings || {};
  const legacyEngine = ['auto', 'codex'].includes(config.imageEngine)
    ? 'codex-oauth'
    : config.imageEngine;
  return {
    engine: source.engine || legacyEngine || 'codex-oauth',
    profileId: source.profileId || '',
    model: source.model || PROVIDER_DEFAULTS.media.image,
    codexModel:
      source.codexModel || (config.authMode === 'codex' ? config.model : '') || DEFAULT_CHAT_MODEL,
    visionProfileId: source.visionProfileId || '',
    detail: ['auto', 'high', 'original'].includes(source.detail) ? source.detail : 'auto',
    quality: ['auto', 'low', 'medium', 'high'].includes(source.quality) ? source.quality : 'high',
    size: IMAGE_SIZES.includes(source.size)
      ? source.size
      : 'auto',
    previews: source.previews === true,
    inspectEdits: source.inspectEdits === true,
  };
}
export function imageConnection(config, settings = imageSettings(config)) {
  if (settings.engine !== 'openai-api') return null;
  const profile = config.llmProfiles?.[settings.profileId];
  if (
    !profile ||
    profile.authMode !== 'api-key' ||
    profile.apiProtocol === 'anthropic' ||
    !profile.apiKey
  ) {
    throw new Error('请在图像设置中选择已保存的 OpenAI Images 兼容 API 连接。');
  }
  if (resolvedModelCapabilities(profile, settings.model).imageGen === false) throw Object.assign(new Error('This model is configured without image generation. Choose another image model.'), {code:'MODEL_IMAGE_GENERATION_DISABLED'});
  return { ...profile, model: settings.model };
}
export function visionConnection(config, fallback = {}) {
  const id = imageSettings(config).visionProfileId;
  if (!id)
    return { ...config, ...fallback, model: fallback.model || config.model || DEFAULT_CHAT_MODEL };
  const profile = config.llmProfiles?.[id];
  if (!profile) throw new Error('选择的视觉模型连接已不存在，请重新选择。');
  return { ...config, ...profile, activeLlmProfileId: id };
}
export function validateImageTask(value) {
  if (value == null) return null;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['auto', 'analyze', 'generate', 'edit'].includes(value.action)
  )
    throw new Error('图片任务类型无效。');
  const count = value.count == null ? 1 : Number(value.count);
  if (!Number.isInteger(count) || count < 1 || count > 20)
    throw new Error('单次图片任务可生成 1–20 张；超过时请分批提交。');
  if (
    value.mask &&
    (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.mask) ||
      value.mask.length > 12 * 1024 * 1024)
  )
    throw new Error('遮罩必须是有效 PNG，且不超过 8 MB。');
  const references = (value.references || []).map((ref) => {
    if (
      !ref ||
      typeof ref.attachmentId !== 'string' ||
      !['subject', 'style', 'composition', 'reference'].includes(ref.role)
    )
      throw new Error('图片参考角色无效。');
    const crop = ref.crop;
    if (
      crop &&
      (!['x', 'y', 'width', 'height'].every((k) => Number.isFinite(crop[k])) ||
        crop.x < 0 ||
        crop.y < 0 ||
        crop.width <= 0 ||
        crop.height <= 0 ||
        crop.x + crop.width > 100 ||
        crop.y + crop.height > 100)
    )
      throw new Error('裁切区域必须在图片范围内。');
    return { attachmentId: ref.attachmentId, role: ref.role, ...(crop ? { crop } : {}) };
  });
  if (references.length > 16) throw new Error('最多支持 16 张参考图。');
  return {
    action: value.action,
    ...(value.action === 'auto' && value.count == null ? {} : { count }),
    references,
    detail: ['auto', 'high', 'original'].includes(value.detail) ? value.detail : 'auto',
    ocr: value.ocr === true,
    inspect: value.inspect === true,
    ...(value.separately === true ? { separately: true } : {}),
    ...(value.mask ? { mask: value.mask } : {}),
    ...(typeof value.retryOf === 'string' ? { retryOf: value.retryOf.slice(0, 128) } : {}),
  };
}
