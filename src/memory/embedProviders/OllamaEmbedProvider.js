import { requestEnvironment } from '../../runtime/requestScope.js';
import { LOCAL_SERVICE_DEFAULTS } from '../../shared/localServices.js';
import { memoryEndpointAllowed } from '../../runtime/runtimeBehavior.js';
/**
 * OllamaEmbedProvider — default local embedder, used for bge-m3 and any
 * other Ollama-hosted model.
 */

import { EmbeddingProvider, toDims } from './EmbeddingProvider.js';

const TIMEOUT_MS = 8_000;

// Input character cap.  Phase-2 #1: the legacy 512 cap was silently
// truncating long frames/scenes *before* they reached bge-m3 — so the
// first 512 chars ended up representing a full 4000-token summary.  We
// now honour MELO_OLLAMA_MAX_INPUT_CHARS (default 8192, matching OpenAI's
// text-embedding-3-large provider).  bge-m3 accepts 8192 tokens natively;
// chars ≈ tokens for CJK and somewhat less for Latin, so 8192 is a safe
// upper bound without a tokeniser dependency.

export class OllamaEmbedProvider extends EmbeddingProvider {
  static get providerName() { return 'ollama'; }

  constructor({ env = requestEnvironment(), baseUrl = env.MELO_OLLAMA_URL || LOCAL_SERVICE_DEFAULTS.ollama.replace(/\/v1$/, ''), model = env.MELO_OLLAMA_EMBED_MODEL || 'bge-m3', dims = Number(env.MELO_EMBED_DIMS || 1024), maxInputChars = Math.max(256, Number(env.MELO_OLLAMA_MAX_INPUT_CHARS || 8192)) } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.model = model;
    this._dims = dims;
    this.maxInputChars = maxInputChars;
  }
  get dims() { return this._dims; }
  get modelId() { return this.model; }

  async isAvailable() {
    if (!memoryEndpointAllowed(this.baseUrl)) return false;
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 2000);
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: ac.signal });
      if (!res.ok) return false;
      const data = await res.json();
      return (data?.models ?? []).some(m =>
        String(m?.name || '').toLowerCase().includes(this.model.toLowerCase()),
      );
    } catch {
      return false;
    }
  }

  async embed(text) {
    if (!memoryEndpointAllowed(this.baseUrl)) return null;
    const input = String(text || '').slice(0, this.maxInputChars).trim();
    if (!input) return null;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const raw = data?.embeddings?.[0] ?? data?.embedding;
      if (!Array.isArray(raw) || !raw.length) return null;
      this.observedDims = raw.length;
      return toDims(new Float32Array(raw), this._dims);
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
}
