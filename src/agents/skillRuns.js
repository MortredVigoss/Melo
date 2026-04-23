// Phase 3.3.4 — skill run telemetry.
//
// Records every skill invocation (prompt and executable) into a local
// SQLite table so the UI can surface a small health panel:
//   • success rate per skill
//   • P50 / average duration
//   • last N errors (message + type)
//
// Storage lives in the existing ~/.melo/desktop/store.sqlite file, side
// by side with the memory store. WAL mode + a separate DatabaseSync
// handle means concurrent writes from the memory pipeline are safe.
//
// Recording is always best-effort: if the DB isn't available we swallow
// the error rather than failing a skill run.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { getMeloHome } from '../config.js';

const STORE_PATH = join(getMeloHome(), 'desktop', 'store.sqlite');

let db = null;

function getDb() {
  if (db) return db;
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    db = new DatabaseSync(STORE_PATH);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS skill_runs (
        id            TEXT PRIMARY KEY,
        skill_id      TEXT NOT NULL,
        chat_id       TEXT,
        started_at    INTEGER NOT NULL,
        duration_ms   INTEGER,
        ok            INTEGER NOT NULL DEFAULT 1,
        error_type    TEXT,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_skill_runs_skill
        ON skill_runs(skill_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_skill_runs_started
        ON skill_runs(started_at DESC);
    `);
    return db;
  } catch (err) {
    // If the DB can't be opened (permissions, locked, etc.) skill runs
    // still proceed — telemetry is optional.
    console.warn('[skillRuns] failed to open store:', err?.message || err);
    db = null;
    return null;
  }
}

/**
 * Record a completed skill invocation. Never throws.
 *
 * @param {object}  entry
 * @param {string}  entry.skillId
 * @param {string}  [entry.chatId]
 * @param {number}  [entry.startedAt]       epoch ms; defaults to Date.now()
 * @param {number}  [entry.durationMs]
 * @param {boolean} [entry.ok]              default true
 * @param {string}  [entry.errorType]
 * @param {string}  [entry.errorMessage]
 */
export function recordSkillRun(entry = {}) {
  const skillId = String(entry.skillId || '').trim();
  if (!skillId) return;
  const database = getDb();
  if (!database) return;

  const row = {
    id: randomUUID(),
    skill_id: skillId,
    chat_id: typeof entry.chatId === 'string' && entry.chatId ? entry.chatId : null,
    started_at: Number.isFinite(entry.startedAt) ? Math.floor(entry.startedAt) : Date.now(),
    duration_ms: Number.isFinite(entry.durationMs) ? Math.max(0, Math.floor(entry.durationMs)) : null,
    ok: entry.ok === false ? 0 : 1,
    error_type: entry.errorType ? String(entry.errorType).slice(0, 128) : null,
    error_message: entry.errorMessage ? String(entry.errorMessage).slice(0, 500) : null,
  };

  try {
    database.prepare(`
      INSERT INTO skill_runs (id, skill_id, chat_id, started_at, duration_ms, ok, error_type, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.skill_id,
      row.chat_id,
      row.started_at,
      row.duration_ms,
      row.ok,
      row.error_type,
      row.error_message,
    );
  } catch (err) {
    console.warn('[skillRuns] insert failed:', err?.message || err);
  }
}

/**
 * Aggregate per-skill statistics, plus recent errors. Used by the health
 * panel. Returns an empty list if the DB isn't available.
 *
 * @param {object} [options]
 * @param {string} [options.skillId]    restrict to one skill
 * @param {number} [options.windowDays] look-back window (default 30)
 * @param {number} [options.errorLimit] cap on recent errors per skill (default 5)
 */
export function getSkillRunStats(options = {}) {
  const database = getDb();
  if (!database) return { skills: [] };

  const windowDays = Number.isFinite(options.windowDays) ? options.windowDays : 30;
  const windowMs = Math.max(1, Math.floor(windowDays * 24 * 60 * 60 * 1000));
  const cutoff = Date.now() - windowMs;
  const errorLimit = Number.isFinite(options.errorLimit) ? Math.max(1, Math.floor(options.errorLimit)) : 5;

  try {
    const whereSkill = options.skillId ? ' AND skill_id = ?' : '';
    const params = [cutoff];
    if (options.skillId) params.push(String(options.skillId));

    const rows = database.prepare(`
      SELECT
        skill_id AS skillId,
        COUNT(*) AS runs,
        SUM(ok)  AS successes,
        AVG(duration_ms) AS avgDurationMs,
        MAX(started_at)  AS lastRunAt
      FROM skill_runs
      WHERE started_at >= ?${whereSkill}
      GROUP BY skill_id
      ORDER BY runs DESC
    `).all(...params);

    // SQLite doesn't expose a built-in median; grab per-skill durations
    // sorted and pick the middle. Only do this for skills that actually
    // have runs — keeps the query set small.
    const result = [];
    for (const row of rows) {
      const durRows = database.prepare(`
        SELECT duration_ms
        FROM skill_runs
        WHERE skill_id = ? AND started_at >= ? AND duration_ms IS NOT NULL
        ORDER BY duration_ms ASC
      `).all(row.skillId, cutoff);
      const durations = durRows.map(r => r.duration_ms).filter(v => Number.isFinite(v));
      const p50 = durations.length
        ? durations[Math.floor(durations.length / 2)]
        : null;

      const errorRows = database.prepare(`
        SELECT started_at AS startedAt, error_type AS errorType, error_message AS errorMessage
        FROM skill_runs
        WHERE skill_id = ? AND ok = 0 AND started_at >= ?
        ORDER BY started_at DESC
        LIMIT ?
      `).all(row.skillId, cutoff, errorLimit);

      result.push({
        skillId: row.skillId,
        runs: Number(row.runs) || 0,
        successes: Number(row.successes) || 0,
        failures: (Number(row.runs) || 0) - (Number(row.successes) || 0),
        successRate: row.runs ? Number(row.successes) / Number(row.runs) : null,
        avgDurationMs: Number.isFinite(row.avgDurationMs) ? Math.round(row.avgDurationMs) : null,
        p50DurationMs: p50,
        lastRunAt: row.lastRunAt ? Number(row.lastRunAt) : null,
        recentErrors: errorRows,
      });
    }

    return { windowDays, skills: result };
  } catch (err) {
    console.warn('[skillRuns] stats query failed:', err?.message || err);
    return { skills: [] };
  }
}

/**
 * Return a map of { skillId → lastRunAt(ms) } for every skill that has
 * run within the given window (default 30 days). Single GROUP BY query —
 * cheap enough to call on every matcher invocation.
 *
 * Used by the skill matcher's recency boost. Returns an empty Map if the
 * DB isn't available.
 */
export function getSkillLastRunMap({ windowDays = 30 } = {}) {
  const out = new Map();
  const database = getDb();
  if (!database) return out;
  const cutoff = Date.now() - Math.max(1, windowDays) * 24 * 60 * 60 * 1000;
  try {
    const rows = database.prepare(`
      SELECT skill_id AS skillId, MAX(started_at) AS lastRunAt
      FROM skill_runs
      WHERE started_at >= ?
      GROUP BY skill_id
    `).all(cutoff);
    for (const row of rows) {
      if (row?.skillId && Number.isFinite(row.lastRunAt)) {
        out.set(row.skillId, Number(row.lastRunAt));
      }
    }
  } catch (err) {
    // Best-effort; recency boost is a nice-to-have, not load-bearing.
    console.warn('[skillRuns] lastRun query failed:', err?.message || err);
  }
  return out;
}

/**
 * Drop rows older than the given window. Called opportunistically to
 * keep the table bounded. Never throws.
 */
export function pruneSkillRuns({ keepDays = 180 } = {}) {
  const database = getDb();
  if (!database) return 0;
  const cutoff = Date.now() - Math.max(1, keepDays) * 24 * 60 * 60 * 1000;
  try {
    const res = database.prepare(`DELETE FROM skill_runs WHERE started_at < ?`).run(cutoff);
    return res?.changes || 0;
  } catch {
    return 0;
  }
}
