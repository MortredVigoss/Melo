/** Sync extracted facts with canonical, scoped records and fill embeddings.
 * User overrides and tombstones survive checkpoint replay. Automatic memories
 * stay in their source chat; semantic similarity never discards a fact. */

import { currentRequestContext, requestEnvironment, runWithRequestContext } from '../runtime/requestScope.js';
import { getMeloHome } from '../config.js';
import { reconcileChatFacts } from './factRecords.js';
import {
  iterateMemoryRecords,
  getMemoriesByIds,
  getMemoriesWithoutEmbeddings,
  saveMemoryEmbedding,
  listMemoriesNeedingReembed,
  clearNeedsReembed,
} from './store.js';
import { getEmbedding as _defaultGetEmbedding } from './embeddings.js';

// ─── Dependency injection hook (test-only) ────────────────────────────────────
//
// Production code uses the real `getEmbedding` from ./embeddings.js.  Tests can
// swap it out via `_setGetEmbeddingForTests()` to simulate provider flaps (the
// outer getEmbedding returning null) without having to disable Ollama on the
// host.  This is a Bug C regression lever: we need to prove the promoter
// doesn't retry a just-failed call, which only manifests when getEmbedding is
// genuinely null.
let _getEmbedding = _defaultGetEmbedding;
/** @internal test-only */
export function _setGetEmbeddingForTests(fn) {
  _getEmbedding = typeof fn === 'function' ? fn : _defaultGetEmbedding;
}

export const PROMOTED_KIND = 'session-fact';

export async function promoteAndPersistFacts(chat, agentId, config) {
  const context={...currentRequestContext(),env:{...requestEnvironment()}};
  return runWithRequestContext(context,async()=>{
    // Bug audit M17: count against this chat's own rows (the global list was
    // capped at 1000, so the "new facts" telemetry drifted on large stores).
    const before=new Set([...iterateMemoryRecords({chatId:chat.id})].map(r=>r.id));
    const entries=reconcileChatFacts(chat,agentId);
    for (const entry of entries) {
      if (entry.metadata.validTo || entry.metadata.forgotten) continue;
      if (getMemoriesByIds([entry.id])[0]?.embedding) continue;
      const embedding=await _getEmbedding(entry.text,config).catch(()=>null);
      if (embedding) saveMemoryEmbedding(entry.id,entry.searchText,embedding);
    }
    return entries.filter(e=>!before.has(e.id)).length;
  });
}

// ─── Background embedding fill-in ────────────────────────────────────────────

const _fillInRunning = new Set();

/**
 * Generate embeddings for all memory entries that still lack one.
 * Runs in the background — only one instance at a time.
 * Safe to call fire-and-forget.
 *
 * @param {object} config  resolved Melo config
 */
export async function scheduleEmbeddingFillIn(config) {
  const home=getMeloHome();
  const context={...currentRequestContext(),env:{...requestEnvironment(),MELO_HOME:home}};
  if (_fillInRunning.has(home)) return;
  _fillInRunning.add(home);
  return runWithRequestContext(context,async()=>{
  try {
    const pendingById = new Map();
    for (const row of getMemoriesWithoutEmbeddings()) {
      if (row?.id && !pendingById.has(row.id)) {
        pendingById.set(row.id, {
          id: row.id,
          searchText: row.searchText,
          needsReembed: false,
        });
      }
    }
    for (const row of listMemoriesNeedingReembed({ limit: 200 })) {
      if (!row?.id) continue;
      pendingById.set(row.id, {
        id: row.id,
        searchText: row.searchText || row.text || '',
        needsReembed: true,
      });
    }

    const pending = Array.from(pendingById.values()).slice(0, 100);
    if (!pending.length) return;

    for (const { id, searchText, needsReembed } of pending) {
      if (!searchText) continue;
      const embedding = await _getEmbedding(searchText, config).catch(() => null);
      if (embedding) {
        // Codex pre-pp B follow-up (2026-05-10): only clear the reembed flag
        // when the write actually committed.  Pre-fix, saveMemoryEmbedding's
        // catch swallowed vec-dim / sqlite-busy / disk-full failures while
        // still returning void, and the unconditional clearNeedsReembed below
        // permanently cancelled retry — leaving the row stuck on the stale
        // embedding forever.  saveMemoryEmbedding now returns boolean; gate
        // clearNeedsReembed on it.
        const wrote = saveMemoryEmbedding(id, searchText, embedding);
        if (wrote && needsReembed) {
          clearNeedsReembed([id]);
        }
      }
      // Yield to event loop between each embedding
      await new Promise(resolve => setImmediate(resolve));
    }
  } catch {
    // best-effort
  } finally {
    _fillInRunning.delete(home);
  }
  });
}
