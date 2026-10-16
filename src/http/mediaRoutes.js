import { createReadStream } from 'node:fs';
import { createRouteRegistry } from './routeRegistry.js';
import { sendJson } from './transport.js';
import { saveUpload, uploadPath, uploadSize } from '../media/uploads.js';

const TYPES = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', mkv: 'video/x-matroska' };

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
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''));
      if (range) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (!(start <= end && start < size)) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return; }
        response.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
        createReadStream(path, { start, end }).pipe(response);
        return;
      }
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      createReadStream(path).pipe(response);
    } },
  ]);
}
