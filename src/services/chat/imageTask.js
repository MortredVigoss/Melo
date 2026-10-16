import { validateImagePrompt, IMAGE_REVIEW_INSTRUCTIONS, parseImageReview, formatImageReview } from '../../images/imagePrompts.js';
import sharp from 'sharp';
import { requestsPhotoAdjustment, requestsNaturalImage, asksAboutImage, instructsImageChange, requestsReferenceImage } from '../../shared/imageRequestIntent.js';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  imageSettings,
  imageConnection,
  visionConnection,
  validateImageTask,
} from '../../images/imageSettings.js';
import { generateApiImage } from '../../images/openaiImageEngine.js';
import { generateImageViaCodex, editImageViaCodex } from '../../images/codexImageEngine.js';
import { generateImageViaMinimax } from '../../images/imageGen.js';
import { saveImageArtifact } from '../../images/imageArtifacts.js';
import { requestedImageCount } from '../../shared/executionScene.js';
import { resolveImageBytes, findLatestUserText } from './imageEditFastPath.js';
import { detectImageEditIntent, IMAGE_FOLLOW_UP_PATTERN } from './messageBuilder.js';
import { createOpenAICompatibleReply } from '../../openai.js';
import { maskQuotedText } from '../../retrieval/requestPolicy.js';

