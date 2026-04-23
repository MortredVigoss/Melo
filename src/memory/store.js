import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getMeloHome } from '../config.js';
import { EMBEDDING_DIMS, cosineSimilarity } from './embeddings.js';
import { debugWarn, isDebugEnabled } from '../debug.js';
import { isSubsequenceMatch } from '../search/scoring.js';

const STORE_PATH = join(getMeloHome(), 'desktop', 'store.sqlite');
let db = null;

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

function getDb() {
  if (db) {
    return db;
  }

  mkdirSync(dirname(STORE_PATH), { recursive: true });
  db = new DatabaseSync(STORE_PATH, { allowExtension: true });
  tryLoadVec(db);

  db.exec(`
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
  const hitsSchema = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_hits'`
  ).get();
  const hasFkCascade = /FOREIGN\s+KEY[^)]*REFERENCES\s+memories\s*\(\s*id\s*\)[^)]*ON\s+DELETE\s+CASCADE/i
    .test(String(hitsSchema?.sql || ''));
  if (!hasFkCascade) {
    db.exec(`
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

  // Embedding dimension metadata table
  db.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);`);

  // ── Bug B migration: older databases created embedding_cache with
  //    text_hash as the sole PRIMARY KEY, so cached vectors survived a
  //    provider swap and could be served back from a different vector
  //    space.  Detect via PRAGMA table_info and, if needed, rebuild the
  //    table with (text_hash, model_id) as the composite primary key,
  //    backfilling existing rows with the currently-stored modelId (or
  //    'unknown' if _meta.embedding_model_id is empty).  Idempotent.
  const cacheCols = db.prepare(`PRAGMA table_info(embedding_cache)`).all();
  const hasModelIdCol = cacheCols.some(c => c.name === 'model_id');
  if (cacheCols.length && !hasModelIdCol) {
    const storedModel = db.prepare(
      `SELECT value FROM _meta WHERE key = 'embedding_model_id'`,
    ).get()?.value || 'unknown';
    db.exec(`
      BEGIN;
      CREATE TABLE embedding_cache__new (
        text_hash  TEXT NOT NULL,
        model_id   TEXT NOT NULL DEFAULT 'unknown',
        embedding  BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (text_hash, model_id)
      );
    `);
    db.prepare(
      `INSERT OR REPLACE INTO embedding_cache__new (text_hash, model_id, embedding, created_at)
         SELECT text_hash, ?, embedding, created_at FROM embedding_cache`,
    ).run(storedModel);
    db.exec(`
      DROP TABLE embedding_cache;
      ALTER TABLE embedding_cache__new RENAME TO embedding_cache;
      COMMIT;
    `);
    console.log(`[memory] embedding_cache migrated to (text_hash, model_id) composite PK (backfilled with model_id='${storedModel}')`);
  }

  // Detect dimension mismatch by reading the vec_memories schema (if it exists)
  const vecSchema = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_memories'`,
  ).get();
  const schemaHasRightDims = vecSchema?.sql?.includes(`float[${EMBEDDING_DIMS}]`);
  const needVecRebuild = vecSchema && !schemaHasRightDims;

  if (needVecRebuild) {
    // Dimension mismatch (e.g. nomic 768 → bge-m3 1024): drop stale index and cache
    try { db.exec(`DROP TABLE IF EXISTS vec_memories`); } catch (err) { debugWarn('memory.store.vec', 'drop vec_memories during rebuild failed', err?.message || err); }
    db.exec(`DELETE FROM embedding_cache`);
    db.prepare(`UPDATE memories SET embedding = NULL`).run();
    console.log(`[memory] vec_memories dimension mismatch — dropping and rebuilding for float[${EMBEDDING_DIMS}]`);
  }
  db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES ('embedding_dims', ?)`).run(String(EMBEDDING_DIMS));

  // Create vec0 table for KNN search if sqlite-vec loaded successfully
  if (_vecLoaded) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[${EMBEDDING_DIMS}]
        );
      `);
    } catch (err) {
      debugWarn('memory.store.vec', 'vec_memories create failed, disabling vector search', err?.message || err);
      _vecLoaded = false; // vec0 creation failed, disable vector search
    }
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
function resolveCacheModelId(explicit) {
  if (explicit && typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  try {
    const row = getDb().prepare(
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
function getCachedEmbedding(text, modelId = null) {
  try {
    const resolvedModel = resolveCacheModelId(modelId);
    const row = getDb().prepare(
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
function storeEmbedding(memoryId, searchText, embedding, modelId = null) {
  if (!embedding) return;
  const database = getDb();
  const buf = Buffer.from(embedding.buffer);
  const hash = textHash(searchText);
  const resolvedModel = resolveCacheModelId(modelId);
  try {
    database.prepare(
      `INSERT OR REPLACE INTO embedding_cache (text_hash, model_id, embedding, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(hash, resolvedModel, buf, new Date().toISOString());

    database.prepare(
      `UPDATE memories SET embedding = ? WHERE id = ?`,
    ).run(buf, memoryId);

    if (_vecLoaded) {
      database.prepare(
        `INSERT OR REPLACE INTO vec_memories (memory_id, embedding) VALUES (?, ?)`,
      ).run(memoryId, buf);
    }
  } catch (err) {
    // Best-effort — surface via MELO_DEBUG=memory.store.cache
    debugWarn('memory.store.cache', `storeEmbedding failed for memoryId=${memoryId}`, err?.message || err);
  }
}

/** KNN query against vec_memories. Returns [{memory_id, distance}] */
function knnRecall(queryEmbedding, limit) {
  if (!_vecLoaded || !queryEmbedding) return [];
  try {
    const buf = Buffer.from(queryEmbedding.buffer);
    return getDb().prepare(`
      SELECT memory_id, distance
      FROM vec_memories
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(buf, limit);
  } catch (err) {
    debugWarn('memory.recall.knn', 'knnRecall query failed', err?.message || err);
    return [];
  }
}

function buildMemoriesFtsQuery(text) {
  const tokens = String(text || '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
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

// ─── Memory recall scoring (intentionally local) ─────────────────────────────
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
//   2. `fuzzySubsequenceScore` below uses base=100 (not 140) because
//      scoreMemoryRow already multiplies the result by 0.4 and mixes it
//      with per-token exact-match scores on a different scale.  Migrating
//      memory to the search-domain weights would rebalance every memory
//      recall ranking.
//
// What IS shared: `isSubsequenceMatch` (imported at the top of the file —
// identical logic and no weight dependency).  Bug 5's noise-floor fix is
// mirrored below so memory recall gets the same "gap-heavy subsequence
// matches score zero" cleanup without taking on the search-domain weights.
function tokenizeQuery(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function fuzzySubsequenceScore(query, target) {
  if (!query || !target) return 0;
  // Bug 5 mirror: single-char subsequence matches are noise; require ≥2.
  if (query.length < 2) return 0;

  let searchIndex = 0;
  let gapPenalty = 0;
  for (const char of query) {
    const foundAt = target.indexOf(char, searchIndex);
    if (foundAt === -1) return 0;
    gapPenalty += Math.max(0, foundAt - searchIndex);
    searchIndex = foundAt + 1;
  }
  // Bug 5 mirror: let the score fall to 0 when the gap penalty swamps the
  // base.  The previous floor of 10 meant every "chars appear in order"
  // match earned points even when the match was spread across the whole
  // haystack.
  return Math.max(0, 100 - gapPenalty - Math.max(0, target.length - query.length));
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

function buildRecallQuery({ namespaces = [], kinds = [], allowGlobal = false } = {}) {
  const normalizedNamespaces = namespaces
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const normalizedKinds = kinds.map(value => String(value || '').trim()).filter(Boolean);
  const namespaceClause = normalizedNamespaces.length
    ? `namespace IN (${normalizedNamespaces.map(() => '?').join(', ')})`
    : allowGlobal
      ? '1 = 1'
      : '';
  if (!namespaceClause) {
    return null;
  }

  const kindClause = normalizedKinds.length
    ? ` AND kind IN (${normalizedKinds.map(() => '?').join(', ')})`
    : '';

  return {
    normalizedNamespaces,
    normalizedKinds,
    sql: `
      SELECT id, namespace, kind, source_id, text, search_text, tokens_estimate,
             created_at, updated_at, last_used_at, metadata_json
      FROM memories
      WHERE ${namespaceClause}${kindClause}
      ORDER BY updated_at DESC
      LIMIT 512
    `,
  };
}

// Exported for unit tests — these are pure and deterministic.
export function isEntryInvalidated(metadata, nowMs = Date.now()) {
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

function touchRows(rows = []) {
  if (!rows.length) {
    return [];
  }

  const database = getDb();
  const usedAt = new Date().toISOString();
  const touch = database.prepare('UPDATE memories SET last_used_at = ? WHERE id = ?');
  // metadata_json is a generic blob — we bump useCount inside it so that
  // importance scoring can weight hot facts without a schema migration.
  const touchMeta = database.prepare(
    'UPDATE memories SET metadata_json = ? WHERE id = ?',
  );

  runInTransaction(() => {
    for (const row of rows) {
      touch.run(usedAt, row.id);
      const nextMetadata = {
        ...(row.metadata || {}),
        useCount: Math.max(0, Number(row.metadata?.useCount) || 0) + 1,
        lastBoostedAt: usedAt,
      };
      touchMeta.run(JSON.stringify(nextMetadata), row.id);
      // Keep the returned shape in sync so callers see the new counter.
      row.metadata = nextMetadata;
    }
  });

  return rows.map(row => ({
    id: row.id,
    namespace: row.namespace,
    kind: row.kind,
    sourceId: row.source_id,
    text: row.text,
    searchText: row.search_text,
    tokensEstimate: row.tokens_estimate,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: usedAt,
    metadata: row.metadata,
    score: row.score,
    // Preserve the embedding blob when callers opted in via
    // includeEmbedding=true (Bug E).  The property is only present on rows
    // that carry it; keyword-fallback callers who don't set the flag are
    // unaffected because `row.embedding` is simply undefined.
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
        text           = excluded.text,
        search_text    = excluded.search_text,
        updated_at     = excluded.updated_at,
        metadata_json  = excluded.metadata_json
    `).run(
      row.id, row.namespace, row.kind, row.sourceId, row.text,
      row.searchText, null, row.tokensEstimate,
      row.createdAt, row.updatedAt, row.lastUsedAt, row.metadataJson,
    );
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
 * Keys on `metadata_json` that the dreaming pipeline / touchRows / validity
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
];

export function replaceMemories(entries = []) {
  const normalizedEntries = entries.map(normalizeEntry).filter(Boolean);
  const database = getDb();

  // ─── Preserve dreaming/touch metadata + last_used_at across the rebuild ─
  // Build a map id → { preservedMeta, lastUsedAt } so the re-insert can
  // merge instead of clobber.  We also prune `memory_hits` rows whose
  // memory_id will no longer exist after the rebuild, avoiding orphan drift.
  const incomingIds = new Set(normalizedEntries.map(row => row.id));
  const preservedById = new Map();
  try {
    const existing = database.prepare(
      `SELECT id, metadata_json, last_used_at FROM memories`,
    ).all();
    for (const row of existing) {
      if (!incomingIds.has(row.id)) continue;
      let oldMeta = {};
      try { oldMeta = JSON.parse(row.metadata_json || '{}') || {}; } catch {}
      const preserved = {};
      for (const key of PRESERVED_METADATA_KEYS) {
        if (oldMeta[key] !== undefined) preserved[key] = oldMeta[key];
      }
      preservedById.set(row.id, { preserved, lastUsedAt: row.last_used_at });
    }
  } catch (err) {
    // metadata table might be empty on first run — fine
    debugWarn('memory.store.replace', 'preserve-scan failed', err?.message || err);
  }

  const clearMemories = database.prepare('DELETE FROM memories');
  const clearFts = database.prepare('DELETE FROM memories_fts');
  const insert = database.prepare(`
    INSERT INTO memories (
      id, namespace, kind, source_id, text, search_text, embedding, tokens_estimate,
      created_at, updated_at, last_used_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = database.prepare(`
    INSERT INTO memories_fts (memory_id, namespace, kind, search_text)
    VALUES (?, ?, ?, ?)
  `);
  // Pre-fetch cached embeddings so we can populate the embedding column and
  // vec_memories table in the same transaction.
  const embeddingMap = new Map();
  for (const row of normalizedEntries) {
    const cached = getCachedEmbedding(row.searchText);
    if (cached) embeddingMap.set(row.id, cached);
  }

  // Clear vec_memories before rebuild (vec0 doesn't support DELETE ... WHERE)
  if (_vecLoaded) {
    try { database.exec('DELETE FROM vec_memories'); } catch (err) { debugWarn('memory.store.replace', 'clear vec_memories failed', err?.message || err); }
  }

  const insertVec = _vecLoaded
    ? database.prepare(`INSERT OR REPLACE INTO vec_memories (memory_id, embedding) VALUES (?, ?)`)
    : null;

  // Drop memory_hits rows whose memory_id won't exist post-rebuild.  This is
  // the snapshot-safe analogue of an ON DELETE CASCADE foreign key.
  const pruneOrphanHits = database.prepare(
    `DELETE FROM memory_hits WHERE memory_id NOT IN (SELECT value FROM json_each(?))`,
  );

  runInTransaction(() => {
    clearMemories.run();
    clearFts.run();
    try { pruneOrphanHits.run(JSON.stringify([...incomingIds])); } catch (err) { debugWarn('memory.store.replace', 'pruneOrphanHits failed', err?.message || err); }
    for (const row of normalizedEntries) {
      const embBuf = embeddingMap.has(row.id)
        ? Buffer.from(embeddingMap.get(row.id).buffer)
        : null;

      // Merge preserved dreaming fields back onto the fresh metadata.
      let metadataJson = row.metadataJson;
      const keep = preservedById.get(row.id);
      if (keep && Object.keys(keep.preserved).length) {
        try {
          const fresh = JSON.parse(row.metadataJson || '{}') || {};
          metadataJson = JSON.stringify({ ...fresh, ...keep.preserved });
        } catch {
          metadataJson = row.metadataJson;
        }
      }
      const lastUsedAt = row.lastUsedAt || keep?.lastUsedAt || null;

      insert.run(
        row.id,
        row.namespace,
        row.kind,
        row.sourceId,
        row.text,
        row.searchText,
        embBuf,
        row.tokensEstimate,
        row.createdAt,
        row.updatedAt,
        lastUsedAt,
        metadataJson,
      );
      insertFts.run(
        row.id,
        row.namespace,
        row.kind,
        toCjkSpaced(row.searchText),
      );
      if (insertVec && embBuf) {
        insertVec.run(row.id, embBuf);
      }
    }
  });
  return normalizedEntries.length;
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
  storeEmbedding(memoryId, searchText, embedding, modelId);
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

export function recallMemories({
  namespaces = [],
  kinds = [],
  query = '',
  limit = 8,
  queryEmbedding = null,
  includeEmbedding = false,
} = {}) {
  const builtQuery = buildRecallQuery({ namespaces, kinds, allowGlobal: false });
  if (!builtQuery) {
    return [];
  }

  const database = getDb();
  const lim = Math.max(1, limit);

  // Semantic path: KNN against vec_memories, then filter by namespace/kind
  if (queryEmbedding && _vecLoaded) {
    try {
      // Over-fetch from KNN (no namespace filter at vec layer) then filter in JS
      const knnResults = knnRecall(queryEmbedding, lim * 8);
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
            .filter(row => !row._invalidated)
            .sort((a, b) => b.score - a.score);

          // Phase 1 #1: MMR diversity rerank. Uses row.embedding which the
          // SELECT above explicitly fetches. Falls back to score-order slice
          // when embeddings are missing.
          const mmrSorted = applyMmrRerank(sorted, lim);

          if (mmrSorted.length > 0) {
            logRecallScores('recallMemories.semantic', mmrSorted, query);
            return touchRows(mmrSorted);
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
  const rows = mapScoredRows(
    database.prepare(builtQuery.sql).all(
      ...builtQuery.normalizedNamespaces,
      ...builtQuery.normalizedKinds,
    ),
    query,
  ).slice(0, lim);

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
  return touchRows(rows);
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

  const annotate = (row) => {
    const flags = {};
    if (invalidated.has(row.id)) flags._invalidated = true;
    if (contested.has(row.id)) {
      flags._contested = true;
      flags._contestedBy = contested.get(row.id);
    }
    if (orphans.has(row.id)) flags._orphan = true;
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

  // ─── Step 1 — scenes ────────────────────────────────────────────────────
  let scenes = [];
  if (queryEmbedding && _vecLoaded) {
    try {
      const knn = knnRecall(queryEmbedding, sLim * 6);
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
  if (!scenes.length) {
    // Keyword fallback across scene rows.
    const built = buildRecallQuery({ namespaces: normalizedNs, kinds: ['scene'], allowGlobal: false });
    if (built) {
      const rows = mapScoredRows(
        database.prepare(built.sql).all(...built.normalizedNamespaces, ...built.normalizedKinds),
        query,
      ).slice(0, sLim);
      scenes = rows.filter(atticOk);
    }
  }

  const sceneIds = scenes.map(s => s.metadata?.sceneId).filter(Boolean);

  // ─── Step 2 — frames (restricted to the scenes we picked) ───────────────
  let frames = [];
  if (queryEmbedding && _vecLoaded) {
    try {
      const knn = knnRecall(queryEmbedding, fLim * 6);
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
  if (!frames.length) {
    const built = buildRecallQuery({ namespaces: normalizedNs, kinds: ['frame'], allowGlobal: false });
    if (built) {
      const rows = mapScoredRows(
        database.prepare(built.sql).all(...built.normalizedNamespaces, ...built.normalizedKinds),
        query,
      ).slice(0, fLim);
      frames = rows.filter(atticOk);
    }
  }

  const frameIds = frames.map(f => f.metadata?.frameId).filter(Boolean);

  // ─── Step 3 — content (leaf prompts/facts) ──────────────────────────────
  let contents = [];
  if (queryEmbedding && _vecLoaded) {
    try {
      const knn = knnRecall(queryEmbedding, cLim * 6);
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
  if (!contents.length) {
    const built = buildRecallQuery({ namespaces: normalizedNs, kinds: ['prompt', 'fact'], allowGlobal: false });
    if (built) {
      const rows = mapScoredRows(
        database.prepare(built.sql).all(...built.normalizedNamespaces, ...built.normalizedKinds),
        query,
      ).slice(0, cLim);
      contents = rows.filter(atticOk);
    }
  }

  const touched = touchRows([...scenes, ...frames, ...contents]);
  const byId = new Map(touched.map(row => [row.id, row]));

  // Hit log — power for promotion gates.  Cheap fire-and-forget insert.
  const qHash = query ? createHash('sha1').update(String(query)).digest('hex').slice(0, 16) : null;
  const hits = [];
  [...scenes, ...frames, ...contents].forEach((r, i) => hits.push({ memoryId: r.id, queryHash: qHash, rank: i }));
  try { recordMemoryHitsBatch(hits); } catch (err) { debugWarn('memory.recall.hits', 'recordMemoryHitsBatch failed', err?.message || err); }

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

/**
 * Aggregate hit stats per memory row over the last `windowDays`.  Returns rows:
 *   { memoryId, hits, distinctQueries, avgRank, goodOutcomes }
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.memoryIds]   if provided, restrict to these ids
 * @param {number}   [opts.windowDays]  default 14
 */
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
           SUM(CASE WHEN outcome='used' THEN 1 ELSE 0 END) AS goodOutcomes
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
export function markMemoriesUsed(memoryIds = [], { windowMs = 10 * 60_000 } = {}) {
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
          AND (outcome IS NULL OR outcome = '')
        ORDER BY hit_at DESC
        LIMIT 1
     )
  `);
  let n = 0;
  runInTransaction(() => {
    for (const id of memoryIds) {
      if (!id) continue;
      try {
        const res = stmt.run(id, sinceIso);
        if (res.changes) n += 1;
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

export function searchMemories({ query = '', kinds = [], limit = 12 } = {}) {
  const database = getDb();
  const normalizedKinds = kinds.map(v => String(v || '').trim()).filter(Boolean);
  const lim = Math.max(1, limit);

  // Fast path: use FTS5 BM25 when a query is provided.
  //
  // Search audit B-4: we (a) filter out temporally-invalidated entries in the
  // FTS result set so expired facts never leak into UI search, and (b) fall
  // through to keyword scoring when the post-filter FTS set is empty.
  // Previously, if FTS matched rows that were all invalidated, the branch
  // returned an empty array WITHOUT running keyword scoring — so a query
  // that keyword-scoring could have answered via fuzzy / substring match
  // silently returned nothing.
  if (query && query.trim()) {
    const ftsQuery = buildMemoriesFtsQuery(toCjkSpaced(query.trim()));
    if (ftsQuery) {
      try {
        const kindClause = normalizedKinds.length
          ? ` AND kind IN (${normalizedKinds.map(() => '?').join(', ')})`
          : '';
        const ftsRows = database.prepare(`
          SELECT memory_id, bm25(memories_fts) AS rank
          FROM memories_fts
          WHERE memories_fts MATCH ?${kindClause}
          ORDER BY rank
          LIMIT ?
        `).all(ftsQuery, ...normalizedKinds, lim * 4); // over-fetch for post-join

        if (ftsRows.length > 0) {
          const ids = ftsRows.map(r => r.memory_id);
          const placeholders = ids.map(() => '?').join(', ');
          const memRows = database.prepare(`
            SELECT id, namespace, kind, source_id, text, search_text, tokens_estimate,
                   created_at, updated_at, last_used_at, metadata_json
            FROM memories
            WHERE id IN (${placeholders})
          `).all(...ids);

          // Re-order by FTS5 rank, attach metadata, drop invalidated.
          const rankMap = new Map(ftsRows.map(r => [r.memory_id, r.rank]));
          const now = Date.now();
          const results = memRows
            .map(row => {
              const metadata = parseMetadata(row.metadata_json);
              return {
                ...row,
                metadata,
                score: -(rankMap.get(row.id) ?? 0), // bm25 returns negatives; negate for ascending sort
                _invalidated: isEntryInvalidated(metadata, now),
              };
            })
            .filter(row => !row._invalidated)
            .sort((a, b) => b.score - a.score)
            .slice(0, lim);

          if (results.length > 0) {
            return touchRows(results);
          }
          // else fall through to keyword scoring
        }
      } catch (err) {
        // Fall through to JS scoring on FTS5 error
        debugWarn('memory.search.fts', 'searchMemories FTS path failed, falling back to JS scoring', err?.message || err);
      }
    }
  }

  // Fallback: JS scoring (original behaviour, also used when query is empty).
  // mapScoredRows already filters out invalidated rows.
  const builtQuery = buildRecallQuery({ namespaces: [], kinds: normalizedKinds, allowGlobal: true });
  if (!builtQuery) return [];

  const rows = mapScoredRows(
    database.prepare(builtQuery.sql).all(...builtQuery.normalizedKinds),
    query,
  ).slice(0, lim);

  return touchRows(rows);
}
