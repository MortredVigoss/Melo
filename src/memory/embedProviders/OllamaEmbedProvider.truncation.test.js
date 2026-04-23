/**
 * Phase 2 #1 — Ollama input truncation is configurable (default 8192, not 512).
 *
 * The legacy 512-char cap silently discarded everything after 512 chars before
 * passing to bge-m3, so long frames/scenes were being embedded from only their
 * first sentence.  Now the cap defaults to 8192 (matching OpenAI provider)
 * and honours MELO_OLLAMA_MAX_INPUT_CHARS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaEmbedProvider } from './OllamaEmbedProvider.js';

/** A fetch stub that records the request body and returns a 1024-dim embedding. */
function makeFetchStub(records) {
  return async (url, init) => {
    records.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: true,
      async json() {
        return { embeddings: [Array.from({ length: 1024 }, () => 0.1)] };
      },
    };
  };
}

test('OllamaEmbedProvider: default maxInputChars is 8192 (not 512)', async () => {
  const records = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(records);
  try {
    const p = new OllamaEmbedProvider();
    // A 3000-char input that used to be truncated to 512.
    const long = 'a'.repeat(3000);
    const vec = await p.embed(long);
    assert.ok(vec instanceof Float32Array);
    assert.equal(records.length, 1);
    // The outbound body's input field should preserve the full 3000 chars,
    // not the old 512 ceiling.
    assert.equal(
      records[0].body.input.length,
      3000,
      'Ollama must no longer truncate to 512 chars',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaEmbedProvider: honours maxInputChars constructor option', async () => {
  const records = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(records);
  try {
    const p = new OllamaEmbedProvider({ maxInputChars: 100 });
    const vec = await p.embed('x'.repeat(500));
    assert.ok(vec instanceof Float32Array);
    assert.equal(records[0].body.input.length, 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaEmbedProvider: caps at the configured max for inputs longer than it', async () => {
  const records = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(records);
  try {
    const p = new OllamaEmbedProvider({ maxInputChars: 2048 });
    const vec = await p.embed('y'.repeat(10_000));
    assert.ok(vec instanceof Float32Array);
    assert.equal(records[0].body.input.length, 2048);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaEmbedProvider: rejects empty input fast (no fetch call)', async () => {
  const records = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(records);
  try {
    const p = new OllamaEmbedProvider();
    assert.equal(await p.embed(''), null);
    assert.equal(await p.embed('   '), null);
    assert.equal(records.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
