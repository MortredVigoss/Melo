/**
 * src/services/tts/nativeStopEndpointsGuard.test.js
 *
 * Regression guard: every native-TTS stop endpoint must clear the
 * streaming say queue (`_nativeSayQueue?.clear()`).
 *
 * History: Bug 1 (987f6e2, 2026-05-12) introduced the native say queue
 * and wired `clear()` into `/api/tts/speak-stop` + `/api/tts/queue-clear`.
 * Codex 🔵 on that commit caught that `/api/tts/native-stop` (the legacy
 * stop alias) was overlooked — leaving macOS streaming un-stoppable
 * through that path.  Follow-up commit fixed it.  This guard pins all
 * three endpoints so a future refactor can't quietly drop one.
 *
 * Source-level rather than HTTP integration: server.js is a long-lived
 * top-level-await module with massive boot side-effects (state hydration,
 * MCP init, lock acquisition).  Importing-for-test isn't practical and
 * an integration test would require booting the real server.  The
 * invariant we care about — "every stop-like endpoint body must mention
 * `_nativeSayQueue?.clear()`" — is structural and a source check is the
 * right granularity.  Combined with the pure unit tests in
 * `nativeSayQueue.test.js`, the queue's actual behavior is well-covered.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// src/services/tts/ → src/server.js is ../../server.js
const serverJsSource = readFileSync(join(here, '..', '..', 'server.js'), 'utf8');

/**
 * Pull out a routing block of the form:
 *   if (url.pathname === '<path>' && request.method === 'POST') { ... }
 * Returns the block body (between matching braces).
 */
function getRouteBody(source, pathname) {
  const sigil = `url.pathname === '${pathname}' && request.method === 'POST'`;
  const sigilIdx = source.indexOf(sigil);
  if (sigilIdx < 0) return null;
  const openIdx = source.indexOf('{', sigilIdx);
  if (openIdx < 0) return null;
  let depth = 0;
  for (let i = openIdx; i < source.length; i += 1) {
    const c = source[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  return null;
}

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const STOP_ENDPOINTS = [
  '/api/tts/speak-stop',
  '/api/tts/queue-clear',
  '/api/tts/native-stop',
];

for (const path of STOP_ENDPOINTS) {
  test(`${path} body exists in server.js`, () => {
    const body = getRouteBody(serverJsSource, path);
    assert.ok(body, `must find a POST handler for ${path}`);
  });

  test(`${path} calls _nativeSayQueue.clear() (Bug 1 native-queue stop coverage)`, () => {
    const body = getRouteBody(serverJsSource, path);
    const code = stripComments(body);
    // Accept any of: `_nativeSayQueue.clear()` or `_nativeSayQueue?.clear()`.
    // The optional-chaining form is what we landed on; the dot form is
    // also acceptable since the singleton may be eagerly initialized in
    // a future refactor.
    assert.match(code, /_nativeSayQueue\??\.clear\(\)/,
      `${path} must invoke _nativeSayQueue.clear() — otherwise streaming say playback can outlive the stop`);
  });
}
