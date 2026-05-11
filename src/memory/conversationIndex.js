/**
 * conversationIndex.js
 *
 * FTS5-powered conversation history search index (search.sqlite).
 *
 * Uses the unicode61 tokenizer with CJK unigram preprocessing:
 * each CJK character is surrounded by spaces before indexing/querying
 * so the tokenizer treats individual characters as word tokens.
 * This lets users search with any substring (e.g. "天气", "hello").
 *
 * Indexing is incremental — individual messages are appended as they arrive.
 * Deduplication is by message_id: if a message_id already exists in the
 * index it is silently skipped.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getMeloHome } from '../config.js';

// G-6 (audit 2026-05-11): SEARCH_DB_PATH was previously a module-load
// `const join(getMeloHome(), …)` — same CLAUDE.md §6 violation pattern
// the dreaming DREAMS_DIR / webSearchTool CACHE_DB_PATH fixes addressed.
// FTS index opens the same `desktop/search.sqlite` file that webSearchTool's
// cache db opens (independent handle, disjoint tables — `messages_fts` here vs
// `web_search_cache`/`url_content_cache` over there).  If a test or
// multi-profile runtime flips MELO_HOME, the cache-db handle now reopens
// at the new path (Phase 2 #2 fix) but the FTS handle would silently keep
// writing to the OLD path.  Same `getDb()`-with-path-change-detection
// pattern applied here.
function searchDbPath() {
  return join(getMeloHome(), 'desktop', 'search.sqlite');
}

let _db = null;
let _openedDbPath = null;

/** @internal test hook — close cached handle so the next getDb() call
 *  re-opens at the current MELO_HOME path.  Tests using mkdtemp+
 *  MELO_HOME isolation should call this in beforeEach/afterEach. */
export function _resetConversationIndexForTests() {
  if (_db) {
    try { _db.close(); } catch {}
  }
  _db = null;
  _openedDbPath = null;
}

// ─── CJK preprocessing ───────────────────────────────────────────────────────

/**
 * Insert a space around every CJK / kana / hangul character so the
 * unicode61 tokenizer treats each one as a distinct word token.
 */
function toCjkSpaced(text = '') {
  return String(text).replace(
    /([\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F])/g,
    ' $1 ',
  );
}

// ─── Database init ────────────────────────────────────────────────────────────

function getDb() {
  const path = searchDbPath();
  if (_db && _openedDbPath === path) return _db;
  // Path changed (test or runtime switched MELO_HOME) — close old handle, open new.
  if (_db) {
    try { _db.close(); } catch {}
    _db = null;
  }

  mkdirSync(dirname(path), { recursive: true });
  _db = new DatabaseSync(path);
  _openedDbPath = path;
  _db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      chat_id    UNINDEXED,
      chat_title UNINDEXED,
      message_id UNINDEXED,
      role       UNINDEXED,
      content,
      created_at UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 1'
    );

    -- Dedup helper: track which message_ids have been indexed
    CREATE TABLE IF NOT EXISTS indexed_message_ids (
      message_id TEXT PRIMARY KEY
    );
  `);
  return _db;
}

// ─── Write API ────────────────────────────────────────────────────────────────

/**
 * Index a single message (fire-and-forget safe — any error is swallowed).
 * Skips tool/system roles and empty content.
 * Skips messages that are already in the index (by message_id).
 *
 * @param {string} chatId
 * @param {string} chatTitle
 * @param {{ id: string, role: string, content: string, createdAt: string }} message
 */
export function indexMessage(chatId, chatTitle, message) {
  try {
    const role = String(message?.role || '');
    if (role === 'tool' || role === 'system') return;

    const text = typeof message?.content === 'string' ? message.content.trim() : '';
    if (!text) return;

    const messageId = String(message?.id || '');
    if (!messageId || !chatId) return;

    const database = getDb();

    // Skip if already indexed
    const existing = database
      .prepare('SELECT 1 FROM indexed_message_ids WHERE message_id = ?')
      .get(messageId);
    if (existing) return;

    database.exec('BEGIN');
    try {
      database.prepare(
        `INSERT INTO messages_fts (chat_id, chat_title, message_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        String(chatId),
        toCjkSpaced(String(chatTitle || '')),
        messageId,
        role,
        toCjkSpaced(text),
        String(message?.createdAt || ''),
      );
      database.prepare(
        'INSERT OR IGNORE INTO indexed_message_ids (message_id) VALUES (?)',
      ).run(messageId);
      database.exec('COMMIT');
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch {}
      throw err;
    }
  } catch {
    // Best-effort — never crash the main message flow
  }
}

/**
 * Bulk-index an array of messages for a chat.
 * Each message is deduped via message_id so safe to call repeatedly.
 *
 * @param {string} chatId
 * @param {string} chatTitle
 * @param {Array} messages
 */
export function indexMessages(chatId, chatTitle, messages = []) {
  if (!chatId || !Array.isArray(messages)) return;
  for (const msg of messages) {
    indexMessage(chatId, chatTitle, msg);
  }
}

/**
 * Remove all indexed entries for a chat (e.g. when a chat is deleted).
 *
 * @param {string} chatId
 */
