// Large photos are not refused: the browser sends a bounded copy (long edge
// ≤ 4096 px) instead of the original. Same rule as ImageLibrary.inputs on the phone.
export const MB = 1024 * 1024;
export const ATTACHMENT_LIMITS = Object.freeze({ image: 100 * MB, video: 500 * MB, default: 20 * MB });
export const TRANSFER_MAX_EDGE = 4096;
export const TRANSFER_KEEP_BYTES = 6 * MB;

export function attachmentLimit(kind) {
  return ATTACHMENT_LIMITS[kind] ?? ATTACHMENT_LIMITS.default;
}

export function needsTransferCopy({ size, width, height }) {
  return size > TRANSFER_KEEP_BYTES || Math.max(width, height) > TRANSFER_MAX_EDGE;
}

export function transferDimensions(width, height, maxEdge = TRANSFER_MAX_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// PNG keeps transparency; every other photo is sent as high-quality JPEG.
export function transferType(mimeType) {
  return mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
}

// Browser-only: returns a data URL of the copy, or null to send the file as is.
export async function makeTransferCopy(file, env = globalThis) {
  if (typeof env.createImageBitmap !== 'function' || !env.document) return null;
  const bitmap = await env.createImageBitmap(file);
  try {
    if (!needsTransferCopy({ size: file.size, width: bitmap.width, height: bitmap.height })) return null;
    const { width, height } = transferDimensions(bitmap.width, bitmap.height);
    const canvas = env.document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const type = transferType(file.type);
    return { url: canvas.toDataURL(type, 0.92), width, height, mimeType: type };
  } finally {
    bitmap.close?.();
  }
}

// Videos are streamed to the local server instead of being base64-encoded into
// the chat request; the attachment then carries the returned local URL.
export async function uploadVideoFile(file, fetchImpl = fetch) {
  const response = await fetchImpl(`/api/media/upload?name=${encodeURIComponent(file.name || 'video')}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'video/mp4' },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.url) throw new Error(payload.error || '视频上传失败。');
  return payload;
}
