/**
 * DREAMS.md writer — append a dated audit record for each sweep so users can
 * see exactly what the background pass changed.  The file lives under
 * ~/.melo/desktop/dreams/YYYY-MM-DD.md and is safe to inspect or commit.
 *
 * Each sweep appends a "## Run <ISO>" block.  We never rewrite old blocks so
 * the diary stays append-only and auditable.
 */

import { mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getMeloHome } from '../../config.js';

// Resolve at call time (synchronous path), not at module load.  Module-load
// resolution froze DREAMS_DIR to whatever MELO_HOME pointed at when the test
// process first imported diary.js — so test suites that later set
// process.env.MELO_HOME = mkdtempSync(...) silently kept writing to the
// production ~/.melo/desktop/dreams/.  Compatible with CLAUDE.md §6: this is
// the synchronous write path, not an async-boundary capture, so reading
// getMeloHome() here is correct (the upstream sweep caller already captured
// home for the duration of the sweep).
function dreamsDir() {
  return join(getMeloHome(), 'desktop', 'dreams');
}

/**
 * Build the diary file path for the given ISO timestamp.
 */
export function diaryPathFor(iso = new Date().toISOString()) {
  const day = iso.slice(0, 10); // YYYY-MM-DD
  return join(dreamsDir(), `${day}.md`);
}

/**
 * @typedef {Object} DreamRecord
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {number} examined
 * @property {number} promoted
 * @property {number} demoted
 * @property {number} merged
 * @property {number} expired
 * @property {number} hitsPruned
 * @property {Array<{id: string, level: string, score?: number}>} [promotedRows]
 * @property {Array<{keepId: string, dropId: string, similarity: number}>} [mergeRows]
 * @property {Array<{id: string, validTo: string, reason: string}>} [expiredRows]
 */

function fmtCount(label, n) {
  if (!n) return null;
  return `- **${label}**: ${n}`;
}

/**
 * Append one sweep's record to the day's diary file.
 * @param {DreamRecord} record
 * @returns {string} the diary file path that was written
 */
export function appendDreamRecord(record) {
  const path = diaryPathFor(record.startedAt);
  mkdirSync(dirname(path), { recursive: true });
  const lines = [];
  if (!existsSync(path)) {
    lines.push(`# Melo Dream Diary — ${record.startedAt.slice(0, 10)}`);
    lines.push('');
    lines.push(
      '_Auto-generated audit of Melo\'s background memory consolidation sweeps. ' +
      'Safe to delete; no runtime dependency._',
    );
    lines.push('');
  }

  lines.push(`## Run ${record.startedAt}`);
  lines.push('');
  lines.push(`Finished: \`${record.finishedAt}\``);
  const counts = [
    fmtCount('Examined', record.examined),
    fmtCount('Promoted to Hot', record.promoted),
    fmtCount('Demoted', record.demoted),
    fmtCount('Merged duplicates', record.merged),
    fmtCount('Expired (validTo set)', record.expired),
    fmtCount('Hit rows pruned', record.hitsPruned),
  ].filter(Boolean);
  if (counts.length) lines.push(...counts);

  if (record.promotedRows?.length) {
    lines.push('');
    lines.push('### Promoted');
    for (const r of record.promotedRows.slice(0, 20)) {
      const s = r.score != null ? ` (score ${r.score.toFixed(2)})` : '';
      lines.push(`- \`${r.id}\` → ${r.level}${s}`);
    }
    if (record.promotedRows.length > 20) {
      lines.push(`- …and ${record.promotedRows.length - 20} more`);
    }
  }
  if (record.mergeRows?.length) {
    lines.push('');
    lines.push('### Merged duplicates');
    for (const m of record.mergeRows.slice(0, 20)) {
      lines.push(`- \`${m.dropId}\` → \`${m.keepId}\` (cos ${m.similarity.toFixed(3)})`);
    }
    if (record.mergeRows.length > 20) {
      lines.push(`- …and ${record.mergeRows.length - 20} more`);
    }
  }
  if (record.expiredRows?.length) {
    lines.push('');
    lines.push('### Expired (validTo set)');
    for (const e of record.expiredRows.slice(0, 20)) {
      lines.push(`- \`${e.id}\` → validTo ${e.validTo} — ${e.reason}`);
    }
    if (record.expiredRows.length > 20) {
      lines.push(`- …and ${record.expiredRows.length - 20} more`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  appendFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

// Public path accessor — kept for any external consumer.  Use a getter so
// callers always see the current home (mirrors dreamsDir() above).
export const DREAMS_PATHS = {
  get DREAMS_DIR() { return dreamsDir(); },
};
