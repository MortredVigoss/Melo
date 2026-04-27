#!/usr/bin/env node
/**
 * scripts/bench-memory.js
 *
 * Recall@k benchmark for `recallMemoriesTiered`.  Reads a golden set of
 * (query → expected memory) pairs and reports hit rates so the
 * `Memory-Redesign-Proposal.md` Phase C "top-5 ≥ 85%" claim becomes a
 * runnable check rather than a paper goal.
 *
 * See `bench/memory/README.md` for the schema and authoring guide.
 *
 * Usage:
 *   node scripts/bench-memory.js                       # default golden + markdown report
 *   node scripts/bench-memory.js --golden path/to.json
 *   node scripts/bench-memory.js --no-embed            # force keyword fallback
 *   node scripts/bench-memory.js --validate            # run Stage-4 validator too
 *   node scripts/bench-memory.js --threshold-recall5 0.85  # CI gate
 *   node scripts/bench-memory.js --json                # JSON instead of markdown
 *   node scripts/bench-memory.js --out path/to.md      # override output path
 *
 * Exit codes:
 *   0  bench ran (and met threshold if one was set)
 *   1  config error (missing golden / store / args)
 *   2  threshold not met (only when --threshold-recall5 is given)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Capture env up front so async work below can't observe a different home.
// (CLAUDE.md §6 — async tasks must not re-read process.env after scheduling.)
const ENV = Object.freeze({
  meloHome: process.env.MELO_HOME || null,
  offlineOnly: process.env.MELO_OFFLINE_ONLY === '1',
  embedProvider: process.env.MELO_EMBED_PROVIDER || null,
  cwd: process.cwd(),
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// ─── CLI parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    golden: join(projectRoot, 'bench', 'memory', 'golden.json'),
    out: null,
    json: false,
    noEmbed: false,
    validate: false,
    thresholdRecall5: null,
    ks: [1, 5, 10],
    sceneLimit: 3,
    frameLimit: 8,
    contentLimit: 12,
    rank: 'tier',
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const eat = () => argv[++i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--no-embed') args.noEmbed = true;
    else if (a === '--validate') args.validate = true;
    else if (a === '--golden') args.golden = eat();
    else if (a.startsWith('--golden=')) args.golden = a.slice('--golden='.length);
    else if (a === '--out') args.out = eat();
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
    else if (a === '--threshold-recall5') args.thresholdRecall5 = Number(eat());
    else if (a.startsWith('--threshold-recall5=')) args.thresholdRecall5 = Number(a.slice('--threshold-recall5='.length));
    else if (a === '--ks') args.ks = String(eat()).split(',').map(n => Number(n.trim())).filter(Number.isFinite);
    else if (a.startsWith('--ks=')) args.ks = String(a.slice('--ks='.length)).split(',').map(n => Number(n.trim())).filter(Number.isFinite);
    else if (a === '--rank') args.rank = String(eat() || '').toLowerCase();
    else if (a.startsWith('--rank=')) args.rank = a.slice('--rank='.length).toLowerCase();
    else {
      console.error(`Unknown argument: ${a}`);
      args.help = true;
    }
  }
  if (args.rank !== 'tier' && args.rank !== 'global') {
    console.error(`Unknown --rank value: ${args.rank} (use 'tier' or 'global')`);
    args.help = true;
  }
  return args;
}

const HELP = `
Usage: node scripts/bench-memory.js [options]

Options:
  --golden <path>            Golden set JSON (default: bench/memory/golden.json)
  --out <path>               Markdown output (default: bench/memory/results-YYYY-MM-DD.md)
  --json                     Print machine-readable JSON to stdout instead of markdown
  --no-embed                 Skip embeddings; force the keyword fallback path
  --validate                 Run Stage-4 validation (default: bypass to isolate recall layer)
  --ks 1,5,10                Comma-separated k values for Recall@k (default: 1,5,10)
  --rank tier|global         How to merge scene/frame/content for top-k.
                             tier (default) mirrors the production injection
                             order (scene → frame → content with each tier
                             keeping its own score-sorted ranking); global
                             pools across tiers and sorts by score, useful
                             when comparing against a flat-ANN baseline.
  --threshold-recall5 0.85   Exit 2 if Recall@5 < threshold
  --help                     Show this message
`.trim();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function loadGolden(path) {
  if (!existsSync(path)) {
    fail(
      `golden set not found: ${path}\n` +
      `→ copy bench/memory/golden.example.json to ${path} and fill in real queries.\n` +
      `   See bench/memory/README.md for the schema.`,
    );
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`failed to read ${path}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`golden set is not valid JSON: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.queries) || parsed.queries.length === 0) {
    fail(`golden set has no queries (parsed.queries must be a non-empty array)`);
  }
  return parsed;
}

function isHit(row, expectedIds, expectedSubstrings) {
  if (!row) return false;
  if (Array.isArray(expectedIds) && expectedIds.length && expectedIds.includes(row.id)) {
    return true;
  }
  if (!Array.isArray(expectedSubstrings) || !expectedSubstrings.length) return false;
  // Recall paths return rows with either `searchText` (after `touchRows`
  // mapping in store.js) or `search_text` (raw DB column).  Cover both so
  // the bench works regardless of which path the recall fell through.
  const hay = `${row.searchText || row.search_text || ''}\n${row.text || ''}`.toLowerCase();
  return expectedSubstrings.some(s => hay.includes(String(s).toLowerCase()));
}

/**
 * Merge scenes/frames/contents into one ranked list.
 *
 * Two modes:
 *
 *   - 'tier' (default) — concatenate scene → frame → content, preserving
 *     each tier's own score ordering.  This mirrors how
 *     `recallMemoriesTiered` callers actually consume the result: the
 *     desktop store injects scene blocks first, then frames, then
 *     contents.  A Recall@k computed on this ordering is what production
 *     downstream code sees.
 *
 *   - 'global' — pool everything and resort by `score` descending.  Useful
 *     when comparing against a flat-ANN baseline (a single collection
 *     ranked purely by similarity).  NOT representative of production
 *     consumption order.
 */
