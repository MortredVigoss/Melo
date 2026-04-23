/**
 * src/memory/statusFormat.js
 *
 * Phase 4 — presentation layer for the memory-status snapshot.
 *
 * Split out of scripts/memory-status.js so:
 *   1. Flag parsing + text formatting are unit-testable without shelling out.
 *   2. Any other tool (a future `melo doctor`, a log-aggregator sink, etc.)
 *      can reuse the same formatters.
 *
 * Keep this module pure: no fs, no process.exit, no network.  It takes a
 * snapshot and returns strings.
 */

export const STATUS_SECTIONS = Object.freeze([
  'store',
  'meta',
  'embedding',
  'tuning',
  'dreams',
]);

const DEFAULT_SECTIONS = STATUS_SECTIONS;

const HELP_TEXT = `
Usage:
  node scripts/memory-status.js [options]

Options:
  --json           Emit machine-readable JSON (includes schemaVersion).
  --live           Probe the configured embedding provider and surface
                   drift (stored modelId vs. live modelId).  Involves a
                   network call when provider=ollama/openai.
  --meta           Only print the _meta section.
  --dreams         Only print the dreams section.
  --sections=a,b   Comma-separated subset of: ${STATUS_SECTIONS.join(', ')}.
  --help, -h       Show this help.

Defaults: text output, all sections, no live probe.
`.trim();

/**
 * Parse argv (process.argv.slice(2) style) into a normalized options bag.
 * Unknown flags are silently ignored — the CLI never hard-errors on typos,
 * it just shows help when asked.
 */
export function parseStatusFlags(argv) {
  const flags = {
    json: false,
    live: false,
    help: false,
    sections: DEFAULT_SECTIONS,
  };
  const selected = new Set();
  let explicitSections = false;

  for (const raw of argv) {
    const arg = String(raw || '');
    if (arg === '--json') flags.json = true;
    else if (arg === '--live') flags.live = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--meta') { selected.add('meta'); explicitSections = true; }
    else if (arg === '--dreams') { selected.add('dreams'); explicitSections = true; }
    else if (arg.startsWith('--sections=')) {
      const value = arg.slice('--sections='.length);
      for (const name of value.split(',').map(s => s.trim()).filter(Boolean)) {
        if (STATUS_SECTIONS.includes(name)) selected.add(name);
      }
      explicitSections = true;
    }
  }

  if (explicitSections) {
    // Preserve canonical order rather than insertion order so output is stable.
    flags.sections = STATUS_SECTIONS.filter(s => selected.has(s));
  }
  return flags;
}

export function getHelpText() {
  return HELP_TEXT;
}

