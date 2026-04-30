import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import {
  getCodexCredential,
  resolveCodexExecutable,
} from './codexAuth.js';
import { signWorkspaceFileUrl } from './web/urlSigning.js';
import { detectImageMimeFromBytes } from './images/imageGen.js';

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
  // codex auth mode → ChatGPT-internal API names (5.x sibling fallback).
  // api-key auth mode → OpenAI platform API names (4.x). See
  // DEFAULT_MODEL_CATALOGS in src/config.js for the rationale.
  codex: ['gpt-5.5', 'gpt-5.4', 'gpt-4.1'],
});
const CODEX_NATIVE_WEB_SEARCH_TOOL = Object.freeze({
  type: 'web_search',
  external_web_access: true,
});

// Inline image generation through the chat stream (Codex OAuth only).
// When the active chat has a workspace path, we add this tool to the
// `/codex/responses` payload so the model can call `image_generation`
// mid-reply. The SSE handler decodes the resulting base64 result, writes
// it into <workspace>/generated/img-…png, and injects a signed-URL
// markdown link (`\n\n![generated image](url)\n\n`) into the streamed
// reply. Downstream the URL → attachment promotion in
// extractUrlAttachmentsFromText (sendChatMessage) picks up the .png
// extension and produces an inline image attachment on the assistant
// message — no caller-side wiring required.
//
// Why through the streamed text and not a separate callback channel?
//   • Streaming naturally interleaves the model's prose with the image,
//     matching how the user reads the reply ("Here's a cat: <image>").
//   • TTS / quote / re-render passes already strip URLs from text so
//     speech and search are unaffected.
//   • One code path serves desktop + Telegram + Discord — every channel
//     already respects markdown image URLs in assistant messages.
// The single image_generation tool config we send to /codex/responses.
//
// Earlier cuts also tried `{ type: 'image_generation', input_fidelity:
// 'high' }` for the edit case (uploaded image + edit prompt) so Codex
// would preserve original details. The Codex backend rejected the
// request — input_fidelity is part of OpenAI's standard Responses API
// schema but the chatgpt.com /codex/responses proxy strips it. The
// standalone codexImageEngine.js learned the same lesson: it ALSO only
// sends input_fidelity when the caller explicitly opts in, never as
// the default. So this constant is the single, simplest config that
// Codex actually accepts; edit-mode behaviour now relies on the
// instructions block + the fact that gpt-image's image_generation tool
// natively reads the conversation's input_image parts as references.
const CODEX_NATIVE_IMAGE_GENERATION_TOOL = Object.freeze({
  type: 'image_generation',
});

// Appended to `instructions` when the conversation has an input_image AND
// inline image generation is enabled. The default Codex behaviour, when
// it sees "edit this screenshot" + a context image, is to fall back to
// "I need a file path" — because nothing tells it the image_generation
// tool can reference conversation input_image parts directly. This block
// states the contract explicitly.
//
// Phrased aggressively (explicit "DO NOT") because the failure mode is
// chronic: the model has years of training data telling it "to edit a
// file you read it first", and a soft hint won't override that prior.
//
// User decision (2026-04-30): the conversation may keep historical
// images across turns ("第 2 轮 '再改一下头发' 应该用刚才那张图"). The
// instruction therefore lists explicit edit verbs but ALSO has an
// equally explicit pass-through clause for non-edit turns ("画一张新图",
// plain text Q&A) — so a stale historical image doesn't poison
// unrelated turns. With input_fidelity unavailable on Codex, the
// pass-through depends entirely on the model's own intent reading
// (these EXCEPTIONS lines below) and gpt-image's default behaviour
// of ignoring reference images that don't match the prompt.
const CODEX_INLINE_IMAGE_EDIT_INSTRUCTION = [
  'INLINE IMAGE EDITING:',
  'The conversation carries one or more uploaded images as input_image parts.',
  'When the user is asking to edit, modify, change, fix, replace, recolor, retouch,',
  'translate, annotate, or otherwise update one of those images, you MUST call the',
  'built-in image_generation tool directly. The tool reads the conversation input_image',
  'as the edit reference automatically — you do not need to fetch, read, or locate the',
  'file yourself. DO NOT ask the user for a file path. DO NOT call read_file or any',
  'filesystem tool. DO NOT reply with text-only instructions ("please save this file',
  "and tell me the path\"). Just emit a short edit prompt to image_generation and the",
  'host app will display the result inline. If multiple images are attached, edit the',
  'most recently uploaded one unless the user specifies otherwise.',
  // Explicit pass-through. Required because the conversation may carry
  // a stale uploaded image from earlier turns; this block must not push
  // the model into edit-mode for unrelated follow-ups.
  'EXCEPTIONS — treat this section as inactive when the user is:',
  '(a) asking for a brand-new image unrelated to anything they uploaded',
  '("draw a fresh cat", "画一张新图"); answer with image_generation but do',
  'NOT base the result on any historical reference image. Or',
  '(b) asking a plain question that has nothing to do with images;',
  'just answer normally without invoking image_generation at all.',
].join(' ');

