import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getMeloHome } from '../config.js';
import { EMBEDDING_DIMS, cosineSimilarity } from './embeddings.js';
import { debugWarn, isDebugEnabled } from '../debug.js';
import { isSubsequenceMatch, scoreFuzzySubsequence } from '../search/scoring.js';

// Resolve STORE_PATH lazily so tests can swap MELO_HOME between runs without
// the path being frozen at module import time.  Production callers see no
// behavioural change — the value is effectively constant once MELO_HOME is
// set, because we cache the db handle on first open.
function resolveStorePath() {
  return join(getMeloHome(), 'desktop', 'store.sqlite');
}
let db = null;
let _openedStorePath = null;

/** @internal test-only — close the current db handle and re-read MELO_HOME
 *  on the next store operation, so each test can scope itself to a fresh
 *  tmpdir without module-level STORE_PATH leaking between cases. */
export function _resetStoreForTests() {
  if (db) {
    try {
      db.close();
    } catch {
      // Already closed or never opened — ignore.
    }
  }
  db = null;
  _vecLoaded = false;
  _openedStorePath = null;
}

// Insert spaces around CJK characters so unicode61 tokenizer treats each as a word
function toCjkSpaced(text = '') {
  return String(text).replace(
    /([\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F])/g,
    ' $1 ',
  );
}

// Load sqlite-vec CJS module synchronously via createRequire.
// sqlite-vec ships a CJS entry point (index.cjs) so this is safe.
import { createRequire } from 'node:module';

let _vecExtPath = null;
try {
  const _require = createRequire(import.meta.url);
  const _sqliteVec = _require('sqlite-vec');
  _vecExtPath = _sqliteVec.getLoadablePath();
} catch (err) {
  // sqlite-vec not installed — vector search disabled
  debugWarn('memory.store.vec', 'sqlite-vec not installed, vector search disabled', err?.message || err);
}

// Whether vec0 is loaded in the current db instance
let _vecLoaded = false;

function tryLoadVec(database) {
  if (_vecLoaded) return true;
  if (!_vecExtPath) return false;
  try {
    database.loadExtension(_vecExtPath);
    _vecLoaded = true;
  } catch (err) {
    debugWarn('memory.store.vec', 'loadExtension failed', err?.message || err);
  }
  return _vecLoaded;
}

/**
 * Idempotent schema setup. Runs CREATE TABLE / migrations against the
 * provided database. Used by both `getDb()` (the cached production
 * singleton) and `withDisposableStoreAt()` (a transient handle bound to
 * a captured ctx.storePath — Phase 7d-5α-A1 fix-7).
 *
 * Pre: caller has already attempted to load sqlite-vec into `database`
 * and tells us whether that succeeded via `vecLoaded`. We use it to
 * decide whether to create the vec_memories virtual table.
 *
 * Returns `{ vecAvailable }` so callers know whether the vec_memories
 * virtual table is actually usable on `database`. fix-8: even when
 * `vecLoaded === true`, the CREATE VIRTUAL TABLE can still fail (extension
 * loaded but vec0 module rejected — happens on disposable handles), and
 * downstream code that prepares INSERT/DELETE against `vec_memories` must
 * see the failure. Without this return value the disposable-store path
 * would prepare statements against a non-existent table.
 */
function applyMemoryStoreSchema(database, vecLoaded) {
  let vecAvailable = false;
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT,
      text TEXT NOT NULL,
      search_text TEXT NOT NULL,
      embedding BLOB,
      tokens_estimate INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_memories_namespace_kind
      ON memories(namespace, kind);
    CREATE INDEX IF NOT EXISTS idx_memories_chat_kind
      ON memories(json_extract(metadata_json, '$.chatId'), kind, id);
    CREATE INDEX IF NOT EXISTS idx_memories_namespace_updated
      ON memories(namespace, updated_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      memory_id  UNINDEXED,
      namespace  UNINDEXED,
      kind       UNINDEXED,
      search_text,
      tokenize = 'unicode61 remove_diacritics 1'
    );
    -- Bug B fix: embedding_cache is keyed by (text_hash, model_id) so a
    -- provider swap (bge-m3 → text-embedding-3-large) cannot serve vectors
    -- from the wrong vector space.  The boot-time migration below upgrades
    -- older databases that had text_hash as the sole PRIMARY KEY.
    CREATE TABLE IF NOT EXISTS embedding_cache (
      text_hash  TEXT NOT NULL,
      model_id   TEXT NOT NULL DEFAULT 'unknown',
      embedding  BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (text_hash, model_id)
    );
    CREATE TABLE IF NOT EXISTS memory_hits (
      memory_id       TEXT NOT NULL,
      hit_at          TEXT NOT NULL,
      query_hash      TEXT,
      rank            INTEGER,
      outcome         TEXT,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_hits_mid_time
      ON memory_hits(memory_id, hit_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_hits_time
      ON memory_hits(hit_at);
  `);

  // ── Migration: older databases created memory_hits without a FK to
  //    memories(id).  Once per boot, check the schema and — if needed —
  //    clean orphan hits and rebuild the table with the cascade constraint.
  //    Safe to run repeatedly; a no-op after the first upgrade.
  const hasFkCascade = database.prepare('PRAGMA foreign_key_list(memory_hits)').all()
    .some(fk => fk.table === 'memories' && fk.from === 'memory_id' && fk.on_delete === 'CASCADE');
  if (!hasFkCascade) {
    database.exec(`
      BEGIN;
      DELETE FROM memory_hits
       WHERE memory_id NOT IN (SELECT id FROM memories);
      CREATE TABLE memory_hits__new (
        memory_id       TEXT NOT NULL,
        hit_at          TEXT NOT NULL,
        query_hash      TEXT,
        rank            INTEGER,
        outcome         TEXT,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      INSERT INTO memory_hits__new (memory_id, hit_at, query_hash, rank, outcome)
        SELECT memory_id, hit_at, query_hash, rank, outcome FROM memory_hits;
      DROP TABLE memory_hits;
      ALTER TABLE memory_hits__new RENAME TO memory_hits;
      CREATE INDEX IF NOT EXISTS idx_memory_hits_mid_time
        ON memory_hits(memory_id, hit_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_hits_time
        ON memory_hits(hit_at);
      COMMIT;
    `);
  }

  // Keep query diversity separate from per-turn idempotency. Legacy hits remain intact.
  if (!database.prepare('PRAGMA table_info(memory_hits)').all().some(c => c.name === 'request_id')) {
    database.exec('ALTER TABLE memory_hits ADD COLUMN request_id TEXT');
  }
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_hits_request ON memory_hits(request_id,memory_id)');

  // Embedding dimension metadata table
  database.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);`);

  // ── Bug B migration: older databases created embedding_cache with
  //    text_hash as the sole PRIMARY KEY, so cached vectors survived a
  //    provider swap and could be served back from a different vector
  //    space.  Detect via PRAGMA table_info and, if needed, rebuild the
  //    table with (text_hash, model_id) as the composite primary key,
  //    backfilling existing rows with the currently-stored modelId (or
  //    'unknown' if _meta.embedding_model_id is empty).  Idempotent.
  const cacheCols = database.prepare(`PRAGMA table_info(embedding_cache)`).all();
  const hasModelIdCol = cacheCols.some(c => c.name === 'model_id');
  if (cacheCols.length && !hasModelIdCol) {
    const storedModel = database.prepare(
      `SELECT value FROM _meta WHERE key = 'embedding_model_id'`,
    ).get()?.value || 'unknown';
    database.exec(`
      BEGIN;
      CREATE TABLE embedding_cache__new (
        text_hash  TEXT NOT NULL,
        model_id   TEXT NOT NULL DEFAULT 'unknown',
        embedding  BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (text_hash, model_id)
      );
    `);
    database.prepare(
      `INSERT OR REPLACE INTO embedding_cache__new (text_hash, model_id, embedding, created_at)
         SELECT text_hash, ?, embedding, created_at FROM embedding_cache`,
    ).run(storedModel);
    database.exec(`
      DROP TABLE embedding_cache;
      ALTER TABLE embedding_cache__new RENAME TO embedding_cache;
      COMMIT;
    `);
    console.log(`[memory] embedding_cache migrated to (text_hash, model_id) composite PK (backfilled with model_id='${storedModel}')`);
  }

  // Detect dimension mismatch by reading the vec_memories schema (if it exists)
  const vecSchema = database.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_memories'`,
  ).get();
  const schemaHasRightDims = vecSchema?.sql?.includes(`float[${EMBEDDING_DIMS}]`);
  const needVecRebuild = vecSchema && !schemaHasRightDims;

  if (needVecRebuild) {
    // Preserve the old index until repair.js validates and commits its replacement.
    database.prepare("INSERT OR REPLACE INTO _meta VALUES ('embedding_repair_required', '1')").run();
  }
  database.prepare(`INSERT OR IGNORE INTO _meta (key, value) VALUES ('embedding_dims', ?)`).run(String(EMBEDDING_DIMS));

  // Create vec0 table for KNN search if sqlite-vec loaded successfully.
  // `vecLoaded` is captured at call time — for the cached production db
  // this matches the module-level `_vecLoaded`; for a disposable handle
  // bound to an alternate storePath, it reflects whether THAT handle
  // successfully loaded vec0.
  if (vecLoaded) {
    try {
      database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[${EMBEDDING_DIMS}]
        );
      `);
      // Verify the table is actually present — `IF NOT EXISTS` swallows
      // "module not found" silently on some sqlite-vec builds.
      const vecPresent = database.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_memories'`,
      ).get();
      vecAvailable = Boolean(vecPresent) && !needVecRebuild;
    } catch (err) {
      debugWarn('memory.store.vec', 'vec_memories create failed, disabling vector search', err?.message || err);
      vecAvailable = false;
    }
  }

  return { vecAvailable };
}

/**
 * Open a sqlite handle bound to an alternate `storePath`, run `work` against
 * it, then close. CLAUDE.md §6 fix-7: lets `replaceMemories(...)` honor a
 * captured ctx.storePath that doesn't match the cached production handle's
 * path — without disturbing the cached handle. Each call opens, sets up
 * schema, runs work, closes.
 */
function withDisposableStoreAt(storePath, work) {
  mkdirSync(dirname(storePath), { recursive: true });
  const tempDb = new DatabaseSync(storePath, { allowExtension: true });
  let vecLoadedHere = false;
  if (_vecExtPath) {
    try {
      tempDb.loadExtension(_vecExtPath);
      vecLoadedHere = true;
    } catch (err) {
      debugWarn('memory.store.vec', 'loadExtension failed (disposable db)', err?.message || err);
    }
  }
  // fix-8: respect what the schema apply actually achieved. Even if the
  // extension loaded successfully, CREATE VIRTUAL TABLE vec_memories can
  // still fail; downstream `_runReplaceMemoriesOn` prepares statements
  // against `vec_memories` based on this flag, so we must not over-claim.
  const { vecAvailable } = applyMemoryStoreSchema(tempDb, vecLoadedHere);
  try {
    tempDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    return work(tempDb, vecAvailable);
  } finally {
    try { tempDb.close(); } catch {}
  }
}

/**
 * Manual transaction wrapper for a specific database handle. Used by the
 * disposable-store path inside `replaceMemories`. Doesn't participate in
 * the SAVEPOINT-tracking that `runInTransaction` does because a disposable
 * handle has no concept of "outer transaction" in this codebase.
 */
function runInTransactionOn(database, work) {
  database.exec('BEGIN');
  try {
    const result = work(database);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (rollbackErr) {
      debugWarn('memory.store.tx', 'ROLLBACK failed (disposable)', rollbackErr?.message || rollbackErr);
    }
    throw error;
  }
}

function getDb() {
  if (db) {
    return db;
  }

  const storePath = resolveStorePath();
  _openedStorePath = storePath;
  mkdirSync(dirname(storePath), { recursive: true });
  db = new DatabaseSync(storePath, { allowExtension: true });
  tryLoadVec(db);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);

  // fix-8: applyMemoryStoreSchema returns whether vec_memories actually
  // exists on the handle after the schema apply. If CREATE VIRTUAL TABLE
  // failed, mirror that back into the module-level flag so subsequent
  // reads/writes avoid vec paths.
  const { vecAvailable } = applyMemoryStoreSchema(db, _vecLoaded);
  if (_vecLoaded && !vecAvailable) {
    _vecLoaded = false;
  }

  return db;
}

// ─── Embedding helpers ────────────────────────────────────────────────────────

function textHash(text) {
  return createHash('sha1').update(String(text)).digest('hex');
}

/**
 * Resolve the "current" modelId the embedding cache should be keyed under.
 * Prefers an explicit caller-supplied value; falls back to the last value
 * the runtime wrote into `_meta.embedding_model_id` (Phase 2); falls back
 * again to a literal 'unknown' so the composite PK is always valid.
 *
 * This is intentionally cheap and synchronous — it's called on every cache
 * read/write, so we stay off the network.
 */
