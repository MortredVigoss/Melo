import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const RECENT_RUNS_PER_CHAT = 50;
function open(home, create = false) {
  const path = join(home, 'desktop', 'turn-history.sqlite');
  if (!create && !existsSync(path)) return null;
  if (create) mkdirSync(join(home, 'desktop'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=5000');
  if (create) db.exec(`CREATE TABLE IF NOT EXISTS turns (runId TEXT PRIMARY KEY, chatId TEXT NOT NULL, requestId TEXT NOT NULL, createdAt TEXT NOT NULL, record TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS turn_request ON turns(chatId,requestId);
    CREATE INDEX IF NOT EXISTS turn_history ON turns(chatId,createdAt DESC,runId DESC)`);
  return db;
}
// Archive only terminal records from the PREVIOUS committed manifest. Writing
// the archive first is safe: if the manifest commit fails, the live copy wins.
export function compactChatRuns(state, committedRuns, home) {
  const committed = new Map((committedRuns || []).map(run => [run.runId, JSON.stringify(run)]));
  const counts = new Map(), archive = [];
  const sorted = [...(state.chatRuns || [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.runId.localeCompare(a.runId));
  for (const run of sorted) {
    if (run.status === 'running') continue;
    const count = (counts.get(run.chatId) || 0) + 1;
    counts.set(run.chatId, count);
    if (count > RECENT_RUNS_PER_CHAT && committed.get(run.runId) === JSON.stringify(run)) archive.push(run);
  }
  if (!archive.length) return;
  const db = open(home, true);
  try {
    db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT INTO turns VALUES(?,?,?,?,?) ON CONFLICT(runId) DO UPDATE SET chatId=excluded.chatId,requestId=excluded.requestId,createdAt=excluded.createdAt,record=excluded.record');
    for (const run of archive) insert.run(run.runId, run.chatId, run.requestId, run.createdAt || '', JSON.stringify(run));
    db.exec('COMMIT');
  } finally { db.close(); }
  const ids = new Set(archive.map(run => run.runId));
  state.chatRuns = state.chatRuns.filter(run => !ids.has(run.runId));
}
export function findArchivedRun(home, chatId, { requestId, runId } = {}) {
  const db = open(home); if (!db) return null;
  try {
    const row = requestId ? db.prepare('SELECT record FROM turns WHERE chatId=? AND requestId=?').get(chatId, requestId)
      : db.prepare('SELECT record FROM turns WHERE chatId=? AND runId=?').get(chatId, runId);
    return row ? JSON.parse(row.record) : null;
  } finally { db.close(); }
}
export function listArchivedRuns(home, chatId, { before, limit = 21 } = {}) {
  const db = open(home); if (!db) return [];
  try {
    const rows = before ? db.prepare('SELECT record FROM turns WHERE chatId=? AND (createdAt<? OR (createdAt=? AND runId<?)) ORDER BY createdAt DESC,runId DESC LIMIT ?').all(chatId, before.createdAt, before.createdAt, before.runId, limit)
      : db.prepare('SELECT record FROM turns WHERE chatId=? ORDER BY createdAt DESC,runId DESC LIMIT ?').all(chatId, limit);
    return rows.map(row => JSON.parse(row.record));
  } finally { db.close(); }
}

export function deleteArchivedChatRuns(home, chatId) {
  const db = open(home); if (!db) return;
  try { db.prepare('DELETE FROM turns WHERE chatId=?').run(chatId); }
  finally { db.close(); }
}
