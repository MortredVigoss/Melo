#!/usr/bin/env node
/**
 * scripts/inspect-search-trail.js
 *
 * Phase 2 instrumentation companion (G-2b round-5 prep).  Reads the
 * append-only JSONL files written by `src/services/search/trailLogger.js`
 * and renders aggregated stats — by-source counts, evidenceTrail
 * tier×outcome histogram, top fail reasons.  Designed to make ≥1 day of
 * production trail data inspectable without per-session ad-hoc `cat | jq`.
 *
 * Activation contract (set on the long-running CLI / server BEFORE searches):
 *   MELO_SEARCH_TRAIL_LOG=1
 *
 * The log lives at:
 *   $MELO_HOME/desktop/search-trail-log/YYYY-MM-DD.jsonl
 *
 * Usage:
 *   node scripts/inspect-search-trail.js                            # today, all sources, full stats
 *   node scripts/inspect-search-trail.js --day=2026-05-11           # specific day
 *   node scripts/inspect-search-trail.js --days=7                   # last 7 days merged
 *   node scripts/inspect-search-trail.js --source=url-fetch         # filter source
 *   node scripts/inspect-search-trail.js --status=fail              # ok|fail|aborted|missed
 *   node scripts/inspect-search-trail.js --raw                      # emit filtered JSONL (no aggregation)
 *   node scripts/inspect-search-trail.js --raw --status=fail | jq . # pipe into jq
 *
 * Exit codes:
 *   0  printed a snapshot (even if 0 entries)
 *   1  log directory not found / unreadable
 *   2  invalid CLI args
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getMeloHome } from '../src/config.js';

const VALID_SOURCES = new Set(['url-fetch', 'social-link', 'web-search']);
const VALID_STATUSES = new Set(['ok', 'fail', 'aborted', 'missed']);

// ─── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    day: null,
    days: 1,
    source: null,
    status: null,
    raw: false,
    help: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--raw') { opts.raw = true; continue; }
    if (arg.startsWith('--day=')) { opts.day = arg.slice(6); continue; }
    if (arg.startsWith('--days=')) { opts.days = Math.max(1, parseInt(arg.slice(7), 10) || 1); continue; }
    if (arg.startsWith('--source=')) { opts.source = arg.slice(9); continue; }
    if (arg.startsWith('--status=')) { opts.status = arg.slice(9); continue; }
    throw new Error(`Unknown argument: ${arg}.  Run with --help for usage.`);
  }
  if (opts.source && !VALID_SOURCES.has(opts.source)) {
    throw new Error(`--source must be one of ${[...VALID_SOURCES].join(', ')} (got: ${opts.source}).`);
  }
  if (opts.status && !VALID_STATUSES.has(opts.status)) {
    throw new Error(`--status must be one of ${[...VALID_STATUSES].join(', ')} (got: ${opts.status}).`);
  }
  return opts;
}

// ─── file enumeration ─────────────────────────────────────────────────────────

function logDir() {
  return join(getMeloHome(), 'desktop', 'search-trail-log');
}

/** Return ISO YYYY-MM-DD strings for the last `n` calendar days, newest first. */
function lastNDays(n, anchor = new Date()) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(anchor.getTime());
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function pickDayFiles(opts) {
  const dir = logDir();
  let stats;
  try {
    stats = statSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Trail log directory does not exist: ${dir}\n` +
        `(Likely cause: MELO_SEARCH_TRAIL_LOG was never set to 1, or no searches have run since.)`,
      );
    }
    throw err;
  }
  if (!stats.isDirectory()) throw new Error(`Trail log path is not a directory: ${dir}`);

  const all = readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  if (opts.day) {
    const file = join(dir, `${opts.day}.jsonl`);
    return all.includes(`${opts.day}.jsonl`) ? [file] : [];
  }
  const wanted = new Set(lastNDays(opts.days));
  return all
    .filter(f => wanted.has(f.replace(/\.jsonl$/, '')))
    .sort()
    .reverse()
    .map(f => join(dir, f));
}

// ─── entry stream ─────────────────────────────────────────────────────────────

function* readEntries(files) {
  for (const file of files) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[inspect] failed to read ${file}: ${err.message}`);
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // Skip malformed lines — the JSONL file is append-only and a
        // partial write can leave a tail.  Don't fail the whole inspect.
      }
    }
  }
}

