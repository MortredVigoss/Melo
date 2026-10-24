import { requestEnvironment } from '../../runtime/requestScope.js';
import { memoryEndpointAllowed } from '../../runtime/runtimeBehavior.js';
/**
 * CustomHttpEmbedProvider — user can point at their own embedding service.
 * Contract:
 *
 *   POST <url>       body: {"text": "..."}
 *   returns          {"embedding": [Number, ...]}
 *
 * Any service that speaks this minimal shape (or a wrapper script around a
 * local model) works.  Dims + model id come from env.
 */

import { EmbeddingProvider, toDims } from './EmbeddingProvider.js';

const TIMEOUT_MS = 10_000;

export class CustomHttpEmbedProvider extends EmbeddingProvider {
  static get providerName() { return 'http'; }

  constructor({ env = requestEnvironment(), url = env.MELO_EMBED_HTTP_URL || '', token = env.MELO_EMBED_HTTP_TOKEN || '', dims = Number(env.MELO_EMBED_DIMS || 1024), model = env.MELO_EMBED_MODEL || 'custom-http' } = {}) {
    super();
    this.url = url;
    this.token = token;
    this._dims = dims;
    this.model = model;
  }
  get dims() { return this._dims; }
  get modelId() { return this.model; }

  async isAvailable() {
    if (!memoryEndpointAllowed(this.url)) return false;
    return Boolean(this.url);
  }

  async embed(text) {
    if (!memoryEndpointAllowed(this.url)) return null;
    if (!this.url) return null;
    const input = String(text || '').slice(0, 2048).trim();
    if (!input) return null;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ text: input }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const raw = data?.embedding ?? data?.data?.[0]?.embedding;
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
