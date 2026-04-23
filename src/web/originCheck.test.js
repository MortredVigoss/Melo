/**
 * Tests for the CSRF Origin guard used on state-mutating POST endpoints
 * like /api/skills/custom, /api/customize/skill-toggle, etc.
 *
 * The server binds to 127.0.0.1:<port> by default. A malicious page in the
 * user's browser could still POST at the server with an Origin header from
 * another domain; this helper rejects those, while allowing same-origin
 * requests and Origin-less (CLI / native WebView) callers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isOriginAllowed } from './originCheck.js';

const HOST = '127.0.0.1';
const PORT = 43127;

test('allows requests with no Origin header (CLI / WebView)', () => {
  assert.equal(isOriginAllowed(undefined, HOST, PORT), true);
  assert.equal(isOriginAllowed(null, HOST, PORT), true);
  assert.equal(isOriginAllowed('', HOST, PORT), true);
});

test('allows same-host same-port origins (explicit host)', () => {
  assert.equal(isOriginAllowed('http://127.0.0.1:43127', HOST, PORT), true);
});

test('allows localhost and 127.0.0.1 aliases regardless of bound host', () => {
  assert.equal(isOriginAllowed('http://localhost:43127', HOST, PORT), true);
  assert.equal(isOriginAllowed('http://127.0.0.1:43127', HOST, PORT), true);
});

test('rejects cross-origin attackers (remote HTTPS)', () => {
  assert.equal(isOriginAllowed('https://evil.com', HOST, PORT), false);
  assert.equal(isOriginAllowed('https://example.com', HOST, PORT), false);
});

test('rejects same hostname on different port (e.g. dev server)', () => {
  assert.equal(isOriginAllowed('http://127.0.0.1:3000', HOST, PORT), false);
  assert.equal(isOriginAllowed('http://localhost:8080', HOST, PORT), false);
});

test('rejects scheme mismatch (https → http server)', () => {
  assert.equal(isOriginAllowed('https://127.0.0.1:43127', HOST, PORT), false);
  assert.equal(isOriginAllowed('https://localhost:43127', HOST, PORT), false);
});

test('rejects suffix / prefix attacks that look like localhost', () => {
  assert.equal(isOriginAllowed('http://127.0.0.1.evil.com:43127', HOST, PORT), false);
  assert.equal(isOriginAllowed('http://evil.com?x=http://127.0.0.1:43127', HOST, PORT), false);
  assert.equal(isOriginAllowed('http://alocalhost:43127', HOST, PORT), false);
});

test('rejects a "null" Origin string (opaque origin, e.g. from data: URLs)', () => {
  // "null" is an explicit string, not a falsy value, so the guard must
  // reject it rather than treat it as "no Origin".
  assert.equal(isOriginAllowed('null', HOST, PORT), false);
});

test('respects a non-default bound host (e.g. 0.0.0.0)', () => {
  // When bound host is 0.0.0.0, localhost/127.0.0.1 aliases still work,
  // and explicit 0.0.0.0 still works.
  assert.equal(isOriginAllowed('http://0.0.0.0:43127', '0.0.0.0', PORT), true);
  assert.equal(isOriginAllowed('http://127.0.0.1:43127', '0.0.0.0', PORT), true);
  assert.equal(isOriginAllowed('http://localhost:43127', '0.0.0.0', PORT), true);
});