function statusOf(entry) {
  if (entry.aborted === true) return 'aborted';
  if (entry.missed === true) return 'missed';
  if (entry.ok === true) return 'ok';
  if (entry.ok === false) return 'fail';
  if (typeof entry.error === 'string' && entry.error) return 'fail';
  return 'unknown';
}

function passesFilter(entry, opts) {
  if (opts.source && entry.source !== opts.source) return false;
  if (opts.status && statusOf(entry) !== opts.status) return false;
  return true;
}

// ─── aggregation ──────────────────────────────────────────────────────────────

function aggregate(entries) {
  const agg = {
    total: 0,
    bySource: {},                       // source → { total, ok, fail, aborted, missed, unknown }
    tierOutcome: {},                    // tier → { ok, fail, aborted, skip, unknown }
    failReasons: new Map(),             // "source/reason" → count
    topUrlsByFailCount: new Map(),      // url → fail count
    latencyP50: { jina: [], direct: [], playwright: [] }, // tier → []ms (sample for percentile)
  };

  for (const e of entries) {
    agg.total += 1;
    const src = e.source || '<unknown>';
    if (!agg.bySource[src]) {
      agg.bySource[src] = { total: 0, ok: 0, fail: 0, aborted: 0, missed: 0, unknown: 0 };
    }
    const st = statusOf(e);
    agg.bySource[src].total += 1;
    agg.bySource[src][st] += 1;

    if (Array.isArray(e.evidenceTrail)) {
      for (const item of e.evidenceTrail) {
        const tier = item?.tier || '<unknown>';
        const outcome = item?.outcome || '<unknown>';
        if (!agg.tierOutcome[tier]) agg.tierOutcome[tier] = {};
        agg.tierOutcome[tier][outcome] = (agg.tierOutcome[tier][outcome] || 0) + 1;
        if (outcome === 'fail' && item?.reason) {
          const key = `${src}/${tier}:${item.reason}`;
          agg.failReasons.set(key, (agg.failReasons.get(key) || 0) + 1);
        }
        if (typeof item?.latencyMs === 'number' && agg.latencyP50[tier]) {
          agg.latencyP50[tier].push(item.latencyMs);
        }
      }
    }

    if (st === 'fail' && e.input?.url) {
      agg.topUrlsByFailCount.set(e.input.url,
        (agg.topUrlsByFailCount.get(e.input.url) || 0) + 1);
    }
  }
  return agg;
}

function p50(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : Math.round((sorted[i - 1] + sorted[i]) / 2);
}

function topN(map, n = 8) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ─── rendering ────────────────────────────────────────────────────────────────

