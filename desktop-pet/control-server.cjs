'use strict';
const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');

function authorized(request, token) {
  const value = request.headers.authorization || '';
  const expected = `Bearer ${token}`;
  const actualBytes = Buffer.from(value), expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) throw Object.assign(new Error('消息过大。'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw Object.assign(new Error('无效的 JSON 请求。'), { status: 400 }); }
}

async function createControlServer({ token, onOpenChat, onChat, onQuit, health = () => ({ ok: true }) }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('A random control token is required.');
  const server = http.createServer(async (request, response) => {
    // No CORS: a webpage must not gain control of the local companion.
    if (request.headers.origin || !authorized(request, token)) { reply(response, 401, { error: 'Unauthorized' }); return; }
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && path === '/health') { reply(response, 200, health()); return; }
      if (request.method !== 'POST' || !['/open-chat', '/chat', '/quit'].includes(path)) { reply(response, 404, { error: 'Not found' }); return; }
      const body = await readBody(request);
      if (path === '/open-chat') {
        await onOpenChat(typeof body.petId === 'string' ? body.petId : '');
        reply(response, 200, { ok: true });
      } else if (path === '/chat') {
        if (typeof body.text !== 'string' || !body.text.trim()) { reply(response, 400, { error: '请输入消息。' }); return; }
        reply(response, 200, { ok: true, ...await onChat(body.text) });
      } else {
        reply(response, 200, { ok: true });
        setImmediate(onQuit);
      }
    } catch (error) {
      if (!response.writableEnded) reply(response, error.status || (error.code === 'SEND_IN_PROGRESS' ? 409 : 500), { error: error.message, code: error.code });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}

module.exports = { createControlServer };