function mergeRanked(tiered, mode = 'tier') {
  if (mode === 'global') {
    const all = [];
    for (const r of tiered.scenes || [])   all.push({ ...r, _tier: 'scene' });
    for (const r of tiered.frames || [])   all.push({ ...r, _tier: 'frame' });
    for (const r of tiered.contents || []) all.push({ ...r, _tier: 'content' });
    all.sort((a, b) => (b.score || 0) - (a.score || 0));
    return all;
  }
  // tier mode
  return [
    ...(tiered.scenes || []).map(r => ({ ...r, _tier: 'scene' })),
    ...(tiered.frames || []).map(r => ({ ...r, _tier: 'frame' })),
    ...(tiered.contents || []).map(r => ({ ...r, _tier: 'content' })),
  ];
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  const golden = loadGolden(args.golden);
  const ks = args.ks.length ? args.ks : [1, 5, 10];

  // Lazy-import store/embedding modules so --help / argparse don't open the DB.
  const { recallMemoriesTiered, memoryStats } = await import('../src/memory/store.js');
  const { getEmbedding } = await import('../src/memory/embeddings.js');

  // Probe the store; surface a friendly error if it's empty.
  let stats = null;
  try {
    stats = memoryStats();
  } catch (err) {
    fail(`failed to open memory store (MELO_HOME=${ENV.meloHome ?? '~/.melo'}): ${err.message}`);
  }
  const totalRows = stats?.totalMemories || 0;
  if (totalRows === 0) {
    fail(
      `memory store is empty (MELO_HOME=${ENV.meloHome ?? '~/.melo'}).\n` +
      `→ run Melo for a while so messages, frames, and scenes get persisted, then re-run.`,
    );
  }

  const startedAt = new Date().toISOString();

  // Probe embedding provider once so the report can declare the recall path.
  let embeddingActive = false;
  let embeddingNote = '';
  if (args.noEmbed) {
    embeddingNote = '--no-embed: forced keyword fallback';
  } else {
    try {
      const probe = await getEmbedding('bench probe');
      embeddingActive = !!(probe && probe.length);
      if (!embeddingActive) embeddingNote = 'embedding provider returned null (keyword fallback)';
    } catch (err) {
      embeddingNote = `embedding probe failed: ${err.message} (keyword fallback)`;
    }
  }

  const perQuery = [];
  for (const q of golden.queries) {
    const tStart = Date.now();
    let queryEmbedding = null;
    if (embeddingActive) {
      try {
        queryEmbedding = await getEmbedding(q.query);
      } catch (err) {
        queryEmbedding = null;
      }
    }
    let tiered;
    try {
      tiered = recallMemoriesTiered({
        namespaces: q.namespaces || [],
        query: q.query,
        queryEmbedding,
        limits: { scenes: args.sceneLimit, frames: args.frameLimit, contents: args.contentLimit },
        validate: args.validate,
      });
    } catch (err) {
      perQuery.push({
        id: q.id,
        query: q.query,
        error: err.message,
        latencyMs: Date.now() - tStart,
      });
      continue;
    }
    const ranked = mergeRanked(tiered, args.rank);
    const hitsAtK = {};
    for (const k of ks) {
      hitsAtK[k] = ranked.slice(0, k).some(r => isHit(r, q.expectedIds, q.expectedSubstrings));
    }

    // Per-kind hit at the kind-specific limit (top-3 / top-8 / top-12).
    const sceneHit = (tiered.scenes || []).slice(0, args.sceneLimit).some(r => isHit(r, q.expectedIds, q.expectedSubstrings));
    const frameHit = (tiered.frames || []).slice(0, args.frameLimit).some(r => isHit(r, q.expectedIds, q.expectedSubstrings));
    const contentHit = (tiered.contents || []).slice(0, args.contentLimit).some(r => isHit(r, q.expectedIds, q.expectedSubstrings));

    perQuery.push({
      id: q.id,
      query: q.query,
      tags: q.tags || [],
      latencyMs: Date.now() - tStart,
      counts: {
        scenes: (tiered.scenes || []).length,
        frames: (tiered.frames || []).length,
        contents: (tiered.contents || []).length,
      },
      kindHits: { scene: sceneHit, frame: frameHit, content: contentHit },
      hitsAtK,
      // Keep a slim trace for misses; full rows are noisy and may leak.
      topIds: ranked.slice(0, Math.max(...ks)).map(r => ({ id: r.id, kind: r.kind, score: r.score })),
    });
  }

  // ─── Aggregate ─────────────────────────────────────────────────────────────
  const total = perQuery.length;
  const errors = perQuery.filter(r => r.error);
  const valid = perQuery.filter(r => !r.error);
  const recallAtK = {};
  for (const k of ks) {
    const hit = valid.filter(r => r.hitsAtK?.[k]).length;
    recallAtK[k] = { hit, total: valid.length, rate: valid.length ? hit / valid.length : 0 };
  }
  const kindHitTotals = {
    scene: valid.filter(r => r.kindHits?.scene).length,
    frame: valid.filter(r => r.kindHits?.frame).length,
    content: valid.filter(r => r.kindHits?.content).length,
  };
  const meanLatency = valid.length
    ? valid.reduce((acc, r) => acc + (r.latencyMs || 0), 0) / valid.length
    : 0;

  const report = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    goldenPath: args.golden,
    goldenVersion: golden.version,
    queries: total,
    errors: errors.length,
    embedding: {
      requested: !args.noEmbed,
      active: embeddingActive,
      note: embeddingNote || null,
      provider: ENV.embedProvider,
    },
    storeRows: totalRows,
    storeByKind: stats?.byKind || {},
    storeByAttic: stats?.byAttic || {},
    vecAvailable: !!stats?.vecAvailable,
    config: {
      ks,
      limits: { scenes: args.sceneLimit, frames: args.frameLimit, contents: args.contentLimit },
      validate: args.validate,
      offlineOnly: ENV.offlineOnly,
      rank: args.rank,
    },
    recallAtK,
    kindHitTotals,
    meanLatencyMs: Number(meanLatency.toFixed(2)),
    perQuery,
  };

  // ─── Emit ──────────────────────────────────────────────────────────────────
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    const md = renderMarkdown(report);
    const outPath = args.out || join(projectRoot, 'bench', 'memory', `results-${todayStamp()}.md`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, md, 'utf8');
    console.log(md);
    console.log(`\nReport written to ${outPath}`);
  }

  if (Number.isFinite(args.thresholdRecall5)) {
    const r5 = recallAtK[5]?.rate ?? 0;
    if (r5 + 1e-9 < args.thresholdRecall5) {
      console.error(`\nRecall@5 ${(r5 * 100).toFixed(1)}% < threshold ${(args.thresholdRecall5 * 100).toFixed(1)}%`);
      process.exit(2);
    }
  }
}

