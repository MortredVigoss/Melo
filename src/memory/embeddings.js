/** Text embeddings from Melo's selected provider. Built-in inference is the
 * default; failures return null so retrieval can use keywords. No automatic
 * switch to another app, service, or API. */

import { getEmbeddingProvider } from './embedProviders/createEmbeddingProvider.js';

export const EMBEDDING_DIMS = 1024;


// ─── LRU cache ────────────────────────────────────────────────────────────────

const CACHE_SIZE = 256;
const _cache = new Map(); // `${modelId}\u241E${text}` → Float32Array

/**
 * Build a cache key that segregates vectors by the backing model.
 *
 * P2-11: before this change the cache keyed on `text` alone, so swapping
 * MELO_EMBED_PROVIDER mid-process (e.g. ollama → openai) would happily
 * return a cached Float32Array from the old model's vector space.  Those
 * spaces don't align — cosine distances become nonsense and sqlite-vec
 * recalls the wrong neighbours.
 *
 * Key = `<modelId>\u241E<text>`.  Unknown-model callers fall back to the
 * sentinel `unknown-model` so their entries don't collide with any real
 * provider's cache.
 */
function cacheKey(modelId, text) {
  const id = modelId && String(modelId).trim() ? String(modelId) : 'unknown-model';
  return `${id}\u241E${text}`;
}

function cacheGet(modelId, text) {
  const key = cacheKey(modelId, text);
  if (!_cache.has(key)) return null;
  // Refresh recency: delete + re-insert
  const val = _cache.get(key);
  _cache.delete(key);
  _cache.set(key, val);
  return val;
}

function cacheSet(modelId, text, embedding) {
  if (_cache.size >= CACHE_SIZE) {
    // Evict oldest entry (Map preserves insertion order)
    _cache.delete(_cache.keys().next().value);
  }
  _cache.set(cacheKey(modelId, text), embedding);
}

/** Test-only: clear the in-memory embedding cache. */
export function _resetEmbeddingCacheForTests() {
  _cache.clear();
}

// ─── Normalize ────────────────────────────────────────────────────────────────

/** L2-normalize a Float32Array in-place so cosine distance = euclidean distance. */
function l2Normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Truncate/pad a Float32Array to EMBEDDING_DIMS and re-normalize. */
function toStandardDims(arr) {
  if (arr.length === EMBEDDING_DIMS) return l2Normalize(arr);
  const out = new Float32Array(EMBEDDING_DIMS);
  out.set(arr.slice(0, EMBEDDING_DIMS));
  return l2Normalize(out);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate an embedding for the given text.
 * Returns Float32Array(1024) or null if no embedding backend is available.
 *
 * @param {string} text
 * @param {object} [config]  Melo resolved config (for API key fallback)
 * @returns {Promise<Float32Array|null>}
 */
export async function getEmbedding(text, config = {}) {
  const normalized = String(text || '').trim();
  if (!normalized) return null;

  // Bound model input; longer source text remains available in the store.
  const input = normalized.slice(0, 8192);

  // ── Preferred: delegate to the embedProviders abstraction so MELO_EMBED_PROVIDER
  //    selection (and its LRU cache) applies uniformly across the app.
  try {
    const provider = await getEmbeddingProvider();
    if (provider && typeof provider.embed === 'function') {
      const providerModelId = provider.modelId || provider.constructor?.providerName || null;
      const cachedProvider = cacheGet(providerModelId, input);
      if (cachedProvider) return cachedProvider;
      const vec = await provider.embed(input);
      if (provider.observedDims != null && provider.observedDims !== EMBEDDING_DIMS) return null;
      if (vec) {
        // Some custom providers may return a non-1024-dim vector; normalise
        // to the store's canonical EMBEDDING_DIMS so sqlite-vec doesn't
        // silently reject it.
        const out = vec.length === EMBEDDING_DIMS ? vec : toStandardDims(new Float32Array(vec));
        Object.defineProperty(out, 'modelId', {value:providerModelId,configurable:true});
        cacheSet(providerModelId, input, out);
        return out;
      }
      // A unavailable provider leaves lexical retrieval available.
    }
  } catch {
    // Provider failure must not break chat or change inference providers.
  }

  // A missing/busy bundled model degrades to keyword retrieval. Never start
  // another application or send memory text to a fallback API.
  return null;
}

/**
 * Check if an embedding backend is available (fast, uses cached result).
 * @param {object} [config]
 * @returns {Promise<boolean>}
 */
export async function isEmbeddingAvailable(config = {}) {
  try {
    const provider = await getEmbeddingProvider();
    if (provider && typeof provider.isAvailable === 'function') {
      if (await provider.isAvailable()) return true;
    }
  } catch {
    // fall through to legacy picker
  }
  const backend = await pickBackend(config);
  return backend.type !== 'none';
}

/**
 * P2-13: report whether the active embedding provider's declared `dims`
 * match the canonical EMBEDDING_DIMS.  If they don't, using the provider
 * is not fatal (getEmbedding pads/truncates via toStandardDims), but any
 * vector-vs-vector comparison across the mismatch boundary is meaningless
 * because the two spaces are not aligned.
 *
 * Callers (typically the boot path) use the return value to decide whether
 * to wipe stored vectors so the next embed pass repopulates from the new
 * space.  Returns:
 *   { ok: true,  dims }                       // aligned, nothing to do
 *   { ok: false, providerDims, canonicalDims, reason }  // mismatch
 *   { ok: false, reason: 'no-provider' }      // provider abstraction down
 *
 * @param {{ dims?: number }} [providerOverride]  inject for tests
 * @returns {Promise<{ ok: boolean, dims?: number, providerDims?: number, canonicalDims?: number, reason?: string }>}
 */
export async function checkEmbeddingDimensions(providerOverride = null) {
  let provider = providerOverride;
  if (!provider) {
    try { provider = await getEmbeddingProvider(); } catch { provider = null; }
  }
  if (!provider) return { ok: false, reason: 'no-provider' };
  const providerDims = Number(provider.dims);
  if (!Number.isFinite(providerDims) || providerDims <= 0) {
    return { ok: false, providerDims: null, canonicalDims: EMBEDDING_DIMS, reason: 'provider-no-dims' };
  }
  if (providerDims !== EMBEDDING_DIMS) {
    return {
      ok: false,
      providerDims,
      canonicalDims: EMBEDDING_DIMS,
      reason: 'provider-canonical-mismatch',
    };
  }
  return { ok: true, dims: providerDims };
}

/**
 * Compute cosine similarity between two Float32Arrays.
 * Both must be L2-normalized (which getEmbedding() guarantees).
 * For normalized vectors: cosine similarity = dot product.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}  0..1  (1 = identical)
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}
