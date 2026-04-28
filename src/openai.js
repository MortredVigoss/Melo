import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  getCodexCredential,
  resolveCodexExecutable,
} from './codexAuth.js';

const execFile = promisify(execFileCallback);
const DEFAULT_CODEX_CLI_TIMEOUT_MS = 600000;
const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 600000;
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 600000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120000;
const DEFAULT_CODEX_REASONING_EFFORT = 'medium';
const DEFAULT_CODEX_FAST_REASONING_EFFORT = 'low';
const DEFAULT_CODEX_TEXT_VERBOSITY = 'medium';
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_EVENT_TYPES = Object.freeze({
  OUTPUT_DELTA: 'response.output_text.delta',
  COMPLETED: 'response.completed',
  DONE: 'response.done',
  INCOMPLETE: 'response.incomplete',
  ERROR: 'error',
  FAILED: 'response.failed',
});
const DEFAULT_DISCOVERED_MODELS = Object.freeze({
  local: ['llama3.1'],
  'api-key': ['gpt-4.1', 'gpt-4.1-mini'],
  codex: ['gpt-5.5', 'gpt-4.1', 'gpt-4.1-mini'],
});
const CODEX_NATIVE_WEB_SEARCH_TOOL = Object.freeze({
  type: 'web_search',
  external_web_access: true,
});
const WEB_SEARCH_TRIGGER_RULES = Object.freeze([
  { pattern: /\b(latest|current|today's)\s+(news|price|stock|weather|score|update)s?\b/i, weight: 3 },
  { pattern: /\bwhat'?s\s+(happening|new)\b/i, weight: 3 },
  { pattern: /\bright\s+now\b/i, weight: 2 },
  { pattern: /\bstock\s+price\b/i, weight: 3 },
  { pattern: /\bweather\s+(forecast|in|at|today)\b/i, weight: 3 },
  { pattern: /\b(search|look up|find|google)\b/i, weight: 2 },
  { pattern: /最新(新闻|消息|价格|动态|行情|报道)/u, weight: 3 },
  { pattern: /(今天|现在|明天|这周)的?(天气|股价|新闻|头条|行情|温度|气温)/u, weight: 3 },
  { pattern: /(股价|股票|汇率|油价|金价)(是|多少|怎么样)/u, weight: 3 },
  { pattern: /查一?下.+?(的|最新|当前)/u, weight: 2 },
  { pattern: /(帮我|请)?(查|搜|搜索|搜一下|查一下|找一下)/u, weight: 2 },
  { pattern: /(天气|几度|多少度|下雨|气温|温度)/u, weight: 3 },
  { pattern: /(怎么去|在哪|地址|电话|营业时间|开放时间)/u, weight: 2 },
  { pattern: /(多少钱|价格|票价|费用|报价)/u, weight: 2 },
]);

// Runtime-extensible trigger list. The frozen defaults above ship with the
// app; users can add domain-specific triggers via `config.webSearchTriggers`
// without touching source. These are merged (not replaced) at check time, so
// extensions are purely additive — a user trigger can only raise the score,
// never suppress a default one.
let _extraWebSearchTriggers = [];

function compileTrigger(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const weight = Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : 1;
  const { pattern, flags } = entry;
  if (pattern instanceof RegExp) {
    return { pattern, weight };
  }
  if (typeof pattern === 'string' && pattern.trim()) {
    try {
      return { pattern: new RegExp(pattern, typeof flags === 'string' ? flags : 'iu'), weight };
    } catch {
      // Invalid regex from user config — drop silently; caller can enable
      // MELO_DEBUG=openai to surface the warning if needed.
      return null;
    }
  }
  return null;
}

export function registerWebSearchTriggers(entries = []) {
  if (!Array.isArray(entries)) return;
  _extraWebSearchTriggers = entries
    .map(compileTrigger)
    .filter(Boolean);
}

export function clearExtraWebSearchTriggers() {
  _extraWebSearchTriggers = [];
}
let keepAliveSetupPromise = null;
let ffmpegAvailabilityPromise = null;

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function withTimeoutSignal(timeoutMs, signal) {
  if (!signal) {
    return AbortSignal.timeout(timeoutMs);
  }

  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  controller.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', abort);
    },
    { once: true },
  );
  return controller.signal;
}

async function ensureFetchKeepAliveConfigured() {
  if (keepAliveSetupPromise) {
    return keepAliveSetupPromise;
  }

  keepAliveSetupPromise = (async () => {
    try {
      const { Agent, setGlobalDispatcher } = await import('undici');
      setGlobalDispatcher(
        new Agent({
          keepAliveTimeout: 30_000,
          keepAliveMaxTimeout: 300_000,
          connections: 32,
        }),
      );
      return true;
    } catch {
      return false;
    }
  })();

  return keepAliveSetupPromise;
}

function resolveStreamIdleTimeoutMs() {
  const configured = Number.parseInt(process.env.MELO_STREAM_IDLE_TIMEOUT_MS || '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

function isAbortError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error.name === 'AbortError' || error.code === 'ABORT_ERR'),
  );
}

