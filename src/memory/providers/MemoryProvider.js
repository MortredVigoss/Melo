/**
 * MemoryProvider — shape contract for Melo memory backends.
 *
 * Concrete providers (SqliteVec / Chroma / LanceDB / HttpProxy) implement
 * these async methods.  The rest of the app only ever sees this interface,
 * which keeps the door open for "swap in a different vector DB without
 * touching the call site".
 *
 * All methods are async because some backends (HttpProxy, remote Chroma) are
 * inherently network-bound; the sqlite-vec adapter returns synchronously but
 * wraps results in Promise.resolve() for shape consistency.
 */

export class MemoryProvider {
  /** Unique provider label, e.g. 'sqlite-vec', 'chroma', 'lancedb'. */
  static get providerName() { return 'abstract'; }

  /** Upsert a fully-normalised entry. @returns {Promise<void>} */
  async upsert(/* entry */) { throw new Error('upsert not implemented'); }

  /** Bulk replace all entries (used by rebuild paths). @returns {Promise<void>} */
  async replaceAll(/* entries */) { throw new Error('replaceAll not implemented'); }

  /**
   * Tiered recall — scene→frame→content.  See store.recallMemoriesTiered for
   * the expected shape.
   */
  async searchTiered(/* { namespaces, query, queryEmbedding, limits, atticLevels } */) {
    throw new Error('searchTiered not implemented');
  }

  /** Flat recall (legacy API surface). */
  async search(/* { namespaces, kinds, query, queryEmbedding, limit } */) {
    throw new Error('search not implemented');
  }

  /** Stats dashboard feed. @returns {Promise<object>} */
  async stats() { throw new Error('stats not implemented'); }

  /** List rows for the attic reassess worker. */
  async listForReassess(/* { sinceIso, limit } */) { throw new Error('listForReassess not implemented'); }

  /** Apply attic level updates. @returns {Promise<number>} */
  async setAtticLevels(/* updates */) { throw new Error('setAtticLevels not implemented'); }

  /** Record a recall-hit log entry (dreaming signal). */
  async recordHit(/* hit */) { return 0; }

  /** Close underlying resources.  Optional. */
  async close() { /* optional */ }
}

/**
 * Helpful diagnostic shim: when a consumer ignores the async contract we
 * still want things to behave.
 */
export function ensureProviderShape(obj) {
  const required = ['upsert', 'replaceAll', 'searchTiered', 'search', 'stats',
    'listForReassess', 'setAtticLevels'];
  for (const m of required) {
    if (typeof obj[m] !== 'function') {
      throw new Error(`MemoryProvider missing method: ${m}`);
    }
  }
  return obj;
}
