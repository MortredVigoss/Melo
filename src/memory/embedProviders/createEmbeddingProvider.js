import { BuiltinEmbedProvider } from './BuiltinEmbedProvider.js';
import { getConfigPath } from '../../config.js';
import { requestEnvironment } from '../../runtime/requestScope.js';
/**
 * Factory for EmbeddingProvider.
 *
 * Memory text is embedded by the model that ships with Melo and by nothing
 * else: no other application is probed and nothing is sent to a cloud
 * embedding service. The Ollama / OpenAI / custom-HTTP adapters that used to
 * sit beside it were removed on 2026-11-14 (no setting ever selected them).
 *
 * MELO_EMBED_PROVIDER names a provider registered with
 * registerEmbeddingProvider; the tests use it to stand in for the model.
 *
 * Returns a thin wrapper with an LRU cache so repeated embeds are free.
 */

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

export function registerEmbeddingProvider(name, factory) { REGISTRY.set(name, factory); }

/**
 * Which providers are tried, in order. The one place that decides it: the
 * status probe used to keep its own list (ollama, openai, http) and reported
 * "no provider" on every machine while the bundled model was working.
 */
export function embeddingProviderOrder(env = requestEnvironment()) {
  const explicit = String(env?.MELO_EMBED_PROVIDER || '').trim().toLowerCase();
  return explicit ? [explicit] : ['builtin'];
}

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
    // The cache bypass. Read as `provider.probe || provider.embed` by diagnosis and repair
    // (src/memory/repair.js), never called as `.probe(`: a connection check or a rebuild
    // answered from the cache would hide a provider that stopped working.
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
  const key = JSON.stringify([configPath, env.MELO_EMBED_PROVIDER, env.MELO_EMBED_MODEL_DIR]);
  if (_singleton && _singletonKey === key) return _singleton;
  _singleton = null; _singletonKey = key;
  const order = embeddingProviderOrder(env);

  const candidates = order.map(name => REGISTRY.get(name)?.({ env })).filter(Boolean);
  for (const p of candidates) {
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