function uniqueModels(models = [], currentModel = '') {
  return Array.from(
    new Set(
      [currentModel, ...(Array.isArray(models) ? models : [])]
        .map(value => String(value || '').trim())
        .filter(Boolean),
    ),
  );
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      return '';
    })
    .join('')
    .trim();
}

function extractChatCompletionsText(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;

  return normalizeMessageContent(content);
}

function extractResponsesText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  const parts = [];

  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (typeof content?.text === 'string' && content.text.trim()) {
        parts.push(content.text);
      } else if (
        content?.text &&
        typeof content.text === 'object' &&
        typeof content.text.value === 'string' &&
        content.text.value.trim()
      ) {
        parts.push(content.text.value);
      }
    }
  }

  return parts.join('\n').trim();
}

function extractAssistantText(payload) {
  const responseText = extractResponsesText(payload);
  if (responseText) {
    return responseText;
  }

  const chatText = extractChatCompletionsText(payload);
  if (chatText) {
    return chatText;
  }

  return 'Melo received an empty response from the model.';
}

function extractChatCompletionDelta(payload) {
  const delta = payload?.choices?.[0]?.delta;
  if (!delta) {
    return '';
  }

  if (typeof delta.content === 'string') {
    return delta.content;
  }

  if (!Array.isArray(delta.content)) {
    return '';
  }

  return delta.content
    .map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      if (item?.text && typeof item.text?.value === 'string') return item.text.value;
      return '';
    })
    .join('');
}

function extractProviderErrorMessage(payload, fallback = 'Provider request failed.') {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  return (
    payload?.error?.message ||
    payload?.message ||
    payload?.detail ||
    fallback
  );
}

function latestUserMessageText(messages = []) {
  const latestUserMessage = [...messages]
    .reverse()
    .find(message => String(message?.role || '').toLowerCase() === 'user');
  return normalizeMessageContent(latestUserMessage?.content || '');
}

function shouldEnableCodexNativeWebSearch(messages = []) {
  const latestUserText = latestUserMessageText(messages);
  if (!latestUserText) {
    return false;
  }

  let score = 0;
  for (const { pattern, weight } of WEB_SEARCH_TRIGGER_RULES) {
    if (pattern.test(latestUserText)) {
      score += weight;
      if (score >= 3) {
        return true;
      }
    }
  }
  // User-extensible trigger list — checked after defaults so a misconfigured
  // user entry cannot block the native web_search path when default triggers
  // already fired.
  for (const { pattern, weight } of _extraWebSearchTriggers) {
    if (pattern.test(latestUserText)) {
      score += weight;
      if (score >= 3) {
        return true;
      }
    }
  }

  return false;
}

function normalizeCodexReasoningEffort(rawValue) {
  const candidate = String(rawValue || '')
    .trim()
    .toLowerCase();

  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(candidate)
    ? candidate
    : DEFAULT_CODEX_REASONING_EFFORT;
}

function resolveFastCodexReasoningEffort(fallback = DEFAULT_CODEX_FAST_REASONING_EFFORT) {
  return normalizeCodexReasoningEffort(
    process.env.MELO_CODEX_FAST_REASONING_EFFORT || fallback,
  );
}

