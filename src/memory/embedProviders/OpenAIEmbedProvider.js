import { requestEnvironment } from '../../runtime/requestScope.js';
import { captureBehavior } from '../../runtime/runtimeBehavior.js';
/**
 * OpenAIEmbedProvider — fallback using OpenAI's text-embedding-3-large.
 * Disabled when MELO_OFFLINE_ONLY=1.
 */

import { EmbeddingProvider, toDims } from './EmbeddingProvider.js';

const TIMEOUT_MS = 10_000;

export class OpenAIEmbedProvider extends EmbeddingProvider {
  static get providerName() { return 'openai'; }

  constructor({ env = requestEnvironment(), apiKey = null, model = 'text-embedding-3-large', dims = 1024 } = {}) {
    super();
    this.apiKey = apiKey || env.OPENAI_API_KEY || env.MELO_API_KEY || '';
    this.model = model;
    this._dims = dims;
  }
  get dims() { return this._dims; }
  get modelId() { return this.model; }

  async isAvailable() {
    if (captureBehavior().MELO_OFFLINE_ONLY === '1') return false;
    return Boolean(this.apiKey) && this.apiKey.startsWith('sk-');
  }

  async embed(text) {
    if (!(await this.isAvailable())) return null;
    const input = String(text || '').slice(0, 8192).trim();
    if (!input) return null;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input, dimensions: this._dims }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const raw = data?.data?.[0]?.embedding;
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
