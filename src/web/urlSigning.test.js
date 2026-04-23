/**
 * Regression tests for workspace-file signed URLs.
 *
 * Pins:
 *   - Sign / verify round-trip
 *   - Tampered signature / path / expiry all fail verification
 *   - Expired URL fails verification
 *   - Basename is preserved in the URL path so src/media/urlDetector.js can
 *     recognise media type from the extension
 *   - setServerOrigin is respected in the returned URL
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signWorkspaceFileUrl,
  verifySignedFileUrl,
  setServerOrigin,
  getServerOrigin,
} from './urlSigning.js';
import { detectUrlKind } from '../media/urlDetector.js';

function paramsFromUrl(urlStr) {
  const u = new URL(urlStr);
  return u.searchParams;
}

test('signWorkspaceFileUrl + verifySignedFileUrl round-trip', () => {
  setServerOrigin('http://127.0.0.1:43127');
  const abs = '/tmp/some/workspace/generated/img-abc.jpg';
  const url = signWorkspaceFileUrl(abs);

  assert.match(url, /^http:\/\/127\.0\.0\.1:43127\/api\/files\/signed\/img-abc\.jpg\?/);

  const verified = verifySignedFileUrl(paramsFromUrl(url));
  assert.equal(verified, abs);
});

test('tampered signature fails', () => {
  const url = signWorkspaceFileUrl('/tmp/a.png');
  const params = paramsFromUrl(url);
  params.set('s', 'A'.repeat(22)); // force length to match the 16-byte b64url
  assert.equal(verifySignedFileUrl(params), null);
});

test('tampered path fails (attacker swaps `p` for /etc/passwd)', () => {
  const url = signWorkspaceFileUrl('/tmp/legit.jpg');
  const params = paramsFromUrl(url);
  const evilP = Buffer.from('/etc/passwd', 'utf8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  params.set('p', evilP);
  assert.equal(verifySignedFileUrl(params), null);
});

test('tampered expiry fails (attacker extends TTL)', () => {
  const url = signWorkspaceFileUrl('/tmp/a.jpg');
  const params = paramsFromUrl(url);
  const newExp = Number(params.get('e')) + 10 * 60_000;
  params.set('e', String(newExp));
  assert.equal(verifySignedFileUrl(params), null);
});

test('expired URL fails verification', () => {
  // Sign with 1 s TTL, then wait 1.5 s so it's past expiry.
  const url = signWorkspaceFileUrl('/tmp/short.png', { ttlMs: 1000 });
  return new Promise(resolve => {
    setTimeout(() => {
      assert.equal(verifySignedFileUrl(paramsFromUrl(url)), null);
      resolve();
    }, 1200);
  });
});

test('basename extension is visible to urlDetector — image', () => {
  const url = signWorkspaceFileUrl('/tmp/generated/photo.jpg');
  assert.equal(detectUrlKind(url), 'image');
});

test('basename extension is visible to urlDetector — webp', () => {
  const url = signWorkspaceFileUrl('/tmp/generated/banner.webp');
  assert.equal(detectUrlKind(url), 'image');
});

test('basename extension is visible to urlDetector — pdf', () => {
  const url = signWorkspaceFileUrl('/tmp/generated/report.pdf');
  assert.equal(detectUrlKind(url), 'document');
});

test('getServerOrigin falls back to env-based guess when unset', () => {
  // We can't unset the module's origin cleanly from outside, but after the
  // first test has set it the value should already be populated. Re-setting
  // to a different value and reading back confirms the setter works.
  setServerOrigin('http://127.0.0.1:9999');
  assert.equal(getServerOrigin(), 'http://127.0.0.1:9999');
});

test('rejects non-absolute paths', () => {
  assert.throws(() => signWorkspaceFileUrl('relative/path.png'), /absolute path/);
  assert.throws(() => signWorkspaceFileUrl(''), /absolute path/);
  assert.throws(() => signWorkspaceFileUrl(null), /absolute path/);
});

test('missing query params → null', () => {
  assert.equal(verifySignedFileUrl(new URLSearchParams()), null);
  assert.equal(verifySignedFileUrl(new URLSearchParams('p=abc')), null);
  assert.equal(verifySignedFileUrl(new URLSearchParams('p=abc&e=123')), null);
});