function resolveCodexCliTimeoutMs() {
  const configured = Number.parseInt(process.env.MELO_CODEX_TIMEOUT_MS || '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CODEX_CLI_TIMEOUT_MS;
}

function resolveCodexRequestTimeoutMs() {
  const configured = Number.parseInt(
    process.env.MELO_CODEX_REQUEST_TIMEOUT_MS ||
      process.env.MELO_CODEX_TIMEOUT_MS ||
      '',
    10,
  );

  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CODEX_REQUEST_TIMEOUT_MS;
}

function createCodexSessionId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `melo_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolveCodexResponsesEndpoint(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl || DEFAULT_CODEX_BASE_URL);

  if (normalized.endsWith('/codex/responses')) {
    return normalized;
  }

  if (normalized.endsWith('/codex')) {
    return `${normalized}/responses`;
  }

  return `${normalized}/codex/responses`;
}

function buildCodexResponsesHeaders({ accessToken, accountId, sessionId }) {
  return {
    authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': accountId,
    originator: 'pi',
    'user-agent': `pi (${platform()} ${release()}; ${arch()})`,
    'openai-beta': 'responses=experimental',
    accept: 'text/event-stream',
    'content-type': 'application/json',
    session_id: sessionId,
  };
}

function normalizeProviderMessageContent(content) {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) {
        parts.push({ type: 'text', text });
      }
      continue;
    }

    if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      parts.push({ type: 'text', text: item.text.trim() });
      continue;
    }

    if (
      item?.type === 'image_url' &&
      typeof item?.image_url?.url === 'string' &&
      item.image_url.url.trim()
    ) {
      parts.push({
        type: 'image_url',
        image_url: {
          url: item.image_url.url.trim(),
        },
      });
      continue;
    }

    // Preserve audio_attachment parts so resolveAudioAttachments can convert them
    // to input_audio (base64) asynchronously after normalization.
    if (item?.type === 'audio_attachment' && item.audio_attachment?.url) {
      parts.push(item);
    }
  }

  if (!parts.length) {
    return '';
  }

  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

function normalizeProviderMessages(messages = []) {
  return messages
    .map(message => ({
      role: message?.role,
      content: normalizeProviderMessageContent(message?.content),
    }))
    .filter(message => {
      if (message.role !== 'user' && message.role !== 'assistant') {
        return false;
      }
      return Boolean(normalizeMessageContent(message.content));
    });
}

function normalizeAttachmentUrl(url = '') {
  return String(url || '').trim();
}

function extractDataUrlMetadata(url = '') {
  const normalizedUrl = normalizeAttachmentUrl(url);
  const match = normalizedUrl.match(/^data:([^;,]+)?(?:;[^,]*)?,/i);
  return {
    mimeType: match?.[1]?.toLowerCase() || '',
    isDataUrl: normalizedUrl.startsWith('data:'),
  };
}

async function readAttachmentResource(url, { timeoutMs = 30000 } = {}) {
  const normalizedUrl = normalizeAttachmentUrl(url);
  if (!normalizedUrl) {
    return null;
  }

  if (normalizedUrl.startsWith('data:')) {
    const base64 = normalizedUrl.split(',')[1] || '';
    if (!base64) {
      return null;
    }
    return {
      buffer: Buffer.from(base64, 'base64'),
      contentType: extractDataUrlMetadata(normalizedUrl).mimeType,
    };
  }

  const response = await fetch(normalizedUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    return null;
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: String(response.headers.get('content-type') || '').toLowerCase(),
  };
}

async function readAttachmentBuffer(url, { timeoutMs = 30000 } = {}) {
  const resource = await readAttachmentResource(url, { timeoutMs });
  return resource?.buffer || null;
}

function inferAttachmentExtension({ mimeType = '', fileName = '', url = '' } = {}, fallback = 'bin') {
  const normalizedMime = String(mimeType || '').toLowerCase();
  if (normalizedMime.includes('wav')) return 'wav';
  if (normalizedMime.includes('mpeg') || normalizedMime.includes('mp3')) return 'mp3';
  if (normalizedMime.includes('ogg') || normalizedMime.includes('opus')) return 'ogg';
  if (normalizedMime.includes('webm')) return 'webm';
  if (normalizedMime.includes('mp4')) return 'mp4';
  if (normalizedMime.includes('quicktime')) return 'mov';

  const candidate = String(fileName || url || '');
  const match = candidate.match(/\.([a-z0-9]+)(?:$|[?#])/i);
  return match ? match[1].toLowerCase() : fallback;
}

// Resolve the audio format string ('wav', 'mp3', 'ogg', etc.) from an attachment descriptor.
function inferAudioFormat(attachment = {}) {
  const mime = String(attachment?.mimeType || '').toLowerCase();
  if (mime.includes('wav') || mime.includes('wave')) return 'wav';
  if (mime.includes('mp3') || mime.includes('mpeg')) return 'mp3';
  if (mime.includes('ogg') || mime.includes('vorbis') || mime.includes('opus')) return 'ogg';
  if (mime.includes('flac')) return 'flac';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('m4a') || mime.includes('aac') || mime.includes('mp4')) return 'mp4';
  const ext = inferAttachmentExtension(attachment, '');
  if (['wav', 'mp3', 'ogg', 'flac', 'webm', 'm4a', 'mp4'].includes(ext)) return ext;
  return 'wav';
}

// Converts all audio_attachment content parts to input_audio (base64 PCM/encoded)
// so the LLM can process the audio natively when the model supports it.
// For data: URLs the base64 is extracted directly; for https: URLs the file is fetched.
async function resolveAudioAttachments(messages = [], { signal } = {}) {
  const results = [];
  for (const message of messages) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) {
      results.push(message);
      continue;
    }

    const newContent = [];
    for (const part of message.content) {
      if (part?.type !== 'audio_attachment') {
        newContent.push(part);
        continue;
      }

      const url = String(part.audio_attachment?.url || '');
      if (!url) {
        continue;
      }

      let audioPart = null;

      if (/^data:audio\//i.test(url)) {
        // data: URL — extract base64 without a fetch
        const commaIdx = url.indexOf(',');
        if (commaIdx > 0) {
          const header = url.slice(0, commaIdx);
          const base64 = url.slice(commaIdx + 1);
          const fmtMatch = header.match(/data:audio\/([a-zA-Z0-9]+)/i);
          const format = fmtMatch ? fmtMatch[1].toLowerCase() : 'wav';
          audioPart = { type: 'input_audio', input_audio: { data: base64, format } };
        }
      } else if (/^https?:\/\//i.test(url)) {
        // Remote URL — fetch and base64-encode
        try {
          const buffer = await readAttachmentBuffer(url, { timeoutMs: 30000, signal });
          if (buffer && buffer.length) {
            const format = inferAudioFormat(part.audio_attachment);
            audioPart = { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format } };
          }
        } catch {
          // skip if fetch fails
        }
      }

      if (audioPart) {
        newContent.push(audioPart);
      }
    }

    // Collapse back to a plain string if only one text part remains
    const normalized =
      newContent.length === 1 && newContent[0]?.type === 'text'
        ? newContent[0].text
        : newContent;
    results.push({ ...message, content: normalized });
  }
  return results;
}

function inferCodexAudioFormat(attachment = {}) {
  const extension = inferAttachmentExtension(attachment, '');
  if (extension === 'wav') {
    return 'wav';
  }
  if (extension === 'mp3') {
    return 'mp3';
  }
  return '';
}

function inferImageMimeType(attachment = {}, contentType = '') {
  const normalizedContentType = String(contentType || '').toLowerCase();
  if (normalizedContentType.startsWith('image/')) {
    return normalizedContentType.split(';', 1)[0];
  }

  const normalizedMimeType = String(attachment?.mimeType || '').toLowerCase();
  if (normalizedMimeType.startsWith('image/')) {
    return normalizedMimeType.split(';', 1)[0];
  }

  const dataUrlMimeType = extractDataUrlMetadata(attachment?.url).mimeType;
  if (dataUrlMimeType.startsWith('image/')) {
    return dataUrlMimeType;
  }

  const extension = inferAttachmentExtension(attachment, '');
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'bmp') return 'image/bmp';
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'avif') return 'image/avif';
  return 'image/png';
}

async function buildCodexImageInputPart(item = {}) {
  const imageUrl = normalizeAttachmentUrl(item?.image_url?.url);
  if (!imageUrl) {
    return null;
  }

  if (imageUrl.startsWith('data:image/')) {
    return {
      type: 'input_image',
      image_url: imageUrl,
    };
  }

  const resource = await readAttachmentResource(imageUrl, { timeoutMs: 30000 });
  if (!resource?.buffer?.length) {
    return {
      type: 'input_image',
      image_url: imageUrl,
    };
  }

  const mimeType = inferImageMimeType({ url: imageUrl }, resource.contentType);
  return {
    type: 'input_image',
    image_url: `data:${mimeType};base64,${resource.buffer.toString('base64')}`,
  };
}

async function hasFfmpeg() {
  if (ffmpegAvailabilityPromise) {
    return ffmpegAvailabilityPromise;
  }

  ffmpegAvailabilityPromise = execFile('ffmpeg', ['-version'], {
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  })
    .then(() => true)
    .catch(() => false);

  return ffmpegAvailabilityPromise;
}

async function transcodeBufferToWav(buffer, attachment = {}, signal) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return null;
  }

  if (!(await hasFfmpeg())) {
    return null;
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'melo-codex-media-'));
  const inputExtension = inferAttachmentExtension(attachment, 'bin');
  const inputPath = join(tempDir, `input.${inputExtension}`);
  const outputPath = join(tempDir, 'output.wav');

  try {
    await writeFile(inputPath, buffer);
    await execFile(
      'ffmpeg',
      [
        '-i',
        inputPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        'wav',
        '-y',
        outputPath,
      ],
      {
        timeout: 120000,
        killSignal: 'SIGTERM',
        signal,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    return readFile(outputPath);
  } catch {
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildCodexAudioInputPart(attachment = {}, { signal, treatAsVideo = false } = {}) {
  const buffer = await readAttachmentBuffer(attachment?.url, {
    timeoutMs: treatAsVideo ? 60000 : 30000,
  });
  if (!buffer || !buffer.length) {
    return null;
  }

  let format = treatAsVideo ? '' : inferCodexAudioFormat(attachment);
  let audioBuffer = buffer;

  if (!format) {
    const transcoded = await transcodeBufferToWav(buffer, attachment, signal);
    if (!transcoded) {
      return null;
    }
    audioBuffer = transcoded;
    format = 'wav';
  }

  return {
    type: 'input_audio',
    input_audio: {
      data: audioBuffer.toString('base64'),
      format,
    },
  };
}

async function buildCodexUserContentParts(content, { signal } = {}) {
  const sourceParts = Array.isArray(content)
    ? content
    : typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : [];
  const parts = [];

  for (const item of sourceParts) {
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) {
        parts.push({ type: 'input_text', text });
      }
      continue;
    }

    if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      parts.push({ type: 'input_text', text: item.text.trim() });
      continue;
    }

    if (
      item?.type === 'image_url' &&
      typeof item?.image_url?.url === 'string' &&
      item.image_url.url.trim()
    ) {
      const imagePart = await buildCodexImageInputPart(item);
      if (imagePart) {
        parts.push(imagePart);
      }
      continue;
    }

    if (item?.type === 'audio_attachment') {
      // The Codex/ChatGPT responses endpoint rejects input_audio content parts.
      // Transcript context is already injected as a separate text part upstream
      // (see resolveAudioAttachments / transcript-injection in the bot and chat
      // pipelines), so we silently drop the raw audio part here instead of
      // emitting a redundant "[Audio attachment: …]" placeholder that would
      // confuse the model.
      continue;
    }

    if (item?.type === 'video_attachment') {
      continue;
    }
  }

  return parts;
}

function buildCodexAssistantContentParts(content) {
  const text = normalizeMessageContent(content);
  if (!text) {
    return [];
  }

  return [
    {
      type: 'output_text',
      text,
      annotations: [],
    },
  ];
}

export async function buildCodexResponsesInput(messages = [], { signal } = {}) {
  const results = [];

  for (const message of messages) {
    if (message?.role !== 'user' && message?.role !== 'assistant') {
      continue;
    }

    if (message.role === 'assistant') {
      const content = buildCodexAssistantContentParts(message.content);
      if (!content.length) {
        continue;
      }

      results.push({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content,
      });
      continue;
    }

    const content = await buildCodexUserContentParts(message.content, { signal });
    if (!content.length) {
      continue;
    }

    results.push({
      role: 'user',
      content,
    });
  }

  return results;
}

function parseCodexSseEvent(block) {
  const lines = block
    .split(/\r?\n/)
    .map(line => line.trimEnd());
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function parseChatCompletionsSseEvent(block) {
  const lines = block
    .split(/\r?\n/)
    .map(line => line.trimEnd());
  const dataLines = lines
    .filter(line => line && !line.startsWith(':'))
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart());

  if (!dataLines.length) {
    return null;
  }

  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function extractCodexEventError(event) {
  if (!event || typeof event !== 'object') {
    return 'Codex OAuth request failed.';
  }

  if (event.type === 'error') {
    return event.message || event.code || 'Codex OAuth request failed.';
  }

  if (event.type === 'response.failed') {
    return (
      event.response?.error?.message ||
      event.response?.incomplete_details?.reason ||
      'Codex response failed.'
    );
  }

  return 'Codex OAuth request failed.';
}

function isCodexReasoningDeltaEvent(eventType = '') {
  const normalized = String(eventType || '').trim();
  if (!normalized) {
    return false;
  }

  return (
    /^response\.reasoning(?:[\w.]*?)\.delta$/u.test(normalized) ||
    /^response\.reasoning(?:[\w.]*?)\.summary(?:[\w.]*?)\.delta$/u.test(normalized) ||
    /^response\.reasoning_summary(?:[\w.]*?)\.delta$/u.test(normalized)
  );
}

function extractCodexReasoningDelta(event) {
  if (!event || typeof event !== 'object') {
    return '';
  }

  if (typeof event.delta === 'string') {
    return event.delta;
  }

  if (typeof event.text === 'string') {
    return event.text;
  }

  if (typeof event.summary === 'string') {
    return event.summary;
  }

  if (event?.text && typeof event.text?.value === 'string') {
    return event.text.value;
  }

  return '';
}

async function cleanupReader(reader) {
  try {
    await reader.cancel();
  } catch {}

  try {
    reader.releaseLock();
  } catch {}
}

function buildStreamStalledError(idleTimeoutMs) {
  return new Error(
    `Model stopped producing output for ${Math.round(
      idleTimeoutMs / 1000,
    )} seconds. The request was cancelled because the stream stalled, not because the task was too long.`,
  );
}

async function drainSseBuffer(buffer, onBlock, { includeTrailing = false } = {}) {
  let remaining = buffer;

  while (true) {
    const separatorIndex = remaining.search(/\r?\n\r?\n/);
    if (separatorIndex === -1) {
      break;
    }

    const separatorLength = remaining.startsWith('\r\n\r\n', separatorIndex) ? 4 : 2;
    const block = remaining.slice(0, separatorIndex);
    remaining = remaining.slice(separatorIndex + separatorLength);
    await onBlock(block);
  }

  if (includeTrailing && remaining.trim()) {
    await onBlock(remaining);
    remaining = '';
  }

  return remaining;
}

async function readSseStream(
  response,
  {
    missingBodyMessage,
    idleTimeoutMs = resolveStreamIdleTimeoutMs(),
    processEventBlock,
  },
) {
  if (!response.body) {
    throw new Error(missingBodyMessage);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastActivityAt = Date.now();
  let stalled = false;
  let normalCompletion = false;
  const stallChecker = setInterval(() => {
    if (Date.now() - lastActivityAt > idleTimeoutMs) {
      stalled = true;
      void reader.cancel().catch(() => {});
      clearInterval(stallChecker);
    }
  }, 5000);
  stallChecker.unref?.();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        normalCompletion = true;
        break;
      }

      lastActivityAt = Date.now();
      buffer += decoder.decode(value, { stream: true });
      buffer = await drainSseBuffer(buffer, processEventBlock);
    }

    buffer += decoder.decode();
    buffer = await drainSseBuffer(buffer, processEventBlock, { includeTrailing: true });
  } catch (error) {
    if (stalled && !normalCompletion) {
      throw buildStreamStalledError(idleTimeoutMs);
    }
    throw error;
  } finally {
    clearInterval(stallChecker);
    await cleanupReader(reader);
  }
}

async function readCodexSseResponse(
  response,
  { onDelta, onReasoningDelta, idleTimeoutMs = resolveStreamIdleTimeoutMs() } = {},
) {
  let deltaText = '';
  let reasoningText = '';
  let completedResponse = null;

  const processEventBlock = async block => {
    const event = parseCodexSseEvent(block);
    if (!event) {
      return;
    }

    if (
      event.type === CODEX_EVENT_TYPES.OUTPUT_DELTA &&
      typeof event.delta === 'string'
    ) {
      deltaText += event.delta;
      if (typeof onDelta === 'function') {
        await onDelta({
          delta: event.delta,
          text: deltaText,
        });
      }
      return;
    }

    if (isCodexReasoningDeltaEvent(event.type)) {
      const delta = extractCodexReasoningDelta(event);
      if (delta) {
        reasoningText += delta;
        if (typeof onReasoningDelta === 'function') {
          await onReasoningDelta({
            delta,
            text: reasoningText,
            eventType: event.type,
          });
        }
      }
      return;
    }

    if (
      event.type === CODEX_EVENT_TYPES.COMPLETED ||
      event.type === CODEX_EVENT_TYPES.DONE ||
      event.type === CODEX_EVENT_TYPES.INCOMPLETE
    ) {
      completedResponse = event.response || completedResponse;
      return;
    }

    if (
      event.type === CODEX_EVENT_TYPES.ERROR ||
      event.type === CODEX_EVENT_TYPES.FAILED
    ) {
      throw new Error(extractCodexEventError(event));
    }
  };

  await readSseStream(response, {
    missingBodyMessage: 'Codex OAuth request returned no response body.',
    idleTimeoutMs,
    processEventBlock,
  });

  const completedText = extractResponsesText(completedResponse);
  if (completedText) {
    return completedText;
  }

  if (deltaText.trim()) {
    return deltaText.trim();
  }

  throw new Error('Codex OAuth request completed without returning a final reply.');
}

async function readChatCompletionsSseResponse(
  response,
  { onDelta, idleTimeoutMs = resolveStreamIdleTimeoutMs() } = {},
) {
  let fullText = '';

  const processEventBlock = async block => {
    const event = parseChatCompletionsSseEvent(block);
    if (!event) {
      return;
    }

    if (event?.error) {
      throw new Error(extractProviderErrorMessage(event, 'Streaming provider request failed.'));
    }

    const delta = extractChatCompletionDelta(event);
    if (delta) {
      fullText += delta;
      if (typeof onDelta === 'function') {
        await onDelta({
          delta,
          text: fullText,
        });
      }
    }
  };

  await readSseStream(response, {
    missingBodyMessage: 'Streaming request returned no response body.',
    idleTimeoutMs,
    processEventBlock,
  });

  if (fullText.trim()) {
    return fullText.trim();
  }

  throw new Error('Streaming request completed without returning a final reply.');
}

async function readCodexErrorResponse(response) {
  const raw = (await response.text()).trim();
  if (!raw) {
    return `Codex OAuth request failed (${response.status} ${response.statusText}).`;
  }

  try {
    const payload = JSON.parse(raw);
    const message =
      payload?.error?.message ||
      payload?.message ||
      payload?.detail ||
      raw;
    return `Codex OAuth request failed (${response.status} ${response.statusText}): ${message}`;
  } catch {
    return `Codex OAuth request failed (${response.status} ${response.statusText}): ${raw}`;
  }
}

function buildCodexExecPrompt(systemPrompt, messages) {
  const transcript = messages
    .map(message => {
      const role = message?.role === 'assistant' ? 'Assistant' : 'User';
      const content = normalizeMessageContent(message?.content);
      if (!content) {
        return '';
      }

      return `${role}:\n${content}`;
    })
    .filter(Boolean)
    .join('\n\n');

  return [
    systemPrompt,
    '',
    'Continue this conversation and respond to the latest user message.',
    '',
    transcript,
  ].join('\n');
}

async function createCodexCliReply({ model, systemPrompt, messages, signal, onDelta }) {
  const tempDir = await mkdtemp(join(tmpdir(), 'melo-codex-'));
  const outputPath = join(tempDir, 'last-message.txt');
  const prompt = buildCodexExecPrompt(systemPrompt, messages);
  const codexExecutable = await resolveCodexExecutable();
  const reasoningEffort = normalizeCodexReasoningEffort(
    process.env.MELO_CODEX_REASONING_EFFORT,
  );
  const timeoutMs = resolveCodexCliTimeoutMs();

  try {
    await execFile(
      codexExecutable,
      [
        'exec',
        '-c',
        `model_reasoning_effort="${reasoningEffort}"`,
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--output-last-message',
        outputPath,
        ...(model ? ['--model', model] : []),
        prompt,
      ],
      {
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        signal,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const reply = (await readFile(outputPath, 'utf8')).trim();
    if (!reply) {
      throw new Error('Codex CLI completed without returning a final reply.');
    }

    if (typeof onDelta === 'function') {
      await onDelta({
        delta: reply,
        text: reply,
      });
    }

    return reply;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(
        'Codex CLI is not installed or not on PATH. Install Codex or switch Melo to API key mode.',
      );
    }

    if (error && typeof error === 'object' && error.killed && error.signal === 'SIGTERM') {
      throw new Error(
        `Codex CLI timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
      );
    }

    const details = [error?.stderr, error?.stdout, error?.message]
      .filter(value => typeof value === 'string' && value.trim())
      .join('\n')
      .trim();
    throw new Error(
      `Codex CLI request failed.${details ? `\n${details}` : ''}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function createCodexResponsesReply({
  baseUrl,
  model,
  systemPrompt,
  messages,
  signal,
  onDelta,
  onReasoningDelta,
  providerProfile = 'default',
}) {
  const credential = await getCodexCredential();
  if (!credential.loggedIn) {
    if (credential.expired) {
      throw new Error('Codex login has expired. Reconnect Codex OAuth inside Melo and retry.');
    }
    throw new Error('Codex login is not available. Reconnect Codex OAuth inside Melo and retry.');
  }

  if (!credential.accountId) {
    throw new Error('Codex login is missing the ChatGPT account id.');
  }

  const accessToken = credential.accessToken;
  const endpoint = resolveCodexResponsesEndpoint(baseUrl);
  const sessionId = createCodexSessionId();
  const timeoutMs = resolveCodexRequestTimeoutMs();
  const reasoningEffort = normalizeCodexReasoningEffort(
    process.env.MELO_CODEX_REASONING_EFFORT,
  );
  const isFastProfile = providerProfile === 'fast';
  const effectiveReasoningEffort = isFastProfile
    ? resolveFastCodexReasoningEffort(reasoningEffort)
    : reasoningEffort;
  const enableWebSearch = shouldEnableCodexNativeWebSearch(messages);
  const payload = {
    model,
    store: false,
    stream: true,
    instructions: systemPrompt,
    input: await buildCodexResponsesInput(messages, { signal }),
    text: { verbosity: isFastProfile ? 'low' : DEFAULT_CODEX_TEXT_VERBOSITY },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: sessionId,
    reasoning: {
      effort: effectiveReasoningEffort,
      summary: 'auto',
    },
    ...(enableWebSearch
      ? {
          tool_choice: 'auto',
          parallel_tool_calls: true,
          tools: [CODEX_NATIVE_WEB_SEARCH_TOOL],
        }
      : {}),
  };

  await ensureFetchKeepAliveConfigured();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: buildCodexResponsesHeaders({
      accessToken,
      accountId: credential.accountId,
      sessionId,
    }),
    body: JSON.stringify(payload),
    signal: withTimeoutSignal(timeoutMs, signal),
  });

  if (!response.ok) {
    throw new Error(await readCodexErrorResponse(response));
  }

  return readCodexSseResponse(response, { onDelta, onReasoningDelta });
}

export async function discoverAvailableModels({
  authMode,
  apiKey,
  baseUrl,
  model,
}) {
  if (authMode === 'codex') {
    return uniqueModels(DEFAULT_DISCOVERED_MODELS.codex, model);
  }

  const normalizedUrl = normalizeBaseUrl(baseUrl || '');
  if (!normalizedUrl) {
    return uniqueModels(DEFAULT_DISCOVERED_MODELS[authMode] || [], model);
  }

  await ensureFetchKeepAliveConfigured();
  const response = await fetch(`${normalizedUrl}/models`, {
    method: 'GET',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Model discovery failed (${response.status} ${response.statusText}): ${errorText}`,
    );
  }

  const payload = await response.json();
  const discovered = Array.isArray(payload?.data)
    ? payload.data
        .map(item => String(item?.id || '').trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
    : [];

  return uniqueModels(
    discovered.length ? discovered : DEFAULT_DISCOVERED_MODELS[authMode] || [],
    model,
  );
}

