// ─── Codex OAuth image generation (gpt-image-2 via /codex/responses) ────────
//
// Third generation engine alongside sdcpp (local) and minimax (paid API).
// Path is the one OpenAI opened to ChatGPT Plus Codex subscribers on
// 2026-04-16: the standard Responses API with a built-in image tool, routed
// through `https://chatgpt.com/backend-api/codex/responses` using the same
// OAuth access token Melo already reads for text generation. Image output is
// billed against the user's Codex usage bucket (covered by ChatGPT Plus /
// Pro / Team / Enterprise) — no separate API key, no per-image charge.
//
// Request shape
// -------------
//   POST /codex/responses
//   Authorization: Bearer <codex oauth token>      (from codexAuth.js)
//   chatgpt-account-id: <account id>               (from JWT claims)
//   openai-beta: responses=experimental
//   session_id, user-agent: mirror buildCodexResponsesHeaders
//   body:
//   {
//     "model": "gpt-5.4",              // any image-tool-capable model
//     "stream": true,
//     "store": false,
//     "input": [
//       { "role": "user",
//         "content": [{ "type": "input_text", "text": "<prompt>" }] }
//     ],
//     "tools": [{ "type": "image_generation", "background": "auto" }],
//     "tool_choice": "auto"
//   }
//
// Response shape (SSE)
// --------------------
// Events we care about (others are ignored):
//
//   response.output_item.added   { item: { type: "image_generation_call", ... } }
//   response.output_item.done    { item: { type: "image_generation_call",
//                                          result: "<base64>",
//                                          status: "completed",
//                                          output_format: "png"|"jpeg"|... } }
//   response.completed           { response: { output: [ …full output array… ] } }
//   error / response.failed      → thrown with detail
//
// `result` is raw base64 (no data: prefix). `output_format` is a best-effort
// hint; we still magic-byte-sniff the decoded bytes before trusting the mime.
//
// Intentionally self-contained: we DO NOT import from openai.js, so this
// module doesn't drag in the chat-completion plumbing, and vice-versa —
// the image engine lives next to sdcppEngine.js in src/images/ for a reason.

import { writeFile } from 'node:fs/promises';
import { platform, release, arch } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getCodexCredential } from '../codexAuth.js';
import { detectImageMimeFromBytes } from './imageGen.js';

const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

// Default model — any image-tool-capable model works. 'gpt-5.4' is the
// current recommendation; 'gpt-5-codex-mini' does NOT expose the image tool
// and is explicitly excluded. Callers can override via opts.model.
const DEFAULT_MODEL = 'gpt-5.4';

// 120s cap — image generation via Responses is slower than text and often
// streams partial previews for 30–60s before the final `result` lands.
const GEN_TIMEOUT_MS = 120_000;

// Idle timeout between SSE events. Progress events (partial_image,
// token deltas) keep the stream warm; a 45s silence is long enough to
// assume the socket is dead.
const IDLE_TIMEOUT_MS = 45_000;

// Floor for a plausible PNG/JPG/WebP — matches imageGen.js's IMAGE_MIN_BYTES.
const IMAGE_MIN_BYTES = 1024;

