'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createControlServer } = require('../control-server.cjs');

async function fixture(t, options = {}) {
  const calls = [];
  const token = randomBytes(32).toString('hex');
  const server = await createControlServer({ token,
    onOpenChat: petId => { calls.push(['open', petId]); },
    onChat: async text => { calls.push(['chat', text]); return { text: `原样 ${text}`, source: 'melo' }; },
    onQuit: () => { calls.push(['quit']); },
    health: () => ({ ok: true, busy: false }),
    ...options,
  });
  t.after(() => server.close());
  const request = async (path, body, headers = {}) => {
    const response = await fetch(server.url + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, token, request, calls };
}

test('opens only through an authenticated request and passes the selected pet id', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.request('/open-chat', { petId: 'winter' }), { status: 200, body: { ok: true } });
  assert.deepEqual(f.calls, [['open', 'winter']]);
  assert.deepEqual((await f.request('/health')).body, { ok: true, busy: false });
});

test('rejects missing/wrong token and browser origins without invoking any handlers', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/open-chat', {}, { authorization: '' })).status, 401);
  assert.equal((await f.request('/chat', { text: 'do this' }, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await f.request('/quit', {}, { origin: 'https://untrusted.example' })).status, 401);
  assert.equal((await f.request('/health', undefined, { authorization: '' })).status, 401);
  assert.deepEqual(f.calls, []);
});

test('chat waits for the authoritative adapter response and preserves input whitespace', async t => {
  const f = await fixture(t);
  const text = '  一条实际消息\n第二行  ';
  const response = await f.request('/chat', { text });
  assert.equal(response.status, 200);
  assert.equal(response.body.text, `原样 ${text}`);
  assert.deepEqual(f.calls, [['chat', text]]);
});

test('invalid payloads, excessive bodies, and unknown routes do not execute actions', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/chat', { text: '   ' })).status, 400);
  assert.equal((await f.request('/chat', '{bad')).status, 400);
  assert.equal((await f.request('/open-chat', '[]')).status, 400);
  assert.equal((await f.request('/unknown', {})).status, 404);
  assert.equal((await f.request('/chat', { text: 'x'.repeat(129 * 1024) })).status, 413);
  assert.deepEqual(f.calls, []);
});

test('adapter errors remain errors instead of successful synthetic dialogue', async t => {
  const f = await fixture(t, { onChat: () => { throw Object.assign(new Error('busy upstream'), { code: 'SEND_IN_PROGRESS' }); } });
  assert.deepEqual(await f.request('/chat', { text: 'hello' }), { status: 409, body: { error: 'busy upstream', code: 'SEND_IN_PROGRESS' } });
});

test('quit acknowledges before requesting process shutdown', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.request('/quit', {}), { status: 200, body: { ok: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, [['quit']]);
});