// Returns true when any user-role message in the array carries an
// image_url content part (with a non-empty URL). Used to decide whether
// to flip the inline image_generation tool into edit mode + append the
// edit-mode instruction block. Exported for tests so the detection rule
// can be pinned independently of the createCodexResponsesReply pipeline.
export function messagesHaveInputImages(messages) {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (message?.role !== 'user') continue;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (
        item?.type === 'image_url' &&
        typeof item?.image_url?.url === 'string' &&
        item.image_url.url.trim()
      ) {
        return true;
      }
    }
  }
  return false;
}

// Exported for tests: lets the unit suite assert payload-tool gating
// without faking the whole credential / fetch round trip. Returned in
// the same insertion order createCodexResponsesReply uses (web_search
// then image_generation) so a snapshot-style test can also assert
// stable ordering of the `tools` array sent to /codex/responses.
//
// `hasInputImage` is accepted for API symmetry with messagesHaveInputImages
// upstream, but no longer changes the tool config — the chatgpt.com
// /codex/responses proxy rejects every variant we tried (input_fidelity,
// background-only, etc.) other than the bare `{ type: 'image_generation' }`.
// The `hasInputImage` flag is still meaningful for INSTRUCTIONS-level
// gating (whether to append the edit-mode block) and stays plumbed in
// case a future Codex-side schema change re-opens edit-tool variants.
//
// DESIGN INTENT (user 2026-04-29): inline image is gated **only** by
// the existence of a writable workspace path. It is NOT additionally
// gated by an agent's allowedTools / sub-agent privilege whitelist —
// the user's product call is that Codex Plus's native image_generation
// is a free server-side capability (parallel to web_search) and should
// be available in every chat / every agent / every sub-agent. When this
// invariant changes (e.g. a non-Codex provider or a paid-per-image
// tier shows up), the gate moves into THIS helper rather than into the
// caller chain.
export function buildCodexResponsesTools({
  enableWebSearch = false,
  workspacePath = null,
  hasInputImage: _hasInputImage = false,
} = {}) {
  const tools = [];
  if (enableWebSearch) tools.push(CODEX_NATIVE_WEB_SEARCH_TOOL);
  if (typeof workspacePath === 'string' && workspacePath.startsWith('/')) {
    tools.push(CODEX_NATIVE_IMAGE_GENERATION_TOOL);
  }
  return tools;
}

// Sniff PNG / JPG / WebP / GIF from the bytes themselves. We deliberately
// do NOT fall back to upstream's `output_format` hint:
//   • matches imageGen.js / codexImageEngine's "trust the bytes, not the
//     server's story" rule — Codex has shipped 200-OK error pages with
//     declared image content-types before;
//   • Codex review (2026-04-29 round 2) flagged the previous fallback as
//     a hole — `output_format: 'png'` would let non-PNG bytes (truncated
//     stream, error page, accidental JSON) be saved with a `.png`
//     extension and rendered as a broken image;
//   • PNG/JPEG/WebP/GIF magic always sits in the first 12 bytes, well
//     under our 1024-byte size floor — so a "valid but un-sniffable"
//     image is essentially impossible.
// Returns null when the buffer has no recognisable image magic; the
// caller treats null as a save failure (image dropped, prose still
// streams).
function codexInlineImageMime(buffer) {
  return detectImageMimeFromBytes(buffer) || null;
}

