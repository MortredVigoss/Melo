import { createReadStream } from 'node:fs';
import { createRouteRegistry } from './routeRegistry.js';
import { sendJson } from './transport.js';
import { saveUpload, uploadPath, uploadSize } from '../media/uploads.js';
import { attachmentPath, mimeTypeForName } from '../media/attachments.js';

const TYPES = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', mkv: 'video/x-matroska' };

// Types the browser may render inline from a same-origin URL: raster images
// and playable media. Everything else (svg, pdf, html, text, json, bin) is
// delivered as a download so an attachment can never run as a same-origin
// document with access to the local-write routes (audit L20).
const INLINE_TYPES = /^(?:image\/(?:png|jpeg|webp|gif|heic|heif|bmp|tiff|avif)|audio\/|video\/)/i;

// Serve a file with ranged (206) playback so WebKit can seek audio/video and
// resume downloads; shared by the upload and attachment routes (audit L11).
export function serveFileWithRanges(request, response, { path, size, type, headers = {} }) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''));
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...headers };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!(start <= end && start < size)) { response.writeHead(416, { 'Content-Range': `bytes */${size}`, ...headers }); response.end(); return; }
    response.writeHead(206, { ...base, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(path, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...base, 'Content-Length': size });
  if (request.method === 'HEAD') { response.end(); return; }
  createReadStream(path).pipe(response);
}

// `home` is captured when the server starts (§6), never read per request.
export function createMediaRoutes({ home }) {
  return createRouteRegistry([
    { method: 'POST', path: '/api/media/upload', auth: 'local-write', handler: async ({ request, response, url }) => {
      try {
        const saved = await saveUpload(request, { home, mimeType: String(request.headers['content-type'] || '').split(';')[0], fileName: url.searchParams.get('name') || '' });
        sendJson(response, 200, saved);
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error.message });
      }
    } },
    // Ranged playback so the chat's video player can seek.
    { method: 'GET', id: 'GET /api/media/uploads/:name', match: url => url.pathname.startsWith('/api/media/uploads/'), auth: 'local-read', handler: async ({ request, response, url }) => {
      const path = uploadPath(url.pathname, home);
      let size;
      try { size = path ? await uploadSize(path) : null; } catch { size = null; }
      if (!size) { sendJson(response, 404, { error: '视频不存在。' }); return; }
      const type = TYPES[path.split('.').pop()] || 'application/octet-stream';
      serveFileWithRanges(request, response, { path, size, type, headers: { 'X-Content-Type-Options': 'nosniff' } });
    } },
    // Externalized chat attachments (src/media/attachments.js). Names are
    // content-stable (<uuid>.<ext>, never rewritten), so the browser may cache
    // them for as long as it likes. Ranged so audio/video attachments play
    // and seek in WebKit (audit L11); non-renderable types download (L20).
    { method: 'GET', id: 'GET /api/media/attachments/:name', match: url => url.pathname.startsWith('/api/media/attachments/'), auth: 'local-read', handler: async ({ request, response, url }) => {
      const path = attachmentPath(url.pathname, home);
      let size;
      try { size = path ? await uploadSize(path) : null; } catch { size = null; }
      if (!path || size === null) { sendJson(response, 404, { error: '附件不存在。' }); return; }
      const type = mimeTypeForName(path);
      const headers = {
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        ...(INLINE_TYPES.test(type) ? {} : { 'Content-Disposition': `attachment; filename="${path.split('/').pop()}"`, 'Content-Security-Policy': 'sandbox' }),
      };
      serveFileWithRanges(request, response, { path, size, type, headers });
    } },
  ]);
}
