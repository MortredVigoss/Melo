import { requestEnvironment } from '../runtime/requestScope.js';
import { createRequire } from 'node:module';
/**
 * src/memory/status.js
 *
 * Phase 3 — shared read-only snapshot of the memory subsystem.
 *
 * Used by:
 *   • src/index.js               (`melo memory status`, human + JSON output)
 *   • src/http/domainRoutes.js   (GET /api/memory/status, fed to the UI)
 *
 * Must stay read-only: no writes to _meta, no mutations to embedding_cache,
 * no touching state.json.  Anyone adding fields here should keep that
 * contract so the UI can poll it freely without risk.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveRuntimePaths } from '../runtime/paths.js';

export function getMeloHome() {
  return resolveRuntimePaths().home;
}

function safeCount(db, sql) {
  try {
    return db.prepare(sql).get()?.n ?? null;
  } catch {
    return null;
  }
}

function readMeta(db) {
  try {
    const rows = db.prepare(`SELECT key, value FROM _meta`).all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  } catch {
    return null;
  }
}

function latestDream(dreamsDir) {
  if (!existsSync(dreamsDir)) return null;
  try {
    const entries = readdirSync(dreamsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const full = join(dreamsDir, f);
        return { name: f, mtimeMs: statSync(full).mtimeMs, path: full };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries[0] || null;
  } catch {
    return null;
  }
}

/**
 * Snapshot schema version.  Bump when any consumer-visible key is renamed,
 * removed, or a value's type changes.  Adding a new optional field does NOT
 * require a bump.  Consumers should check this before relying on new fields.
 */
export const MEMORY_STATUS_SCHEMA_VERSION = 1;

/**
 * Collect a full memory-status snapshot.  Purely read-only.  If the store
 * doesn't exist yet (fresh install) the shape is still valid — `exists`
 * reports false and counts are null.
 *
 * @returns {{
 *   schemaVersion: number,
 *   meloHome: string,
 *   store: { path: string, exists: boolean, sizeBytes: number | null, openError?: string },
 *   meta: Record<string, string> | null,
 *   counts: { memories: number|null, memoriesFts: number|null, vecMemories: number|null, embeddingCache: number|null },
 *   byKind: Record<string, number>,
 *   byAttic: Record<string, number>,
 *   dreams: { dir: string, latest: { name: string, mtimeMs: number, path: string } | null, count: number },
 *   embedding: { provider: string, cacheRows: number|null, dimsConfigured: number, storedModelId: string|null, drift: { stored: string|null, inferredProvider: string|null, hasDrift: boolean } },
 *   tuning: { mmrLambda: number, recencyHalfLifeDays: number },
 * }}
 */
export function collectMemoryStatus({ meloHome = getMeloHome() } = {}) {
  const storePath = join(meloHome, 'desktop', 'store.sqlite');
  const dreamsDir = join(meloHome, 'desktop', 'dreams');

  const snapshot = {
    derivedIndex: derivedIndexStatus(meloHome),
    schemaVersion: MEMORY_STATUS_SCHEMA_VERSION,
    meloHome,
    store: { path: storePath, exists: false, sizeBytes: null },
    meta: null,
    counts: {
      memories: null,
      memoriesFts: null,
      vecMemories: null,
      embeddingCache: null,
    },
    // Phase E follow-up (Codex 🔴 P0 2026-05-05): byKind / byAttic used
    // to come from store.memoryStats(), which goes through the writable
    // getDb() singleton and runs `PRAGMA journal_mode = WAL` at open
    // time — turning a "read-only status" command into a write side
    // effect (creates store.sqlite-wal / -shm files, modifies schema
    // PRAGMAs). collectMemoryStatus already opens a readOnly handle for
    // counts; the cheapest fix is to run the by-kind / by-attic queries
    // on that same handle. Empty objects = "store didn't exist or query
    // failed", same convention as `counts`.
    byKind: {},
    byAttic: {},
    dreams: { dir: dreamsDir, latest: null, count: 0 },
    embedding: {
      provider: process.env.MELO_EMBED_PROVIDER || 'builtin',
      cacheRows: null,
      dimsConfigured: 1024,   // the width of the bundled model; no setting changes it
      storedModelId: null,
      // probeAttempted distinguishes "user didn't ask to probe" from
      // "user asked but the provider was unavailable" — both end with
      // inferredProvider=null but the CLI/UI treat them differently.
      drift: { stored: null, inferredProvider: null, hasDrift: false, probeAttempted: false },
    },
    tuning: {
      mmrLambda: Number(process.env.MELO_MMR_LAMBDA || 0.7),
      recencyHalfLifeDays: Number(process.env.MELO_RECENCY_HALF_LIFE_DAYS || 14),
    },
  };

  if (existsSync(storePath)) {
    snapshot.store.exists = true;
    try {
      snapshot.store.sizeBytes = statSync(storePath).size;
    } catch { /* noop */ }

    let db = null;
    try {
      db = new DatabaseSync(storePath, { readOnly: true, allowExtension: true });
      try { db.loadExtension(createRequire(import.meta.url)('sqlite-vec').getLoadablePath()); } catch {}
      snapshot.meta = readMeta(db);
      snapshot.counts = {
        memories: safeCount(db, 'SELECT COUNT(*) AS n FROM memories'),
        memoriesFts: safeCount(db, 'SELECT COUNT(*) AS n FROM memories_fts'),
        vecMemories: safeCount(db, 'SELECT COUNT(*) AS n FROM vec_memories'),
        embeddingCache: safeCount(db, 'SELECT COUNT(*) AS n FROM embedding_cache'),
      };
      // by-kind / by-attic — same readonly connection, no PRAGMA writes.
      // json_extract is part of stock SQLite and works in readonly mode.
      try {
        const kindRows = db.prepare(
          `SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind`,
        ).all();
        snapshot.byKind = Object.fromEntries(kindRows.map(r => [r.kind, r.n]));
      } catch { /* noop — leaves {} */ }
      try {
        const atticRows = db.prepare(
          `SELECT json_extract(metadata_json, '$.attic') AS attic, COUNT(*) AS n
             FROM memories GROUP BY attic`,
        ).all();
        snapshot.byAttic = Object.fromEntries(
          atticRows.map(r => [r.attic || 'none', r.n]),
        );
      } catch { /* noop — leaves {} */ }
      snapshot.embedding.cacheRows = snapshot.counts.embeddingCache;
      const storedModelId = snapshot.meta?.embedding_model_id || null;
      snapshot.embedding.storedModelId = storedModelId;
      snapshot.embedding.drift.stored = storedModelId;
    } catch (err) {
      snapshot.store.openError = err?.message || String(err);
    } finally {
      try { db?.close(); } catch { /* noop */ }
    }
  }

  // Count dream files + pick the latest.  Cheap — just readdir.
  if (existsSync(dreamsDir)) {
    try {
      snapshot.dreams.count = readdirSync(dreamsDir).filter(f => f.endsWith('.md')).length;
    } catch { /* noop */ }
  }
  snapshot.dreams.latest = latestDream(dreamsDir);

  return snapshot;
}

