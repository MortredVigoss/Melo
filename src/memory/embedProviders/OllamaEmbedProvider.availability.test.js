import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaEmbedProvider } from './OllamaEmbedProvider.js';

// 2026-11-14: the availability probe armed a two-second abort timer and never
// cleared it, so `melo memory status` (which probes this provider) stayed
// alive for two seconds after the answer was known; seven cases of
// src/index.memoryCli.test.js paid that each.
const pendingTimers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;

async function probe(fetchStub) {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => { calls += 1; return fetchStub(...args); };
  try {
    const provider = new OllamaEmbedProvider({ env: {}, baseUrl: 'http://127.0.0.1:9', model: 'bge-m3' });
    const before = pendingTimers();
    const available = await provider.isAvailable();
    return { available, calls, left: pendingTimers() - before };
  } finally { globalThis.fetch = realFetch; }
}

test('the availability probe leaves no timer behind, whether the service refuses, answers or lacks the model', async () => {
  const refused = await probe(async () => { throw new TypeError('fetch failed'); });
  assert.deepEqual(refused, { available: false, calls: 1, left: 0 }, 'a refused connection');
  const present = await probe(async () => ({ ok: true, json: async () => ({ models: [{ name: 'bge-m3:latest' }] }) }));
  assert.deepEqual(present, { available: true, calls: 1, left: 0 }, 'the model is installed');
  const absent = await probe(async () => ({ ok: true, json: async () => ({ models: [{ name: 'other' }] }) }));
  assert.deepEqual(absent, { available: false, calls: 1, left: 0 }, 'the service runs without the model');
  const failing = await probe(async () => ({ ok: false, json: async () => ({}) }));
  assert.deepEqual(failing, { available: false, calls: 1, left: 0 }, 'an error status');
});
