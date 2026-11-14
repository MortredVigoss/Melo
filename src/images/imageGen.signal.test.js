// The MiniMax image request and the download of its result: each must end at
// the time limit AND at the caller's cancel.
//
// Until 2026-11-14 a caller's signal replaced the limit on the request (both
// product callers pass one, so the 90 s limit never applied), and the
// download had the limit but ignored the cancel.
//
// `fetch` is replaced by a stand-in that never answers and only ends when the
// signal it was given fires, which is how a silent server looks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImageViaMinimax } from './imageGen.js';

function neverAnswers(init, seen) {
  seen.push(init?.signal);
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) return; // would hang: the test's own guard reports it
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

// Resolves to what the call did within `guardMs`, or to 'still waiting'.
async function outcome(call, guardMs = 1500) {
  let timer;
  const guard = new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'still waiting' }), guardMs); });
  try {
    return await Promise.race([call.then(value => ({ state: 'returned', value }), error => ({ state: 'rejected', error })), guard]);
  } finally {
    clearTimeout(timer);
  }
}

async function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}

const apiAnswer = { ok: true, status: 200, json: async () => ({ data: { image_urls: ['https://cdn.example/picture.png'] }, base_resp: { status_code: 0 } }) };

test('the request ends at the time limit even when the caller passes a signal of its own', async () => {
  const seen = [];
  const caller = new AbortController(); // never aborted, like a turn nobody cancels
  const started = Date.now();
  const result = await withFetch((url, init) => neverAnswers(init, seen), () =>
    outcome(generateImageViaMinimax({ prompt: 'a lighthouse', apiKey: 'k', signal: caller.signal, timeoutMs: 80 })));
  assert.equal(result.state, 'rejected', 'the silent request is given up, it does not wait for the caller');
  assert.equal(result.error?.name, 'TimeoutError');
  assert.ok(Date.now() - started < 1000);
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], caller.signal, 'the request does not get the bare caller signal');
});

test('the request still ends at once when the caller cancels', async () => {
  const seen = [];
  const caller = new AbortController();
  setTimeout(() => caller.abort(), 30);
  const result = await withFetch((url, init) => neverAnswers(init, seen), () =>
    outcome(generateImageViaMinimax({ prompt: 'a lighthouse', apiKey: 'k', signal: caller.signal, timeoutMs: 60_000 })));
  assert.equal(result.state, 'rejected');
  assert.equal(result.error?.name, 'AbortError');
});

test('without a caller signal the time limit applies, as before', async () => {
  const seen = [];
  const result = await withFetch((url, init) => neverAnswers(init, seen), () =>
    outcome(generateImageViaMinimax({ prompt: 'a lighthouse', apiKey: 'k', timeoutMs: 80 })));
  assert.equal(result.state, 'rejected');
  assert.equal(result.error?.name, 'TimeoutError');
});

test('the download of the generated image is stopped by the caller\'s cancel', async () => {
  const seen = [];
  const caller = new AbortController();
  let downloads = 0;
  const stub = (url, init) => {
    if (String(url).includes('api.minimaxi.chat')) return Promise.resolve(apiAnswer);
    downloads += 1;
    setTimeout(() => caller.abort(), 30); // the user cancels while the image is downloading
    return neverAnswers(init, seen);
  };
  const result = await withFetch(stub, () =>
    outcome(generateImageViaMinimax({ prompt: 'a lighthouse', apiKey: 'k', signal: caller.signal, timeoutMs: 60_000 })));
  assert.equal(downloads, 1, 'the download had started');
  assert.equal(result.state, 'rejected', 'the download does not go on for the rest of its time limit');
  assert.equal(result.error?.name, 'AbortError');
});

test('the download ends at the time limit as well', async () => {
  const seen = [];
  const caller = new AbortController();
  const stub = (url, init) => String(url).includes('api.minimaxi.chat') ? Promise.resolve(apiAnswer) : neverAnswers(init, seen);
  const result = await withFetch(stub, () =>
    outcome(generateImageViaMinimax({ prompt: 'a lighthouse', apiKey: 'k', signal: caller.signal, timeoutMs: 80 })));
  assert.equal(result.state, 'rejected');
  assert.equal(result.error?.name, 'TimeoutError');
});
