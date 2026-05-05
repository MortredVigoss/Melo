/**
 * src/memory/status.js
 *
 * Phase 3 — shared read-only snapshot of the memory subsystem.
 *
 * Used by:
 *   • scripts/memory-status.js   (CLI, human + JSON output)
 *   • src/server.js              (GET /api/memory/status, fed to the UI)
 *
 * Must stay read-only: no writes to _meta, no mutations to embedding_cache,
 * no touching state.json.  Anyone adding fields here should keep that
 * contract so the UI can poll it freely without risk.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function getMeloHome() {
  return process.env.MELO_HOME || join(homedir(), '.melo');
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
export function collectMemoryStatus() {
  const meloHome = getMeloHome();
  const storePath = join(meloHome, 'desktop', 'store.sqlite');
  const dreamsDir = join(meloHome, 'desktop', 'dreams');

  const snapshot = {
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
      provider: process.env.MELO_EMBED_PROVIDER || '(default)',
      cacheRows: null,
      dimsConfigured: Number(process.env.MELO_EMBED_DIMS || 1024),
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
      db = new DatabaseSync(storePath, { readOnly: true });
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
 * Probe the live embedding provider chain (Ollama → OpenAI → CustomHttp)
 * and report which one (if any) is available + why the others failed.
 *
 * Phase F-2 (2026-05-05) follow-up: production diagnosis revealed the
 * symptom "vec_memories empty + embedding_cache=0" boils down to NO
 * provider being available — Ollama installed but not running, no
 * OPENAI_API_KEY, no MELO_EMBED_HTTP_URL — and the user had no way to
 * see this from `melo memory status`. The recall path falls back to
 * keyword cleanly so chat keeps working, but vector ANN is dead. This
 * helper surfaces the failure mode so users know what to fix.
 *
 * Returns:
 *   {
 *     available: 'ollama' | 'openai' | 'http' | null,
 *     modelId:   string | null,
 *     dims:      number | null,
 *     reasons:   { [provider]: string }   // per-provider rejection note
 *   }
 *
 * Bounded — total wall time ≤ ~3s (each provider's isAvailable has its
 * own internal timeout; Ollama uses 2s).
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
  const explicit = String(process.env.MELO_EMBED_PROVIDER || '').trim().toLowerCase();
  const order = explicit ? [explicit] : ['ollama', 'openai', 'http'];

  // Re-implement getEmbeddingProvider's loop so we can surface per-provider
  // rejection reasons. The factory registry is the same module-level Map.
  for (const name of order) {
    const factory = providerModule.REGISTRY?.get?.(name)
      ?? providerModule._REGISTRY?.get?.(name); // tolerate either export name
    if (!factory) {
      result.reasons[name] = `no factory registered for "${name}"`;
      continue;
    }
    let p;
    try {
      p = factory();
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
    // Per-provider explanation — what would a user need to fix?
    if (name === 'ollama') {
      result.reasons.ollama =
        'Ollama HTTP API at MELO_OLLAMA_URL (default http://localhost:11434) not reachable, ' +
        'or the configured embed model (MELO_OLLAMA_EMBED_MODEL, default bge-m3) is not pulled. ' +
        'Run `ollama serve` and `ollama pull bge-m3` to enable.';
    } else if (name === 'openai') {
      const offline = process.env.MELO_OFFLINE_ONLY === '1';
      result.reasons.openai = offline
        ? 'MELO_OFFLINE_ONLY=1 explicitly disables the OpenAI embed provider.'
        : 'Neither OPENAI_API_KEY nor MELO_API_KEY (sk-...) set — set one to enable.';
    } else if (name === 'http') {
      result.reasons.http =
        'MELO_EMBED_HTTP_URL not set — point this at a custom embed-server endpoint to enable.';
    } else {
      result.reasons[name] = 'isAvailable returned false';
    }
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
