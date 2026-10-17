// Image identity and delivery belong to the saved turn, not to an expiring
// presentation URL or a shortened scene label.
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import sharp from 'sharp';
import { readExecutionScene } from './executionScenes.js';
import { IMAGE_FOLLOW_UP_PATTERN, shouldCarryForwardRecentMedia } from './messageBuilder.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { requestIdentity } from '../../runtime/requestContext.js';
import { normalizeMessageBlocks } from '../../domain/message/messageBlocks.js';
import { refreshChatMemorySummary } from '../../memory/chatThreadContext.js';
import { inferImageTask } from './imageTask.js';
import { requestsPhotoAdjustment } from '../../shared/imageRequestIntent.js';
import { hydrateAttachments } from '../../media/attachments.js';

export async function imageFollowUpAttachments({ chat, content, attachments, imageTask, home }) {
  if (attachments.some(a => a.kind === 'image') || imageTask?.action === 'generate' || imageTask?.retryOf) return attachments;
  if (inferImageTask(content, [], imageTask)?.action === 'generate') return attachments;
  const adjustment = requestsPhotoAdjustment(content || '') && inferImageTask(content,
    [{role:'user',content:[{type:'image_url'}]}],imageTask)?.action === 'edit';
  if (imageTask?.action !== 'edit' && !adjustment && !IMAGE_FOLLOW_UP_PATTERN.test(content || '')) return attachments;
  const recent = (chat.messages || []).slice(-4);
  for (let i = recent.length - 1; i >= 0; i--) {
    const message = recent[i];
    if (message.role === 'user' && message.attachments?.some(a => a.kind === 'image')) {
      // A newer upload takes precedence over older generated results.
      // Externalized uploads are read back inline so extraction and the
      // persisted snapshot see the same bytes as a fresh upload.
      return shouldCarryForwardRecentMedia([...recent, {role:'user',content}], recent.length, i) || imageTask?.action === 'edit' || adjustment
        ? [...attachments, ...await hydrateAttachments(message.attachments.filter(a => a.kind === 'image'), { home })]
        : attachments;
    }
    if (message.role !== 'assistant' || !message.metadata?.runId) continue;
    const scene = await readExecutionScene(home, message.metadata.runId);
    if (!scene || scene.chatId !== chat.id || scene.messageId !== message.id) continue;
    const images = (scene.selectedImageIds || []).map(id => scene.artifacts.find(a => a.id === id && a.kind === 'image')).filter(Boolean);
    if (!images.length) continue;
    const restored = [];
    for (const image of images) {
      // Only a server-recorded artifact from this chat is eligible. Never fetch
      // arbitrary URLs or decode a client-provided signed-path parameter.
      if (!image.path?.startsWith('/')) throw new Error('上一张成果没有可读取的本地文件，请重新附加图片。');
      let file;
      try {
        file = await open(image.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid image artifact');
        const bytes = await sharp(await file.readFile(), {limitInputPixels:80_000_000}).rotate().png().toBuffer();
        restored.push({id:image.id,kind:'image',label:image.title || '上一张成果',url:`data:image/png;base64,${bytes.toString('base64')}`});
      } catch {
        throw new Error('上一张成果已无法读取，请重新附加图片；不会退回更早的原图。');
      } finally { await file?.close(); }
    }
    // Keep a self-contained input snapshot for later retry, like an upload.
    return [...attachments, ...restored];
  }
  return attachments;
}

export function restoreImageRetry(chat, task) {
  const source = chat.messages.find(m => m.role === 'user' && m.metadata?.runId === task.retryOf);
  if (!source) throw new Error('原图像任务不可用，请重新附加图片。');
  return {content:source.content, attachments:source.attachments || [],
    imageTask:{...(source.metadata?.imageTask || task),count:task.count,retryOf:task.retryOf}};
}

export async function persistResolvedImageTask(context, task) {
  await updateStateAtomically(state => {
    const message = state.chats.find(c => c.id === context.chatId)?.messages.find(m => m.role === 'user' && m.metadata?.runId === context.runId);
    if (!message) throw new Error('原图像请求已不存在。');
    message.metadata.imageTask = task;
  }, {home:context.home});
}

export async function persistImageProgress(context, {artifacts, count}, agent) {
  let message;
  await updateStateAtomically(state => {
    const chat = state.chats.find(c => c.id === context.chatId);
    if (!chat) throw new Error('Chat no longer exists.');
    message = chat.messages.find(m => m.role === 'assistant' && m.metadata?.runId === context.runId);
    const content = [...artifacts.map(a => `![${a.title}](${a.url})`),`已成功生成 ${artifacts.length}/${count} 张。`,'已生成图片已保存。'].join('\n\n');
    if (!message) {
      message = {id:`image-reply-${context.runId}`,role:'assistant',createdAt:new Date().toISOString(),metadata:{...requestIdentity(context),agent}};
      chat.messages.push(message);
    }
    Object.assign(message,{content,blocks:normalizeMessageBlocks([],content),attachments:artifacts.map(a=>({id:a.id,kind:'image',url:a.url,label:a.title}))});
    message.metadata.imageDelivery = {status:'running',count,generated:artifacts.length};
    const run = state.chatRuns?.find(r => r.runId === context.runId);
    if (run) run.assistantMessageId = message.id;
    chat.updatedAt = new Date().toISOString();
    refreshChatMemorySummary(chat);
  }, {home:context.home});
  return message;
}

export async function finishPartialImageReply(context, status) {
  let message;
  await updateStateAtomically(state => {
    const chat = state.chats.find(c => c.id === context.chatId);
    message = chat?.messages.find(m => m.role === 'assistant' && m.metadata?.runId === context.runId && m.metadata?.imageDelivery?.status === 'running');
    if (!message) return;
    message.metadata.imageDelivery.status = status;
    message.content = message.content.replace('已生成图片已保存。', status === 'cancelled'
      ? '已停止剩余生成或核对，已生成图片保留。'
      : '后续生成或核对中断，已生成图片保留。');
    message.blocks = normalizeMessageBlocks([],message.content);
    refreshChatMemorySummary(chat);
  }, {home:context.home});
  return message;
}