// Build the workspace destination for an inline image. Mirrors imageTool's
// allocateWorkspaceOutputPath so all chat-side image artifacts share the
// same `generated/` folder on disk and the same signed-URL shape.
function codexInlineImageExt(mimeType) {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  return '.png';
}

// Exported for tests so we can assert the save path / mime sniffing /
// signed-URL shape without going through the streaming pipeline.
export async function saveCodexInlineImageItem(item, workspacePath) {
  // `result` is base64 (per the spec). Be defensive: strip a leading data:
  // URI prefix in case upstream starts emitting one.
  const raw = String(item?.result || '').trim();
  if (!raw) return null;
  const base64 = raw.startsWith('data:') ? raw.replace(/^data:[^,]*,/, '') : raw;

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  // 1KiB floor — anything smaller is almost certainly a partial / placeholder
  // and would render as a broken image. Same threshold codexImageEngine uses.
  if (buffer.length < 1024) return null;

  const mimeType = codexInlineImageMime(buffer);
  if (!mimeType) return null;

  const dir = join(workspacePath, 'generated');
  await mkdir(dir, { recursive: true });
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString('hex');
  const ext = codexInlineImageExt(mimeType);
  const path = join(dir, `img-${ts}-${rand}${ext}`);
  await writeFile(path, buffer);

  let url;
  try {
    url = signWorkspaceFileUrl(path);
  } catch {
    return null;
  }
  return { path, url, mimeType, bytes: buffer.length };
}
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

