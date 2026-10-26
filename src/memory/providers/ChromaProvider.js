import { MEMORY_SERVICE_DEFAULTS } from '../../shared/localServices.js';
/**
 * ChromaProvider — talks to a Chroma server (local or remote) over HTTP.
 * Default URL: http://localhost:8000 (Chroma's default).  Config via env:
 *   MELO_CHROMA_URL
 *   MELO_CHROMA_COLLECTION (default: melo_memories)
 *
 * This provider is intentionally minimal — it satisfies the MemoryProvider
 * interface with a best-effort mapping:
 *   • upsert → POST /api/v1/collections/{name}/upsert
 *   • search → POST /api/v1/collections/{name}/query
 *   • stats  → GET  /api/v1/collections/{name}/count
 *
 * Scene/frame tiering is approximated by filtering on metadata.kind.  Users
 * who need the full 3-tier semantics should stay on sqlite-vec.
 */

import { MemoryProvider } from './MemoryProvider.js';

const DEFAULT_URL = process.env.MELO_CHROMA_URL || MEMORY_SERVICE_DEFAULTS.chroma;
const DEFAULT_COLLECTION = process.env.MELO_CHROMA_COLLECTION || 'melo_memories';

export class ChromaProvider extends MemoryProvider {
  static get providerName() { return 'chroma'; }

  constructor({ url = DEFAULT_URL, collection = DEFAULT_COLLECTION, timeoutMs = 8000 } = {}) {
    super();
    this.url = url.replace(/\/+$/, '');
    this.collection = collection;
    this.timeoutMs = timeoutMs;
  }

  async _fetch(path, init = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}${path}`, {
        ...init,
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      });
      if (!res.ok) throw new Error(`chroma ${res.status}`);
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async upsert(entry) {
    if (!entry?.id) return;
    const body = {
      ids: [entry.id],
      documents: [entry.text],
      metadatas: [{
        namespace: entry.namespace,
        kind: entry.kind,
        ...(entry.metadata || {}),
      }],
      ...(entry.embedding ? { embeddings: [Array.from(entry.embedding)] } : {}),
    };
    try {
      await this._fetch(`/api/v1/collections/${this.collection}/upsert`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch {
      // best-effort
    }
  }

  async replaceAll(entries = []) {
    // Best-effort snapshot semantics: clear the collection before replaying
    // the new snapshot so stale rows do not survive a rebuild. Chroma's HTTP
    // API has varied across versions; if delete is unavailable we still upsert
    // the fresh rows rather than failing the memory pipeline.
    try {
      await this._fetch(`/api/v1/collections/${this.collection}/delete`, {
        method: 'POST',
        body: JSON.stringify({ where: {} }),
      });
    } catch {
      // Older Chroma versions may reject collection-wide delete.
    }
    for (const e of entries) {
      // eslint-disable-next-line no-await-in-loop
      await this.upsert(e);
    }
  }

  async search({ namespaces = [], kinds = [], queryEmbedding = null, limit = 8 } = {}) {
    if (!queryEmbedding) return [];
    const where = {};
    if (namespaces.length) where.namespace = { $in: namespaces };
    if (kinds.length) where.kind = { $in: kinds };
    try {
      const data = await this._fetch(`/api/v1/collections/${this.collection}/query`, {
        method: 'POST',
        body: JSON.stringify({
          query_embeddings: [Array.from(queryEmbedding)],
          n_results: limit,
          where: Object.keys(where).length ? where : undefined,
        }),
      });
      const ids = data?.ids?.[0] || [];
      const metadatas = data?.metadatas?.[0] || [];
      const documents = data?.documents?.[0] || [];
      const distances = data?.distances?.[0] || [];
      return ids.map((id, i) => ({
        id,
        namespace: metadatas[i]?.namespace,
        kind: metadatas[i]?.kind,
        text: documents[i] || '',
        metadata: metadatas[i] || {},
        score: 1 - Math.min(1, distances[i] ?? 1),
      }));
    } catch {
      return [];
    }
  }

  async searchTiered(opts = {}) {
    // Approximate: one query, slice by kind.
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
      const data = await this._fetch(`/api/v1/collections/${this.collection}/count`);
      return {
        totalMemories: data?.count || 0,
        byKind: {},
        byAttic: {},
        vecIndexedCount: data?.count || 0,
        vecAvailable: true,
        provider: 'chroma',
      };
    } catch {
      return { totalMemories: 0, byKind: {}, byAttic: {}, vecIndexedCount: 0, vecAvailable: false, provider: 'chroma' };
    }
  }

  async listForReassess() { return []; }    // chroma has no attic metadata concept here
  async setAtticLevels() { return 0; }
}
