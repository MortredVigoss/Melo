/**
 * LanceDbProvider — file-backed vector store via @lancedb/lancedb.
 *
 * We only take an optional soft dependency: if the package isn't installed
 * we simply return `null` from `isAvailable()` and the factory falls back
 * to sqlite-vec.  This keeps `npm install` light for users who don't need
 * LanceDB.
 *
 * Config:
 *   MELO_LANCE_DIR — where to store the .lance dir (default ~/.melo/desktop/lance)
 *   MELO_LANCE_TABLE — table name (default melo_memories)
 */

import { join } from 'node:path';
import { MemoryProvider } from './MemoryProvider.js';
import { getMeloHome } from '../../config.js';

const DEFAULT_DIR = process.env.MELO_LANCE_DIR || join(getMeloHome(), 'desktop', 'lance');
const DEFAULT_TABLE = process.env.MELO_LANCE_TABLE || 'melo_memories';

let _lancedb = null;

async function loadLance() {
  if (_lancedb !== null) return _lancedb;
  try {
    // dynamic import — keeps the dep soft
    _lancedb = await import('@lancedb/lancedb');
  } catch {
    _lancedb = false;
  }
  return _lancedb;
}

export async function isLanceAvailable() {
  return Boolean(await loadLance());
}

export class LanceDbProvider extends MemoryProvider {
  static get providerName() { return 'lancedb'; }

  constructor({ dir = DEFAULT_DIR, table = DEFAULT_TABLE } = {}) {
    super();
    this.dir = dir;
    this.tableName = table;
    this._conn = null;
    this._table = null;
  }

  async _openTable() {
    if (this._table) return this._table;
    const lance = await loadLance();
    if (!lance) throw new Error('lancedb not installed');
    this._conn = await lance.connect(this.dir);
    try {
      this._table = await this._conn.openTable(this.tableName);
    } catch {
      // Create on first use with an empty schema-bearing row
      this._table = await this._conn.createTable(this.tableName, [
        { id: '__seed__', vector: new Array(1024).fill(0), text: '', namespace: '', kind: '', metadata: '{}' },
      ]);
      await this._table.delete("id = '__seed__'");
    }
    return this._table;
  }

  async upsert(entry) {
    if (!entry?.id) return;
    try {
      const table = await this._openTable();
      const row = {
        id: entry.id,
        vector: entry.embedding ? Array.from(entry.embedding) : new Array(1024).fill(0),
        text: entry.text,
        namespace: entry.namespace,
        kind: entry.kind,
        metadata: JSON.stringify(entry.metadata || {}),
      };
      const safeId = String(entry.id).replace(/'/g, "''");
      await table.delete(`id = '${safeId}'`).catch(() => {});
      await table.add([row]);
    } catch {
      // best-effort
    }
  }

  async replaceAll(entries = []) {
    try {
      const table = await this._openTable();
      await table.delete('1=1');
      for (const e of entries) {
        // eslint-disable-next-line no-await-in-loop
        await this.upsert(e);
      }
    } catch {
      // best-effort
    }
  }

  async search({ namespaces = [], kinds = [], queryEmbedding = null, limit = 8 } = {}) {
    if (!queryEmbedding) return [];
    try {
      const table = await this._openTable();
      let q = table.search(Array.from(queryEmbedding)).limit(limit);
      const preds = [];
      if (namespaces.length) {
        preds.push(`namespace IN (${namespaces.map(n => `'${n.replace(/'/g, "''")}'`).join(', ')})`);
      }
      if (kinds.length) {
        preds.push(`kind IN (${kinds.map(k => `'${k.replace(/'/g, "''")}'`).join(', ')})`);
      }
      if (preds.length) q = q.where(preds.join(' AND '));
      const rows = await q.toArray();
      return rows.map(r => ({
        id: r.id,
        namespace: r.namespace,
        kind: r.kind,
        text: r.text,
        metadata: safeJson(r.metadata),
        score: 1 - Math.min(1, r._distance ?? 1),
      }));
    } catch {
      return [];
    }
  }

  async searchTiered(opts = {}) {
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
      const table = await this._openTable();
      const count = await table.countRows();
      return {
        totalMemories: count,
        byKind: {},
        byAttic: {},
        vecIndexedCount: count,
        vecAvailable: true,
        provider: 'lancedb',
      };
    } catch {
      return { totalMemories: 0, byKind: {}, byAttic: {}, vecIndexedCount: 0, vecAvailable: false, provider: 'lancedb' };
    }
  }

  async listForReassess() { return []; }
  async setAtticLevels() { return 0; }
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}
