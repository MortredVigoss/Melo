import { requestError } from '../services/chat/requestContract.js';
import { encodeResponse } from './bootstrapTransport.js';

export function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(encodeResponse(payload))}\n`);
}

export function startSse(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write(':ok\n\n');
}

export function writeSseEvent(response, event, payload) {
  if (response.writableEnded || response.destroyed) {
    return;
  }

  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(event === 'done' ? encodeResponse(payload) : payload)}\n\n`);
}

export async function readJsonBody(request, { maxBytes = Infinity } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // Drain oversized requests without buffering them. Throwing from inside
    // the iterator destroys the socket before the HTTP 413 can be delivered.
    if (size <= maxBytes) chunks.push(chunk);
  }
  if (size > maxBytes) throw Object.assign(new Error('资料超过同步容量，原数据已保留。'), {statusCode: 413, status: 413});

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch {
    throw requestError('INVALID_JSON', 'Request body must contain valid JSON.');
  }
}