export function fmtBytes(n) {
  if (n == null) return 'n/a';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtRelTime(ms, now = Date.now()) {
  if (ms == null) return 'n/a';
  const age = now - ms;
  const s = Math.floor(age / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Build the drift banner (multi-line string) or return '' if no drift.
 *
 * We show it twice-over: as a loud header when text-mode output, and
 * inside the embedding section.  Returning '' when there's no drift lets
 * callers concatenate unconditionally.
 */
export function formatDriftBanner(drift) {
  if (!drift || !drift.hasDrift) return '';
  const stored = drift.stored || '?';
  const live = drift.inferredProvider || '?';
  return [
    '!! EMBEDDING MODEL DRIFT',
    `   stored = ${stored}`,
    `   live   = ${live}`,
    '   Old vectors were written by a different model; recall quality may degrade.',
    '   Resolve by wiping + re-embedding (UI → Customize → Memory → Wipe embeddings,',
    '   or POST /api/memory/wipe-embeddings).',
  ].join('\n');
}

function renderStoreSection(snap) {
  const lines = [];
  lines.push(`MELO_HOME        ${snap.meloHome}`);
  lines.push(`store.sqlite     ${snap.store.path}`);
  lines.push(`  exists         ${snap.store.exists ? 'yes' : 'no'}`);
  lines.push(`  size           ${fmtBytes(snap.store.sizeBytes)}`);
  if (snap.store.openError) lines.push(`  open error     ${snap.store.openError}`);
  lines.push('');
  lines.push('row counts');
  lines.push(`  memories         ${snap.counts.memories ?? 'n/a'}`);
  lines.push(`  memories_fts     ${snap.counts.memoriesFts ?? 'n/a'}`);
  lines.push(`  vec_memories     ${snap.counts.vecMemories ?? 'n/a'}`);
  lines.push(`  embedding_cache  ${snap.counts.embeddingCache ?? 'n/a'}`);
  return lines.join('\n');
}

function renderMetaSection(snap) {
  const lines = ['_meta'];
  if (!snap.meta) {
    lines.push('  (unavailable — _meta table not populated yet)');
  } else if (Object.keys(snap.meta).length === 0) {
    lines.push('  (empty)');
  } else {
    for (const [k, v] of Object.entries(snap.meta)) {
      lines.push(`  ${k.padEnd(20)} ${v}`);
    }
  }
  return lines.join('\n');
}

function renderEmbeddingSection(snap) {
  const lines = ['embedding'];
  lines.push(`  provider         ${snap.embedding.provider}`);
  lines.push(`  dims (configured) ${snap.embedding.dimsConfigured}`);
  const storedModelId = snap.embedding.storedModelId;
  lines.push(`  model (stored)   ${storedModelId || '(not yet recorded)'}`);
  const drift = snap.embedding.drift || {};
  const liveLabel = drift.inferredProvider
    ? drift.inferredProvider
    : drift.probeAttempted
      ? '(provider unavailable)'
      : '(probe skipped — pass --live)';
  lines.push(`  model (live)     ${liveLabel}`);
  if (drift.hasDrift) {
    lines.push(`  [!] drift: stored≠live (see banner at top)`);
  }
  const vecDimsRaw = snap.meta?.embedding_dims;
  if (vecDimsRaw && Number(vecDimsRaw) !== snap.embedding.dimsConfigured) {
    lines.push(`  [!] _meta.embedding_dims=${vecDimsRaw} differs from configured ${snap.embedding.dimsConfigured}`);
  }
  return lines.join('\n');
}

function renderTuningSection(snap) {
  return [
    'tuning (effective)',
    `  MMR λ            ${snap.tuning.mmrLambda}  (MELO_MMR_LAMBDA)`,
    `  recency half-life ${snap.tuning.recencyHalfLifeDays}d (MELO_RECENCY_HALF_LIFE_DAYS)`,
  ].join('\n');
}

function renderDreamsSection(snap, now) {
  const lines = ['dreams'];
  lines.push(`  dir              ${snap.dreams.dir}`);
  lines.push(`  count            ${snap.dreams.count}`);
  if (!snap.dreams.latest) {
    lines.push('  latest           (no DREAMS found)');
  } else {
    const l = snap.dreams.latest;
    lines.push(`  latest           ${l.name}`);
    lines.push(`  last written     ${fmtRelTime(l.mtimeMs, now)} (${new Date(l.mtimeMs).toISOString()})`);
  }
  return lines.join('\n');
}

const SECTION_RENDERERS = {
  store: renderStoreSection,
  meta: renderMetaSection,
  embedding: renderEmbeddingSection,
  tuning: renderTuningSection,
  dreams: renderDreamsSection,
};

/**
 * Full text rendering.  `sections` restricts which blocks appear; the
 * header + drift banner are always shown if applicable.
 *
 * `now` is an injectable clock for deterministic tests.
 */
export function formatText(snap, { sections = DEFAULT_SECTIONS, now = Date.now() } = {}) {
  const parts = [];
  parts.push('── Melo memory status ─────────────────────────────');
  const banner = formatDriftBanner(snap.embedding?.drift);
  if (banner) {
    parts.push(banner);
    parts.push('');
  }
  for (const name of sections) {
    const render = SECTION_RENDERERS[name];
    if (!render) continue;
    parts.push(render(snap, now));
    parts.push('');
  }
  parts.push('───────────────────────────────────────────────────');
  return parts.filter((v, i, arr) => !(v === '' && arr[i - 1] === '')).join('\n');
}