export function unindexChat(chatId) {
  try {
    if (!chatId) return;
    const database = getDb();
    // Get message_ids for this chat so we can clean indexed_message_ids too
    const rows = database
      .prepare('SELECT message_id FROM messages_fts WHERE chat_id = ?')
      .all(String(chatId));
    database.exec('BEGIN');
    try {
      database.prepare("DELETE FROM messages_fts WHERE chat_id = ?").run(String(chatId));
      for (const row of rows) {
        database
          .prepare('DELETE FROM indexed_message_ids WHERE message_id = ?')
          .run(row.message_id);
      }
      database.exec('COMMIT');
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch {}
      throw err;
    }
  } catch {
    // Best-effort
  }
}

// ─── Read API ─────────────────────────────────────────────────────────────────

/**
 * Coerce a caller-supplied timestamp into epoch milliseconds.
 * Accepts: ISO 8601 string, RFC 2822 date string, Date instance, or numeric
 * epoch value (seconds, milliseconds, microseconds, or nanoseconds — detected
 * by magnitude).
 *
 * Returns `null` for anything else — that includes nonsense timestamps like
 * `1000` or `-5` which would previously be coerced into a ~1970 ms value
 * and silently become a permissive filter.
 *
 * Search audit B-2: the old heuristic `value < 1e12 ? *1000 : as-is` treated
 * EVERY finite number under 10^12 as seconds, so passing `1000` (meaning
 * 1000 ms = 1970-01-01 00:00:01) produced 10^6 ms, and negative numbers
 * produced negative ms.  We now require the coerced value to land inside a
 * sensible chat-timestamp window [2001-09-09, 2200-01-01] or return null.
 */
// Inclusive lower bound: 2001-09-09T01:46:40Z — the UNIX epoch milestone that
// 10^12 ms corresponds to.  Anything before this is a suspicious timestamp
// for chat activity.
const MIN_CHAT_MS = 1_000_000_000_000;        // 2001-09-09T01:46:40Z
// Exclusive upper bound: ~7258118400000 (year 2200).  Anything past this
// is almost certainly a mistake (e.g. a nanosecond value that didn't get
// scaled down).
const MAX_CHAT_MS = 7_258_118_400_000;        // year 2200

export function coerceAfterTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;

  let ms = null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Detect the caller's time unit by magnitude.  These windows are disjoint
    // until you hit astronomical values.
    if (value < 1e12) {
      // Seconds — roughly year 1970 (s=1) through 2286 (s=1e10).
      ms = Math.round(value * 1000);
    } else if (value < 1e15) {
      // Milliseconds — this is the common case.
      ms = Math.round(value);
    } else if (value < 1e18) {
      // Microseconds — occasionally produced by database clients.
      ms = Math.round(value / 1000);
    } else {
      // Nanoseconds — produced by OpenTelemetry-style clocks.
      ms = Math.round(value / 1_000_000);
    }
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    // Numeric string → re-enter the number path instead of Date.parse, which
    // interprets plain digit runs as years (e.g. "2024" → 2024-01-01).
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      return coerceAfterTimestamp(Number(trimmed));
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) ms = parsed;
  } else if (value instanceof Date && !Number.isNaN(value.getTime())) {
    ms = value.getTime();
  }

  if (ms === null || !Number.isFinite(ms)) return null;
  if (ms < MIN_CHAT_MS || ms >= MAX_CHAT_MS) return null;
  return ms;
}

/**
 * Search conversation history using FTS5 BM25 ranking.
 *
 * @param {string} query
 * @param {{
 *   limit?: number,
 *   after?: string | number | Date,  // ISO date / epoch ms / epoch s / Date — only return messages created ≥ this
 *   chatId?: string,                  // restrict to a single chat
 * }} options
 * @returns {{ chatId, chatTitle, messageId, role, snippet, createdAt, rank }[]}
 */
export function searchHistory(query, { limit = 10, after, chatId } = {}) {
  if (!query || !query.trim()) return [];

  const database = getDb();
  const ftsQuery = buildFtsQuery(toCjkSpaced(query.trim()));
  if (!ftsQuery) return [];

  const conditions = ['messages_fts MATCH ?'];
  const params = [ftsQuery];

  const afterMs = coerceAfterTimestamp(after);
  if (afterMs !== null) {
    conditions.push('created_at >= ?');
    params.push(afterMs);
  }

  if (chatId !== undefined && chatId !== null && String(chatId).trim()) {
    conditions.push('chat_id = ?');
    params.push(String(chatId).trim());
  }

  params.push(Math.max(1, Math.min(50, limit || 10)));

  try {
    const sql = `
      SELECT
        chat_id    AS chatId,
        chat_title AS chatTitle,
        message_id AS messageId,
        role,
        snippet(messages_fts, 4, '…[', ']…', '…', 32) AS snippet,
        created_at AS createdAt,
        bm25(messages_fts) AS rank
      FROM messages_fts
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank
      LIMIT ?
    `;
    const rows = database.prepare(sql).all(...params);

    return rows.map(row => ({
      chatId: row.chatId,
      chatTitle: row.chatTitle,
      messageId: row.messageId,
      role: row.role,
      snippet: row.snippet,
      createdAt: row.createdAt,
      rank: row.rank,
    }));
  } catch {
    return [];
  }
}

// ─── FTS5 query builder ───────────────────────────────────────────────────────

/**
 * Build an FTS5 MATCH query from free text.
 * Each whitespace-separated token becomes a quoted phrase.
 * Tokens are joined with OR so partial matches rank lower but still match.
 */
function buildFtsQuery(text) {
  const tokens = String(text || '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, '')}"`)
    .join(' OR ');
  return tokens || null;
}
