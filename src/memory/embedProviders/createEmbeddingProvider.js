/**
 * Factory for EmbeddingProvider.  Resolution order:
 *
 *   MELO_EMBED_PROVIDER env var  — explicit pick, values: 'ollama' | 'openai' | 'http'
 *   else: try ollama → openai → http in that order, picking the first available.
 *
 * Returns a thin wrapper with an LRU cache so repeated embeds are free.
 */

import { OllamaEmbedProvider } from './OllamaEmbedProvider.js';
import { OpenAIEmbedProvider } from './OpenAIEmbedProvider.js';
import { CustomHttpEmbedProvider } from './CustomHttpEmbedProvider.js';

const CACHE_SIZE = 512;

function makeCache() {
  const map = new Map();
  return {
    get(k) {
      if (!map.has(k)) return null;
      const v = map.get(k);
      map.delete(k);
      map.set(k, v);
      return v;
    },
    set(k, v) {
      if (map.size >= CACHE_SIZE) map.delete(map.keys().next().value);
      map.set(k, v);
    },
    clear() { map.clear(); },
  };
}

const REGISTRY = new Map();
REGISTRY.set('ollama', () => new OllamaEmbedProvider());
REGISTRY.set('openai', () => new OpenAIEmbedProvider());
REGISTRY.set('http', () => new CustomHttpEmbedProvider());

export function registerEmbeddingProvider(name, factory) { REGISTRY.set(name, factory); }

/**
 * Wrap a provider with an LRU cache so repeated embed() calls for the same
 * text are free.  Preserves the EmbeddingProvider shape.
 */
export function withEmbeddingCache(provider) {
  const cache = makeCache();
  return {
    ...provider,
    get dims() { return provider.dims; },
    get modelId() { return provider.modelId; },
    async isAvailable() { return provider.isAvailable(); },
    async embed(text) {
      const key = String(text || '').trim();
      if (!key) return null;
      const hit = cache.get(key);
      if (hit) return hit;
      const emb = await provider.embed(key);
      if (emb) cache.set(key, emb);
      return emb;
    },
    _resetCacheForTests() { cache.clear(); },
  };
}

let _singleton = null;

/** Build an EmbeddingProvider from env; caches the instance. */
export async function getEmbeddingProvider() {
  if (_singleton) return _singleton;

  const explicit = String(process.env.MELO_EMBED_PROVIDER || '').trim().toLowerCase();
  const order = explicit
    ? [explicit]
    : ['ollama', 'openai', 'http'];

  for (const name of order) {
    const factory = REGISTRY.get(name);
    if (!factory) continue;
    const p = factory();
    // eslint-disable-next-line no-await-in-loop
    if (await p.isAvailable()) {
      _singleton = withEmbeddingCache(p);
      return _singleton;
    }
  }

  _singleton = null;
  return null;
}

export function _resetEmbeddingProviderForTests() { _singleton = null; }
