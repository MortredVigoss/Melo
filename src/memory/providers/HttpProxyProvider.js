/**
 * HttpProxyProvider — a tiny REST contract that lets users point Melo at any
 * self-hosted memory service (Mem0, Supermemory, Honcho, a custom stack).
 *
 * The expected endpoints on the target service are intentionally minimal:
 *
 *   POST /upsert          body: Entry
 *   POST /search          body: {namespaces, kinds, query, queryEmbedding, limit}
 *                         returns: {results: [...]}
 *   POST /search_tiered   (optional; falls back to three /search calls)
 *   GET  /stats           returns: {totalMemories, byKind, byAttic, ...}
 *   POST /attic_update    body: [{id, attic}]
 *   GET  /reassess?sinceIso=&limit=
 *
 * Config:
 *   MELO_MEMORY_HTTP_URL    e.g. http://localhost:7401
 *   MELO_MEMORY_HTTP_TOKEN  optional bearer token
 */

import { MemoryProvider } from './MemoryProvider.js';

const DEFAULT_URL = process.env.MELO_MEMORY_HTTP_URL || '';
const DEFAULT_TOKEN = process.env.MELO_MEMORY_HTTP_TOKEN || '';

export class HttpProxyProvider extends MemoryProvider {
  static get providerName() { return 'http-proxy'; }

  constructor({ url = DEFAULT_URL, token = DEFAULT_TOKEN, timeoutMs = 10_000 } = {}) {
    super();
    if (!url) throw new Error('HttpProxyProvider requires MELO_MEMORY_HTTP_URL');
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  _headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async _fetch(path, init = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}${path}`, {
        ...init,
        signal: ac.signal,
        headers: this._headers(init.headers),
      });
      if (!res.ok) throw new Error(`http-proxy ${res.status}`);
      if (res.status === 204) return null;
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async upsert(entry) {
    try {
      await this._fetch('/upsert', {
        method: 'POST',
        body: JSON.stringify({
          ...entry,
          embedding: entry.embedding ? Array.from(entry.embedding) : null,
        }),
      });
    } catch {}
  }

  async replaceAll(entries = []) {
    try {
      await this._fetch('/replace_all', {
        method: 'POST',
        body: JSON.stringify({
          entries: entries.map(e => ({
            ...e,
            embedding: e.embedding ? Array.from(e.embedding) : null,
          })),
        }),
      });
    } catch {
      // If /replace_all is not implemented, fall back to upserts.
      for (const e of entries) {
        // eslint-disable-next-line no-await-in-loop
        await this.upsert(e);
      }
    }
  }

  async search({ namespaces = [], kinds = [], query = '', queryEmbedding = null, limit = 8 } = {}) {
    try {
      const data = await this._fetch('/search', {
        method: 'POST',
        body: JSON.stringify({
          namespaces, kinds, query, limit,
          queryEmbedding: queryEmbedding ? Array.from(queryEmbedding) : null,
        }),
      });
      return Array.isArray(data?.results) ? data.results : [];
    } catch {
      return [];
    }
  }

  async searchTiered(opts = {}) {
    try {
      const data = await this._fetch('/search_tiered', {
        method: 'POST',
        body: JSON.stringify({
          ...opts,
          queryEmbedding: opts.queryEmbedding ? Array.from(opts.queryEmbedding) : null,
        }),
      });
      if (data && typeof data === 'object') {
        return {
          scenes: data.scenes || [],
          frames: data.frames || [],
          contents: data.contents || [],
        };
      }
    } catch {
      // fall through
    }
    const { limits = {}, ...rest } = opts;
    const { scenes: sLim = 3, frames: fLim = 8, contents: cLim = 12 } = limits;
    const [scenes, frames, contents] = await Promise.all([
      this.search({ ...rest, kinds: ['scene'], limit: sLim }),
      this.search({ ...rest, kinds: ['frame'], limit: fLim }),
      this.search({ ...rest, kinds: ['prompt', 'fact'], limit: cLim }),
    ]);
    return { scenes, frames, contents };
  }

  async stats() {
    try {
      const data = await this._fetch('/stats');
      return { ...(data || {}), provider: 'http-proxy' };
    } catch {
      return { totalMemories: 0, byKind: {}, byAttic: {}, vecIndexedCount: 0, vecAvailable: false, provider: 'http-proxy' };
    }
  }

  async listForReassess(opts = {}) {
    try {
      const params = new URLSearchParams();
      if (opts.sinceIso) params.set('sinceIso', opts.sinceIso);
      if (opts.limit) params.set('limit', String(opts.limit));
      const q = params.toString();
      const data = await this._fetch(`/reassess${q ? '?' + q : ''}`);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async setAtticLevels(updates = []) {
    try {
      const data = await this._fetch('/attic_update', {
        method: 'POST',
        body: JSON.stringify(updates),
      });
      return Number(data?.updated) || 0;
    } catch {
      return 0;
    }
  }
}