/**
 * Check the embedding provider the product would use right now and report
 * whether it is available and, if not, why.
 *
 * It asks createEmbeddingProvider for the order instead of keeping a list of
 * its own. Until 2026-11-14 it probed Ollama, OpenAI and a custom HTTP
 * endpoint — none of which the product uses — so `melo memory status` said
 * "no provider" on every machine and `melo memory fill-embeddings` refused to
 * run while the bundled model was working.
 *
 * Returns:
 *   {
 *     available: string | null,           // provider name, e.g. 'builtin'
 *     modelId:   string | null,
 *     dims:      number | null,
 *     reasons:   { [provider]: string }   // why a provider was not usable
 *   }
 *
 * Reads the file system only: no network request.
 */
export async function probeEmbeddingProviderAvailability() {
  const result = {
    available: null,
    modelId: null,
    dims: null,
    reasons: {},
  };
  let providerModule;
  try {
    providerModule = await import('./embedProviders/createEmbeddingProvider.js');
  } catch (err) {
    result.reasons._import = err?.message || String(err);
    return result;
  }
  const env = { ...requestEnvironment() };

  for (const name of providerModule.embeddingProviderOrder(env)) {
    const factory = providerModule.REGISTRY?.get?.(name);
    if (!factory) {
      result.reasons[name] = `no factory registered for "${name}"`;
      continue;
    }
    let p;
    try {
      p = factory({ env });
    } catch (err) {
      result.reasons[name] = `factory threw: ${err?.message || err}`;
      continue;
    }
    let ok = false;
    try {
      ok = await p.isAvailable();
    } catch (err) {
      result.reasons[name] = `isAvailable threw: ${err?.message || err}`;
      continue;
    }
    if (ok) {
      result.available = name;
      result.modelId = p?.modelId ? String(p.modelId).trim() : null;
      result.dims = typeof p?.dims === 'number' ? p.dims : null;
      return result;
    }
    result.reasons[name] = name === 'builtin'
      ? `The embedding model that ships with Melo was not found in ${p.modelDir}. ` +
        'Reinstall Melo, or point MELO_EMBED_MODEL_DIR at a directory that holds it.'
      : 'isAvailable returned false';
  }
  return result;
}

/**
 * Augment a snapshot with the *live* provider modelId.  Optional — CLI
 * consumers don't need to boot the embedding provider just to print the
 * snapshot.  Server consumers may pass the already-initialised provider's
 * modelId to flag drift.
 */
export function withLiveProviderModelId(snapshot, providerModelId) {
  const stored = snapshot.embedding.drift.stored;
  const live = providerModelId ? String(providerModelId).trim() : null;
  return {
    ...snapshot,
    embedding: {
      ...snapshot.embedding,
      drift: {
        stored,
        inferredProvider: live,
        hasDrift: Boolean(live && stored && live !== stored),
        // Calling this augmenter counts as an attempt — even if the
        // provider came back null (service down, auth failure, etc.).
        probeAttempted: true,
      },
    },
  };
}
import { derivedIndexStatus } from '../state/derivedDispatcher.js';
