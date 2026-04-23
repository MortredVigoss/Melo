/**
 * SqliteVecProvider — wraps the existing store.js implementation behind the
 * MemoryProvider interface.  Zero behaviour change: just forwards calls.
 * This is the default provider; if the user sets nothing, this is what runs.
 */

import { MemoryProvider } from './MemoryProvider.js';
import {
  upsertMemory,
  replaceMemories,
  recallMemories,
  recallMemoriesTiered,
  memoryStatsExtended,
  memoryStats,
  setAtticLevels,
  listMemoriesForAtticReassess,
  recordMemoryHit,
} from '../store.js';

export class SqliteVecProvider extends MemoryProvider {
  static get providerName() { return 'sqlite-vec'; }

  async upsert(entry) { return upsertMemory(entry); }
  async replaceAll(entries) { return replaceMemories(entries); }

  async searchTiered(opts = {}) { return recallMemoriesTiered(opts); }
  async search(opts = {}) { return recallMemories(opts); }

  async stats() {
    // Prefer the extended dashboard stats; fallback for older databases.
    try { return memoryStatsExtended(); } catch { return memoryStats(); }
  }

  async listForReassess(opts = {}) { return listMemoriesForAtticReassess(opts); }
  async setAtticLevels(updates) { return setAtticLevels(updates); }
  async recordHit(hit) { return recordMemoryHit(hit); }
}