function render(agg, opts, files) {
  const lines = [];
  const fileList = files.map(f => f.split('/').pop()).join(', ') || '<none>';
  lines.push(`# search-trail inspect — ${agg.total} entries from ${files.length} file(s): ${fileList}`);
  if (opts.source || opts.status) {
    lines.push(`#   filters: source=${opts.source || '*'}, status=${opts.status || '*'}`);
  }
  lines.push('');

  if (agg.total === 0) {
    lines.push('No entries matched.  Confirm MELO_SEARCH_TRAIL_LOG=1 was set on the producing process,');
    lines.push('and that searches/url-fetches have actually run since.');
    return lines.join('\n');
  }

  // By-source breakdown.
  lines.push('## by-source breakdown');
  for (const [src, counts] of Object.entries(agg.bySource)) {
    const okPct = ((counts.ok / counts.total) * 100).toFixed(1);
    lines.push(
      `  ${src.padEnd(13)} total=${String(counts.total).padStart(5)}` +
      `  ok=${counts.ok} (${okPct}%)  fail=${counts.fail}` +
      `  aborted=${counts.aborted}  missed=${counts.missed}` +
      (counts.unknown ? `  unknown=${counts.unknown}` : ''),
    );
  }
  lines.push('');

  // Tier × outcome histogram (only if any evidenceTrail entries exist).
  const tiers = Object.keys(agg.tierOutcome);
  if (tiers.length) {
    lines.push('## evidenceTrail tier × outcome');
    const outcomes = ['ok', 'fail', 'aborted', 'skip', 'unknown'];
    const header = '  ' + 'tier'.padEnd(18) + outcomes.map(o => o.padStart(8)).join('');
    lines.push(header);
    for (const tier of tiers.sort()) {
      const row = agg.tierOutcome[tier];
      const cells = outcomes.map(o => String(row[o] || 0).padStart(8));
      lines.push('  ' + tier.padEnd(18) + cells.join(''));
    }
    lines.push('');
  }

  // Top fail reasons.
  if (agg.failReasons.size) {
    lines.push('## top fail reasons (source/tier:reason)');
    for (const [key, count] of topN(agg.failReasons, 10)) {
      lines.push(`  ${String(count).padStart(5)}× ${key}`);
    }
    lines.push('');
  }

  // Top failing URLs.
  if (agg.topUrlsByFailCount.size) {
    lines.push('## top failing URLs');
    for (const [url, count] of topN(agg.topUrlsByFailCount, 8)) {
      lines.push(`  ${String(count).padStart(5)}× ${url}`);
    }
    lines.push('');
  }

  // Latency P50 per tier (where the sample is meaningful).
  const lat = Object.entries(agg.latencyP50)
    .map(([tier, samples]) => [tier, p50(samples), samples.length])
    .filter(([, p]) => p !== null);
  if (lat.length) {
    lines.push('## latency P50 (ms) by tier');
    for (const [tier, p, n] of lat) {
      lines.push(`  ${tier.padEnd(12)} P50=${p}ms  (n=${n})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function emitRaw(entries) {
  for (const e of entries) {
    process.stdout.write(JSON.stringify(e) + '\n');
  }
}

function helpText() {
  return [
    'inspect-search-trail — aggregate stats over Phase 2 search-trail JSONL.',
    '',
    'Usage:',
    '  node scripts/inspect-search-trail.js                            # today',
    '  node scripts/inspect-search-trail.js --day=YYYY-MM-DD',
    '  node scripts/inspect-search-trail.js --days=N                   # last N days merged',
    '  node scripts/inspect-search-trail.js --source=url-fetch|social-link|web-search',
    '  node scripts/inspect-search-trail.js --status=ok|fail|aborted|missed',
    '  node scripts/inspect-search-trail.js --raw                      # emit filtered JSONL, no aggregation',
    '',
    'Prerequisite:',
    '  Set MELO_SEARCH_TRAIL_LOG=1 on the long-running CLI / server before searches.',
    '  Files land in $MELO_HOME/desktop/search-trail-log/YYYY-MM-DD.jsonl.',
    '',
    'Examples:',
    '  # one-week summary of failures:',
    '  node scripts/inspect-search-trail.js --days=7 --status=fail',
    '  # dump raw failed url-fetches for jq pipelining:',
    '  node scripts/inspect-search-trail.js --raw --source=url-fetch --status=fail | jq .',
  ].join('\n');
}

// ─── main ─────────────────────────────────────────────────────────────────────

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(helpText() + '\n');
    return;
  }

  let files;
  try {
    files = pickDayFiles(opts);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err.message);
    process.exit(1);
  }

  const filtered = [];
  for (const e of readEntries(files)) {
    if (passesFilter(e, opts)) filtered.push(e);
  }

  if (opts.raw) {
    emitRaw(filtered);
    return;
  }
  process.stdout.write(render(aggregate(filtered), opts, files) + '\n');
}

main();