function resolveCacheModelId(explicit, database = null) {
  if (explicit && typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  try {
    // CLAUDE.md §6 fix-7: when called from inside replaceMemories' disposable-
    // store branch, an explicit `database` is passed so the _meta lookup
    // happens against the captured home's sqlite — not the cached production
    // singleton (which would lazily open at the current env path).
    const dbHandle = database || getDb();
    const row = dbHandle.prepare(
      `SELECT value FROM _meta WHERE key = 'embedding_model_id'`,
    ).get();
    const v = row?.value;
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch { /* noop — table may not exist on first boot */ }
  return 'unknown';
}

/**
 * Retrieve a cached embedding BLOB for the given text, or null.
 * Bug B fix: scoped by modelId so a provider swap (same dims, different
 * vector space) never returns the previous model's vector.
 */
function getCachedEmbedding(text, modelId = null, database = null) {
  try {
    const resolvedModel = resolveCacheModelId(modelId, database);
    // CLAUDE.md §6 fix-7: when called inside replaceMemories' disposable-
    // store branch, the caller passes the disposable database explicitly
    // so the embedding lookup reads the captured-home's cache, not the
    // cached production singleton (which under cross-home test conditions
    // would resolve to a different home's path via getDb()'s lazy open).
    const dbHandle = database || getDb();
    const row = dbHandle.prepare(
      'SELECT embedding FROM embedding_cache WHERE text_hash = ? AND model_id = ?',
    ).get(textHash(text), resolvedModel);
    if (!row?.embedding) return null;
    return new Float32Array(row.embedding.buffer ?? row.embedding);
  } catch (err) {
    debugWarn('memory.store.cache', 'getCachedEmbedding failed', err?.message || err);
    return null;
  }
}

/**
 * Persist an embedding into the cache and vec_memories table.
 * Bug B fix: keyed by (text_hash, model_id) so two providers sharing the
 * same dims can coexist without poisoning each other's cache rows.
 */
/**
 * @returns {boolean} true if all three writes (cache + memories + vec) committed,
 *   false if `embedding` was missing or any write threw inside the transaction.
 *   Callers that key off this (e.g. memoryPromotion.js's clearNeedsReembed) must
 *   only act on `true` — the prior void return silently let them clear the
 *   reembed flag even when the vec0 write rolled back.
 */
function storeEmbedding(memoryId, searchText, embedding, modelId = null) {
  searchText=String(searchText || '').toLowerCase().replace(/\s+/g,' ').trim();
  if (!embedding) return false;
  const database = getDb();
  const current = database.prepare('SELECT search_text FROM memories WHERE id = ?').get(memoryId);
  if (!current || current.search_text !== searchText) return false;
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  const hash = textHash(searchText);
  const resolvedModel = resolveCacheModelId(modelId);
  const storedModel = database.prepare("SELECT value FROM _meta WHERE key='embedding_model_id'").get()?.value;
  if (storedModel && modelId && storedModel !== modelId) return false;
  if (database.prepare("SELECT value FROM _meta WHERE key='embedding_repair_required'").get()?.value === '1') return false;
  try {
    // Phase F-2c follow-up #2 (2026-05-10): wrap the three-step write in
    // runInTransaction so the embedding_cache INSERT, memories UPDATE, and
    // vec_memories DELETE+INSERT either ALL commit or ALL roll back.
    // Without this:
    //   • atomicity: a process kill / disk-full / sqlite-busy between
    //     `DELETE FROM vec_memories WHERE memory_id=?` and the following
    //     `INSERT INTO vec_memories ...` leaves vec_memories permanently
    //     missing the row while embedding_cache + memories.embedding are
    //     already populated — the 6861892 fix that replaced
    //     `INSERT OR REPLACE` (which was atomic per-statement) introduced
    //     this exact gap.
    //   • concurrency: two storeEmbedding(sameId) calls racing produce
    //     T1.DELETE → T2.DELETE → T2.INSERT → T1.INSERT throws UNIQUE,
    //     silently swallowed by the outer catch.  T1's caller has no
    //     idea the write was clobbered.
    // runInTransaction nests via SAVEPOINT (see _txDepth), so callers that
    // already wrap storeEmbedding in their own outer transaction (e.g. a
    // future replaceMemories-with-embeddings path) stay correct.
    runInTransaction(() => {
      database.prepare(
        `INSERT OR REPLACE INTO embedding_cache (text_hash, model_id, embedding, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(hash, resolvedModel, buf, new Date().toISOString());

      database.prepare(
        `UPDATE memories SET embedding = ? WHERE id = ?`,
      ).run(buf, memoryId);

      if (_vecLoaded) {
        // vec0 virtual tables reject `INSERT OR REPLACE` (see 6861892);
        // DELETE-then-INSERT is the vec0-safe pattern, now atomic via
        // the surrounding transaction.
        database.prepare(
          `DELETE FROM vec_memories WHERE memory_id = ?`,
        ).run(memoryId);
        database.prepare(
          `INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)`,
        ).run(memoryId, buf);
      }
    });
    return true;
  } catch (err) {
    // Best-effort — surface via MELO_DEBUG=memory.store.cache.
    // Transaction rollback is automatic when runInTransaction throws,
    // so partial state never reaches disk on failure.
    debugWarn('memory.store.cache', `storeEmbedding failed for memoryId=${memoryId}`, err?.message || err);
    return false;
  }
}

/** KNN query against vec_memories. Returns [{memory_id, distance}] */
function knnRecall(queryEmbedding, limit, { namespaces = [], kinds = [] } = {}) {
  if (!_vecLoaded || !queryEmbedding) return [];
  try {
    if (!namespaces.length) return [];
    const buf = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);
    const kindClause = kinds.length ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : '';
    return getDb().prepare(`
      SELECT memory_id, distance
      FROM vec_memories
      WHERE embedding MATCH ?
        AND memory_id IN (
          SELECT id FROM memories
          WHERE namespace IN (${namespaces.map(() => '?').join(', ')})${kindClause} AND ${activeMemorySQL()}
        )
      ORDER BY distance
      LIMIT ?
    `).all(buf, ...namespaces, ...kinds, limit);
  } catch (err) {
    debugWarn('memory.recall.knn', 'knnRecall query failed', err?.message || err);
    return [];
  }
}

export function buildMemoriesFtsQuery(text) {
  const unique = [...new Set(String(text || '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean))];
  // Repeated CJK text used to produce thousands of identical OR branches.
  // Keep bounded evidence from both ends of a long query.
  const tokens = (unique.length > 128 ? [...unique.slice(0,64), ...unique.slice(-64)] : unique)
    .map(t => `"${t.replace(/"/g, '')}"`)
    .join(' OR ');
  return tokens || null;
}

function normalizeEntry(entry = {}) {
  const id = String(entry.id || '').trim();
  const namespace = String(entry.namespace || '').trim();
  const kind = String(entry.kind || '').trim();
  const text = String(entry.text || '').trim();
  if (!id || !namespace || !kind || !text) {
    return null;
  }

  const createdAt =
    typeof entry.createdAt === 'string' && entry.createdAt.trim()
      ? entry.createdAt
      : new Date().toISOString();
  const updatedAt =
    typeof entry.updatedAt === 'string' && entry.updatedAt.trim()
      ? entry.updatedAt
      : createdAt;
  const searchText = String(entry.searchText || text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  return {
    id,
    namespace,
    kind,
    sourceId: typeof entry.sourceId === 'string' ? entry.sourceId : null,
    text,
    searchText,
    tokensEstimate:
      Number.isFinite(Number(entry.tokensEstimate)) && Number(entry.tokensEstimate) > 0
        ? Number(entry.tokensEstimate)
        : Math.ceil(text.length / 4),
    createdAt,
    updatedAt,
    lastUsedAt:
      typeof entry.lastUsedAt === 'string' && entry.lastUsedAt.trim()
        ? entry.lastUsedAt
        : null,
    metadataJson: JSON.stringify(entry.metadata || {}),
  };
}

// ─── Memory recall scoring (intentionally local where it must diverge) ──────
//
// We DO NOT import the full scoring stack from src/search/scoring.js here, on
// purpose:
//
//   1. `tokenizeQuery` below splits on anything that isn't a letter/number/
//      whitespace, which keeps a CJK phrase ("北京天气") as a single token.
//      The search/scoring tokenizer uses Intl.Segmenter and breaks CJK into
//      individual characters — correct for workspace file search, wrong
//      for memory recall where the phrase-as-unit behavior is what gives
//      meaningful ranking signal.
//
//   2. `fuzzySubsequenceScore` below delegates to `scoreFuzzySubsequence`
//      from src/search/scoring.js with base=100 (not the search domain's
//      140).  scoreMemoryRow multiplies the result by 0.4 and mixes it with
//      per-token exact-match scores on a different scale, so migrating
//      memory to the search-domain weights would rebalance every memory
//      recall ranking.  Sharing the algorithm core means Bug 5 (noise-floor
//      removal, gap-penalty math, ≥2-char guard) is fixed in exactly one
//      place — the base= parameter is the only memory-specific knob.
//
// What IS shared:
//   • `isSubsequenceMatch`  (imported — identical logic, no weight tuning)
//   • `scoreFuzzySubsequence({ base })`  (imported — same algorithm, base=100)
function tokenizeQuery(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const MEMORY_FUZZY_BASE = 100;

function fuzzySubsequenceScore(query, target) {
  return scoreFuzzySubsequence(query, target, { base: MEMORY_FUZZY_BASE });
}

function scoreMemoryRow(row, query = '') {
  const normalizedQuery = String(query || '').toLowerCase().trim();
  const haystack = String(row.search_text || row.text || '').toLowerCase();
  const tokens = tokenizeQuery(query);
  let score = 0;

  if (!tokens.length) {
    score += 10;
  }

  // Exact full-query match
  if (normalizedQuery && haystack === normalizedQuery) {
    score += 300;
  } else if (normalizedQuery && haystack.startsWith(normalizedQuery)) {
    score += 180;
  } else if (normalizedQuery && haystack.includes(normalizedQuery)) {
    const idx = haystack.indexOf(normalizedQuery);
    score += Math.max(80, 160 - Math.ceil(idx / 4));
  }

  // Per-token scoring: exact match → subsequence match → fuzzy
  for (const token of tokens) {
    const index = haystack.indexOf(token);
    if (index >= 0) {
      score += Math.max(18, 90 - Math.ceil(index / 5));
      continue;
    }
    // Subsequence match (e.g. "usr" matches "user")
    if (token.length >= 3 && isSubsequenceMatch(haystack, token)) {
      score += 30;
      continue;
    }
    // Fuzzy character-level match
    const fuzz = fuzzySubsequenceScore(token, haystack);
    if (fuzz > 0) {
      score += Math.round(fuzz * 0.4);
    }
  }

  // Recency bonus only applies when a query token matched (score > 0) or
  // when there is no query at all. Without this guard, recently-written entries
  // that have nothing to do with the query still get a positive score and leak
  // into search results.
  const hasMatch = score > 0;
  if (hasMatch || !tokens.length) {
    const recencyAnchor = Date.parse(row.updated_at || row.created_at || '') || 0;
    if (recencyAnchor) {
      const ageHours = Math.max(0, (Date.now() - recencyAnchor) / (1000 * 60 * 60));
      score += Math.max(0, 36 - ageHours * 1.5);
    }
  }

  return score;
}

function parseMetadata(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const activeMemorySQL = (prefix = '') => {
  const meta = `${prefix}metadata_json`;
  return ['mergedInto','sourceDeleted','quarantined','forgotten','mobileSyncConflict'].map(key =>
    `COALESCE(json_extract(${meta}, '$.${key}'), '') IN ('', 0)`).join(' AND ') +
    ` AND (json_extract(${meta}, '$.validTo') IS NULL OR julianday(json_extract(${meta}, '$.validTo')) IS NULL OR julianday(json_extract(${meta}, '$.validTo')) > julianday('now'))`;
};
function buildRecallQuery({ namespaces = [], kinds = [], allowGlobal = false } = {}) {
  const normalizedNamespaces = [...new Set(namespaces.map(value => String(value || '').trim()).filter(Boolean))];
  const normalizedKinds = [...new Set(kinds.map(value => String(value || '').trim()).filter(Boolean))];
  if (!normalizedNamespaces.length && !allowGlobal) return null;
  return { normalizedNamespaces, normalizedKinds, allowGlobal };
}
function keywordRecallRows(built, query = '', {limit = 64, accept = () => true, preferHot = false} = {}) {
  if (!built) return [];
  const database = getDb(), {normalizedNamespaces:ns, normalizedKinds:kinds} = built;
  const clauses = [activeMemorySQL('m.')], params = [];
  if (ns.length) { clauses.push(`m.namespace IN (${ns.map(()=>'?').join(',')})`); params.push(...ns); }
  if (kinds.length) { clauses.push(`m.kind IN (${kinds.map(()=>'?').join(',')})`); params.push(...kinds); }
  const columns = 'm.id,m.namespace,m.kind,m.source_id,m.text,m.search_text,m.tokens_estimate,m.created_at,m.updated_at,m.last_used_at,m.metadata_json';
  const pageSize = Math.max(64,Math.min(512,limit*2));
  function collect(sql, bindings, fts = false) {
    const stmt=database.prepare(sql), out=[];
    for(let offset=0;out.length<limit;offset+=pageSize) {
      const rows=stmt.all(...bindings,pageSize,offset);
      const scored = fts ? rows.map(row=>({...row,metadata:parseMetadata(row.metadata_json),score:-row.rank})) : mapScoredRows(rows,query);
      for(const row of scored) if(accept(materializeMemoryRows([row])[0]))out.push(row);
      if(rows.length<pageSize)break;
    }
    return out.slice(0,limit);
  }
  const ftsQuery = buildMemoriesFtsQuery(toCjkSpaced(query));
  if(ftsQuery) {
    try {
      const matches=collect(`SELECT ${columns},bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.id=memories_fts.memory_id
        WHERE memories_fts MATCH ? AND ${clauses.join(' AND ')} ORDER BY rank,m.id LIMIT ? OFFSET ?`,[ftsQuery,...params],true);
      if(matches.length)return matches;
    } catch(error) { debugWarn('memory.recall.fts','FTS unavailable; using scoped substring fallback',error?.message || error); }
    // Rare fuzzy/partial queries retain their old fallback, but SQL narrows
    // candidates before materialization and never imposes a newest-512 cutoff.
    const tokens=tokenizeQuery(query).slice(0,32);
    if(tokens.length) {
      clauses.push('('+tokens.map(()=>`lower(m.search_text) LIKE ? ESCAPE '\\'`).join(' OR ')+')');
      params.push(...tokens.map(token=>'%'+[...token].map(c=>c.replace(/[\\%_]/g,'\\$&')).join('%')+'%'));
    }
  }
  // Hot-first ordering (design audit M3): the Hot Attic candidate pool used to
  // be "the 32 most recently updated rows", so an old pinned decision fell out
  // of the pool as soon as newer ordinary facts arrived and dreaming's
  // promotion had no visible effect. With preferHot, rows that are pinned,
  // marked hot by the sweep, or in an always-hot category come first.
  const hotOrder = preferHot
    ? `CASE WHEN json_extract(m.metadata_json,'$.pinned')=1 THEN 0
            WHEN json_extract(m.metadata_json,'$.category') IN ('correction','decision') THEN 1
            WHEN json_extract(m.metadata_json,'$.attic')='hot' THEN 2
            ELSE 3 END,`
    : '';
  return collect(`SELECT ${columns} FROM memories m WHERE ${clauses.join(' AND ')} ORDER BY ${hotOrder}m.updated_at DESC,m.id LIMIT ? OFFSET ?`,params);
}

// Exported for unit tests — these are pure and deterministic.
export function isEntryInvalidated(metadata, nowMs = Date.now()) {
  if (metadata?.mergedInto || metadata?.mobileSyncConflict || metadata?.sourceDeleted || metadata?.quarantined || metadata?.forgotten) return true;
  const validTo = metadata?.validTo;
  if (!validTo) return false;
  const parsed = Date.parse(validTo);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

export function useCountBoost(metadata) {
  // Log-scaled importance feedback loop.  Hot facts surface earlier without
  // letting heavy reuse drown out a perfectly-matching fresh entry.
  const raw = Number(metadata?.useCount);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(60, Math.round(Math.log2(raw + 1) * 20));
}

// ─── Temporal decay (Phase 1 — #2) ───────────────────────────────────────────
//
// Newer rows outrank older rows at equal relevance, so long-lived stores
// don't let stale facts block fresh ones.  Exponential half-life with a
// floor (RECENCY_FLOOR) so old rows *de-prioritize* but never disappear.
//
// Exempt categories mirror dreaming's merge/supersede protection
// (merge.js:34, supersede.js:35) so decay does NOT fight dreaming:
//   - pinned: explicit user/system flag
//   - correction / decision / identity: belief-revision categories
// These all return 1 (full weight).

export const RECENCY_HALF_LIFE_DAYS = Number(process.env.MELO_RECENCY_HALF_LIFE_DAYS || 14);
const RECENCY_FLOOR = 0.5;
const EVERGREEN_CATEGORIES = new Set(['correction', 'decision', 'identity']);

/**
 * Compute a multiplier in [RECENCY_FLOOR, 1] for row freshness.
 * updatedAtArg is the row's SQL `updated_at` column (ISO string). Metadata
 * is inspected for `pinned` and `category`/`kind` so dreaming-protected
 * rows stay evergreen.
 */
export function recencyMultiplier(metadata, updatedAtArg) {
  if (!metadata) return 1;
  if (metadata.pinned) return 1;
  const category = String(metadata.category || metadata.kind || '').toLowerCase();
  if (EVERGREEN_CATEGORIES.has(category)) return 1;
  const ts = Date.parse(updatedAtArg || metadata.updatedAt || '') || 0;
  if (!ts) return 1; // fail-open: no timestamp → no penalty
  const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
  const decay = Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decay;
}

// ─── Recall scoring breakdown (Search audit C-4) ─────────────────────────────
//
// Instead of collapsing the final recall score into one opaque number, the
// helpers below produce a `_scoreParts` object when MELO_DEBUG includes
// `memory.recall.score`.  The fields are:
//   { semantic, keyword, useCountBoost, final }
// All four are always defined — unused signals are 0 — so a downstream log
// consumer can diff them across a before/after change without branching on
// the recall mode.  Production callers never see these parts; they only
// materialize under the debug gate.

const RECALL_SCORE_SCOPE = 'memory.recall.score';

function recallScoreDebugEnabled() {
  return isDebugEnabled(RECALL_SCORE_SCOPE);
}

/**
 * Build the `{ score, components }` pair for a single recall row.
 *
 * Exported so tests (and, later, a debug HTTP endpoint) can validate that
 * the component split matches the collapsed score they already assert on.
 *
 * @param {Object} args
 * @param {Object} args.metadata
 * @param {number} [args.semantic]   1 / (1 + knn-distance), 0 if none
 * @param {number} [args.keyword]    raw keyword score from scoreMemoryRow, 0 if none
 * @returns {{ score: number, components: { semantic: number, keyword: number, useCountBoost: number, final: number } }}
 */
export function computeRecallScoreParts({ metadata, semantic = 0, keyword = 0, updatedAt = null } = {}) {
  const semanticPart = Number.isFinite(semantic) ? semantic : 0;
  const keywordPart = Number.isFinite(keyword) ? keyword : 0;
  const boost = useCountBoost(metadata);
  // Scaling rule matches the in-place formulas in recallMemories / scoreAnn:
  //   semantic path: score = semantic + boost/600
  //   keyword  path: score = keyword + boost
  // computeRecallScoreParts is used for each path separately, so "final" is
  // just the sum the caller actually applies.  We return both halves so a
  // debug log can show them independently.
  //
  // Phase 1 #2: apply recency multiplier on top. pinned / correction /
  // decision / identity stay at weight 1 (see recencyMultiplier). This
  // aligns with dreaming's protection so the two systems can't drift.
  const rawFinal = semanticPart + keywordPart + (keywordPart > 0 ? boost : boost / 600);
  const recencyWeight = recencyMultiplier(metadata, updatedAt);
  const final = rawFinal * recencyWeight;
  return {
    score: final,
    components: {
      semantic: round4(semanticPart),
      keyword: round4(keywordPart),
      useCountBoost: boost,
      recencyWeight: round4(recencyWeight),
      final: round4(final),
    },
  };
}

function round4(n) {
  return Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : 0;
}

// ─── MMR diversity rerank (Phase 1 — #1) ────────────────────────────────────
//
// After score-sort, semantic recall can return N near-duplicates from one
// topic and crowd out related-but-different frames/facts.  MMR picks items
// iteratively, trading raw score vs novelty against what's already picked.
//
// Formula per candidate c:  mmr(c) = λ*score(c) - (1-λ)*max_sim(c, picked)
// pinned items bypass the diversity penalty (their max_sim is forced to 0)
// so a user-pinned row can't be excluded just because a near-duplicate ranked
// one slot above it.
//
// Fallback: if nothing has an embedding, return the top-lim by score (no
// MMR), so MMR can never make recall *worse* than pre-Phase-1 behaviour.

export const MMR_LAMBDA = Number(process.env.MELO_MMR_LAMBDA || 0.7);

function parseEmbeddingBlob(buf) {
  if (!buf) return null;
  try {
    // node:sqlite returns BLOB as Uint8Array; copy into an aligned ArrayBuffer
    // so Float32Array construction is safe regardless of the source byteOffset.
    const bytes = Buffer.isBuffer(buf) || buf instanceof Uint8Array
      ? buf
      : Buffer.from(buf);
    if (bytes.byteLength % 4 !== 0) return null;
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return new Float32Array(ab);
  } catch (err) {
    debugWarn('memory.recall.mmr', 'parseEmbeddingBlob failed', err?.message || err);
    return null;
  }
}

/**
 * Rerank a list of already-scored rows using MMR.  Each row should carry
 * at least { id, score, metadata, embedding }.  embedding is the raw BLOB
 * from the memories table (may be null — those rows get no diversity
 * penalty and still compete on score).
 *
 * Returns a new array of at most `lim` items.
 */
export function applyMmrRerank(sorted, lim, lambda = MMR_LAMBDA) {
  if (!Array.isArray(sorted) || sorted.length === 0) return [];
  if (sorted.length <= lim) return sorted.slice();

  const embByIdx = sorted.map(r => parseEmbeddingBlob(r?.embedding));
  // If no candidate has a usable embedding, fall back to the score order.
  if (!embByIdx.some(Boolean)) return sorted.slice(0, lim);

  const picked = [];
  const pickedEmbs = [];
  // Work on a shallow index list so we can splice without mutating input.
  const remainingIdx = sorted.map((_, i) => i);

  while (picked.length < lim && remainingIdx.length > 0) {
    let bestK = 0;
    let bestMmr = -Infinity;
    for (let k = 0; k < remainingIdx.length; k++) {
      const i = remainingIdx[k];
      const row = sorted[i];
      const emb = embByIdx[i];
      let maxSim = 0;
      // pinned rows bypass the diversity penalty
      if (emb && !row?.metadata?.pinned && pickedEmbs.length > 0) {
        for (const pe of pickedEmbs) {
          if (!pe) continue;
          const sim = cosineSimilarity(emb, pe);
          if (sim > maxSim) maxSim = sim;
        }
      }
      const mmr = lambda * (row.score || 0) - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestK = k;
      }
    }
    const chosenI = remainingIdx.splice(bestK, 1)[0];
    picked.push(sorted[chosenI]);
    pickedEmbs.push(embByIdx[chosenI]);
  }
  return picked;
}

/**
 * Emit a debug log of the top-N rows with their score components. No-op
 * when MELO_DEBUG doesn't include `memory.recall.score`.
 *
 * @param {string} source     short label (e.g. 'recallMemories.semantic')
 * @param {Array} rows        rows already scored; each must carry _scoreParts
 * @param {string} [query]
 */
function logRecallScores(source, rows, query = '') {
  if (!recallScoreDebugEnabled()) return;
  const sample = rows.slice(0, 5).map(r => ({
    id: r.id,
    kind: r.kind,
    namespace: r.namespace,
    score: r.score,
    parts: r._scoreParts?.components,
  }));
  debugWarn(RECALL_SCORE_SCOPE, `${source} query="${String(query).slice(0, 80)}" n=${rows.length}`, sample);
}

function mapScoredRows(rows = [], query = '') {
  const now = Date.now();
  return rows
    .map(row => {
      const metadata = parseMetadata(row.metadata_json);
      const keyword = scoreMemoryRow(row, query);
      const { score, components } = computeRecallScoreParts({
        metadata,
        keyword,
        updatedAt: row.updated_at,
      });
      return {
        ...row,
        metadata,
        score,
        _scoreParts: { components },
        _invalidated: isEntryInvalidated(metadata, now),
      };
    })
    .filter(row => row.score > 0 && !row._invalidated)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return Date.parse(right.updated_at || right.created_at || '') - Date.parse(left.updated_at || left.created_at || '');
    });
}

function materializeMemoryRows(rows = [], { lastUsedAt = null } = {}) {
  return rows.map(row => ({
    id: row.id,
    namespace: row.namespace,
    kind: row.kind,
    sourceId: row.source_id ?? row.sourceId ?? null,
    text: row.text,
    searchText: row.search_text ?? row.searchText ?? '',
    tokensEstimate: row.tokens_estimate ?? row.tokensEstimate ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
    lastUsedAt: lastUsedAt ?? row.last_used_at ?? row.lastUsedAt ?? null,
    metadata: row.metadata || parseMetadata(row.metadata_json),
    score: row.score,
    ...(row.embedding !== undefined ? { embedding: row.embedding } : {}),
  }));
}

// Re-entrant transaction helper.  SQLite does NOT allow nested BEGIN (it
// errors with "cannot start a transaction within a transaction"), so when
// `runInTransaction` is invoked while another tx is already open we use a
// SAVEPOINT instead.  This lets callers (e.g. the dreaming sweep in Bug D)
// wrap a whole orchestration in one atomic outer tx while the inner write
// helpers keep their own per-call runInTransaction boundary — if the outer
// tx fails, everything rolls back together; if only an inner savepoint
// fails, the error propagates but the outer state is still consistent.
let _txDepth = 0;
function runInTransaction(work) {
  const database = getDb();
  const depth = _txDepth;
  const savepoint = depth > 0 ? `melo_sp_${depth}` : null;
  if (savepoint) database.exec(`SAVEPOINT ${savepoint}`);
  else database.exec('BEGIN');
  _txDepth += 1;
  try {
    const result = work(database);
    if (savepoint) database.exec(`RELEASE ${savepoint}`);
    else database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      if (savepoint) {
        database.exec(`ROLLBACK TO ${savepoint}`);
        database.exec(`RELEASE ${savepoint}`);
      } else {
        database.exec('ROLLBACK');
      }
    } catch (rollbackErr) {
      // Ignore rollback failures so the original error remains visible.
      debugWarn('memory.store.tx', 'ROLLBACK failed', rollbackErr?.message || rollbackErr);
    }
    throw error;
  } finally {
    _txDepth -= 1;
  }
}

/**
 * Public, composable transaction wrapper.  Call this to batch a multi-step
 * orchestration (dreaming sweep, bulk import, ...) into one atomic unit.
 * Inner writer helpers (upsertMemory, setAtticLevels, ...) can still use
 * `runInTransaction` — they fall through to SAVEPOINTs automatically when
 * called inside `withTransaction`.
 *
 * The callback may be async, but keep in mind that holding a SQLite tx
 * across an await serialises every other write on the same connection
 * until the promise resolves.  Prefer to finish all async work (LLM calls,
 * network fetches) BEFORE entering `withTransaction`.
 *
 * @template T
 * @param {() => T} work
 * @returns {T}
 */
export function withTransaction(work) {
  return runInTransaction(() => work());
}

/**
 * Insert or update a single memory entry without touching other entries.
 * Used by the promotion pipeline to add cross-session facts incrementally.
 *
 * @param {object} entry  raw entry object (same shape as normalizeEntry input)
 */
export function upsertMemory(entry) {
  const row = normalizeEntry(entry);
  if (!row) return;
  const database = getDb();
  const previous = database.prepare('SELECT search_text FROM memories WHERE id = ?').get(row.id);
  const textChanged = previous && previous.search_text !== row.searchText;
  const alreadyInFts = database.prepare(
    `SELECT 1 FROM memories_fts WHERE memory_id = ? LIMIT 1`,
  ).get(row.id);

  runInTransaction(() => {
    database.prepare(`
      INSERT INTO memories (
        id, namespace, kind, source_id, text, search_text, embedding, tokens_estimate,
        created_at, updated_at, last_used_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        namespace      = excluded.namespace,
        source_id      = excluded.source_id,
        text           = excluded.text,
        search_text    = excluded.search_text,
        updated_at     = excluded.updated_at,
        metadata_json  = excluded.metadata_json
    `).run(
      row.id, row.namespace, row.kind, row.sourceId, row.text,
      row.searchText, null, row.tokensEstimate,
      row.createdAt, row.updatedAt, row.lastUsedAt, row.metadataJson,
    );
    if (textChanged) {
      database.prepare('UPDATE memories SET embedding = NULL WHERE id = ?').run(row.id);
      if (_vecLoaded) database.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(row.id);
    }
    // FTS5 virtual tables don't support ON CONFLICT — the only safe update
    // is DELETE + INSERT.  Bug fix: previously we only INSERTed when the
    // row was missing, so updates to search_text on an existing id left
    // the FTS index pointing at the OLD text.  That caused full-text
    // search to return stale matches after promotion re-classification or
    // identity-supersede rewrites.
    if (alreadyInFts) {
      database.prepare(
        `DELETE FROM memories_fts WHERE memory_id = ?`,
      ).run(row.id);
    }
    database.prepare(`
      INSERT INTO memories_fts (memory_id, namespace, kind, search_text)
      VALUES (?, ?, ?, ?)
    `).run(row.id, row.namespace, row.kind, toCjkSpaced(row.searchText));
  });
}

/**
 * Keys on `metadata_json` that dreaming, confirmed usage and validity
 * tracker own.  `replaceMemories` preserves them across a rebuild so a
 * snapshot never wipes background work.
 */
const PRESERVED_METADATA_KEYS = [
  'attic',
  'useCount',
  'lastBoostedAt',
  'mergedInto',
  'mergedFrom',
  'validFrom',
  'validTo',
  'pinned',
  'forgotten',
  'sourceDeleted',
  'quarantined',
  'mobileSyncConflict',
  'userEdited',
  'scope',
  'audience',
];

function isSnapshotProtectedIncrementalMemory(row = {}) {
  // `memoryPromotion.js` writes cross-session facts incrementally using
  // upsertMemory(). Snapshot rebuilds are allowed to prune stale state-derived
  // rows, but promoted session facts are intentionally independent of any
  // single chat snapshot and must survive compaction/deletion saves.
  return row.kind === 'session-fact' && String(row.id || '').startsWith('promoted:');
}

/**
 * @param {Array} entries
 * @param {{ storePath?: string }} [options]
 *   • `storePath` — when provided AND different from the currently
 *     cached production handle, this call routes through a disposable
 *     sqlite handle bound to `storePath`. CLAUDE.md §6 fix-7: lets
 *     readStateSnapshot's repair-save tunnel its captured ctx.storePath
 *     through replaceMemories without disturbing the cached production
 *     db. Production callers (which never pass `storePath`) keep using
 *     the cached singleton path with zero behavior change.
 */
export function replaceMemories(entries = [], { storePath } = {}) {
  const normalizedEntries = entries.map(normalizeEntry).filter(Boolean);

  // Captured-ctx path: target storePath differs from the cached prod
  // db. Use a disposable handle so we never mix homes on the cached
  // production singleton.
  if (storePath && storePath !== _openedStorePath) {
    return withDisposableStoreAt(storePath, (database, vecLoadedHere) => {
      return _runReplaceMemoriesOn(
        database,
        normalizedEntries,
        vecLoadedHere,
        work => runInTransactionOn(database, work),
      );
    });
  }

  // Default path: use the cached prod db + the standard SAVEPOINT-aware
  // runInTransaction. Behavior unchanged from before fix-7.
  const database = getDb();
  return _runReplaceMemoriesOn(
    database,
    normalizedEntries,
    _vecLoaded,
    work => runInTransaction(work),
  );
}

// A patch contains only changed source rows and IDs whose source disappeared.
// UPDATE (never REPLACE) preserves FK-linked hit history for surviving IDs.
export function patchMemories(entries = [], { deleteIds = [], storePath } = {}) {
  const normalized = entries.map(normalizeEntry).filter(Boolean);
  if (storePath && storePath !== _openedStorePath) return withDisposableStoreAt(storePath, (database, vecLoaded) =>
    _runReplaceMemoriesOn(database, normalized, vecLoaded, work => runInTransactionOn(database, work), {deleteIds}));
  return _runReplaceMemoriesOn(getDb(), normalized, _vecLoaded, work => runInTransaction(work), {deleteIds});
}

function _runReplaceMemoriesOn(database, incomingEntries, vecLoaded, runTx, {deleteIds = null} = {}) {
  const incoming = new Map(incomingEntries.map(row => [row.id, row]));
  if (incoming.size !== incomingEntries.length) throw new Error('UNIQUE constraint failed: duplicate memory id in snapshot');
  const select = database.prepare('SELECT id, namespace, kind, source_id, text, search_text, tokens_estimate, created_at, updated_at, last_used_at, metadata_json FROM memories WHERE id = ?');
  const remove = database.prepare('DELETE FROM memories WHERE id = ?');
  const removeFts = database.prepare('DELETE FROM memories_fts WHERE memory_id = ?');
  const removeVec = vecLoaded ? database.prepare('DELETE FROM vec_memories WHERE memory_id = ?') : null;
  const insertVec = vecLoaded ? database.prepare('INSERT INTO vec_memories(memory_id,embedding) VALUES (?,?)') : null;
  const insertFts = database.prepare('INSERT INTO memories_fts(memory_id,namespace,kind,search_text) VALUES (?,?,?,?)');
  const save = database.prepare(`INSERT INTO memories(id,namespace,kind,source_id,text,search_text,tokens_estimate,created_at,updated_at,last_used_at,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET namespace=excluded.namespace,kind=excluded.kind,source_id=excluded.source_id,
    text=excluded.text,search_text=excluded.search_text,tokens_estimate=excluded.tokens_estimate,created_at=excluded.created_at,
    updated_at=excluded.updated_at,last_used_at=excluded.last_used_at,metadata_json=excluded.metadata_json`);
  const setEmbedding = database.prepare('UPDATE memories SET embedding = ? WHERE id = ?');
  runTx(() => {
    const removed = deleteIds || database.prepare('SELECT id,kind FROM memories').all()
      .filter(row => !incoming.has(row.id) && !isSnapshotProtectedIncrementalMemory(row)).map(row => row.id);
    for (const id of new Set(removed)) {
      if (incoming.has(id)) continue;
      const prior = select.get(id);
      if (!prior || isSnapshotProtectedIncrementalMemory(prior)) continue;
      removeVec?.run(id); removeFts.run(id); remove.run(id);
    }
    for (const row of incoming.values()) {
      const prior = select.get(row.id);
      const oldMeta = parseMetadata(prior?.metadata_json);
      const metadata = parseMetadata(row.metadataJson);
      for (const key of PRESERVED_METADATA_KEYS) if (oldMeta[key] !== undefined) metadata[key] = oldMeta[key];
      const metadataJson = JSON.stringify(metadata);
      const lastUsedAt = prior?.last_used_at || row.lastUsedAt || null;
      const textChanged = !prior || prior.search_text !== row.searchText;
      const indexChanged = textChanged || prior.namespace !== row.namespace || prior.kind !== row.kind;
      // Profile snapshots have no source timestamp. Do not manufacture a new
      // modification time on every unrelated global settings update.
      const sameIdentity = prior && row.kind === 'identity' && prior.text === row.text && prior.metadata_json === metadataJson;
      const createdAt = row.kind === 'identity' && prior ? prior.created_at : row.createdAt;
      const updatedAt = sameIdentity ? prior.updated_at : row.updatedAt;
      const same = prior && prior.namespace === row.namespace && prior.kind === row.kind && prior.source_id === row.sourceId &&
        prior.text === row.text && prior.search_text === row.searchText && prior.tokens_estimate === row.tokensEstimate &&
        prior.created_at === createdAt && prior.updated_at === updatedAt && prior.last_used_at === lastUsedAt && prior.metadata_json === metadataJson;
      if (same) continue;
      save.run(row.id,row.namespace,row.kind,row.sourceId,row.text,row.searchText,row.tokensEstimate,createdAt,updatedAt,lastUsedAt,metadataJson);
      if (indexChanged) { removeFts.run(row.id); insertFts.run(row.id,row.namespace,row.kind,toCjkSpaced(row.searchText)); }
      if (textChanged) {
        const cached = getCachedEmbedding(row.searchText, null, database);
        const embedding = cached ? Buffer.from(cached.buffer, cached.byteOffset, cached.byteLength) : null;
        setEmbedding.run(embedding,row.id); removeVec?.run(row.id);
        if (embedding) insertVec?.run(row.id,embedding);
      }
    }
  });
  return incoming.size;
}

/**
 * Store a generated embedding for a specific memory entry.
 * Called asynchronously after replaceMemories to fill in missing embeddings.
 *
 * Bug B: `modelId` is optional — when omitted, the cache falls back to
 * `_meta.embedding_model_id` (set on boot by runtime.js).  Passing an
 * explicit modelId lets callers pin the cache entry to the exact provider
 * that generated the vector, which matters when the provider is being
 * swapped mid-session.
 *
 * @param {string}       memoryId
 * @param {string}       searchText   original search_text (for cache key)
 * @param {Float32Array} embedding
 * @param {string|null}  [modelId]    optional — overrides _meta resolution
 */
export function saveMemoryEmbedding(memoryId, searchText, embedding, modelId = null) {
  const actualModel = modelId || embedding?.modelId || null;
  const storedModel = readStoredEmbeddingModelId();
  if (actualModel && storedModel && actualModel !== storedModel) {
    requireEmbeddingRepair();
    // Cache may hold multiple spaces; the active vector index may not.
    if (embedding?.length === EMBEDDING_DIMS && [...embedding].every(Number.isFinite)) {
      getDb().prepare('INSERT OR REPLACE INTO embedding_cache VALUES (?, ?, ?, ?)')
        .run(textHash(searchText),actualModel,Buffer.from(embedding.buffer,embedding.byteOffset,embedding.byteLength),new Date().toISOString());
    }
    return false;
  }
  if (actualModel && !storedModel) writeStoredEmbeddingModelId(actualModel);
  return storeEmbedding(memoryId, searchText, embedding, actualModel);
}

/**
 * Return all memory entries that still lack an embedding, sorted by namespace.
 * Used by the background fill-in job.
 *
 * @returns {{ id: string, searchText: string }[]}
 */
export function getMemoriesWithoutEmbeddings() {
  try {
    const rows = getDb().prepare(
      `SELECT id, search_text FROM memories WHERE embedding IS NULL LIMIT 200`,
    ).all();
    return rows.map(r => ({ id: r.id, searchText: r.search_text }));
  } catch (err) {
    debugWarn('memory.store.embed', 'getMemoriesWithoutEmbeddings query failed', err?.message || err);
    return [];
  }
}

/** Batch the flat per-turn requests into one candidate pool. Sparse categories
 * get a scoped refill so plentiful prompt rows cannot starve corrections/tasks.
 * Namespace + kind restrictions still apply before each ANN top-K selection.
 */
export function recallMemoryGroups({groups = [], query = '', queryEmbedding = null, accept = () => true} = {}) {
  const active = groups.filter(g => g.namespaces?.length && g.kinds?.length && g.limit > 0);
  if (!active.length) return new Map();
  const namespaces = [...new Set(active.flatMap(g=>g.namespaces))];
  const kinds = [...new Set(active.flatMap(g=>g.kinds))];
  const matches = (row,g) => g.namespaces.includes(row.namespace) && g.kinds.includes(row.kind) && (!g.accept || g.accept(row));
  const pool = recallMemories({namespaces,kinds,query,queryEmbedding,
    limit: Math.min(512,active.reduce((sum,g)=>sum+g.limit,0)*4),
    accept: row => accept(row) && active.some(g=>matches(row,g))});
  const counts = getDb().prepare(`SELECT namespace,kind,COUNT(*) AS n FROM memories
    WHERE namespace IN (${namespaces.map(()=>'?').join(',')}) AND kind IN (${kinds.map(()=>'?').join(',')})
      AND ${activeMemorySQL()} GROUP BY namespace,kind`).all(...namespaces,...kinds);
  return new Map(active.map(group => {
    let rows = pool.filter(row=>matches(row,group)).slice(0,group.limit);
    const count = counts.filter(row=>group.namespaces.includes(row.namespace) && group.kinds.includes(row.kind)).reduce((sum,row)=>sum+row.n,0);
    if (rows.length < Math.min(group.limit,count)) rows = recallMemories({...group,query,queryEmbedding,accept:row=>accept(row)&&matches(row,group)});
    return [group.id,rows];
  }));
}

export function recallMemories({
  namespaces = [],
  kinds = [],
  query = '',
  limit = 8,
  queryEmbedding = null,
  includeEmbedding = false,
  accept = () => true,
  preferHot = false,
} = {}) {
  const builtQuery = buildRecallQuery({ namespaces, kinds, allowGlobal: false });
  if (!builtQuery) {
    return [];
  }

  const database = getDb();
  const lim = Math.max(1, limit);

  // Constrain ANN before taking top K: other chats/kinds must not crowd out
  // valid candidates, even when thousands of prompt rows are more similar.
  if (queryEmbedding && _vecLoaded && database.prepare("SELECT value FROM _meta WHERE key='embedding_repair_required'").get()?.value !== '1') {
    try {
      const knnResults = knnRecall(queryEmbedding, lim * 8, {namespaces:builtQuery.normalizedNamespaces,kinds:builtQuery.normalizedKinds});
      if (knnResults.length > 0) {
        const ids = knnResults.map(r => r.memory_id);
        const placeholders = ids.map(() => '?').join(', ');

        const normalizedNs = builtQuery.normalizedNamespaces;
        const normalizedKinds = builtQuery.normalizedKinds;
        const nsClause = normalizedNs.length
          ? `AND namespace IN (${normalizedNs.map(() => '?').join(', ')})`
          : '';
        const kindClause = normalizedKinds.length
          ? `AND kind IN (${normalizedKinds.map(() => '?').join(', ')})`
          : '';

        const rows = database.prepare(`
          SELECT id, namespace, kind, source_id, text, search_text, embedding,
                 tokens_estimate, created_at, updated_at, last_used_at, metadata_json
          FROM memories
          WHERE id IN (${placeholders}) ${nsClause} ${kindClause}
        `).all(...ids, ...normalizedNs, ...normalizedKinds);

        if (rows.length > 0) {
          // Order by KNN distance (lower = more similar) with a small
          // importance boost so hot facts surface earlier in ties.  Also
          // filter out temporally-invalidated entries up front.
          const distMap = new Map(knnResults.map(r => [r.memory_id, r.distance]));
          const now = Date.now();
          const sorted = rows
            .map(row => {
              const metadata = parseMetadata(row.metadata_json);
              const semantic = 1 / (1 + (distMap.get(row.id) ?? 99));
              const { score, components } = computeRecallScoreParts({
                metadata,
                semantic,
                updatedAt: row.updated_at,
              });
              return {
                ...row,
                metadata,
                score,
                _scoreParts: { components },
                _invalidated: isEntryInvalidated(metadata, now),
              };
            })
            .filter(row => !row._invalidated && accept(materializeMemoryRows([row])[0]))
            .sort((a, b) => b.score - a.score);

          // Phase 1 #1: MMR diversity rerank. Uses row.embedding which the
          // SELECT above explicitly fetches. Falls back to score-order slice
          // when embeddings are missing.
          // Fuse both candidate sets. New/unembedded exact matches must compete
          // even when ANN found unrelated rows. Reciprocal rank avoids mixing
          // raw keyword scores (hundreds) with cosine scores (0..1).
          const lexical = keywordRecallRows(builtQuery, query, {limit:lim*4,accept});
          if (!String(query).trim()) lexical.length=0;
          const fused = new Map();
          sorted.forEach((row,i)=>fused.set(row.id,{...row,score:1/(60+i+1)}));
          lexical.forEach((row,i)=>{
            const prior=fused.get(row.id);
            const exact=query && String(row.search_text || row.text).toLowerCase().includes(String(query).toLowerCase());
            fused.set(row.id,{...row,...prior,score:(prior?.score||0)+1/(60+i+1)+(exact?0.05:0)});
          });
          // 2026-10-17 audit C-12: MMR used to run only on the no-query branch,
          // which production never takes, so the diversity rerank was dead code.
          // Apply it after RRF fusion with scores normalised to 0..1 so the
          // diversity penalty is on the same scale as the relevance term.
          let mmrSorted;
          if (String(query).trim()) {
            const fusedSorted = [...fused.values()].sort((a,b)=>b.score-a.score);
            const top = fusedSorted[0]?.score || 1;
            mmrSorted = applyMmrRerank(fusedSorted.map(row=>({...row,score:row.score/top})),lim);
          } else {
            mmrSorted = applyMmrRerank(sorted,lim);
          }

          if (mmrSorted.length > 0) {
            logRecallScores('recallMemories.semantic', mmrSorted, query);
            return materializeMemoryRows(mmrSorted);
          }
        }
      }
    } catch (err) {
      // Fall through to keyword scoring
      debugWarn('memory.recall.knn', 'recallMemories semantic path failed, falling back to keyword', err?.message || err);
    }
  }

  // Keyword scoring fallback (original behaviour).
  //
  // Bug E: buildRecallQuery's SQL deliberately omits the `embedding` column
  // to keep keyword recalls light (each BLOB is ~4KB).  But some callers —
  // most notably memoryPromotion's semantic-dedup branch — need the vector
  // alongside the row, and silently receive `undefined`, so the branch is
  // effectively dead.  Opt-in `includeEmbedding: true` re-fetches just the
  // embedding BLOB by id for the final scored slice, so callers that need
  // it pay the cost, everyone else stays on the lean path.
  const rows = keywordRecallRows(builtQuery,query,{limit:lim,accept,preferHot});

  if (includeEmbedding && rows.length > 0) {
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(', ');
    try {
      const embRows = database.prepare(
        `SELECT id, embedding FROM memories WHERE id IN (${placeholders})`,
      ).all(...ids);
      const embMap = new Map(embRows.map(r => [r.id, r.embedding]));
      for (const row of rows) row.embedding = embMap.get(row.id) ?? null;
    } catch (err) {
      debugWarn('memory.recall.keyword', 'includeEmbedding side-fetch failed', err?.message || err);
    }
  }

  logRecallScores('recallMemories.keyword', rows, query);
  return materializeMemoryRows(rows);
}

// ─── Tiered recall (scene → frame → content) ────────────────────────────────
//
// New entry point for the Phase-C architecture.  Keeps recallMemories intact
// so nothing in the existing desktopStore paths breaks — callers that want
// the tiered result explicitly ask for it.
//
// Flow:
//   1. Scene-level ANN (k=3) on the query embedding.
//   2. Frame-level ANN (k=8) restricted to those scenes.
//   3. Content-level ANN (k=12) restricted to those frames.
// Each step also has a keyword fallback so missing embeddings degrade
// gracefully to the existing BM25-style scoring.
//
// The returned shape is a composite object so the caller can decide how to
// merge the three tiers into the prompt budget.

function scoreAnn(rows, distMap, nowMs) {
  return rows
    .map(row => {
      const metadata = parseMetadata(row.metadata_json);
      const semantic = 1 / (1 + (distMap.get(row.id) ?? 99));
      const { score, components } = computeRecallScoreParts({
        metadata,
        semantic,
        updatedAt: row.updated_at,
      });
      return {
        ...row,
        metadata,
        score,
        _scoreParts: { components },
        _invalidated: isEntryInvalidated(metadata, nowMs),
      };
    })
    .filter(row => !row._invalidated)
    .sort((a, b) => b.score - a.score);
}

function fetchByIds(ids, extraClause = '', extraArgs = []) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  try {
    return getDb().prepare(`
      SELECT id, namespace, kind, source_id, text, search_text, tokens_estimate,
             created_at, updated_at, last_used_at, metadata_json
      FROM memories
      WHERE id IN (${placeholders}) ${extraClause}
    `).all(...ids, ...extraArgs);
  } catch (err) {
    debugWarn('memory.recall.fetch', 'fetchByIds failed', err?.message || err);
    return [];
  }
}

// ─── Stage 4 — context validation ───────────────────────────────────────────
//
// The first three tiers (scene → frame → content) answer "what is most likely
// relevant?"  They do NOT answer "is the relevant set internally consistent?"
// A pure ANN recall will happily surface an old claim and its own correction
// side-by-side, or two contradictory "role" facts the user asserted at
// different times.  That's the gap Stage 4 closes — the missing loop of the
// inverted pyramid.
//
// The pass is deliberately annotate-don't-delete: rows stay in the returned
// tier arrays (callers might still want to show "X was corrected to Y"), but
// each contested/superseded/orphan row is flagged so the prompt-builder can
// either drop it or phrase around it.  A `conflicts` report is also attached
// so telemetry can track how often the validator fires.
//
// The detector uses signals that are already present on every memory row — no
// extra embedding queries, no extra DB round-trips.
//
// Signals (ordered cheapest → strongest):
//   A. validTo re-check  — fires late so validity windows that lapsed between
//      Stage 0 and now still get caught.
//   B. explicit correction vs. older peer on the same topic — kind=
//      'verification-correction' or metadata.category='correction' dominates.
//   C. single-value category collision — name/role/location/work/identity
//      can only have one live answer, so the newer wins.
//   D. cross-tier orphan — a content row whose metadata.frameId doesn't
//      appear in the recalled frame set means scene→frame narrowing did not
//      ratify it; downgrade.
//   E. lifecycle status — rows marked needs_confirmation stay visible but
//      get an explicit flag so prompt builders phrase them as stale/contextual.

const STAGE4_SINGLE_VALUE_CATEGORIES = new Set([
  'name',
  'role',
  'location',
  'work',
  'identity',
]);

function _stage4NormalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function _stage4IsCorrection(row) {
  if (!row) return false;
  if (String(row.kind || '').toLowerCase() === 'verification-correction') return true;
  const category = String(row.metadata?.category || '').toLowerCase();
  return category === 'correction';
}

// Topic key used to detect "same-subject" peers.  Prefers an explicit
// extractor-supplied key; otherwise falls back to category + normalized text
// (same shape as speakerFacts.getSpeakerFactStorageKey) so the key is stable
// across the offline extractor, the session-memory merger, and this
// retrieval-time validator.
function _stage4TopicKey(row) {
  if (!row) return '';
  const explicit =
    row.metadata?.factKey ||
    row.metadata?.topic ||
    row.metadata?.subject ||
    null;
  if (explicit) return _stage4NormalizeText(explicit);
  const category = String(row.metadata?.category || row.kind || '').toLowerCase();
  const text = _stage4NormalizeText(row.text || '');
  if (!category || !text) return '';
  if (STAGE4_SINGLE_VALUE_CATEGORIES.has(category)) {
    // Single-value categories: the category alone is the topic — any two
    // rows with the same category collide, even if their text differs.
    return category;
  }
  return `${category}:${text}`;
}

function _stage4UpdatedAt(row) {
  const candidates = [row?.updated_at, row?.metadata?.updatedAt, row?.created_at];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string' && c) {
      const parsed = Date.parse(c);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

/**
 * Stage 4 of the tiered recall — runs coherence checks over the union of
 * scene + frame + content rows returned by the first three stages.  Emits
 * a `conflicts` report and annotates contested/superseded/orphan/expired
 * rows; it never drops rows silently.
 *
 * Exported so unit tests and the prompt-builder can drive it independently
 * of `recallMemoriesTiered`.
 *
 * @param   {{scenes: Array, frames: Array, contents: Array}} tiers
 * @param   {Object}   [options]
 * @param   {number}   [options.nowMs]         default Date.now()
 * @param   {boolean}  [options.dropContested] if true, contested/expired
 *                                             rows are filtered out of
 *                                             the returned tier arrays
 * @returns {{scenes: Array, frames: Array, contents: Array, conflicts: Array}}
 */
export function validateContext(
  { scenes = [], frames = [], contents = [] } = {},
  { nowMs = Date.now(), dropContested = false } = {},
) {
  const conflicts = [];
  const all = [...scenes, ...frames, ...contents];
  if (!all.length) {
    return { scenes, frames, contents, conflicts };
  }

  // ── A. Temporal safety net — re-apply isEntryInvalidated with a fresh
  //        `now`.  Stage 0 filters ran with an older timestamp; a validTo
  //        that lapsed in between still slips through without this.
  const invalidated = new Set();
  for (const row of all) {
    if (row?._invalidated) {
      // Already flagged by an earlier tier — keep the flag, don't duplicate
      // it in the conflict report.
      invalidated.add(row.id);
      continue;
    }
    if (isEntryInvalidated(row?.metadata || {}, nowMs)) {
      invalidated.add(row.id);
      conflicts.push({
        type: 'expired',
        loserId: row.id,
        reason: 'validTo <= now',
      });
    }
  }

  // ── B. Explicit corrections beat older peers on the same topic.
  const contested = new Map(); // id -> winnerId
  const corrections = all.filter(_stage4IsCorrection);
  for (const c of corrections) {
    const key = _stage4TopicKey(c);
    if (!key) continue;
    const cTs = _stage4UpdatedAt(c);
    for (const peer of all) {
      if (peer.id === c.id) continue;
      if (_stage4IsCorrection(peer)) continue;
      if (invalidated.has(peer.id)) continue;
      if (_stage4TopicKey(peer) !== key) continue;
      if (_stage4UpdatedAt(peer) >= cTs) continue;
      contested.set(peer.id, c.id);
      conflicts.push({
        type: 'correction',
        winnerId: c.id,
        loserId: peer.id,
        reason: 'newer correction on same topic',
      });
    }
  }

  // ── C. Single-value category collision — only the newest value is live.
  const byCategory = new Map();
  for (const row of all) {
    const cat = String(row.metadata?.category || row.kind || '').toLowerCase();
    if (!STAGE4_SINGLE_VALUE_CATEGORIES.has(cat)) continue;
    if (invalidated.has(row.id) || contested.has(row.id)) continue;
    const list = byCategory.get(cat) || [];
    list.push(row);
    byCategory.set(cat, list);
  }
  for (const [cat, list] of byCategory) {
    if (list.length < 2) continue;
    list.sort((a, b) => _stage4UpdatedAt(b) - _stage4UpdatedAt(a));
    const winner = list[0];
    const winnerText = _stage4NormalizeText(winner.text || '');
    for (let i = 1; i < list.length; i++) {
      const loser = list[i];
      // If the stored texts normalize to the same value, they're not in
      // conflict — two writes of the same fact.  Skip to avoid bogus
      // conflict noise.
      if (_stage4NormalizeText(loser.text || '') === winnerText) continue;
      contested.set(loser.id, winner.id);
      conflicts.push({
        type: 'superseded',
        winnerId: winner.id,
        loserId: loser.id,
        reason: `newer value in single-value category '${cat}'`,
      });
    }
  }

  // ── D. Cross-tier orphan — content whose frame wasn't ratified by
  //        Stage 2 is weakly supported.  Flag, don't drop.
  const orphans = new Set();
  const frameIdSet = new Set(
    frames.map(f => f.metadata?.frameId).filter(Boolean),
  );
  if (frameIdSet.size) {
    for (const row of contents) {
      const fid = row.metadata?.frameId;
      if (fid && !frameIdSet.has(fid)) {
        orphans.add(row.id);
        conflicts.push({
          type: 'orphan',
          loserId: row.id,
          reason: 'content frameId is outside the recalled frame set',
        });
      }
    }
  }

  // ── E. Lifecycle uncertainty — these are not "wrong" rows; they are
  //        routines/derived memories whose anchor facts changed later.
  const needsConfirmation = new Set();
  for (const row of all) {
    if (row?.metadata?.status === 'needs_confirmation') {
      needsConfirmation.add(row.id);
      conflicts.push({
        type: 'needs_confirmation',
        loserId: row.id,
        winnerId: row.metadata?.staleBecause?.anchorId || null,
        reason: `depends on changed '${row.metadata?.staleBecause?.changedFactKey || 'fact'}'`,
      });
    }
  }

  const annotate = (row) => {
    const flags = {};
    if (invalidated.has(row.id)) flags._invalidated = true;
    if (contested.has(row.id)) {
      flags._contested = true;
      flags._contestedBy = contested.get(row.id);
    }
    if (orphans.has(row.id)) flags._orphan = true;
    if (needsConfirmation.has(row.id)) flags._needsConfirmation = true;
    return Object.keys(flags).length ? { ...row, ...flags } : row;
  };

  const keep = (row) => {
    if (!dropContested) return true;
    if (invalidated.has(row.id)) return false;
    if (contested.has(row.id)) return false;
    return true;
  };

  return {
    scenes: scenes.filter(keep).map(annotate),
    frames: frames.filter(keep).map(annotate),
    contents: contents.filter(keep).map(annotate),
    conflicts,
  };
}

/**
 * Tiered scene → frame → content recall.  Returns:
 *   { scenes, frames, contents, conflicts }   – tier arrays plus a Stage-4
 *                                                coherence report.
 *
 * @param {Object}         options
 * @param {string[]}       [options.namespaces]   fallback namespace filter
 * @param {string}         [options.query]        raw query text
 * @param {Float32Array}   [options.queryEmbedding]
 * @param {Object}         [options.limits]       { scenes, frames, contents }
 * @param {string[]}       [options.atticLevels]  filter (e.g. ['warm','cold'])
 * @param {boolean}        [options.validate]     run Stage 4 (default true)
 * @param {boolean}        [options.dropContested] Stage-4 filter mode
 *                                                 (default false — annotate)
 * @returns {{ scenes: Array, frames: Array, contents: Array, conflicts: Array }}
 */
export function recallMemoriesTiered({
  namespaces = [],
  query = '',
  queryEmbedding = null,
  limits = {},
  atticLevels = null,
  validate = true,
  dropContested = false,
  accept = () => true,
} = {}) {
  const { scenes: sLim = 3, frames: fLim = 8, contents: cLim = 12 } = limits;
  const database = getDb();
  const now = Date.now();
  const normalizedNs = namespaces.map(n => String(n || '').trim()).filter(Boolean);

  // ─── Helper: attic filter ───────────────────────────────────────────────
  const atticOk = (row) => {
    if (!atticLevels || !atticLevels.length) return true;
    const level = row.metadata?.attic || 'cold';
    return atticLevels.includes(level);
  };

  if (!normalizedNs.length) return {scenes:[],frames:[],contents:[],conflicts:[]};
  const mergeTier = (semantic, kinds, limit) => {
    if (!String(query).trim() && semantic.length) return semantic.filter(row=>accept(materializeMemoryRows([row])[0])).slice(0,limit);
    const built = buildRecallQuery({namespaces:normalizedNs,kinds,allowGlobal:false});
    const lexical=keywordRecallRows(built,query,{limit:limit*4,accept:row=>atticOk(row) && accept(row)});
    const fused=new Map();
    semantic.filter(row=>accept(materializeMemoryRows([row])[0])).forEach((row,i)=>fused.set(row.id,{...row,score:1/(61+i)}));
    lexical.forEach((row,i)=>{
      const prior=fused.get(row.id);
      const exact=query && String(row.search_text || row.text).toLowerCase().includes(String(query).toLowerCase());
      fused.set(row.id,{...row,...prior,score:(prior?.score || 0)+1/(61+i)+(exact?0.05:0)});
    });
    return [...fused.values()].sort((a,b)=>b.score-a.score).slice(0,limit);
  };

  // ─── Step 1 — scenes ────────────────────────────────────────────────────
  let scenes = [];
  if (queryEmbedding && _vecLoaded && database.prepare("SELECT value FROM _meta WHERE key='embedding_repair_required'").get()?.value !== '1') {
    try {
      const knn = knnRecall(queryEmbedding, sLim * 6, {namespaces:normalizedNs,kinds:['scene']});
      const ids = knn.map(r => r.memory_id);
      const nsClause = normalizedNs.length
        ? `AND namespace IN (${normalizedNs.map(() => '?').join(', ')})`
        : '';
      const sceneRows = fetchByIds(
        ids,
        `AND kind = 'scene' ${nsClause}`,
        normalizedNs,
      );
      const distMap = new Map(knn.map(r => [r.memory_id, r.distance]));
      scenes = scoreAnn(sceneRows, distMap, now).filter(atticOk).slice(0, sLim);
    } catch (err) {
      debugWarn('memory.recall.tiered', 'scene ANN failed', err?.message || err);
      scenes = [];
    }
  }

  scenes=mergeTier(scenes,['scene'],sLim);
  const sceneIds = scenes.map(s => s.metadata?.sceneId).filter(Boolean);

  // ─── Step 2 — frames (restricted to the scenes we picked) ───────────────
  let frames = [];
  if (queryEmbedding && _vecLoaded && database.prepare("SELECT value FROM _meta WHERE key='embedding_repair_required'").get()?.value !== '1') {
    try {
      const knn = knnRecall(queryEmbedding, fLim * 6, {namespaces:normalizedNs,kinds:['frame']});
      const ids = knn.map(r => r.memory_id);
      const nsClause = normalizedNs.length
        ? `AND namespace IN (${normalizedNs.map(() => '?').join(', ')})`
        : '';
      const frameRows = fetchByIds(
        ids,
        `AND kind = 'frame' ${nsClause}`,
        normalizedNs,
      );
      const distMap = new Map(knn.map(r => [r.memory_id, r.distance]));
      let scored = scoreAnn(frameRows, distMap, now).filter(atticOk);
      if (sceneIds.length) {
        // Prefer frames that belong to the recovered scenes.
        scored = scored.sort((a, b) => {
          const aIn = sceneIds.includes(a.metadata?.sceneId) ? 1 : 0;
          const bIn = sceneIds.includes(b.metadata?.sceneId) ? 1 : 0;
          if (aIn !== bIn) return bIn - aIn;
          return b.score - a.score;
        });
      }
      frames = scored.slice(0, fLim);
    } catch (err) {
      debugWarn('memory.recall.tiered', 'frame ANN failed', err?.message || err);
      frames = [];
    }
  }

  frames=mergeTier(frames,['frame'],fLim);
  const frameIds = frames.map(f => f.metadata?.frameId).filter(Boolean);

  // ─── Step 3 — content (leaf prompts/facts) ──────────────────────────────
  let contents = [];
  if (queryEmbedding && _vecLoaded && database.prepare("SELECT value FROM _meta WHERE key='embedding_repair_required'").get()?.value !== '1') {
    try {
      const knn = knnRecall(queryEmbedding, cLim * 6, {namespaces:normalizedNs,kinds:['prompt','fact']});
      const ids = knn.map(r => r.memory_id);
      const nsClause = normalizedNs.length
        ? `AND namespace IN (${normalizedNs.map(() => '?').join(', ')})`
        : '';
      const rows = fetchByIds(
        ids,
        `AND kind IN ('prompt','fact') ${nsClause}`,
        normalizedNs,
      );
      const distMap = new Map(knn.map(r => [r.memory_id, r.distance]));
      let scored = scoreAnn(rows, distMap, now).filter(atticOk);
      if (frameIds.length) {
        scored = scored.sort((a, b) => {
          const aIn = frameIds.includes(a.metadata?.frameId) ? 1 : 0;
          const bIn = frameIds.includes(b.metadata?.frameId) ? 1 : 0;
          if (aIn !== bIn) return bIn - aIn;
          return b.score - a.score;
        });
      }
      contents = scored.slice(0, cLim);
    } catch (err) {
      debugWarn('memory.recall.tiered', 'content ANN failed', err?.message || err);
      contents = [];
    }
  }

  contents=mergeTier(contents,['prompt','fact'],cLim);
  const byId = new Map(materializeMemoryRows([...scenes, ...frames, ...contents]).map(row => [row.id, row]));

  const scenesOut = scenes.map(s => byId.get(s.id) || s);
  const framesOut = frames.map(f => byId.get(f.id) || f);
  const contentsOut = contents.map(c => byId.get(c.id) || c);

  if (!validate) {
    return {
      scenes: scenesOut,
      frames: framesOut,
      contents: contentsOut,
      conflicts: [],
    };
  }

  try {
    return validateContext(
      { scenes: scenesOut, frames: framesOut, contents: contentsOut },
      { nowMs: now, dropContested },
    );
  } catch (err) {
    debugWarn('memory.recall.validate', 'Stage 4 validation failed, returning un-validated tiers', err?.message || err);
    return {
      scenes: scenesOut,
      frames: framesOut,
      contents: contentsOut,
      conflicts: [],
    };
  }
}

/**
 * Aggregate counts/health of the memory store.  Useful for dashboards,
 * telemetry, and for the upcoming `memoryStats()` CLI.
 */
export function memoryStats() {
  const database = getDb();
  try {
    const kindRows = database.prepare(
      `SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind`,
    ).all();
    const atticRows = database.prepare(
      `SELECT json_extract(metadata_json, '$.attic') AS attic, COUNT(*) AS n
       FROM memories
       GROUP BY attic`,
    ).all();
    const vecCount = _vecLoaded
      ? database.prepare(`SELECT COUNT(*) AS n FROM vec_memories`).get()?.n || 0
      : 0;
    return {
      totalMemories: kindRows.reduce((acc, row) => acc + row.n, 0),
      byKind: Object.fromEntries(kindRows.map(r => [r.kind, r.n])),
      byAttic: Object.fromEntries(atticRows.map(r => [r.attic || 'none', r.n])),
      vecIndexedCount: vecCount,
      vecAvailable: _vecLoaded,
    };
  } catch (err) {
    debugWarn('memory.store.stats', 'memoryStats query failed', err?.message || err);
    return {
      totalMemories: 0,
      byKind: {},
      byAttic: {},
      vecIndexedCount: 0,
      vecAvailable: _vecLoaded,
    };
  }
}

/**
 * Update the attic level on a set of memory rows.  Used by the daily
 * reassess worker.
 *
 * @param {Array<{id: string, attic: string}>} updates
 */
export function setAtticLevels(updates = []) {
  if (!updates.length) return 0;
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE memories
    SET metadata_json = json_set(metadata_json, '$.attic', ?)
    WHERE id = ?
  `);
  let n = 0;
  runInTransaction(() => {
    for (const update of updates) {
      if (!update?.id || !update?.attic) continue;
      const result = stmt.run(String(update.attic), update.id);
      n += result.changes || 0;
    }
  });
  return n;
}

/**
 * Return a page of rows for the attic worker to re-evaluate.  Filters by
 * updated_at ≥ sinceIso when provided so incremental reassess is cheap.
 *
 * @param {Object} [options]
 * @param {string} [options.sinceIso]   only rows updated on/after this time
 * @param {number} [options.limit]      default 500
 */
export function listMemoriesForAtticReassess({ sinceIso = null, limit = 500 } = {}) {
  const database = getDb();
  const lim = Math.max(1, Math.min(5000, Number(limit) || 500));
  try {
    const rows = sinceIso
      ? database.prepare(`
          SELECT id, kind, updated_at, last_used_at, metadata_json
          FROM memories
          WHERE updated_at >= ?
          LIMIT ?
        `).all(sinceIso, lim)
      : database.prepare(`
          SELECT id, kind, updated_at, last_used_at, metadata_json
          FROM memories
          LIMIT ?
        `).all(lim);
    return rows.map(row => ({
      id: row.id,
      kind: row.kind,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      metadata: parseMetadata(row.metadata_json),
    }));
  } catch (err) {
    debugWarn('memory.dreaming.reassess', 'listMemoriesForAtticReassess query failed', err?.message || err);
    return [];
  }
}

// ─── Memory hits (dreaming/promotion gates) ─────────────────────────────────

/**
 * Record that a memory row was pulled into a recall result.  Cheap insert so
 * the dreaming pass can score each row by recall frequency + query diversity
 * over rolling windows.
 *
 * @param {Object} hit
 * @param {string} hit.memoryId
 * @param {string} [hit.queryHash]   sha1 of query (we only need identity, not content)
 * @param {number} [hit.rank]        zero-indexed position in the result list
 * @param {string} [hit.outcome]     'used' | 'ignored' | null
 */
export function recordMemoryHit({ memoryId, queryHash = null, rank = null, outcome = null } = {}) {
  if (!memoryId) return;
  try {
    getDb().prepare(`
      INSERT INTO memory_hits (memory_id, hit_at, query_hash, rank, outcome)
      VALUES (?, ?, ?, ?, ?)
    `).run(memoryId, new Date().toISOString(), queryHash, rank, outcome);
  } catch (err) {
    // best-effort, never break the calling recall
    debugWarn('memory.recall.hits', 'recordMemoryHit failed', err?.message || err);
  }
}

export function recordMemoryHitsBatch(hits = []) {
  if (!Array.isArray(hits) || !hits.length) return 0;
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO memory_hits (memory_id, hit_at, query_hash, rank, outcome)
    VALUES (?, ?, ?, ?, ?)
  `);
  const nowIso = new Date().toISOString();
  let n = 0;
  runInTransaction(() => {
    for (const h of hits) {
      if (!h?.memoryId) continue;
      try {
        stmt.run(h.memoryId, h.hitAt || nowIso, h.queryHash || null, h.rank ?? null, h.outcome || null);
        n += 1;
      } catch (err) {
        // keep going
        debugWarn('memory.recall.hits', `hit insert failed for ${h.memoryId}`, err?.message || err);
      }
    }
  });
  return n;
}

/** One feedback transaction at the model boundary, after context budgeting.
 * Recall/search are pure reads. Candidates dropped from the prompt are hits,
 * but only fully included entries increase useCount. Replays of a turn are safe.
 */
export function recordMemoryFeedback({ candidates = [], usedIds = [], requestId, query = '' } = {}) {
  if (!requestId || !candidates.length) return 0;
  const database = getDb(), queryHash = createHash('sha1').update(String(query)).digest('hex');
  const now = new Date().toISOString();
  const insert = database.prepare(`INSERT OR IGNORE INTO memory_hits(memory_id,hit_at,query_hash,rank,request_id)
    SELECT id,?,?,?,? FROM memories WHERE id=? AND ${activeMemorySQL()}`);
  let used = 0;
  runInTransaction(() => {
    const fresh = [];
    [...new Map(candidates.filter(r => r?.id).map(r => [r.id,r])).values()].forEach((row,rank) => {
      if (insert.run(now,queryHash,rank,requestId,row.id).changes) fresh.push(row.id);
    });
    const included = new Set(usedIds);
    used = markMemoriesUsed(fresh.filter(id => included.has(id)), {queryHash,requestId});
  });
  return used;
}

/**
 * Aggregate hit stats per memory row over the last `windowDays`.  Returns rows:
 *   { memoryId, hits, distinctQueries, avgRank, goodOutcomes }
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.memoryIds]   if provided, restrict to these ids
 * @param {number}   [opts.windowDays]  default 14
 */
/**
 * Negative feedback (design audit M6): the user stopped using a fact. Recorded
 * as a hit with outcome 'rejected' so dreaming's outcome gate sees it; the
 * gate reads goodOutcomes = used − rejected.
 */
export function recordMemoryRejection(memoryId, { requestId = 'user:forget' } = {}) {
  if (!memoryId) return 0;
  try {
    return getDb().prepare(`INSERT INTO memory_hits(memory_id,hit_at,query_hash,rank,request_id,outcome) VALUES(?,?,?,?,?,'rejected')`)
      .run(String(memoryId), new Date().toISOString(), 'user-feedback', 0, `${requestId}:${Date.now()}`).changes;
  } catch (err) {
    debugWarn('memory.feedback', 'recordMemoryRejection failed', err?.message || err);
    return 0;
  }
}

export function getHitStats({ memoryIds = null, windowDays = 14 } = {}) {
  const database = getDb();
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const idClause = memoryIds?.length
    ? ` AND memory_id IN (${memoryIds.map(() => '?').join(', ')})`
    : '';
  const sql = `
    SELECT memory_id AS memoryId,
           COUNT(*)                               AS hits,
           COUNT(DISTINCT query_hash)             AS distinctQueries,
           AVG(COALESCE(rank, 0))                 AS avgRank,
           SUM(CASE WHEN outcome='used' THEN 1 WHEN outcome='rejected' THEN -1 ELSE 0 END) AS goodOutcomes,
           SUM(CASE WHEN outcome='rejected' THEN 1 ELSE 0 END) AS rejectedOutcomes
    FROM memory_hits
    WHERE hit_at >= ?${idClause}
    GROUP BY memory_id
  `;
  try {
    const args = memoryIds?.length ? [sinceIso, ...memoryIds] : [sinceIso];
    return database.prepare(sql).all(...args);
  } catch (err) {
    debugWarn('memory.dreaming.hitstats', 'getHitStats query failed', err?.message || err);
    return [];
  }
}

/**
 * Drop hit records older than `maxDays`.  Run at the tail of each sweep so the
 * table stays small.
 */
export function pruneHits({ maxDays = 60 } = {}) {
  const cutoff = new Date(Date.now() - maxDays * 86_400_000).toISOString();
  try {
    const res = getDb().prepare(`DELETE FROM memory_hits WHERE hit_at < ?`).run(cutoff);
    return res.changes || 0;
  } catch (err) {
    debugWarn('memory.dreaming.prune', 'pruneHits failed', err?.message || err);
    return 0;
  }
}

/**
 * Delete a single memory row.  `memory_hits` rows for the same id are
 * cascaded away by the FK; `vec_memories` is cleaned up explicitly because
 * vec0 does not support CASCADE.  `memories_fts` is a virtual table mirrored
 * by the next rebuild and stays in sync best-effort.
 *
 * @param {string} id
 * @returns {boolean} true when a row was deleted
 */
export function deleteMemoryById(id) {
  if (!id) return false;
  const database = getDb();
  let changed = 0;
  runInTransaction(() => {
    try {
      const res = database.prepare('DELETE FROM memories WHERE id = ?').run(id);
      changed = res.changes || 0;
      if (changed) {
        try { database.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id); } catch (err) { debugWarn('memory.store.delete', 'memories_fts delete failed', err?.message || err); }
        try { database.prepare('DELETE FROM vec_memories  WHERE memory_id = ?').run(id); } catch (err) { debugWarn('memory.store.delete', 'vec_memories delete failed', err?.message || err); }
      }
    } catch (err) { debugWarn('memory.store.delete', 'deleteMemoryById failed', err?.message || err); }
  });
  return changed > 0;
}

export function pruneMemoriesByNamespaceKind({
  namespace = '',
  kind = '',
  keep = 200,
  preservePinned = true,
} = {}) {
  const normalizedNamespace = String(namespace || '').trim();
  const normalizedKind = String(kind || '').trim();
  const keepCount = Math.max(0, Number(keep) || 0);
  if (!normalizedNamespace || !normalizedKind) return 0;

  const database = getDb();
  try {
    const pinnedClause = preservePinned
      ? `AND COALESCE(json_extract(metadata_json, '$.pinned'), 0) != 1`
      : '';
    const rows = database.prepare(`
      SELECT id
      FROM memories
      WHERE namespace = ?
        AND kind = ?
        ${pinnedClause}
      ORDER BY datetime(created_at) DESC, datetime(updated_at) DESC, id DESC
      LIMIT -1 OFFSET ?
    `).all(normalizedNamespace, normalizedKind, keepCount);

    let deleted = 0;
    runInTransaction(() => {
      for (const row of rows) {
        if (!row?.id) continue;
        const res = database.prepare('DELETE FROM memories WHERE id = ?').run(row.id);
        if (res.changes) {
          deleted += res.changes || 0;
          try { database.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(row.id); } catch (err) { debugWarn('memory.store.prune', 'memories_fts delete failed', err?.message || err); }
          try { database.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(row.id); } catch (err) { debugWarn('memory.store.prune', 'vec_memories delete failed', err?.message || err); }
        }
      }
    });
    return deleted;
  } catch (err) {
    debugWarn('memory.store.prune', 'pruneMemoriesByNamespaceKind failed', err?.message || err);
    return 0;
  }
}

/**
 * Delete memory_hits rows whose memory_id no longer exists in `memories`.
 *
 * Under the current schema this should be a no-op because the FK has
 * `ON DELETE CASCADE` and `PRAGMA foreign_keys = ON` is enforced at boot.
 * Kept as a diagnostic hook for (a) ad-hoc repair of a database that
 * predates the FK migration, and (b) tests that forcibly insert orphan
 * hits to assert the cleanup behaves.
 *
 * @returns {number} rows deleted
 */
export function cleanupOrphanHits() {
  try {
    const res = getDb().prepare(
      `DELETE FROM memory_hits WHERE memory_id NOT IN (SELECT id FROM memories)`
    ).run();
    return res.changes || 0;
  } catch (err) {
    debugWarn('memory.dreaming.prune', 'cleanupOrphanHits failed', err?.message || err);
    return 0;
  }
}

/**
 * Mark the most recent hit for each memoryId as `outcome='used'`.
 *
 * This is how the retrieval layer tells the dreaming worker "this memory
 * actually got consumed by the agent" — i.e. it survived all the filtering
 * and was rendered into a prompt block.  The value feeds back into
 * `scoreGate()` via `goodOutcomes/hits` so rows that are reliably useful
 * stay in Hot and rows that are frequently recalled-but-dropped decay.
 *
 * We only update the most recent NULL-outcome hit per memoryId within the
 * caller's window (default 10 min) so that earlier unrelated hits aren't
 * retroactively labelled.
 *
 * @param {string[]} memoryIds
 * @param {Object}   [opts]
 * @param {number}   [opts.windowMs]  default 10 * 60_000
 * @returns {number} number of rows updated
 */
export function markMemoriesUsed(memoryIds = [], { windowMs = 10 * 60_000, queryHash = null, requestId = null } = {}) {
  if (!Array.isArray(memoryIds) || !memoryIds.length) return 0;
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  const database = getDb();
  // Per-id subquery: find the most recent hit row within the window and
  // update just that one, so we don't accidentally overwrite older hits
  // that belonged to different queries.
  const stmt = database.prepare(`
    UPDATE memory_hits
       SET outcome = 'used'
     WHERE rowid = (
       SELECT rowid
         FROM memory_hits
        WHERE memory_id = ?
          AND hit_at >= ?
          AND (? IS NULL OR query_hash = ?)
          AND (? IS NULL OR request_id = ?)
          AND (outcome IS NULL OR outcome = '')
        ORDER BY hit_at DESC
        LIMIT 1
     )
  `);
  const usedAt = new Date().toISOString();
  const bump = database.prepare(`UPDATE memories SET last_used_at = ?, metadata_json = json_set(metadata_json,
    '$.useCount', MAX(0,COALESCE(CAST(json_extract(metadata_json, '$.useCount') AS INTEGER),0)) + 1, '$.lastBoostedAt', ?) WHERE id = ?`);
  let n = 0;
  runInTransaction(() => {
    for (const id of new Set(memoryIds)) {
      if (!id) continue;
      try {
        const res = stmt.run(id, sinceIso, queryHash, queryHash, requestId, requestId);
        if (res.changes) { bump.run(usedAt, usedAt, id); n += 1; }
      } catch (err) {
        // best-effort
        debugWarn('memory.recall.hits', `markMemoriesUsed failed for ${id}`, err?.message || err);
      }
    }
  });
  return n;
}

// ─── Read helpers for the dreaming worker ────────────────────────────────────

/**
 * Return the full row (id, namespace, kind, text, search_text, embedding,
 * metadata, updated_at) for a list of ids.  Dreaming modules need the
 * embedding to do cosine-similarity merging.
 */
export function getMemoriesByIds(ids = []) {
  if (!ids.length) return [];
  const database = getDb();
  try {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = database.prepare(`
      SELECT id, namespace, kind, source_id, text, search_text, embedding,
             tokens_estimate, created_at, updated_at, last_used_at, metadata_json
      FROM memories
      WHERE id IN (${placeholders})
    `).all(...ids);
    return rows.map(row => ({
      id: row.id,
      namespace: row.namespace,
      kind: row.kind,
      sourceId: row.source_id,
      text: row.text,
      searchText: row.search_text,
      embedding: row.embedding ? new Float32Array(row.embedding.buffer ?? row.embedding) : null,
      tokensEstimate: row.tokens_estimate,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      metadata: parseMetadata(row.metadata_json),
    }));
  } catch (err) {
    debugWarn('memory.recall.fetch', 'getMemoriesByIds failed', err?.message || err);
    return [];
  }
}

// ─── P2-13: boot-time embedding dim mismatch helpers ──────────────────────

/**
 * Read the embedding dimension that was stored when vectors were last
 * written.  Returns null if _meta hasn't been populated yet.
 */
export function readStoredEmbeddingDims() {
  try {
    const row = getDb().prepare(
      `SELECT value FROM _meta WHERE key = 'embedding_dims'`,
    ).get();
    const n = Number(row?.value);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err) {
    debugWarn('memory.store.dims', 'readStoredEmbeddingDims failed', err?.message || err);
    return null;
  }
}

/**
 * Phase 2 #2 — read/write the modelId that produced the currently-stored
 * vectors.  Dims alone don't prove vector-space compatibility: OpenAI
 * text-embedding-3-large (1024 dims, truncated) and Voyage voyage-3-large
 * (1024 dims) both fit but live in different spaces, so swapping them
 * silently would break recall.  We record the modelId on every successful
 * save and compare it at boot (runtime.js) to warn the user.
 *
 * Unlike the dims check, a modelId drift does NOT auto-wipe — because the
 * two spaces might actually be the same (e.g. OpenAI ada-002 aliased to a
 * custom gateway modelId).  We let the user confirm via
 * wipeEmbeddingsForDimChange() or a future UI action.
 */
export function readStoredEmbeddingModelId() {
  try {
    const row = getDb().prepare(
      `SELECT value FROM _meta WHERE key = 'embedding_model_id'`,
    ).get();
    const v = row?.value;
    return typeof v === 'string' && v.trim() ? v : null;
  } catch (err) {
    debugWarn('memory.store.dims', 'readStoredEmbeddingModelId failed', err?.message || err);
    return null;
  }
}

export function writeStoredEmbeddingModelId(modelId) {
  if (!modelId || typeof modelId !== 'string') return false;
  try {
    getDb().prepare(
      `INSERT OR REPLACE INTO _meta (key, value) VALUES ('embedding_model_id', ?)`,
    ).run(modelId);
    return true;
  } catch (err) {
    debugWarn('memory.store.dims', 'writeStoredEmbeddingModelId failed', err?.message || err);
    return false;
  }
}

/**
 * Wipe every stored embedding because the active provider produces
 * vectors of a different dimensionality than what's on disk.  The
 * next embed pass will repopulate from the new vector space.
 *
 * This is what the runtime calls when it detects a P2-13 mismatch.
 * Exposed so hosts can also trigger it manually (e.g. after a deliberate
 * provider swap).
 *
 * @param {number} newDims  the provider's declared dims; stored in _meta
 * @returns {number}  number of rows whose embedding was cleared
 */
export function wipeEmbeddingsForDimChange(newDims) {
  const database = getDb();
  let cleared = 0;
  try {
    const res = database.prepare(`UPDATE memories SET embedding = NULL WHERE embedding IS NOT NULL`).run();
    cleared = res.changes || 0;
    try { database.exec(`DELETE FROM embedding_cache`); } catch (err) { debugWarn('memory.store.dims', 'DELETE embedding_cache failed', err?.message || err); }
    try { database.exec(`DROP TABLE IF EXISTS vec_memories`); } catch (err) { debugWarn('memory.store.dims', 'DROP vec_memories failed', err?.message || err); }
    if (Number.isFinite(newDims) && newDims > 0) {
      database.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES ('embedding_dims', ?)`)
        .run(String(newDims));
    }
  } catch (err) {
    debugWarn('memory.store.dims', 'wipeEmbeddingsForDimChange failed', err?.message || err);
  }
  return cleared;
}

/**
 * List candidate rows for duplicate merging — only entries that have an
 * embedding and a specific kind.
 *
 * P2-12: when `sinceIso` is provided (incremental sweeps), the query scopes
 * to namespaces that have had at least one row updated on/after sinceIso.
 * We still return *all* rows inside those namespaces (not just the fresh
 * ones) so the merge planner can pair a newly-written row against an older
 * near-duplicate it wouldn't otherwise see.  Namespaces that had no
 * activity in the window are skipped entirely — that's where the cost win
 * comes from.  When sinceIso is null the behaviour is unchanged.
 *
 * @param {Object} [options]
 * @param {string|null} [options.namespace]
 * @param {string[]}    [options.kinds]
 * @param {number}      [options.limit]
 * @param {string|null} [options.sinceIso]  incremental cut-off
 */
export function listMergeCandidates({
  namespace = null,
  kinds = ['fact', 'session-fact'],
  limit = 2000,
  sinceIso = null,
} = {}) {
  const database = getDb();
  const cap = Math.max(1, Math.min(5000, limit));
  try {
    if (sinceIso) {
      // 1) Find active namespaces (touched since sinceIso) that have any
      //    candidate row at all.  A namespace without an active row cannot
      //    produce a new merge pair in this window.
      const kindClause = kinds.length ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : '';
      const nsClause = namespace ? ` AND namespace = ?` : '';
      const nsArgs = [sinceIso, ...kinds];
      if (namespace) nsArgs.push(namespace);
      const activeNamespaces = database.prepare(`
        SELECT DISTINCT namespace
        FROM memories
        WHERE embedding IS NOT NULL
          AND updated_at >= ?
          ${kindClause}
          ${nsClause}
      `).all(...nsArgs).map(r => r.namespace).filter(Boolean);

      if (activeNamespaces.length === 0) return [];

      // 2) Pull every candidate row inside those namespaces.  This keeps
      //    merge detection correct when a fresh row is a dup of an older
      //    neighbour while still avoiding a full-store scan.
      const placeholders = activeNamespaces.map(() => '?').join(', ');
      const fullSql = `
        SELECT id, namespace, kind, text, search_text, embedding, metadata_json, updated_at
        FROM memories
        WHERE embedding IS NOT NULL
          AND namespace IN (${placeholders})
          ${kindClause}
        ORDER BY updated_at DESC
        LIMIT ?
      `;
      const rows = database.prepare(fullSql).all(...activeNamespaces, ...kinds, cap);
      return rows.map(mapMergeCandidateRow);
    }

    // Legacy full-listing path.
    const kindClause = kinds.length ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : '';
    const nsClause = namespace ? ` AND namespace = ?` : '';
    const sql = `
      SELECT id, namespace, kind, text, search_text, embedding, metadata_json, updated_at
      FROM memories
      WHERE embedding IS NOT NULL${kindClause}${nsClause}
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    const args = [...kinds];
    if (namespace) args.push(namespace);
    args.push(cap);
    const rows = database.prepare(sql).all(...args);
    return rows.map(mapMergeCandidateRow);
  } catch (err) {
    debugWarn('memory.dreaming.merge', 'listMergeCandidates failed', err?.message || err);
    return [];
  }
}

function mapMergeCandidateRow(row) {
  return {
    id: row.id,
    namespace: row.namespace,
    kind: row.kind,
    text: row.text,
    searchText: row.search_text,
    embedding: row.embedding ? new Float32Array(row.embedding.buffer ?? row.embedding) : null,
    metadata: parseMetadata(row.metadata_json),
    updatedAt: row.updated_at,
  };
}

/**
 * Mark a row as merged into another.  Updates metadata.mergedInto and adds the
 * useCount to the target.  Does NOT delete the source row — it's kept for the
 * audit trail but moved to Cold.
 *
 * Search audit C-6: the survivor absorbs semantic weight from the dropped row
 * (higher useCount, merged-from provenance) and — in cross-kind merges —
 * effectively becomes the canonical form of a concept that used to live in
 * two places.  We flag the target with `metadata.needsReembed = true` so the
 * next embedding-refresh pass can re-encode it with the updated context.
 * Consumers that don't care about reembedding just ignore the flag; it's a
 * soft signal, not a lifecycle gate.
 */
export function mergeMemoryInto({ sourceId, targetId, useCountBonus = 0 } = {}) {
  if (!sourceId || !targetId || sourceId === targetId) return false;
  const database = getDb();
  try {
    runInTransaction(() => {
      // Mark source as merged & cold
      database.prepare(`
        UPDATE memories
        SET metadata_json = json_set(json_set(metadata_json, '$.mergedInto', ?), '$.attic', 'cold')
        WHERE id = ?
      `).run(targetId, sourceId);

      // Bump target useCount + merge record + flag for re-embedding
      const row = database.prepare('SELECT metadata_json FROM memories WHERE id = ?').get(targetId);
      const meta = row ? parseMetadata(row.metadata_json) : {};
      const nextMeta = {
        ...meta,
        useCount: (Number(meta.useCount) || 0) + Math.max(0, useCountBonus),
        mergedFrom: [...(Array.isArray(meta.mergedFrom) ? meta.mergedFrom : []), sourceId],
        needsReembed: true,
      };
      database.prepare('UPDATE memories SET metadata_json = ? WHERE id = ?')
        .run(JSON.stringify(nextMeta), targetId);
    });
    return true;
  } catch (err) {
    debugWarn('memory.dreaming.merge', `mergeMemoryInto failed src=${sourceId} dst=${targetId}`, err?.message || err);
    return false;
  }
}

/**
 * List rows flagged `metadata.needsReembed = true` — these are merge
 * survivors (or identity supersedents, eventually) whose embedding should
 * be refreshed by the next dreaming / batch-embed pass.
 *
 * @param {Object} [options]
 * @param {number} [options.limit]
 * @returns {Array<{id: string, namespace: string, kind: string, text: string,
 *                  searchText: string, metadata: Object, updatedAt: string}>}
 */
export function listMemoriesNeedingReembed({ limit = 500 } = {}) {
  const database = getDb();
  const cap = Math.max(1, Math.min(5000, limit));
  try {
    const rows = database.prepare(`
      SELECT id, namespace, kind, text, search_text, metadata_json, updated_at
      FROM memories
      WHERE json_extract(metadata_json, '$.needsReembed') = 1
        AND json_extract(metadata_json, '$.mergedInto') IS NULL
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(cap);
    return rows.map(r => ({
      id: r.id,
      namespace: r.namespace,
      kind: r.kind,
      text: r.text,
      searchText: r.search_text,
      metadata: parseMetadata(r.metadata_json),
      updatedAt: r.updated_at,
    }));
  } catch (err) {
    debugWarn('memory.dreaming.reembed', 'listMemoriesNeedingReembed failed', err?.message || err);
    return [];
  }
}

/**
 * Clear the `needsReembed` flag on a set of ids (after re-embedding them).
 */
export function clearNeedsReembed(ids = []) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE memories
    SET metadata_json = json_remove(metadata_json, '$.needsReembed')
    WHERE id = ?
  `);
  let n = 0;
  runInTransaction(() => {
    for (const id of ids) {
      try { n += stmt.run(id).changes || 0; } catch (err) {
        debugWarn('memory.dreaming.reembed', `clearNeedsReembed failed for ${id}`, err?.message || err);
      }
    }
  });
  return n;
}

/**
 * Write metadata.validTo on a list of ids (temporal backfill).
 */
export function setValidTo(ids = [], validToIso = new Date().toISOString()) {
  if (!ids.length) return 0;
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE memories
    SET metadata_json = json_set(metadata_json, '$.validTo', ?)
    WHERE id = ?
  `);
  let n = 0;
  runInTransaction(() => {
    for (const id of ids) {
      try { n += stmt.run(validToIso, id).changes || 0; } catch (err) { debugWarn('memory.store.valid', `setValidTo failed for ${id}`, err?.message || err); }
    }
  });
  return n;
}

/**
 * Extended memoryStats: adds hit counts + merge counts for the dreaming UI.
 */
export function memoryStatsExtended() {
  const base = memoryStats();
  const database = getDb();
  try {
    const hitRow = database.prepare(`SELECT COUNT(*) AS n FROM memory_hits`).get();
    const mergedRow = database.prepare(
      `SELECT COUNT(*) AS n FROM memories WHERE json_extract(metadata_json, '$.mergedInto') IS NOT NULL`,
    ).get();
    const expiredRow = database.prepare(
      `SELECT COUNT(*) AS n FROM memories
       WHERE json_extract(metadata_json, '$.validTo') IS NOT NULL
         AND json_extract(metadata_json, '$.validTo') < ?`,
    ).get(new Date().toISOString());
    return {
      ...base,
      totalHits: hitRow?.n || 0,
      mergedCount: mergedRow?.n || 0,
      expiredCount: expiredRow?.n || 0,
    };
  } catch (err) {
    debugWarn('memory.store.stats', 'memoryStatsExtended failed', err?.message || err);
    return base;
  }
}

// ─── End tiered recall additions ─────────────────────────────────────────────

export function searchMemories({query = '', kinds = [], limit = 20} = {}) {
  const built = buildRecallQuery({kinds,allowGlobal:true});
  return materializeMemoryRows(keywordRecallRows(built,query,{limit:Math.max(1,limit)}));
}

export function requireEmbeddingRepair() {
  getDb().prepare("INSERT OR REPLACE INTO _meta VALUES ('embedding_repair_required', '1')").run();
}

export function notifyMemoryIndexRepaired(home) {
  if (db && _openedStorePath === join(home,'desktop','store.sqlite')) {
    try { db.prepare('SELECT memory_id FROM vec_memories LIMIT 1').get(); _vecLoaded = true; } catch {}
  }
}

// Stable keyset traversal for maintenance/export. Updating rows must not move
// them across an OFFSET boundary or silently leave records beyond a UI limit.
export function* iterateMemoryRecords({ kind = 'session-fact', chatId = null, batchSize = 500 } = {}) {
  let after = '';
  const query = getDb().prepare(`SELECT * FROM memories WHERE kind = ? AND id > ? ${chatId ? "AND json_extract(metadata_json, '$.chatId') = ?" : ''} ORDER BY id LIMIT ?`);
  for (;;) {
    const rows = query.all(kind, after, ...(chatId ? [chatId] : []), Math.max(1, Math.min(10000, batchSize)));
    if (!rows.length) return;
    after = rows.at(-1).id;
    yield* materializeMemoryRows(rows);
  }
}

// Administrative reads never count as recall or increase importance.
export function listMemoryRecords({ kind = 'session-fact', limit = 1000, offset = 0, chatId = null } = {}) {
  const rows=getDb().prepare(`SELECT * FROM memories WHERE kind = ? ${chatId ? "AND json_extract(metadata_json, '$.chatId') = ?" : ''} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
    .all(kind,...(chatId?[chatId]:[]),Math.max(1,Math.min(10000,Number(limit)||1000)),Math.max(0,Number(offset)||0));
  return materializeMemoryRows(rows);
}