// ─── Header builder (mirrors openai.js#buildCodexResponsesHeaders) ──────────
// Duplicated intentionally — keeping this engine free of an openai.js import
// avoids a module-load cycle (openai.js imports tts/urlSigning/etc.) and
// lets the engine be unit-tested in isolation with a stubbed fetch.
function buildHeaders({ accessToken, accountId, sessionId }) {
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

// ─── SSE parsing ────────────────────────────────────────────────────────────
// One SSE event block = lines separated by \n, delimited by a blank line.
// We collect `data:` lines, concatenate them, and JSON-parse. Comments
// (`: keep-alive`) and lone blank lines are skipped. Same semantics as the
// Codex reader in openai.js — copied locally so this module is standalone.
export function parseSseEventBlock(block) {
  const lines = String(block || '').split(/\r?\n/).map(line => line.trimEnd());
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (!dataLines.length) return null;
  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// Walk a Responses-API `response.output` array and return the FIRST
// image_generation_call item that has a base64 `result` on it. This is the
// completed-response fallback path when we didn't catch the streaming
// `response.output_item.done` event for whatever reason.
function findImageResultInOutput(output) {
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (item && item.type === 'image_generation_call' && typeof item.result === 'string' && item.result) {
      return item;
    }
  }
  return null;
}

// Map `output_format` hints → mime type. We still re-sniff the decoded
// bytes, but a matching hint is a useful tie-breaker when the buffer has
// only a partial header.
function mimeFromOutputFormat(format) {
  const f = String(format || '').toLowerCase().trim();
  if (f === 'png') return 'image/png';
  if (f === 'jpeg' || f === 'jpg') return 'image/jpeg';
  if (f === 'webp') return 'image/webp';
  if (f === 'gif') return 'image/gif';
  return null;
}

// Extract an actionable message from an `error` / `response.failed` event.
function eventErrorMessage(event) {
  if (!event || typeof event !== 'object') return 'Codex image generation failed.';
  if (event.type === 'error') {
    return event.message || event.code || 'Codex image generation failed.';
  }
  if (event.type === 'response.failed') {
    return (
      event.response?.error?.message ||
      event.response?.incomplete_details?.reason ||
      'Codex image response failed.'
    );
  }
  return 'Codex image generation failed.';
}

// ─── Stream consumer ────────────────────────────────────────────────────────
// Reads the SSE body, splits into event blocks (double-newline boundary),
// feeds each to `handleEvent`. Stops as soon as handleEvent returns a truthy
// value — that's the "found a completed image" signal, propagated up to the
// caller. Also enforces the per-event idle timeout.
async function consumeSseStream(response, handleEvent, { idleTimeoutMs = IDLE_TIMEOUT_MS } = {}) {
  if (!response.body) {
    throw new Error('Codex image generation returned no response body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastActivityAt = Date.now();
  let stalled = false;

  const stallChecker = setInterval(() => {
    if (Date.now() - lastActivityAt > idleTimeoutMs) {
      stalled = true;
      void reader.cancel().catch(() => {});
      clearInterval(stallChecker);
    }
  }, 5000);
  stallChecker.unref?.();

  let result = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastActivityAt = Date.now();
      buffer += decoder.decode(value, { stream: true });

      // Drain any complete event blocks from the head of the buffer. SSE
      // events are separated by a blank line (\n\n), which is canonicalised
      // to \n\n regardless of whether the stream uses \r\n endings.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const found = await handleEvent(parseSseEventBlock(block));
        if (found) { result = found; break; }
        boundary = buffer.indexOf('\n\n');
      }
      if (result) break;
    }

    if (!result) {
      // Flush anything remaining in the buffer (no trailing blank line).
      buffer += decoder.decode();
      if (buffer.trim()) {
        const found = await handleEvent(parseSseEventBlock(buffer));
        if (found) result = found;
      }
    }
  } catch (error) {
    if (stalled) {
      throw new Error(`Codex image generation stalled (no SSE events for ${idleTimeoutMs}ms).`);
    }
    throw error;
  } finally {
    clearInterval(stallChecker);
    try { await reader.cancel(); } catch { /* best-effort */ }
  }

  return result;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate an image via the Codex OAuth path. Returns the raw bytes + sniffed
 * mime; callers typically pipe into generateAndSaveImageViaCodex below.
 *
 * @param {object} opts
 * @param {string} opts.prompt              text-to-image prompt
 * @param {string} [opts.model]             default 'gpt-5.4'
 * @param {string} [opts.background]        'transparent' | 'opaque' | 'auto'
 * @param {string} [opts.inputFidelity]     'high' | 'low' (gpt-image-1.5+)
 * @param {AbortSignal} [opts.signal]       request-level abort
 * @param {number} [opts.timeoutMs]         overall fetch timeout (default 120s)
 * @param {Function} [opts.fetchImpl]       test-only fetch override
 * @returns {Promise<{ buffer: Buffer, mimeType: string, model: string }>}
 */
export async function generateImageViaCodex({
  prompt,
  model = DEFAULT_MODEL,
  background,
  inputFidelity,
  signal,
  timeoutMs = GEN_TIMEOUT_MS,
  fetchImpl = fetch,
  credentialProvider = getCodexCredential,
} = {}) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('generateImageViaCodex: prompt is required');
  }

  const credential = await credentialProvider();
  if (!credential?.loggedIn) {
    const err = new Error(
      credential?.expired
        ? 'Codex login has expired. Reconnect Codex OAuth inside Melo and then retry.'
        : 'Codex login is not available. Connect Codex OAuth inside Melo and then retry.',
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  if (!credential.accountId) {
    const err = new Error('Codex login is missing the ChatGPT account id.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const sessionId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : randomUUID();

  // Keep the tool config minimal — only forward keys the user actually set,
  // so we don't accidentally pin a default that upstream may want to evolve.
  const imageTool = { type: 'image_generation' };
  if (background) imageTool.background = String(background);
  if (inputFidelity) imageTool.input_fidelity = String(inputFidelity);

  const body = {
    model,
    stream: true,
    store: false,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: prompt.slice(0, 4000) }],
      },
    ],
    tools: [imageTool],
    tool_choice: 'auto',
  };

  // Compose an abort signal that fires on either the caller's signal OR the
  // overall timeout. We use AbortSignal.any where available (Node 20+);
  // otherwise fall back to a manual linkage.
  const fetchSignal = composeSignals(signal, AbortSignal.timeout(timeoutMs));

  const response = await fetchImpl(CODEX_RESPONSES_ENDPOINT, {
    method: 'POST',
    headers: buildHeaders({
      accessToken: credential.accessToken,
      accountId: credential.accountId,
      sessionId,
    }),
    body: JSON.stringify(body),
    signal: fetchSignal,
  });

  if (!response.ok) {
    const raw = await safeReadText(response);
    let message = `Codex image generation HTTP ${response.status}`;
    try {
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed?.error?.message) message = `Codex: ${parsed.error.message}`;
      else if (parsed?.message) message = `Codex: ${parsed.message}`;
      else if (raw) message += `: ${raw.slice(0, 200)}`;
    } catch {
      if (raw) message += `: ${raw.slice(0, 200)}`;
    }
    const err = new Error(message);
    err.code = response.status === 401 || response.status === 403
      ? 'NOT_CONFIGURED'
      : 'GENERATE_FAILED';
    throw err;
  }

  // Walk the stream for the image_generation_call.done event (or, as a
  // fallback, the terminal response.completed event containing the item).
  let completedResponse = null;

  const imageItem = await consumeSseStream(
    response,
    event => {
      if (!event) return null;

      // Streaming-path success signal.
      if (event.type === 'response.output_item.done' && event.item?.type === 'image_generation_call') {
        const item = event.item;
        if (typeof item.result === 'string' && item.result) {
          return item;
        }
      }

      // Terminal completion — stash for the fallback path below. Don't
      // return yet: the stream may also carry output_item.done events we
      // prefer.
      if (event.type === 'response.completed' || event.type === 'response.done') {
        completedResponse = event.response || completedResponse;
        const fromOutput = findImageResultInOutput(completedResponse?.output);
        if (fromOutput) return fromOutput;
      }

      // Terminal failure.
      if (event.type === 'error' || event.type === 'response.failed') {
        const msg = eventErrorMessage(event);
        const err = new Error(msg);
        err.code = 'GENERATE_FAILED';
        throw err;
      }

      return null;
    },
    { idleTimeoutMs: IDLE_TIMEOUT_MS },
  );

  if (!imageItem) {
    // Final sweep: if we got a response.completed but missed the image on
    // first pass (e.g. output_item.done came after completed — rare but
    // observed on heavy load), check again against the stashed response.
    const fromStash = findImageResultInOutput(completedResponse?.output);
    if (!fromStash) {
      throw new Error('Codex image generation completed without an image_generation_call result.');
    }
    return bytesFromItem(fromStash, model);
  }

  return bytesFromItem(imageItem, model);
}

