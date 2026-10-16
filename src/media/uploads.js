// Large videos are uploaded as a byte stream into the Melo home instead of
// travelling as base64 inside the chat request. Attachments then carry a
// local URL (/api/media/uploads/<name>) that the player and the video
// extractor both understand.
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const EXTENSIONS = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v', 'video/webm': 'webm', 'video/x-matroska': 'mkv' };
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp4|mov|m4v|webm|mkv)$/;
const URL_PREFIX = '/api/media/uploads/';

export const uploadsDir = home => join(home, 'desktop', 'media', 'uploads');
export const uploadUrl = name => URL_PREFIX + name;

export function extensionFor(mimeType, fileName = '') {
  return EXTENSIONS[mimeType] || (/\.(mp4|mov|m4v|webm|mkv)$/i.exec(fileName)?.[1]?.toLowerCase() ?? null);
}

// The file a local upload URL points to, or null for anything else.
export function uploadPath(url, home) {
  const value = String(url || '');
  if (!value.startsWith(URL_PREFIX)) return null;
  const name = value.slice(URL_PREFIX.length);
  return NAME.test(name) ? join(uploadsDir(home), name) : null;
}

// Streams the request body to disk; rejects (and removes the partial file)
// once more than maxBytes arrive, so an oversized upload never fills the disk.
export async function saveUpload(stream, { home, mimeType, fileName, maxBytes = MAX_UPLOAD_BYTES }) {
  const extension = extensionFor(mimeType, fileName);
  if (!extension) throw Object.assign(new Error('只支持 MP4、MOV、M4V、WebM、MKV 视频。'), { statusCode: 415 });
  const dir = uploadsDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `${randomUUID()}.${extension}`, partial = join(dir, `.${name}.part`);
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = createWriteStream(partial, { mode: 0o600 });
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { stream.destroy(); out.destroy(); reject(Object.assign(new Error(`视频超过 ${Math.round(maxBytes / 1024 / 1024)} MB，未保存。`), { statusCode: 413 })); }
      });
      stream.on('error', reject); out.on('error', reject);
      out.on('finish', resolve);
      stream.pipe(out);
    });
    if (!size) throw Object.assign(new Error('没有收到视频内容。'), { statusCode: 400 });
    await rename(partial, join(dir, name));
    return { name, url: uploadUrl(name), size };
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

export async function uploadSize(path) {
  return (await stat(path)).size;
}
