import test from 'node:test';
import assert from 'node:assert/strict';
import { routeHttpUrlClick } from './anchorRouting.js';

const SERVER_ORIGIN = 'http://127.0.0.1:43127';

test('routeHttpUrlClick: same-origin http anchor → same-origin route', () => {
  const result = routeHttpUrlClick('http://127.0.0.1:43127/artifacts/abc', SERVER_ORIGIN);
  assert.equal(result.kind, 'same-origin');
  assert.equal(result.href, 'http://127.0.0.1:43127/artifacts/abc');
});

test('routeHttpUrlClick: external https URL → external route', () => {
  const result = routeHttpUrlClick('https://example.com/page', SERVER_ORIGIN);
  assert.equal(result.kind, 'external');
  assert.equal(result.href, 'https://example.com/page');
});

test('routeHttpUrlClick: external URL with same host but different port → external', () => {
  const result = routeHttpUrlClick('http://127.0.0.1:9999/foo', SERVER_ORIGIN);
  assert.equal(result.kind, 'external');
});

test('routeHttpUrlClick: same host different scheme → external', () => {
  const result = routeHttpUrlClick('https://127.0.0.1:43127/x', SERVER_ORIGIN);
  assert.equal(result.kind, 'external');
});

test('routeHttpUrlClick: non-http scheme (mailto/javascript/data) → invalid', () => {
  for (const href of [
    'mailto:nobody@example.com',
    'javascript:void(0)',
    'data:text/plain;base64,aGk=',
    '#anchor',
    '/relative/path',
  ]) {
    const result = routeHttpUrlClick(href, SERVER_ORIGIN);
    assert.equal(result.kind, 'invalid', `expected invalid for ${href}`);
  }
});

test('routeHttpUrlClick: empty / null / undefined → invalid', () => {
  for (const href of ['', '   ', null, undefined]) {
    const result = routeHttpUrlClick(href, SERVER_ORIGIN);
    assert.equal(result.kind, 'invalid');
  }
});

test('routeHttpUrlClick: malformed URL → invalid', () => {
  // Starts with http:// (passes regex) but URL parsing throws.
  const result = routeHttpUrlClick('http://[::badly-formed', SERVER_ORIGIN);
  assert.equal(result.kind, 'invalid');
});

test('routeHttpUrlClick: URL with implicit default port (443/80) is normalized', () => {
  // location.origin omits default ports. Both anchors should classify as
  // same-origin against the default-port server origin.
  const httpsResult = routeHttpUrlClick(
    'https://example.com:443/page',
    'https://example.com',
  );
  assert.equal(httpsResult.kind, 'same-origin');

  const httpResult = routeHttpUrlClick(
    'http://example.com:80/page',
    'http://example.com',
  );
  assert.equal(httpResult.kind, 'same-origin');
});