// Exported for tests: lets the unit test feed a mocked SSE stream directly
// without faking the full createCodexResponsesReply credential / fetch path.
export async function readCodexSseResponse(
  response,
  {
    onDelta,
    onReasoningDelta,
    onInlineImage,
    idleTimeoutMs = resolveStreamIdleTimeoutMs(),
  } = {},
) {
  let deltaText = '';
  let reasoningText = '';
  let completedResponse = null;
  // attemptedImageIds — dedup so we don't re-invoke onInlineImage for a
  // single image_generation_call that the stream surfaces twice (once
  // via response.output_item.done, again inside response.completed).
  // A failed callback still gets recorded here — same item, same crash,
  // no point retrying within one response.
  const attemptedImageIds = new Set();
  // injectedImageSnippets — the markdown URL strings we actually appended
  // into deltaText. The final-text branch uses this list to verify that
  // whichever text we end up returning (deltaText or canonical
  // completedText) carries every image we generated. Codex review round 2
  // (2026-04-29) caught two failure modes a Set-of-ids couldn't pin:
  //   • SET-only: completed-only path produced deltaText="<image markdown
  //     only>", emittedImageIds.size > 0 → returned deltaText, dropping
  //     the canonical text the model emitted in the response.completed
  //     payload.
  //   • SET-only: a save failure flipped emittedImageIds.size to 0 even
  //     though we'd already streamed the markdown to onDelta — but UI
  //     can't take it back.
  // Tracking the snippets themselves lets us implement the contract
  // verbatim: the returned text must contain (a) all canonical prose AND
  // (b) every image markdown we successfully injected.
  const injectedImageSnippets = [];

  // When an inline image lands, emit it as a markdown URL into the
  // streamed reply text. The snippet is appended to deltaText so the URL
  // survives the final return path AND streamed via onDelta so the
  // desktop UI can render it inline before completion.
  const emitInlineImage = async item => {
    if (typeof onInlineImage !== 'function') return;
    if (!item || typeof item !== 'object') return;
    const id = String(item.id || `${Date.now()}-${attemptedImageIds.size}`);
    if (attemptedImageIds.has(id)) return;
    attemptedImageIds.add(id);
    let snippet;
    try {
      snippet = await onInlineImage(item);
    } catch {
      // Save / sign failures must never break the chat reply — we just
      // skip the image. The model's prose still streams normally, and
      // injectedImageSnippets stays untouched so the final-text branch
      // does not append a markdown URL we never wrote.
      return;
    }
    if (typeof snippet !== 'string' || !snippet) return;
    injectedImageSnippets.push(snippet);
    deltaText += snippet;
    if (typeof onDelta === 'function') {
      await onDelta({ delta: snippet, text: deltaText });
    }
  };

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

    // Streaming-path success signal for the built-in image_generation tool.
    // Same shape as codexImageEngine (which uses this endpoint standalone).
    if (
      event.type === 'response.output_item.done' &&
      event.item?.type === 'image_generation_call' &&
      typeof event.item.result === 'string' &&
      event.item.result
    ) {
      await emitInlineImage(event.item);
      return;
    }

    if (
      event.type === CODEX_EVENT_TYPES.COMPLETED ||
      event.type === CODEX_EVENT_TYPES.DONE ||
      event.type === CODEX_EVENT_TYPES.INCOMPLETE
    ) {
      completedResponse = event.response || completedResponse;
      // Fallback: under heavy load, some output_item.done events arrive
      // out-of-order or are merged into the terminal response payload.
      // Walk the completed output once for any image_generation_call we
      // haven't emitted yet so the user still sees the image.
      const output = completedResponse?.output;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (
            item &&
            item.type === 'image_generation_call' &&
            typeof item.result === 'string' &&
            item.result
          ) {
            await emitInlineImage(item);
          }
        }
      }
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

  // Final-text contract (Codex review round 2, 2026-04-29):
  //
  //   1. Canonical text — `extractResponsesText(completedResponse)` is
  //      authoritative when present; it's the model's own final
  //      answer assembled by the server from all output_text items.
  //      `deltaText` is just our running concatenation of streamed
  //      delta chunks plus any image markdown we appended.
  //
  //   2. Image markdown — every successfully injected snippet must
  //      appear in the returned text. Otherwise downstream
  //      `extractUrlAttachmentsFromText` won't see the .png URL and
  //      every generated image silently disappears from the assistant
  //      message.
  //
  // Failure modes we MUST NOT regress (each pinned by a test):
  //   • Pure text reply → return canonical completedText; no behaviour
  //     change vs pre-image-feature path.
  //   • Streamed text + image → completedText alone misses the image;
  //     deltaText already contains both, so return deltaText.
  //   • Completed-only payload (no text deltas) + image → completedText
  //     has the prose, deltaText has only the image markdown. Combine.
  //   • Save failure for one of N images → injectedImageSnippets only
  //     lists the ones that landed; we don't re-inject failed ones.
  const completedText = extractResponsesText(completedResponse);
  const trimmedDelta = deltaText.trim();
  const baseText = completedText || trimmedDelta;

  if (!injectedImageSnippets.length) {
    if (baseText) return baseText;
    throw new Error('Codex OAuth request completed without returning a final reply.');
  }

  // Pick whichever base text already contains every image snippet —
  // that's the version that actually flowed through onDelta to the UI
  // in real time (so the user has already seen it inline). When neither
  // contains them all, append the missing snippets to the canonical
  // text so the final return matches the streamed UI state.
  const allInDelta = injectedImageSnippets.every(s => deltaText.includes(s));
  if (allInDelta && trimmedDelta) {
    // deltaText already has prose + images interleaved in the stream
    // order the user saw. Prefer it when completedText is absent OR
    // its prose is already a substring of deltaText.
    if (!completedText || deltaText.includes(completedText)) {
      return trimmedDelta;
    }
    // completedText carries prose deltaText didn't catch (e.g. a chunk
    // arrived as part of the terminal payload, not as an output_text
    // delta). Append images to canonical text — see contract case 3.
  }

  if (completedText) {
    const missing = injectedImageSnippets.filter(s => !completedText.includes(s));
    if (!missing.length) return completedText;
    // Snippets are wrapped with leading+trailing blank lines so a
    // simple concat keeps the markdown URL parseable by
    // extractUrlAttachmentsFromText without further glue.
    return [completedText, ...missing].join('').trimEnd();
  }

  if (trimmedDelta) return trimmedDelta;
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

