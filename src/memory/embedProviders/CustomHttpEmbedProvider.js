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

const URL_ENV = process.env.MELO_EMBED_HTTP_URL || '';
const TOKEN_ENV = process.env.MELO_EMBED_HTTP_TOKEN || '';
const DIMS_ENV = Number(process.env.MELO_EMBED_DIMS || 1024);
const MODEL_ENV = process.env.MELO_EMBED_MODEL || 'custom-http';
const TIMEOUT_MS = 10_000;

export class CustomHttpEmbedProvider extends EmbeddingProvider {
  static get providerName() { return 'http'; }

  constructor({ url = URL_ENV, token = TOKEN_ENV, dims = DIMS_ENV, model = MODEL_ENV } = {}) {
    super();
    this.url = url;
    this.token = token;
    this._dims = dims;
    this.model = model;
  }
  get dims() { return this._dims; }
  get modelId() { return this.model; }

  async isAvailable() {
    return Boolean(this.url);
  }

  async embed(text) {
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
      return toDims(new Float32Array(raw), this._dims);
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
}
