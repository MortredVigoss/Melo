import { EMBEDDING_DIMS } from './embeddings.js';
import { debugWarn } from '../debug.js';

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
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
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

export { applyMemoryStoreSchema };