function pct(n, d) {
  if (!d) return '0.0%';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Memory Bench — ${report.startedAt}`);
  lines.push('');
  const kindBits = Object.entries(report.storeByKind || {})
    .map(([k, n]) => `${k}=${n}`).join(' ');
  lines.push(`Golden set: \`${report.goldenPath}\` (version ${report.goldenVersion}) · ` +
             `Store rows: ${report.storeRows}${kindBits ? ` (${kindBits})` : ''} · ` +
             `vec: ${report.vecAvailable ? 'available' : 'unavailable'}`);
  // Recall path is "ANN primary" only when BOTH the embedding provider
  // returned a vector AND the on-disk vec_memories index is loadable.  An
  // embedding-available + vec-unavailable combo (sqlite-vec extension
  // failed to load, or the table is missing) silently degrades to keyword
  // scoring inside `recallMemoriesTiered`; reporting "ANN" in that case
  // would make a regression invisible.
  let recallPath;
  let recallNote = report.embedding.note || null;
  if (report.embedding.active && report.vecAvailable) {
    recallPath = 'embedding (ANN) primary';
  } else if (report.embedding.active && !report.vecAvailable) {
    recallPath = 'keyword fallback';
    const extra = 'embedding ready but vec_memories unavailable';
    recallNote = recallNote ? `${extra}; ${recallNote}` : extra;
  } else {
    recallPath = 'keyword fallback';
  }
  lines.push(`Recall path: **${recallPath}**${recallNote ? ` — ${recallNote}` : ''}`);
  lines.push(`Limits: scenes=${report.config.limits.scenes}, frames=${report.config.limits.frames}, contents=${report.config.limits.contents} · validate=${report.config.validate} · rank=${report.config.rank}`);
  lines.push('');
  lines.push('## Recall@k');
  lines.push('');
  lines.push('| k | hit | total | rate |');
  lines.push('|---|-----|-------|------|');
  for (const k of report.config.ks) {
    const r = report.recallAtK[k];
    lines.push(`| ${k} | ${r.hit} | ${r.total} | ${pct(r.hit, r.total)} |`);
  }
  lines.push('');
  lines.push('## Per-kind hit rate');
  lines.push('');
  lines.push('| kind | hits | rate | top-k limit |');
  lines.push('|------|------|------|-------------|');
  const validTotal = report.queries - report.errors;
  lines.push(`| scene   | ${report.kindHitTotals.scene}   | ${pct(report.kindHitTotals.scene, validTotal)}   | ${report.config.limits.scenes} |`);
  lines.push(`| frame   | ${report.kindHitTotals.frame}   | ${pct(report.kindHitTotals.frame, validTotal)}   | ${report.config.limits.frames} |`);
  lines.push(`| content | ${report.kindHitTotals.content} | ${pct(report.kindHitTotals.content, validTotal)} | ${report.config.limits.contents} |`);
  lines.push('');
  lines.push(`Mean recall latency: ${report.meanLatencyMs} ms`);
  lines.push('');

  // Misses + errors detail
  const misses = report.perQuery.filter(r => !r.error && !r.hitsAtK?.[5]);
  if (misses.length) {
    lines.push('## Misses (Recall@5 = 0)');
    lines.push('');
    for (const m of misses) {
      lines.push(`### \`${m.id}\``);
      lines.push(`- query: \`${m.query}\``);
      lines.push(`- tags: ${m.tags?.length ? m.tags.join(', ') : '(none)'}`);
      lines.push(`- counts: ${m.counts.scenes}/${m.counts.frames}/${m.counts.contents} (s/f/c)`);
      lines.push(`- top-${Math.max(...report.config.ks)} ids:`);
      for (const r of (m.topIds || []).slice(0, 5)) {
        lines.push(`  - \`${r.id}\` (${r.kind}, score ${Number(r.score || 0).toFixed(3)})`);
      }
      lines.push('');
    }
  }

  if (report.errors) {
    lines.push('## Errors');
    lines.push('');
    for (const e of report.perQuery.filter(r => r.error)) {
      lines.push(`- \`${e.id}\`: ${e.error}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