function bytesFromItem(item, model) {
  // `result` is base64 (no data: prefix per the spec). Be defensive in case
  // upstream starts emitting data URIs: strip the prefix if present.
  const raw = String(item.result || '').trim();
  const base64 = raw.startsWith('data:')
    ? raw.replace(/^data:[^,]*,/, '')
    : raw;

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw new Error('Codex image generation: result was not valid base64.');
  }

  if (buffer.length < IMAGE_MIN_BYTES) {
    throw new Error(
      `Codex image generation returned a suspiciously small buffer ` +
      `(${buffer.length} bytes; expected >= ${IMAGE_MIN_BYTES}). ` +
      `Likely an incomplete stream or a stub placeholder.`,
    );
  }

  const sniffed = detectImageMimeFromBytes(buffer);
  const hinted = mimeFromOutputFormat(item.output_format);
  const mimeType = sniffed || hinted;
  if (!mimeType) {
    const preview = buffer.slice(0, 32).toString('utf8').replace(/[\r\n\t]+/g, ' ').slice(0, 80);
    throw new Error(
      `Codex image generation failed magic-byte check ` +
      `(output_format=${item.output_format || 'n/a'}, head="${preview}"). ` +
      `Decoded base64 did not start with a known image header.`,
    );
  }

  return { buffer, mimeType, model };
}

/**
 * Convenience: generate → save to disk. Mirrors generateAndSaveImage in
 * imageGen.js so imageTool.js can treat the three engines uniformly.
 */
export async function generateAndSaveImageViaCodex({ outputPath, ...rest }) {
  if (!outputPath) throw new Error('generateAndSaveImageViaCodex: outputPath required');
  const { buffer, mimeType, model } = await generateImageViaCodex(rest);
  await writeFile(outputPath, buffer);
  return {
    path: outputPath,
    bytes: buffer.length,
    mimeType,
    model,
    sourceUrl: null,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

// AbortSignal.any is Node ≥ 20.3. Older Node would land on the manual path.
function composeSignals(userSignal, timeoutSignal) {
  if (typeof AbortSignal.any === 'function') {
    const signals = [timeoutSignal];
    if (userSignal) signals.unshift(userSignal);
    return AbortSignal.any(signals);
  }
  if (!userSignal) return timeoutSignal;

  const controller = new AbortController();
  const forwardAbort = signal => () => {
    if (!controller.signal.aborted) {
      controller.abort(signal?.reason);
    }
  };
  if (userSignal.aborted) return userSignal;
  if (timeoutSignal.aborted) return timeoutSignal;
  userSignal.addEventListener('abort', forwardAbort(userSignal), { once: true });
  timeoutSignal.addEventListener('abort', forwardAbort(timeoutSignal), { once: true });
  return controller.signal;
}