// Exported for tests so payload-level regressions (Codex review 2026-04-30:
// `tools` / `instructions` / `model` combinations across edit-mode,
// pure-generate and pure-text cases) can be pinned without standing up
// the real credential file or the real /codex/responses endpoint. The
// `_credentialProvider` and `_fetchImpl` parameters are private test
// seams — production callers pass the function the usual public shape.
export async function createCodexResponsesReply({
  baseUrl,
  model,
  systemPrompt,
  messages,
  signal,
  onDelta,
  onReasoningDelta,
  providerProfile = 'default',
  workspacePath = null,
  _credentialProvider = getCodexCredential,
  _fetchImpl,
} = {}) {
  const credential = await _credentialProvider();
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
  // Inline image generation only fires when the chat has a workspace
  // path we can write to. Background jobs that don't bind a workspace
  // (some Telegram polling code paths) skip the tool, falling back to
  // the standalone `image` builtin if the model decides to call it.
  // CLAUDE.md §6: capture `workspacePath` at call time (we already do
  // via the function param) so the SSE handler's microtasks never reach
  // back into a different chat's home.
  //
  // The decision logic is in `buildCodexResponsesTools` — kept exported
  // so payload-shape regressions are unit-testable without faking
  // getCodexCredential + fetch. See the design-intent block on that
  // helper for why we DON'T also gate on agent/sub-agent allowedTools.
  //
  // hasInputImage flips the image_generation tool to edit mode (high
  // input_fidelity) AND appends the explicit edit-mode instruction
  // block. Without those, the model defaults to "I need a file path"
  // when the user asks "edit this screenshot" — chronic failure mode
  // observed 2026-04-30 in both desktop and Telegram bot scenarios.
  const hasInputImage = messagesHaveInputImages(messages);
  const tools = buildCodexResponsesTools({
    enableWebSearch,
    workspacePath,
    hasInputImage,
  });
  const enableInlineImage = tools.some(t => t?.type === 'image_generation');
  // Append the edit-mode instruction only when both (a) inline image is
  // enabled (workspace exists) AND (b) there is actually an input image
  // — otherwise we'd inject anti-file-path guidance into pure text
  // turns, which has no upside and risks confusing the model.
  const effectiveInstructions =
    enableInlineImage && hasInputImage
      ? `${systemPrompt}\n\n${CODEX_INLINE_IMAGE_EDIT_INSTRUCTION}`
      : systemPrompt;

  // The model is whatever the caller chose. An earlier cut force-
  // overrode it to gpt-5.5 whenever inline image was enabled — Codex
  // review caught that as too wide (it silently swapped models for
  // every Codex+workspace chat including pure-text Q&A) and the user
  // reverted the rule on 2026-04-30. The default Codex catalog
  // (gpt-5.5, gpt-5.4, gpt-4.1) is image-tool-capable across the
  // board, so users only see image-generation failures if they
  // explicitly switch to gpt-5-codex-mini, in which case the model's
  // own "I can't draw" response is the right signal.
  const payload = {
    model,
    store: false,
    stream: true,
    instructions: effectiveInstructions,
    input: await buildCodexResponsesInput(messages, { signal }),
    text: { verbosity: isFastProfile ? 'low' : DEFAULT_CODEX_TEXT_VERBOSITY },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: sessionId,
    reasoning: {
      effort: effectiveReasoningEffort,
      summary: 'auto',
    },
    ...(tools.length
      ? {
          tool_choice: 'auto',
          parallel_tool_calls: true,
          tools,
        }
      : {}),
  };

  await ensureFetchKeepAliveConfigured();
  const fetchFn = _fetchImpl || fetch;
  const response = await fetchFn(endpoint, {
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

  // Closure binds the workspacePath captured at call time. The SSE handler
  // invokes this for every image_generation_call.done event; on save it
  // returns a markdown URL snippet which gets appended to the streamed
  // reply, so the URL flows through extractUrlAttachmentsFromText and
  // becomes a regular image attachment on the assistantMessage.
  const onInlineImage = enableInlineImage
    ? async item => {
        const saved = await saveCodexInlineImageItem(item, workspacePath);
        if (!saved) return null;
        // Bracket the URL with blank lines so it never glues to surrounding
        // prose ("Here's a cat:![cat](http…)" would render but reads worse).
        return `\n\n![generated image](${saved.url})\n\n`;
      }
    : undefined;

  return readCodexSseResponse(response, {
    onDelta,
    onReasoningDelta,
    onInlineImage,
  });
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
  workspacePath = null,
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
        workspacePath,
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
