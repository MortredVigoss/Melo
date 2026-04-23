/**
 * embeddings.js
 *
 * Text embedding generation for semantic memory search.
 *
 * Preferred path: delegate to the `embedProviders/` abstraction.  That module
 * implements MELO_EMBED_PROVIDER resolution (ollama / openai / custom http)
 * and its own LRU cache.  This file only falls back to its legacy
 * pick-a-backend logic when the abstraction did not produce a provider (boot
 * order quirk, an old import cycle, a test that skipped the runtime wiring).
 *
 * Keeping the legacy path means a plain `import { getEmbedding }` still
 * works even in the smallest scripts that never boot the runtime, while the
 * full app goes through the configured provider.
 *
 * Returns Float32Array(1024) or null if no backend is available.
 *
 * The caller should treat null as "semantic search unavailable" and fall back
 * to the existing keyword-based recall.
 */

import { getEmbeddingProvider } from './embedProviders/createEmbeddingProvider.js';

export const EMBEDDING_DIMS = 1024;

const OLLAMA_BASE = 'http://localhost:11434';
const OLLAMA_MODEL = 'bge-m3';
const EMBED_TIMEOUT_MS = 8_000;

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

// ─── Ollama backend ───────────────────────────────────────────────────────────

async function embedWithOllama(text) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, input: text }),
    });
    if (!res.ok) throw new Error(`ollama embed ${res.status}`);
    const data = await res.json();
    // Response: { embeddings: [[...]] }
    const raw = data?.embeddings?.[0] ?? data?.embedding;
    if (!Array.isArray(raw) || !raw.length) throw new Error('empty embedding');
    return toStandardDims(new Float32Array(raw));
  } finally {
    clearTimeout(timer);
  }
}

// ─── OpenAI backend ───────────────────────────────────────────────────────────

async function embedWithOpenAI(text, apiKey) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-large',
        input: text,
        dimensions: EMBEDDING_DIMS,
      }),
    });
    if (!res.ok) throw new Error(`openai embed ${res.status}`);
    const data = await res.json();
    const raw = data?.data?.[0]?.embedding;
    if (!Array.isArray(raw) || !raw.length) throw new Error('empty embedding');
    return toStandardDims(new Float32Array(raw));
  } finally {
    clearTimeout(timer);
  }
}

// ─── Backend availability cache ───────────────────────────────────────────────

// Cache which backend works to avoid repeated failed requests.
// Resets every 5 minutes so transient failures don't lock out a backend forever.
let _backendCache = null;
let _backendCacheAt = 0;
const BACKEND_CACHE_TTL_MS = 5 * 60 * 1000;

async function pickBackend(config) {
  const now = Date.now();
  if (_backendCache !== null && now - _backendCacheAt < BACKEND_CACHE_TTL_MS) {
    return _backendCache;
  }

  // 1. Try ollama (check tags endpoint, fast)
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 2_000);
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: ac.signal });
    if (res.ok) {
      const data = await res.json();
      const hasModel = (data?.models ?? []).some(m =>
        String(m?.name || '').toLowerCase().includes('bge-m3'),
      );
      if (hasModel) {
        _backendCache = { type: 'ollama' };
        _backendCacheAt = now;
        return _backendCache;
      }
    }
  } catch {
    // ollama not running or model not found
  }

  // 2. Try OpenAI API key — skipped entirely when the user pins offline mode.
  if (process.env.MELO_OFFLINE_ONLY !== '1') {
    const openaiKey = process.env.OPENAI_API_KEY || process.env.MELO_API_KEY || config?.apiKey;
    if (openaiKey && !openaiKey.includes('chatgpt') && openaiKey.startsWith('sk-')) {
      _backendCache = { type: 'openai', key: openaiKey };
      _backendCacheAt = now;
      return _backendCache;
    }
  }

  _backendCache = { type: 'none' };
  _backendCacheAt = now;
  return _backendCache;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate an embedding for the given text.
 * Returns Float32Array(768) or null if no embedding backend is available.
 *
 * @param {string} text
 * @param {object} [config]  Melo resolved config (for API key fallback)
 * @returns {Promise<Float32Array|null>}
 */
export async function getEmbedding(text, config = {}) {
  const normalized = String(text || '').trim();
  if (!normalized) return null;

  // Truncate to 512 chars — more than enough for a short memory fact
  const input = normalized.slice(0, 512);

  // ── Preferred: delegate to the embedProviders abstraction so MELO_EMBED_PROVIDER
  //    selection (and its LRU cache) applies uniformly across the app.
  try {
    const provider = await getEmbeddingProvider();
    if (provider && typeof provider.embed === 'function') {
      const providerModelId = provider.modelId || provider.constructor?.providerName || null;
      const cachedProvider = cacheGet(providerModelId, input);
      if (cachedProvider) return cachedProvider;
      const vec = await provider.embed(input);
      if (vec) {
        // Some custom providers may return a non-1024-dim vector; normalise
        // to the store's canonical EMBEDDING_DIMS so sqlite-vec doesn't
        // silently reject it.
        const out = vec.length === EMBEDDING_DIMS ? vec : toStandardDims(new Float32Array(vec));
        cacheSet(providerModelId, input, out);
        return out;
      }
      // Provider returned null — fall through to the legacy picker below,
      // which may still succeed via a different transport.
    }
  } catch {
    // provider boot failure shouldn't kill recall — fall through
  }

  const backend = await pickBackend(config);
  // Legacy picker uses well-known model ids; cache under them so a later
  // provider swap can't return these vectors to the wrong caller.
  const legacyModelId =
    backend.type === 'ollama' ? `ollama:${OLLAMA_MODEL}` :
    backend.type === 'openai' ? 'openai:text-embedding-3-large' :
    null;

  if (legacyModelId) {
    const cachedLegacy = cacheGet(legacyModelId, input);
    if (cachedLegacy) return cachedLegacy;
  }

  try {
    let embedding = null;

    if (backend.type === 'ollama') {
      embedding = await embedWithOllama(input);
    } else if (backend.type === 'openai') {
      embedding = await embedWithOpenAI(input, backend.key);
    } else {
      return null; // no backend available
    }

    if (embedding) {
      cacheSet(legacyModelId, input, embedding);
      return embedding;
    }
  } catch {
    // On failure, invalidate backend cache so next call retries
    _backendCache = null;
  }

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
