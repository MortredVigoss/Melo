import { BuiltinEmbedProvider } from './BuiltinEmbedProvider.js';
import { readFileSync } from 'node:fs';
import { getConfigPath } from '../../config.js';
import { requestEnvironment } from '../../runtime/requestScope.js';
/**
 * Factory for EmbeddingProvider.  Resolution order:
 *
 *   MELO_EMBED_PROVIDER env var — explicit integration override.
 *   Otherwise use only Melo's bundled local model. Never auto-probe external
 *   applications or silently send memory text to a cloud embedding service.
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

// Exported so probe-only paths (status.js → probeEmbeddingProviderAvailability)
// can iterate the same factories getEmbeddingProvider would, surfacing
// per-provider rejection reasons without booting the singleton.
export const REGISTRY = new Map();
REGISTRY.set('builtin', () => new BuiltinEmbedProvider());
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
    get observedDims() { return provider.observedDims ?? provider.dims; },
    async probe(text) { return provider.embed(text); },
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
let _singletonKey = null;

/** Build an EmbeddingProvider from env; caches the instance. */
export async function getEmbeddingProvider() {
  const configPath = getConfigPath();
  const env = { ...requestEnvironment() };
  let connection = null;
  try { connection = JSON.parse(readFileSync(configPath, 'utf8')).embeddingConnection; } catch {}
  const key = JSON.stringify([configPath, connection, env.MELO_EMBED_PROVIDER, env.MELO_EMBED_MODEL_DIR]);
  if (_singleton && _singletonKey === key) return _singleton;
  _singleton = null; _singletonKey = key;
  const explicit = String(env.MELO_EMBED_PROVIDER || '').trim().toLowerCase();
  // Local semantic retrieval is owned by Melo. No probing of other apps or
  // automatic cloud fallback; external adapters remain explicit integrations.
  const order = explicit ? [explicit] : ['builtin'];

  const candidates = order.map(name => REGISTRY.get(name)?.()).filter(Boolean);
  for (const p of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await p.isAvailable()) {
      const instance = withEmbeddingCache(p);
      if (_singletonKey === key) _singleton = instance;
      return instance;
    }
  }

  if (_singletonKey === key) _singleton = null;
  return null;
}

export function _resetEmbeddingProviderForTests() { _singleton = null; }
