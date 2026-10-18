import { normalizeUsage } from './runtime/usage.js';
import { modelReplyText } from './tools/functionCalling.js';
import { isToolProtocolMessage, renderToolMessage } from './tools/toolProtocol.js';
import { prepareVisionInputs } from './media/visionInputs.js';
import { fastGenerationOptions } from './shared/fastGeneration.js';
import { requestAnthropicReply } from './providers/anthropic.js';
import { DEFAULT_MODEL_CATALOGS, normalizeReasoningEffort } from './shared/modelCatalog.js';
import { readCodexModelCatalog } from './providers/codexModels.js';
import { readCodexSseResponse, readChatCompletionsSseResponse } from './providers/streams.js';
export { readCodexSseResponse } from './providers/streams.js';
import { normalizeMessageContent, extractAssistantText, extractProviderErrorMessage } from './providers/responseText.js';
import { requestEnvironment } from './runtime/requestScope.js';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createCapabilityRecorder } from './runtime/capabilities.js';
import { resolveRuntimePaths } from './runtime/paths.js';
import { buildPromptCacheKey } from './retrieval/promptCacheKey.js';
import { promisify } from 'node:util';
import { getCodexCredential } from './codexAuth.js';
import { IMAGE_INTENT_RULES } from './images/imagePrompts.js';
import { signWorkspaceFileUrl } from './web/urlSigning.js';
import { detectImageMimeFromBytes } from './images/imageGen.js';
// Shared message intent rules; messageBuilder depends only on the pure
// context window, never on a provider-backed compactor.
import {
  IMAGE_GEN_INTENT_PATTERN,
  IMAGE_EDIT_INTENT_PATTERN,
  IMAGE_FOLLOW_UP_PATTERN,
} from './services/chat/messageBuilder.js';
import {
  clearSearchTriggers,
  registerSearchTriggers,
  shouldUseNativeWebSearch,
} from './retrieval/searchRouter.js';

const execFile = promisify(execFileCallback);
const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 600000;
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 600000;
const DEFAULT_CODEX_REASONING_EFFORT = 'medium';
const DEFAULT_CODEX_FAST_REASONING_EFFORT = 'low';
const DEFAULT_CODEX_TEXT_VERBOSITY = 'medium';
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';

const DEFAULT_DISCOVERED_MODELS = DEFAULT_MODEL_CATALOGS;
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
  "and tell me the path\"). Emit a faithful edit prompt retaining all user constraints and the",
  'host app will display the result inline. If multiple images are attached, edit the',
  'most recently uploaded one unless the user specifies otherwise.',
  'For edits, preserve unrequested attributes; only change what the user explicitly asks to change.',
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

// Prepend per-turn guidance (image-intent rules) to the latest user input item
// so `instructions` stays cache-stable (design audit A2).
export function withTurnGuidance(input, guidance) {
  if (!guidance || !Array.isArray(input)) return input;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.role !== 'user' || !Array.isArray(item.content)) continue;
    const content = [{ type: 'input_text', text: `[Turn guidance]\n${guidance}` }, ...item.content];
    return input.map((entry, i) => (i === index ? { ...entry, content } : entry));
  }
  return input;
}

// Inline copy of detectImageIntent (lives in services/chat/messageBuilder.js
// alongside the regex constants we import above). See the comment on the
// patterns import for why we don't pull the original function.
function _detectImageIntentLocal(text, { hasInputImage = false } = {}) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (IMAGE_GEN_INTENT_PATTERN.test(text)) return true;
  if (!hasInputImage) return false;
  if (IMAGE_EDIT_INTENT_PATTERN.test(text)) return true;
  if (IMAGE_FOLLOW_UP_PATTERN.test(text)) return true;
  return false;
}

