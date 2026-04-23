/**
 * MiniMax image generation (T2I).
 *
 * Mirrors the shape of src/tts.js — same credentials (`minimaxApiKey`,
 * `minimaxGroupId`), same base host, same Bearer-token auth.
 *
 * API
 * ---
 *   POST https://api.minimaxi.chat/v1/image_generation
 *   headers: Authorization: Bearer <minimaxApiKey>
 *   body:
 *     {
 *       "model": "image-01",
 *       "prompt": "…",
 *       "aspect_ratio": "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3",
 *       "n": 1
 *     }
 *
 * Response shape (observed):
 *   {
 *     "id": "...",
 *     "data": { "image_urls": ["https://...jpg"] },
 *     "base_resp": { "status_code": 0, "status_msg": "" }
 *   }
 *
 * Non-zero `status_code` indicates an application-level error even when the
 * HTTP status is 200.
 */

import { writeFile } from 'node:fs/promises';

const MINIMAX_IMAGE_BASE = 'https://api.minimaxi.chat/v1/image_generation';
const MINIMAX_IMAGE_MODEL = 'image-01';
const GEN_TIMEOUT_MS = 90_000;

const VALID_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

// ─── Download validation ────────────────────────────────────────────────────
//
// MiniMax can return 200 OK with a non-image body (HTML error page, empty
// body, rate-limit JSON). `content-type` header is sometimes incorrect too.
// We trust the bytes, not the server's story:
//   1) size >= IMAGE_MIN_BYTES (real images are never this small)
//   2) leading bytes match a known image format magic
//
// Detected mime wins over the response header so downstream consumers get
// an authoritative content-type.

const IMAGE_MIN_BYTES = 1024;

/**
 * Sniff image format from buffer magic bytes.
 * Returns `image/png` | `image/jpeg` | `image/webp` | `image/gif` | null.
 */
export function detectImageMimeFromBytes(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }
  // WebP: "RIFF" ???? "WEBP"
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  // GIF: "GIF8"
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }
  return null;
}

/**
 * Generate an image via MiniMax.
 *
 * @param {object} opts
 * @param {string} opts.prompt         free-text description
 * @param {string} [opts.aspectRatio]  default "1:1"
 * @param {string} opts.apiKey
 * @param {string} [opts.groupId]      optional (TTS uses it as ?GroupId=…; unclear for image API — pass through for safety)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ buffer: Buffer, mimeType: string, sourceUrl: string }>}
 */
export async function generateImageViaMinimax({ prompt, aspectRatio = '1:1', apiKey, groupId, signal }) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('generateImageViaMinimax: prompt is required');
  }
  if (!apiKey) {
    throw new Error('generateImageViaMinimax: apiKey is required');
  }
  const ratio = VALID_ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : '1:1';

  const url = groupId
    ? `${MINIMAX_IMAGE_BASE}?GroupId=${encodeURIComponent(groupId)}`
    : MINIMAX_IMAGE_BASE;

  const res = await fetch(url, {
    method: 'POST',
    signal: signal || AbortSignal.timeout(GEN_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MINIMAX_IMAGE_MODEL,
      prompt: prompt.slice(0, 1500),
      aspect_ratio: ratio,
      n: 1,
      response_format: 'url',
    }),
  });

  if (!res.ok) {
    throw new Error(`MiniMax image generation HTTP ${res.status}`);
  }
  const data = await res.json();
  const statusCode = data?.base_resp?.status_code;
  if (statusCode !== undefined && statusCode !== 0) {
    const msg = data?.base_resp?.status_msg || `status_code ${statusCode}`;
    throw new Error(`MiniMax image generation failed: ${msg}`);
  }
  const imageUrl = data?.data?.image_urls?.[0];
  if (!imageUrl) {
    throw new Error('MiniMax image generation: no image_urls in response');
  }

  // Download the generated image. MiniMax URLs are usually pre-signed and
  // short-lived, so caching them on disk is the right move.
  const imgRes = await fetch(imageUrl, {
    signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  });
  if (!imgRes.ok) {
    throw new Error(`Failed to download generated image: HTTP ${imgRes.status}`);
  }
  const headerMime = imgRes.headers.get('content-type') || '';
  const buffer = Buffer.from(await imgRes.arrayBuffer());

  // Validate before returning. MiniMax sometimes hands back an error page
  // or an empty body with HTTP 200 — catching it here gives the caller a
  // clear error instead of a user-visible broken image.
  if (buffer.length < IMAGE_MIN_BYTES) {
    throw new Error(
      `Generated image is too small (${buffer.length} bytes, expected >= ${IMAGE_MIN_BYTES}). ` +
      `MiniMax likely returned an error body instead of an image.`,
    );
  }
  const sniffedMime = detectImageMimeFromBytes(buffer);
  if (!sniffedMime) {
    const preview = buffer.slice(0, 32).toString('utf8').replace(/[\r\n\t]+/g, ' ').slice(0, 80);
    throw new Error(
      `Generated image failed magic-byte check (content-type=${headerMime || 'n/a'}, head="${preview}"). ` +
      `Response did not start with a known image header (PNG/JPEG/WebP/GIF).`,
    );
  }

  return { buffer, mimeType: sniffedMime, sourceUrl: imageUrl };
}

/**
 * Convenience: generate → save to disk. Returns absolute path.
 *
 * @param {object} opts          same as generateImageViaMinimax
 * @param {string} opts.outputPath  absolute destination path
 * @returns {Promise<{ path: string, bytes: number, mimeType: string }>}
 */
export async function generateAndSaveImage({ outputPath, ...rest }) {
  if (!outputPath) throw new Error('generateAndSaveImage: outputPath required');
  const { buffer, mimeType, sourceUrl } = await generateImageViaMinimax(rest);
  await writeFile(outputPath, buffer);
  return { path: outputPath, bytes: buffer.length, mimeType, sourceUrl };
}
