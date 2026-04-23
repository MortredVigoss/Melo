import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCookiesForUrl } from './youtubeExtractor.js';

test('resolveCookiesForUrl returns empty string when no config provided', () => {
  assert.equal(resolveCookiesForUrl('https://www.douyin.com/video/123', undefined), '');
  assert.equal(resolveCookiesForUrl('https://www.douyin.com/video/123', null), '');
  assert.equal(resolveCookiesForUrl('https://www.douyin.com/video/123', {}), '');
});

test('resolveCookiesForUrl returns empty when domainCookies is not an object', () => {
  assert.equal(resolveCookiesForUrl('https://douyin.com/v/1', { domainCookies: null }), '');
  assert.equal(resolveCookiesForUrl('https://douyin.com/v/1', { domainCookies: 'uin=abc' }), '');
  assert.equal(resolveCookiesForUrl('https://douyin.com/v/1', { domainCookies: [] }), '');
});

test('resolveCookiesForUrl matches exact hostname (after stripping www.)', () => {
  const config = {
    domainCookies: {
      'douyin.com': 'sessionid=douyin-session',
      'tiktok.com': 'sid_guard=tiktok-sid',
    },
  };
  assert.equal(
    resolveCookiesForUrl('https://www.douyin.com/video/abc', config),
    'sessionid=douyin-session',
  );
  assert.equal(
    resolveCookiesForUrl('https://tiktok.com/@user/video/1', config),
    'sid_guard=tiktok-sid',
  );
});

test('resolveCookiesForUrl matches subdomains via suffix match', () => {
  const config = {
    domainCookies: {
      'qq.com': 'uin=1234567; skey=abcd',
    },
  };
  // y.qq.com ends with ".qq.com"
  assert.equal(
    resolveCookiesForUrl('https://y.qq.com/n/ryqq/albumDetail/xyz', config),
    'uin=1234567; skey=abcd',
  );
  // subdomain chain also resolves
  assert.equal(
    resolveCookiesForUrl('https://a.b.qq.com/path', config),
    'uin=1234567; skey=abcd',
  );
});

test('resolveCookiesForUrl tolerates leading dot and www. in the config key', () => {
  const config = {
    domainCookies: {
      '.bilibili.com': 'SESSDATA=abc',
      'www.example.com': 'example=yes',
    },
  };
  assert.equal(
    resolveCookiesForUrl('https://www.bilibili.com/video/BV1xx', config),
    'SESSDATA=abc',
  );
  assert.equal(
    resolveCookiesForUrl('https://example.com/page', config),
    'example=yes',
  );
});

test('resolveCookiesForUrl returns empty string for a non-matching domain', () => {
  const config = {
    domainCookies: { 'douyin.com': 'sessionid=abc' },
  };
  assert.equal(resolveCookiesForUrl('https://www.youtube.com/watch?v=xyz', config), '');
  assert.equal(resolveCookiesForUrl('https://unrelated.example/path', config), '');
});

test('resolveCookiesForUrl returns empty for invalid URL input', () => {
  const config = { domainCookies: { 'douyin.com': 'sessionid=abc' } };
  assert.equal(resolveCookiesForUrl('not a url', config), '');
  assert.equal(resolveCookiesForUrl('', config), '');
  assert.equal(resolveCookiesForUrl(null, config), '');
});

test('resolveCookiesForUrl prefix false-match protection: "example.com" must not leak into "otherexample.com"', () => {
  // Hostname suffix match requires a preceding dot, so "otherexample.com" should NOT match "example.com".
  const config = {
    domainCookies: { 'example.com': 'leak=no' },
  };
  assert.equal(
    resolveCookiesForUrl('https://otherexample.com/page', config),
    '',
  );
});

test('resolveCookiesForUrl skips blank/empty domain keys', () => {
  const config = {
    domainCookies: {
      '': 'blank=key',
      '.': 'dot=key',
      'douyin.com': 'real=cookie',
    },
  };
  assert.equal(
    resolveCookiesForUrl('https://www.douyin.com/x', config),
    'real=cookie',
  );
});

test('resolveCookiesForUrl coerces non-string cookie values safely', () => {
  const config = {
    domainCookies: {
      'douyin.com': null,      // becomes ''
      'tiktok.com': '',         // already empty
    },
  };
  assert.equal(resolveCookiesForUrl('https://douyin.com/', config), '');
  assert.equal(resolveCookiesForUrl('https://tiktok.com/', config), '');
});

test('resolveCookiesForUrl trims whitespace around the cookie value', () => {
  const config = {
    domainCookies: {
      'douyin.com': '  sessionid=abc; other=1   ',
    },
  };
  assert.equal(
    resolveCookiesForUrl('https://douyin.com/', config),
    'sessionid=abc; other=1',
  );
});