// Pull the latest user-role message's text for image-intent detection.
// Walks the messages array in reverse and joins all `text` parts of the
// most recent user turn. String content is returned verbatim; structured
// content arrays are flattened with single-space joins. Cheap, no LLM —
// used to drive the buildCodexResponsesTools image-intent gate.
//
// Local to openai.js to avoid pulling chat-service helpers into the
// openai module's import graph (small symmetric helper, single use site).
export function extractLatestUserTextForIntent(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user' || message.isToolResult) continue;
    const content = message.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      const parts = [];
      for (const part of content) {
        if (typeof part?.text === 'string') {
          parts.push(part.text);
        } else if (part?.type === 'text' && typeof part.text === 'string') {
          parts.push(part.text);
        }
      }
      if (parts.length) return parts.join(' ').trim();
    }
  }
  return '';
}

// Returns true when any user-role message in the array carries an
// image_url content part (with a non-empty URL). Used to decide whether
// to flip the inline image_generation tool into edit mode + append the
// edit-mode instruction block. Exported for tests so the detection rule
// can be pinned independently of the createCodexResponsesReply pipeline.
export function messagesHaveInputImages(messages) {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    // Tool images (web_screenshot, isToolResult) are not user uploads.
    if (message?.role !== 'user' || message?.isToolResult) continue;
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

// Stricter variant: returns true ONLY when the LATEST user-role message
// carries an image_url. Used by the Phase 4 image-intent gate.
//
// Cross-system contract (Codex Phase 4 follow-up H plan, 2026-05-04):
// this gate consults the SAME post-carry-forward state of the latest
// user turn that messageBuilder.js produces. messageBuilder runs
// upstream of createCodexResponsesReply and merges an older turn's
// image into the latest user turn ONLY when the latest text matches
// IMAGE_FOLLOW_UP_PATTERN (e.g. "这张图改一下" / "换背景"). Bare edit
// verbs that don't reference an image-noun ("再改一下头发", "换一下
// 颜色", "change the background") explicitly do NOT trigger
// carry-forward — the messageBuilder design (review round 6
// 2026-04-30) tightened that gate to avoid CSS/theming
// false-positives where a screenshot from earlier in the chat would
// be mis-pulled into a code-styling discussion.
//
// By consulting only the latest turn we automatically inherit the
// same decision: carry-forward triggered → image is in latest turn →
// gate enables image_generation; carry-forward didn't trigger →
// image stays in old turn → gate keeps image_generation off. The two
// systems cannot drift because they read the same fact. The
// integration test src/services/chat/imageIntentGate.integration.test.js
// pins the alignment so a future expansion on either side that
// breaks parity lights up red.
//
// Closes Codex review Phase 4 🔴 (history-wide image leak), Phase 4 C
// 评级 (carry-forward / gate semantic drift).
export function latestUserMessageHasImage(messages) {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user' || message.isToolResult) continue;
    const content = message.content;
    if (!Array.isArray(content)) return false;
    for (const item of content) {
      if (
        item?.type === 'image_url' &&
        typeof item?.image_url?.url === 'string' &&
        item.image_url.url.trim()
      ) {
        return true;
      }
    }
    // Found the latest user turn but no image — do NOT keep walking
    // backward, since older turns are not the "current" image.
    return false;
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
// DESIGN INTENT (user 2026-04-29 → revised 2026-05-04 Phase 4):
// inline image_generation now requires BOTH (a) a writable workspace
// path AND (b) explicit image intent on the latest user turn. The
// original 2026-04-29 design ("workspace alone is enough") leaked
// across tool-routing boundaries: when fetch_url failed against a
// link the model had image_generation in its tool list and used it
// as a fabrication fallback (Xiaohongshu/Douyin share links with
// thumbnail attachments → user got an image instead of a summary).
//
// `hasImageIntent` is computed by `detectImageIntent` in
// services/chat/messageBuilder.js — it fires for text-to-image asks
// regardless of input image, and for edit / look-at-image asks only
// when an input image is present. Gating image_generation on this
// instead of the always-on workspace flag means the model PHYSICALLY
// cannot pick image_generation as a fallback when the user's intent
// is unrelated to images. Intentional asks ("draw a cat", "画一张",
// "edit this photo") still get the tool.
//
// `hasInputImage` continues to flow through for INSTRUCTIONS-level
// gating (whether to append the edit-mode block) — the chatgpt.com
// /codex/responses proxy still rejects every variant we tried for
// the tool config itself, so that part of the helper does not change.
export function buildCodexResponsesTools({
  enableWebSearch = false,
  workspacePath = null,
  hasInputImage: _hasInputImage = false,
  hasImageIntent = false,
  nativeImageGenerationEnabled = true,
} = {}) {
  const tools = [];
  if (enableWebSearch) tools.push(CODEX_NATIVE_WEB_SEARCH_TOOL);
  if (
    nativeImageGenerationEnabled && hasImageIntent &&
    typeof workspacePath === 'string' &&
    workspacePath.startsWith('/')
  ) {
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
export function registerWebSearchTriggers(entries = []) {
  registerSearchTriggers(entries);
}

export function clearExtraWebSearchTriggers() {
  clearSearchTriggers();
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

function shouldEnableCodexNativeWebSearch(messages = []) {
  return shouldUseNativeWebSearch(messages, { authMode: 'codex' });
}

function normalizeCodexReasoningEffort(rawValue, model) {
  return normalizeReasoningEffort(model, rawValue, DEFAULT_CODEX_REASONING_EFFORT);
}

function resolveFastCodexReasoningEffort(model, fallback = DEFAULT_CODEX_FAST_REASONING_EFFORT) {
  if (/^gpt-6-luna(?:-|$)/i.test(model)) return 'none';
  return normalizeReasoningEffort(model, requestEnvironment().MELO_CODEX_FAST_REASONING_EFFORT || fallback, fallback);
}

function resolveCodexRequestTimeoutMs() {
  const configured = Number.parseInt(
    requestEnvironment().MELO_CODEX_REQUEST_TIMEOUT_MS ||
      requestEnvironment().MELO_CODEX_TIMEOUT_MS ||
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
          ...(item.image_url.detail ? { detail: item.image_url.detail } : {}),
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
    .map(message => isToolProtocolMessage(message)
      // Protocol-neutral tool turns (design audit E1) are rendered by the
      // transport (anthropic.js / chat-completions below), not flattened here.
      ? message
      : {
        role: message?.role,
        content: normalizeProviderMessageContent(message?.content),
      })
    .filter(message => {
      if (isToolProtocolMessage(message)) return true;
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

async function readAttachmentResource(url, { timeoutMs = 30000, signal } = {}) {
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
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
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
      ...(item.image_url?.detail ? { detail: item.image_url.detail } : {}),
      image_url: imageUrl,
    };
  }

  const resource = await readAttachmentResource(imageUrl, { timeoutMs: 30000 });
  if (!resource?.buffer?.length) {
    return {
      type: 'input_image',
      ...(item.image_url?.detail ? { detail: item.image_url.detail } : {}),
      image_url: imageUrl,
    };
  }

  const mimeType = inferImageMimeType({ url: imageUrl }, resource.contentType);
  return {
    type: 'input_image',
      ...(item.image_url?.detail ? { detail: item.image_url.detail } : {}),
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
    if (Array.isArray(message?.responseItems)) {
      results.push(...message.responseItems);
      continue;
    }
    if (Array.isArray(message?.functionCallOutputs)) {
      results.push(...message.functionCallOutputs);
      continue;
    }
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
  onModelMetadata,
  onExecutionEvent,
  providerProfile = 'default',
  workspacePath = null,
  nativeWebSearchEnabled,
  nativeImageGenerationEnabled = true,
  cacheScope,
  functionTools,
  _credentialProvider = getCodexCredential,
  _fetchImpl,
} = {}) {
  const capturedHome = resolveRuntimePaths().home;
  const endpoint = resolveCodexResponsesEndpoint(baseUrl);
  const sessionId = createCodexSessionId();
  const timeoutMs = resolveCodexRequestTimeoutMs();
  const reasoningEffort = normalizeCodexReasoningEffort(requestEnvironment().MELO_CODEX_REASONING_EFFORT, model);
  const isFastProfile = providerProfile === 'fast';
  const effectiveReasoningEffort = isFastProfile ? resolveFastCodexReasoningEffort(model) : reasoningEffort;
  const record = createCapabilityRecorder({ config: { authMode: 'codex', model } });
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
  const promptCacheKey = buildPromptCacheKey({
    home: capturedHome, accountId: credential.accountId, endpoint, model, scope: cacheScope, profile: providerProfile,
  }) || sessionId;
  const enableWebSearch = typeof nativeWebSearchEnabled === 'boolean'
    ? nativeWebSearchEnabled
    : shouldEnableCodexNativeWebSearch(messages);
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
  // Phase 4 image-intent gate (2026-05-04): image_generation only enters
  // the tool list when the latest user turn actually reads as an image
  // task. Closes the Xiaohongshu/Douyin share-link mis-routing where the
  // tool was being used as a fallback for failed fetch_url calls. See
  // buildCodexResponsesTools and detectImageIntent for the full rationale.
  //
  // Codex review follow-up (Phase 4 🔴 2026-05-04): the image-intent
  // gate must use the STRICTER `latestUserMessageHasImage` — not the
  // broad `messagesHaveInputImages` — because IMAGE_EDIT_INTENT_PATTERN
  // matches generic "change/改一下/换成" copy. With history-wide image
  // detection, an old uploaded image would re-enable image_generation
  // for an unrelated CSS/theming follow-up turn. The latest-turn-only
  // check matches imageEditFastPath's `findLatestUserImageUrl`.
  const latestUserText = extractLatestUserTextForIntent(messages);
  const latestUserHasImage = latestUserMessageHasImage(messages);
  const hasImageIntent = _detectImageIntentLocal(latestUserText, { hasInputImage: latestUserHasImage });
  // Design audit A2: function definitions first (stable per chat), native
  // provider tools after them, so an image/search-specific turn appends to
  // the cached prefix instead of shifting every function definition.
  const nativeTools = buildCodexResponsesTools({
    enableWebSearch,
    workspacePath,
    hasInputImage,
    hasImageIntent,
    nativeImageGenerationEnabled,
  });
  const tools = [...(Array.isArray(functionTools) ? functionTools : []), ...nativeTools];
  const enableInlineImage = tools.some(t => t?.type === 'image_generation');
  // Image-intent rules are per-turn guidance: they ride in the latest user
  // input (see below) rather than in `instructions`, which must stay
  // byte-identical across turns for the prompt cache.
  const effectiveInstructions = systemPrompt;
  const turnGuidance = enableInlineImage
    ? [IMAGE_INTENT_RULES, ...(hasInputImage ? [CODEX_INLINE_IMAGE_EDIT_INSTRUCTION] : [])].join('\n\n')
    : '';

  // Preserve the selected model for both text and image-tool requests.
  const payload = {
    model,
    store: false,
    stream: true,
    instructions: effectiveInstructions,
    input: withTurnGuidance(await buildCodexResponsesInput(messages, { signal }), turnGuidance),
    text: { verbosity: isFastProfile ? 'low' : DEFAULT_CODEX_TEXT_VERBOSITY },
    include: ['reasoning.encrypted_content', ...(nativeWebSearchEnabled ? ['web_search_call.action.sources'] : [])],
    prompt_cache_key: promptCacheKey,
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
        if (!saved) {
          onExecutionEvent?.({ kind: 'operation', id: item.id, name: 'native_image_generation', module: 'create', status: 'failed', errorCode: 'IMAGE_SAVE_FAILED' });
          return null;
        }
        onExecutionEvent?.({ kind: 'operation', id: item.id, name: 'native_image_generation', module: 'create', status: 'completed',
          artifacts: [{ id: `image-${item.id}`, kind: 'image', url: saved.url, path: saved.path, title: '生成图片' }] });
        // Bracket the URL with blank lines so it never glues to surrounding
        // prose ("Here's a cat:![cat](http…)" would render but reads worse).
        return `\n\n![generated image](${saved.url})\n\n`;
      }
    : undefined;

  return readCodexSseResponse(response, {
    onModelMetadata,
    onDelta,
    onReasoningDelta,
    onInlineImage,
    onInlineImagePreview: enableInlineImage ? async event => {
      if (!event.item_id || !event.partial_image_b64) return;
      try {
        const {saveImageArtifact}=await import('./images/imageArtifacts.js');
        const saved=await saveImageArtifact(workspacePath,Buffer.from(event.partial_image_b64,'base64'),{prefix:'preview',signal});
        onExecutionEvent?.({kind:'preview',id:event.item_id,url:saved.url,path:saved.path,index:event.partial_image_index});
      } catch(error) { if(signal?.aborted) throw error; }
    } : undefined,
    onExecutionEvent,
    onNativeSearch: () => record('search', { ok: true, level: 'results', provider: 'codex-native', reason: 'native-search-completed' }),
    returnToolResponse: Array.isArray(functionTools),
  });
}

// Public API function turns use the same stateless Responses continuation as
// OAuth. No provider-hosted agent runtime or server-side conversation storage.
// prompt_cache_key is an OpenAI-specific routing hint; some OpenAI-compatible
// servers reject unknown fields, so only first-party hosts (or an explicit
// MELO_PROMPT_CACHE_KEY=1) receive it (2026-10-17 audit C-5).
export function apiPromptCacheKey({ baseUrl, model, cacheScope, providerProfile = 'default', endpoint = 'api' }) {
  if (!cacheScope) return null;
  let host = '';
  try { host = new URL(String(baseUrl || '')).hostname; } catch { host = ''; }
  const firstParty = /(^|\.)openai\.com$/i.test(host);
  if (!firstParty && requestEnvironment().MELO_PROMPT_CACHE_KEY !== '1') return null;
  return buildPromptCacheKey({ home: '', accountId: '', endpoint, model, scope: cacheScope, profile: providerProfile });
}

export async function createApiResponsesReply({ baseUrl, apiKey, model, systemPrompt, messages,
  functionTools, signal, onDelta, onReasoningDelta, onModelMetadata, maxTokens, cacheScope, providerProfile,
  _fetchImpl = fetch } = {}) {
  const promptCacheKey = apiPromptCacheKey({ baseUrl, model, cacheScope, providerProfile, endpoint: 'responses' });
  const payload = {
    model, instructions: systemPrompt, store: false, stream: true,
    input: await buildCodexResponsesInput(messages, { signal }),
    include: ['reasoning.encrypted_content'],
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    ...(Number.isFinite(maxTokens) ? { max_output_tokens: maxTokens } : {}),
    ...(functionTools?.length ? { tools: functionTools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
  };
  await ensureFetchKeepAliveConfigured();
  const response = await _fetchImpl(`${normalizeBaseUrl(baseUrl).replace(/\/responses$/, '')}/responses`, {
    method: 'POST', redirect: 'error', signal: withTimeoutSignal(DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS, signal),
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try { detail = extractProviderErrorMessage(JSON.parse(raw), raw); } catch {}
    throw new Error(`Responses request failed (${response.status}): ${detail}`);
  }
  return readCodexSseResponse(response, { onDelta, onReasoningDelta,
    onModelMetadata: metadata => onModelMetadata?.({ ...metadata, transport: 'responses' }),
    returnToolResponse: Array.isArray(functionTools),
  });
}

export async function discoverAvailableModels({
  authMode,
  apiProtocol,
  apiKey,
  baseUrl,
  model,
}) {
  if (authMode === 'codex') {
    const catalog = await readCodexModelCatalog();
    return uniqueModels(catalog.length ? catalog : DEFAULT_DISCOVERED_MODELS.codex, model);
  }

  const normalizedUrl = normalizeBaseUrl(baseUrl || '');
  if (!normalizedUrl) {
    return uniqueModels(DEFAULT_DISCOVERED_MODELS[authMode] || [], model);
  }

  await ensureFetchKeepAliveConfigured();
  const response = await fetch(`${normalizedUrl}/models`, {
    method: 'GET',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...(apiProtocol === 'anthropic' || new URL(normalizedUrl).hostname === 'api.anthropic.com' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : {}),
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

export async function createOpenAICompatibleReply(options) {
  const record = createCapabilityRecorder({ config: options });
  let metadata = {};
  // `timeoutMs` (run budget, design audit C1): the caller's remaining run
  // time caps this one request on top of the per-transport 600 s ceilings.
  const timeoutMs = Number(options.timeoutMs);
  const signal = Number.isFinite(timeoutMs) && timeoutMs > 0 ? withTimeoutSignal(timeoutMs, options.signal) : options.signal;
  try {
    const reply = await requestOpenAICompatibleReply({
      ...options, signal, onModelMetadata: value => { metadata = { ...metadata, ...value }; options.onModelMetadata?.(value); },
    });
    const reportedModel = /^[a-z0-9._:/-]{1,150}$/i.test(metadata.reportedModel || '') ? metadata.reportedModel : '';
    const receipt = {
      requestedModel: options.model, reportedModel,
      usage: normalizeUsage(metadata.usage),
      transport: metadata.transport || (options.authMode === 'codex' ? 'codex-responses' : 'chat-completions'),
      simulated: Boolean(requestEnvironment().MELO_MOCK_RESPONSE),
    };
    options.onProviderResponse?.(receipt);
    if (options.providerProfile !== 'fast') {
      const hasToolCalls = reply?.responseItems?.some(item => item.type === 'function_call')
        || reply?.message?.tool_calls?.length > 0 || reply?.content?.some?.(block => block?.type === 'tool_use');
      await record('model', { ok: Boolean(modelReplyText(reply).trim() || hasToolCalls), level: 'response', provider: options.authMode || '', ...receipt });
    }
    return reply;
  } catch (error) {
    if (options.providerProfile !== 'fast' && !isAbortError(error)) {
      await record('model', { ok: false, reason: 'provider-request-failed', provider: options.authMode || '' });
    }
    throw error;
  }
}

async function requestOpenAICompatibleReply({
  authMode,
  apiProtocol,
  apiKey,
  baseUrl,
  model,
  systemPrompt,
  messages,
  signal,
  onDelta,
  onReasoningDelta,
  onModelMetadata,
  onExecutionEvent,
  providerProfile = 'default',
  workspacePath = null,
  nativeWebSearchEnabled,
  nativeImageGenerationEnabled = true,
  cacheScope,
  maxTokens,
  functionTools,
  // Tool protocol (design audit E1): which shape `functionTools` is in and
  // which transport must carry the tool turn. Absent → the historical
  // behaviour (any functionTools array means the Responses protocol).
  toolProtocol,
}) {
  if (requestEnvironment().MELO_MOCK_RESPONSE) {
    const mockReply = requestEnvironment().MELO_MOCK_RESPONSE;
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
    return await createCodexResponsesReply({
        baseUrl,
        model,
        systemPrompt,
        messages,
        signal,
        onDelta,
        onReasoningDelta,
        onModelMetadata,
        onExecutionEvent,
        providerProfile,
        workspacePath,
        nativeWebSearchEnabled,
        nativeImageGenerationEnabled,
        cacheScope,
        functionTools,
      });
  }

  if (authMode !== 'local' && !apiKey) {
    throw new Error(
      'No API key configured. Set MELO_API_KEY, OPENAI_API_KEY, or run `melo config set apiKey ...`.',
    );
  }

  if (!normalizeBaseUrl(baseUrl)) {
    throw new Error('No base URL configured. Open Model settings and set a valid endpoint first.');
  }

  messages = await prepareVisionInputs(messages, { readResource: readAttachmentResource, signal });
  const nativeTools = Array.isArray(functionTools);
  const resolvedToolProtocol = nativeTools ? (toolProtocol || 'responses') : null;
  if (resolvedToolProtocol === 'responses' || apiProtocol === 'responses') {
    return createApiResponsesReply({ baseUrl, apiKey, model, systemPrompt, messages, functionTools, signal,
      onDelta, onReasoningDelta, onModelMetadata, maxTokens, cacheScope, providerProfile });
  }
  const protocol = apiProtocol || (new URL(baseUrl).hostname === 'api.anthropic.com' ? 'anthropic' : 'chat-completions');
  if (protocol === 'anthropic' || resolvedToolProtocol === 'anthropic') {
    return requestAnthropicReply({ baseUrl: normalizeBaseUrl(baseUrl), apiKey, model, systemPrompt, messages: normalizeProviderMessages(messages), signal: withTimeoutSignal(DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS, signal), onDelta, onModelMetadata, maxTokens: maxTokens ?? (providerProfile === 'fast' ? 1024 : undefined),
      ...(resolvedToolProtocol === 'anthropic' ? { tools: functionTools } : {}) });
  }

  const endpoint = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const chatTools = resolvedToolProtocol === 'chat-completions';
  // Resolve audio_attachment parts to input_audio (base64) so models that support
  // native audio input (e.g. GPT-4o Audio, local multimodal models) can process them
  // directly instead of requiring Whisper transcription.
  const resolvedMessages = await resolveAudioAttachments(normalizeProviderMessages(messages), { signal });
  const chatPromptCacheKey = apiPromptCacheKey({ baseUrl, model, cacheScope, providerProfile, endpoint: 'chat-completions' });
  const payload = {
    ...fastGenerationOptions({ model, baseUrl, maxTokens, providerProfile }),
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      // Tool protocol (E1): assistant `tool_calls` are echoed exactly as
      // received and each result becomes one `{role:'tool'}` message.
      ...resolvedMessages.flatMap(message => renderToolMessage(message, 'chat-completions') || [message]),
    ],
    ...(typeof onDelta === 'function' ? { stream: true } : {}),
    ...(chatPromptCacheKey ? { prompt_cache_key: chatPromptCacheKey } : {}),
    ...(chatTools && functionTools.length ? { tools: functionTools, tool_choice: 'auto' } : {}),
  };

  await ensureFetchKeepAliveConfigured();
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
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
    return readChatCompletionsSseResponse(response, { onDelta, onModelMetadata, returnToolResponse: chatTools });
  }

  const json = await response.json();
  onModelMetadata?.({ reportedModel: json.model || '', responseId: json.id || '', usage: json.usage, finishReason: json.choices?.[0]?.finish_reason });
  if (chatTools) return chatCompletionsToolReply(json, { onDelta });
  const assistantText = extractAssistantText(json);
  if (typeof onDelta === 'function') {
    await onDelta({
      delta: assistantText,
      text: assistantText,
    });
  }
  return assistantText;
}

// Non-streaming chat-completions reply in the tool protocol: `{ protocol:
// 'chat-completions', text, message }` where `message` is the assistant
// message exactly as the provider returned it (echoed back in history).
async function chatCompletionsToolReply(json, { onDelta } = {}) {
  const choice = json?.choices?.[0];
  const message = choice?.message && typeof choice.message === 'object' ? choice.message : null;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const finishReason = choice?.finish_reason;
  if (finishReason && finishReason !== 'stop' && !(finishReason === 'tool_calls' && toolCalls.length)) {
    throw new Error(`Provider response incomplete (finish_reason: ${String(finishReason).slice(0, 60)}).`);
  }
  const text = normalizeMessageContent(message?.content);
  if (!text && !toolCalls.length) throw new Error('Provider returned an empty response without a final reply.');
  if (typeof onDelta === 'function' && text) await onDelta({ delta: text, text });
  return { protocol: 'chat-completions', text, message: { ...message, role: 'assistant' } };
}