export async function createOpenAICompatibleReply({
  authMode,
  apiKey,
  baseUrl,
  model,
  systemPrompt,
  messages,
  signal,
  onDelta,
  onReasoningDelta,
  providerProfile = 'default',
}) {
  if (process.env.MELO_MOCK_RESPONSE) {
    const mockReply = process.env.MELO_MOCK_RESPONSE;
    if (typeof onDelta === 'function') {
      const chunks = mockReply.match(/.{1,18}/g) || [mockReply];
      let text = '';
      for (const chunk of chunks) {
        text += chunk;
        await onDelta({
          delta: chunk,
          text,
        });
      }
    }
    return mockReply;
  }

  if (authMode === 'codex') {
    try {
      return await createCodexResponsesReply({
        baseUrl,
        model,
        systemPrompt,
        messages,
        signal,
        onDelta,
        onReasoningDelta,
        providerProfile,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (process.env.MELO_CODEX_ENABLE_CLI_FALLBACK !== '1') {
        throw error;
      }

      return createCodexCliReply({
        model,
        systemPrompt,
        messages,
        signal,
        onDelta,
      });
    }
  }

  if (authMode !== 'local' && !apiKey) {
    throw new Error(
      'No API key configured. Set MELO_API_KEY, OPENAI_API_KEY, or run `melo config set apiKey ...`.',
    );
  }

  if (!normalizeBaseUrl(baseUrl)) {
    throw new Error('No base URL configured. Open Model settings and set a valid endpoint first.');
  }

  const endpoint = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  // Resolve audio_attachment parts to input_audio (base64) so models that support
  // native audio input (e.g. GPT-4o Audio, local multimodal models) can process them
  // directly instead of requiring Whisper transcription.
  const resolvedMessages = await resolveAudioAttachments(normalizeProviderMessages(messages), { signal });
  const payload = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...resolvedMessages,
    ],
    ...(typeof onDelta === 'function' ? { stream: true } : {}),
  };

  await ensureFetchKeepAliveConfigured();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: withTimeoutSignal(DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS, signal),
  });

  if (!response.ok) {
    const rawError = await response.text();
    let message = rawError;
    try {
      const payload = JSON.parse(rawError);
      message = extractProviderErrorMessage(payload, rawError);
    } catch {}
    throw new Error(
      `Provider request failed (${response.status} ${response.statusText}): ${message}`,
    );
  }

  const responseType = response.headers.get('content-type') || '';
  if (typeof onDelta === 'function' && responseType.includes('text/event-stream')) {
    return readChatCompletionsSseResponse(response, { onDelta });
  }

  const json = await response.json();
  const assistantText = extractAssistantText(json);
  if (typeof onDelta === 'function') {
    await onDelta({
      delta: assistantText,
      text: assistantText,
    });
  }
  return assistantText;
}