export function inferImageTask(text, messages, explicit) {
  if (explicit?.action === 'analyze') return validateImageTask(explicit);
  const instruction = maskQuotedText(text);
  // Discussing a workflow or declining execution must not spend image quota.
  // An explicit analysis route also bypasses the legacy edit shortcut.
  if (
    imageExecutionDeclined(instruction) ||
    /^(?:请|帮我)?(?:解释|说明|讲讲)|^(?:如何|怎么|为什么)|(?:对比度|饱和度|曝光|亮度).{0,16}(?:有什么|会怎样|会怎么样|的原理)|(?:画|绘制|生成|做).{0,60}(?:的代码|的提示词)|\b(?:how|why)\b.{0,50}\b(?:contrast|saturation|exposure|brightness)|\b(?:in|as)\s+(?:svg|css|html)(?:\s+code)?\b/iu.test(instruction) ||
    /(?:生成|绘制|编辑|生图)[^，。；!?;\n]{0,20}(?:的代码|要怎么|要如何|教程)|^(?:请|帮我|给我)?(?:写|生成|提供)[^，。；!?;\n]{0,25}提示词(?:$|[，。；!?;：:\n])|\b(?:create|write|generate)\s+(?:an?\s+)?(?:image\s+)?(?:prompt|tutorial|code)\b|^(?:如何|怎么|how\s+(?:to|do|can))[^\n]{0,40}(?:生成|编辑|生图|generate|edit|draw)/iu.test(instruction)
  ) {
    return validateImageTask({ action: 'analyze' });
  }
  if (explicit && explicit.action !== 'auto')
    return validateImageTask({ ...explicit, count: explicit.count ?? requestedImageCount(text) });
  const hasImage = messages.some(
    (m) =>
      m.role === 'user' &&
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === 'image_url'),
  );
  const affirmative = instruction.split(/[，。；！？,;!?\n]/).filter(clause => !/(?:不要|不用|不必|无需|禁止|别)|\b(?:do not|don't|never)\b/iu.test(clause)).join('，');
  const taskFor = action => validateImageTask({ ...explicit, action, count: explicit?.count ?? requestedImageCount(text), references: explicit?.references ?? [] });
  const generationRequested = requestsNaturalImage(affirmative) || requestsReferenceImage(affirmative) ||
    /^(?:请|帮我|给我|麻烦|你|请帮我)*\s*(?:生成|画|绘制|制作|做)[^。！？\n]{0,100}(?:图片|图像|插画|海报|照片|张图|幅图)|^(?:please\s+)?(?:generate|draw|create)\s+(?:an?\s+|\d+\s+)?(?:images?|pictures?|illustrations?|photos?)\b/i.test(
      instruction,
    );
  // A photo on this message plus an instruction is an edit however it is phrased.
  const latestUser = [...messages].reverse().find(m => m.role === 'user');
  const attachedNow = Array.isArray(latestUser?.content) && latestUser.content.some(p => p.type === 'image_url');
  const uploadedInstruction = attachedNow && !asksAboutImage(instruction) && instructsImageChange(affirmative) && !generationRequested;
  if (hasImage && ((detectImageEditIntent(affirmative) && IMAGE_FOLLOW_UP_PATTERN.test(affirmative)) || requestsPhotoAdjustment(affirmative) || uploadedInstruction))
    return taskFor('edit');
  if (generationRequested)
    return taskFor('generate');
  return explicit?.action === 'auto' ? taskFor('analyze') : null;
}

function imageExecutionDeclined(instruction) {
  const clauses = instruction.split(/[，。；！？,;!?\n]/);
  return clauses.some(clause => {
    const match = clause.match(/(?:不要|不用|不必|无需|禁止|别)\s*(?:实际|真的|真正|立即|现在)?\s*(?:生成|绘制|画|修改|编辑)(.*)$|\b(?:do not|don't|never)\s+(?:actually\s+)?(?:generate|draw|edit|modify)\b(.*)$/iu);
    if (!match) return false;
    const object = (match[1] ?? match[2] ?? '').trim();
    // A task-level prohibition has no object, or names the whole image.
    // "不要修改人物的脸" / "do not draw text" are local constraints.
    return !object || /^(?:了|出来|任何图片|(?:这|那|原)?(?:张)?(?:图片|图像|照片|海报|插画|图))(?:了|出来)?$|^(?:(?:an?|any|the|this|that)\s+)?(?:images?|pictures?|photos?|posters?)(?:\s+at all)?\.?$/iu.test(object);
  });
}

// A failed generation is reported and never silently retried on another paid
// service. Each saved artifact belongs to one actual request, including partial
// success. Reopening the scene only reads these observations.
export async function runImageTask({
  task,
  config,
  messages,
  attachments = [],
  workspace,
  signal,
  sseEmitter,
  onDelta,
  onImageProgress,
  selectedModel,
  home,
  dependencies = {},
}) {
  if (!task || task.action === 'analyze') return null;
  task = validateImageTask(task);
  const prompt = validateImagePrompt(findLatestUserText(messages));
  const settings = imageSettings(config),
    engine = settings.engine;
  if (!workspace?.rootPath) throw new Error('图像任务需要可写的聊天工作空间。');
  const api = engine === 'openai-api' ? imageConnection(config, settings) : null;
  if (task.mask && engine !== 'openai-api')
    throw new Error(
      '当前生图通道未开放局部遮罩。请在图像设置中选择支持编辑的图像 API，再提交本次局部修改。',
    );
  if (task.action === 'edit' && !['codex-oauth', 'openai-api'].includes(engine))
    throw new Error('当前引擎仅接入文生图，请选择 Codex OAuth 或图像 API 进行编辑。');
  let latest = messages
      .filter(
        (m) =>
          m.role === 'user' &&
          Array.isArray(m.content) &&
          m.content.some((p) => p.type === 'image_url'),
      )
      .at(-1),
    inputs = (Array.isArray(latest?.content) ? latest.content : []).filter(
      (p) => p.type === 'image_url',
    );
  if (task.action === 'generate')
    inputs = attachments
      .filter((a) => a.kind === 'image')
      .map((a) => ({ type: 'image_url', image_url: { url: a.url }, role: 'reference' }));
  if (task.references.length) {
    const roles = new Map(task.references.map((ref) => [ref.attachmentId, ref.role]));
    if (task.references.some((ref) => !attachments.some((a) => a.id === ref.attachmentId)))
      throw new Error('参考图片已被移除，请重新选择图片用途。');
    inputs = attachments
      .filter((a) => a.kind === 'image')
      .map((a) => ({
        type: 'image_url',
        image_url: { url: a.url },
        role: roles.get(a.id) || 'reference',
      }));
  }
  if (inputs.length && !['codex-oauth', 'openai-api'].includes(engine))
    throw new Error('当前引擎未接入参考图，请选择 Codex OAuth 或图像 API。');
  const images = [];
  for (const part of inputs) {
    const resolved = await resolveImageBytes(part.image_url?.url);
    if (!resolved) throw new Error('参考图无法安全读取，请重新附加原图。');
    images.push({
      buffer: await sharp(resolved.bytes, { limitInputPixels: 80_000_000 })
        .rotate()
        .png()
        .toBuffer(),
      mimeType: 'image/png',
      role: part.role || 'reference',
    });
  }
  if (task.action === 'edit' && !images.length) throw new Error('编辑图片需要附加至少一张原图。');
  const referenceRoles = images.map(image => image.role);
  const requestModel =
    api?.model ||
    (engine === 'codex-oauth'
      ? settings.codexModel
      : engine === 'minimax'
        ? 'image-01'
        : '本地配置模型');
  const emit = (e) => {
    try {
      sseEmitter?.('execution_event', e);
    } catch {}
  };
  emit({
    kind: 'image-task',
    task: { action: task.action, count: task.count, engine, model: requestModel },
  });
  let before;
  if (images.length)
    before = await saveImageArtifact(workspace.rootPath, images[0].buffer, {
      prefix: 'reference',
      signal,
    });
  const links = [],
    artifacts = [],
    failures = [],
    reviews = [];
  for (let index = 0; index < task.count; index++) {
    signal?.throwIfAborted();
    const id = `image-${randomUUID()}`;
    const observe = (status, extra = {}) =>
      emit({
        kind: 'operation',
        id,
        module: 'create',
        name: task.action === 'edit' ? 'image_edit' : 'image',
        provider: engine,
        status,
        input: `第 ${index + 1}/${task.count} 张 · 请求模型：${requestModel}`,
        ...extra,
      });
    const onPreview = async (encoded, frame) => {
      signal?.throwIfAborted();
      try {
        const saved = await saveImageArtifact(workspace.rootPath, Buffer.from(encoded, 'base64'), {
          prefix: 'preview',
          signal,
        });
        emit({ kind: 'preview', id, url: saved.url, path: saved.path, index: frame });
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    };
    observe('running');
    let generated = false;
    try {
      let result;
      if (engine === 'openai-api')
        result = await (dependencies.api || generateApiImage)({
          connection: api,
          action: task.action,
          referenceRoles,
          prompt,
          images,
          mask: task.mask ? Buffer.from(task.mask.split(',')[1], 'base64') : null,
          quality: settings.quality,
          size: settings.size,
          previews: settings.previews,
          signal,
          onPreview,
        });
      else if (engine === 'codex-oauth') {
        if (images.length)
          result = await (dependencies.edit || editImageViaCodex)({
            prompt,
            sourceImageBytes: images[0].buffer,
            sourceImageMime: images[0].mimeType,
            referenceImages: images.slice(1),
            referenceRoles,
            action: task.action,
            model: requestModel,
            quality: settings.quality,
            signal,
            onPreview,
            onStage: (e) => emit({ kind: 'pipeline', ...e, id: `${id}:${e.id}` }),
          });
        else
          result = await (dependencies.generate || generateImageViaCodex)({
            prompt,
            model: requestModel,
            quality: settings.quality,
            signal,
            onPreview,
          });
      } else if (engine === 'minimax')
        result = await (dependencies.minimax || generateImageViaMinimax)({
          prompt,
          apiKey: config.minimaxApiKey,
          groupId: config.minimaxGroupId,
          signal,
        });
      else if (engine === 'sdcpp') {
        const { generateWithSdcpp } = await import('../../images/sdcppEngine.js');
        await mkdir(join(workspace.rootPath, 'generated'), { recursive: true });
        const local = await generateWithSdcpp({
          prompt,
          config,
          homeDir: home,
          outputPath: join(workspace.rootPath, 'generated', `local-${randomUUID()}.png`),
          signal,
        });
        result = { ...local, buffer: await readFile(local.path), reportedModel: local.model };
      } else throw new Error('未知生图引擎，请重新选择。');
      signal?.throwIfAborted();
      const saved = await saveImageArtifact(workspace.rootPath, result.buffer, { signal });
      const artifact = {
        id: `artifact-${id}`,
        kind: 'image',
        url: saved.url,
        path: saved.path,
        title: `${task.action === 'edit' ? '编辑' : '生成'}图片 ${index + 1}`,
        engine,
        requestedModel: requestModel,
        reportedModel: result.reportedModel || '',
        requestedQuality: settings.quality,
        reportedQuality: result.reportedQuality || '',
        ...(before ? { beforeUrl: before.url, beforePath: before.path } : {}),
      };
      generated = true;
      artifacts.push(artifact);
      links.push(`![${artifact.title}](${saved.url})`);
      observe('completed', {
        output: `已保存图片 · 请求模型：${requestModel} · 返回模型：${result.reportedModel || '服务未报告'} · 请求质量：${settings.quality} · 返回质量：${result.reportedQuality || '服务未报告'}`,
        artifacts: [artifact],
      });
      await onImageProgress?.({artifacts:[...artifacts],count:task.count});
      if (typeof onDelta === 'function')
        try {
          await onDelta({ delta: `\n\n${links.at(-1)}\n\n`, text: links.join('\n\n') });
        } catch {
          /* A detached UI cannot revoke a saved image. */
        }
      if (task.inspect || (task.action === 'edit' && settings.inspectEdits)) {
        const checkId = `${id}:inspect`;
        let vision;
        try {
          vision = visionConnection(config, { model: selectedModel || config.model });
        } catch {
          const note = `第 ${index + 1} 张未完成视觉核对：视觉连接不可用，已生成图片保留。`;
          reviews.push(note);
          emit({kind:'pipeline',id:checkId,name:'核对图片结果',status:'failed',output:note});
          continue;
        }
        emit({
          kind: 'pipeline',
          id: checkId,
          name: '核对图片结果',
          status: 'running',
          model: vision.model,
        });
        try {
          const report = await (dependencies.reply || createOpenAICompatibleReply)({
            ...vision,
            signal,
            workspacePath: null,
            nativeWebSearchEnabled: false,
            systemPrompt: IMAGE_REVIEW_INSTRUCTIONS,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: `${task.action === 'edit' ? '编辑' : '生成'}要求：${prompt}` },
                  ...images.flatMap((image, i) => [
                    {type:'text',text:`参考图 ${i + 1}，用途：${image.role}${i === 0 && task.action === 'edit' ? '（编辑原图）' : ''}`},
                    {type:'image_url',image_url:{url:`data:image/png;base64,${image.buffer.toString('base64')}`}},
                  ]),
                  {type:'text',text:'待核对的最终结果：'},
                  {
                    type: 'image_url',
                    image_url: { url: `data:image/png;base64,${saved.buffer.toString('base64')}` },
                  },
                ],
              },
            ],
          });
          const review = parseImageReview(report);
          const note = formatImageReview(review, index);
          reviews.push(note);
          emit({kind:'pipeline',id:checkId,name:'核对图片结果',status:'completed',output:note});
        } catch (error) {
          reviews.push(`第 ${index + 1} 张未完成视觉核对，已生成图片保留。`);
          emit({
            kind: 'pipeline',
            id: checkId,
            name: '核对图片结果',
            status: signal?.aborted ? 'cancelled' : 'failed',
            output: '核对未完成，已生成图片保留',
          });
          if (signal?.aborted) throw error;
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        if (!generated) observe('cancelled');
        throw error;
      }
      let message = String(error.message || error);
      for (const key of [config.apiKey, config.minimaxApiKey, api?.apiKey].filter(Boolean))
        message = message.split(key).join('[redacted]');
      message = message.slice(0, 500);
      failures.push(`第 ${index + 1} 张：${message}`);
      observe('failed', { output: message, errorCode: 'IMAGE_GENERATION_FAILED' });
    }
  }
  const reply = [...links, `已成功生成 ${links.length}/${task.count} 张。`, ...reviews, ...failures].join(
    '\n\n',
  );
  sseEmitter?.('reply_text', { text: reply, final: true });
  return reply;
}
