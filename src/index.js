#!/usr/bin/env node

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { argv } from 'node:process';
import {
  DEFAULT_CONFIG,
  VALID_AUTH_MODES,
  getConfigPath,
  getMeloHome,
  getResolvedConfig,
  loadConfig,
  maskApiKey,
  updateConfig,
} from './config.js';
import { createOpenAICompatibleReply } from './openai.js';
import { webSearchTool, checkSearchHealth, getCacheStats, clearCache } from './tools/builtins/webSearchTool.js';
import { searchHistoryTool } from './tools/builtins/searchHistoryTool.js';
import { draftSkillFromConversation } from './agents/skillDrafting.js';
import { createCustomSkill } from './desktopStore.js';
import { cleanupStalePlaywrightDaemons } from './web/playwrightFetcher.js';

// Codex C fix #11 (review #12, 2026-05-04): CLI mode cleanup. melo
// CLI tasks like `melo search` spawn Playwright daemons via
// webSearchTool. Without a SIGINT/SIGTERM hook the daemons survive
// CLI exit (Ctrl-C / kill) until the next melo start runs the
// startup cleanup. Hook here is purely additive — server mode
// (started via `npm start`) goes through server.js's shutdown()
// and never reaches CLI's signal handlers.
//
// Why both startup-cleanup AND signal-cleanup:
//   - startup cleanup at module-load reaps daemons from PRIOR runs
//     (covers crashes / SIGKILL).
//   - signal cleanup here reaps daemons from THIS run before the
//     CLI exits (covers Ctrl-C / kill TERM during search).
function _cliCleanup(exitCode) {
  try { cleanupStalePlaywrightDaemons(); } catch {}
  process.exit(exitCode);
}
process.once('SIGINT', () => _cliCleanup(130));
process.once('SIGTERM', () => _cliCleanup(143));

// Codex P2 (review #11/#12, 2026-05-04): uncaughtException /
// unhandledRejection emergency-exit. Same rationale as server.js:
// state is untrusted, do SYNC cleanup only (execSync pkill) + exit
// immediately. Without this, Node 19+ default behavior is exit on
// unhandled rejection — and our cleanupStalePlaywrightDaemons
// startup hook on the NEXT melo run reaps any leaked daemons.
// Adding the hook here moves cleanup to THIS run, no waiting.
function _cliEmergencyExit(label, errorObj) {
  try { process.stderr.write(`[melo-cli] ${label}: ${errorObj?.stack || errorObj}\n`); } catch {}
  try { cleanupStalePlaywrightDaemons(); } catch {}
  process.exit(1);
}
process.on('uncaughtException', err => _cliEmergencyExit('uncaughtException', err));
process.on('unhandledRejection', reason => _cliEmergencyExit('unhandledRejection', reason));

function printHelp() {
  output.write(
    [
      'Melo Local',
      '',
      'Commands:',
      '  melo                        Start interactive chat',
      '  melo chat "<prompt>"        Send one prompt',
      '  melo search "<query>"       Run a web search (flags: --json, --num N, --no-cache)',
      '  melo search --cache stats   Show search-cache stats (rows, freshness, size)',
      '  melo search --cache clear   Clear all caches (also: clear-search | clear-url | clear-stale)',
      '  melo history "<query>"      Search past conversation history (flags: --json, --limit N)',
      '  melo memory status          Show memory store snapshot (counts, tiers, dreams, drift)',
      '  melo memory consolidate     Run dreaming sweep now (flags: --full, --json)',
      '  melo doctor                 Show local runtime + search subsystem status',
      '  melo config show            Show resolved config',
      `  melo config set <k> <v>     Set authMode (${VALID_AUTH_MODES.join(' | ')}) | apiKey | model | baseUrl | systemPrompt`,
      '',
      'Interactive shortcuts:',
      '  /help                       Show help',
      '  /config                     Show resolved config',
      '  /search <query>             Run web search inline',
      '  /history <query>            Search past conversations inline',
      '  /save-as-skill [hint]       Draft a reusable skill from the recent conversation',
      '  /exit                       Quit Melo',
      '',
    ].join('\n'),
  );
}

// ─── Arg parsing helpers (exported for tests) ───────────────────────────────
//
// Keep parsing dumb, positional, and tolerant of flag order — the CLI isn't
// user-scripted often enough to justify a dep on yargs/commander.

export function parseSearchArgs(args) {
  const out = { query: '', num: undefined, json: false, noCache: false, cache: null };
  const positional = [];
  const VALID_CACHE_ACTIONS = new Set(['stats', 'clear', 'clear-search', 'clear-url', 'clear-stale']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (a === '--no-cache') out.noCache = true;
    else if (a === '--num' || a === '-n') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v < 1) throw new Error(`Invalid --num value: ${args[i]}`);
      out.num = Math.floor(v);
    } else if (a.startsWith('--num=')) {
      const v = Number(a.slice('--num='.length));
      if (!Number.isFinite(v) || v < 1) throw new Error(`Invalid --num value: ${a}`);
      out.num = Math.floor(v);
    } else if (a === '--cache') {
      const action = args[++i];
      if (!action || !VALID_CACHE_ACTIONS.has(action)) {
        throw new Error(`Invalid --cache action: ${action ?? '(missing)'}. Expected one of: ${[...VALID_CACHE_ACTIONS].join(', ')}`);
      }
      out.cache = action;
    } else if (a.startsWith('--cache=')) {
      const action = a.slice('--cache='.length);
      if (!VALID_CACHE_ACTIONS.has(action)) {
        throw new Error(`Invalid --cache action: ${action}. Expected one of: ${[...VALID_CACHE_ACTIONS].join(', ')}`);
      }
      out.cache = action;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag for melo search: ${a}`);
    } else {
      positional.push(a);
    }
  }
  out.query = positional.join(' ').trim();
  return out;
}

export function parseHistoryArgs(args) {
  const out = { query: '', limit: undefined, json: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (a === '--limit' || a === '-l') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v < 1) throw new Error(`Invalid --limit value: ${args[i]}`);
      out.limit = Math.floor(v);
    } else if (a.startsWith('--limit=')) {
      const v = Number(a.slice('--limit='.length));
      if (!Number.isFinite(v) || v < 1) throw new Error(`Invalid --limit value: ${a}`);
      out.limit = Math.floor(v);
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag for melo history: ${a}`);
    } else {
      positional.push(a);
    }
  }
  out.query = positional.join(' ').trim();
  return out;
}

// ─── Search / history command handlers ──────────────────────────────────────

async function runSearchCommand(args) {
  const parsed = parseSearchArgs(args);

  // --cache subcommand: stats | clear | clear-search | clear-url | clear-stale
  if (parsed.cache) {
    await runSearchCacheCommand(parsed.cache, parsed.json);
    return;
  }

  const { query, num, json, noCache } = parsed;
  if (!query) {
    throw new Error('Usage: melo search "<query>" [--json] [--num N] [--no-cache]  |  melo search --cache stats|clear');
  }

  const signal = AbortSignal.timeout(30_000);
  const result = await webSearchTool.run(
    { query, num_results: num ?? 5, noCache },
    { signal },
  );

  if (json) {
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    output.write(`${result.output}\n`);
    if (result.meta?.timings) {
      const t = result.meta.timings;
      const cacheTag = t.cacheHit ? ' [cache hit]' : t.weatherFastPath ? ' [wttr.in]' : '';
      output.write(`\n— ${t.totalMs}ms total (serp ${t.serpMs}ms, content ${t.contentMs}ms)${cacheTag}\n`);
    }
  }

  if (!result.ok) process.exitCode = 1;
}

function formatAge(ms) {
  if (ms == null) return 'n/a';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

async function runSearchCacheCommand(action, json) {
  if (action === 'stats') {
    const stats = await getCacheStats();
    if (json) {
      output.write(`${JSON.stringify(stats, null, 2)}\n`);
      return;
    }
    if (!stats.exists) {
      output.write(`Search cache: not yet created (${stats.path})\n`);
      return;
    }
    const kb = (stats.sizeBytes / 1024).toFixed(1);
    output.write(`Search cache @ ${stats.path} (${kb} KB)\n\n`);
    output.write(`  SERP cache (web_search_cache)\n`);
    output.write(`    rows         ${stats.searchCache.rows} total, ${stats.searchCache.freshRows} fresh (TTL ${Math.round(stats.searchTtlMs / 60_000)} min)\n`);
    output.write(`    newest       ${formatAge(stats.searchCache.newestAgeMs)}\n`);
    output.write(`    oldest       ${formatAge(stats.searchCache.oldestAgeMs)}\n\n`);
    output.write(`  URL content cache (url_content_cache)\n`);
    output.write(`    rows         ${stats.urlCache.rows} total, ${stats.urlCache.freshRows} fresh (TTL ${Math.round(stats.urlTtlMs / 60_000)} min)\n`);
    output.write(`    newest       ${formatAge(stats.urlCache.newestAgeMs)}\n`);
    output.write(`    oldest       ${formatAge(stats.urlCache.oldestAgeMs)}\n`);
    return;
  }

  // Map CLI action to library scope
  const scope = action === 'clear'
    ? 'all'
    : action === 'clear-search' ? 'search'
      : action === 'clear-url' ? 'url'
        : action === 'clear-stale' ? 'stale'
          : 'all';
  const result = clearCache(scope);
  if (json) {
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    output.write(`Cleared ${result.deleted} cache row(s) (scope=${result.scope}).\n`);
  } else {
    output.write(`Cache clear failed: ${result.error}\n`);
    process.exitCode = 1;
  }
}

async function runHistoryCommand(args) {
  const { query, limit, json } = parseHistoryArgs(args);
  if (!query) {
    throw new Error('Usage: melo history "<query>" [--json] [--limit N]');
  }
  const result = await searchHistoryTool.run({ query, limit: limit ?? 8 });
  if (json) {
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    output.write(`${result.output}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}

function printConfig(config) {
  output.write(
    [
      `provider      ${config.provider}`,
      `authMode      ${config.authMode}`,
      `baseUrl       ${config.baseUrl}`,
      `model         ${config.model}`,
      `apiKey        ${maskApiKey(config.apiKey)}`,
      `codexLogin    ${
        config.codexAuth?.loggedIn
          ? `${config.codexAuth.email || 'signed in'} (${config.codexAuth.plan || 'unknown'})`
          : 'not signed in'
      }`,
      `configPath    ${getConfigPath()}`,
      `meloHome      ${getMeloHome()}`,
      '',
    ].join('\n'),
  );
}

// ─── memory CLI ─────────────────────────────────────────────────────────────
//
// `melo memory status` — read-only snapshot: store path / counts / kind +
// attic distribution / dreams diary / embedding drift / tuning. Does not
// boot the embedding provider. Add `--json` for machine-readable output.
//
// `melo memory consolidate` — fire one dreaming sweep on the current
// store. `--full` overrides the incremental window; `--json` prints the
// sweep result. The same triggerDreamingNow path the Desktop UI's
// "Consolidate now" button (Phase 5) will eventually use.

function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

// Phase F follow-up (Codex 🔴 C 评级 2026-05-05): single-pass normalizer
// for `melo memory` args. Pulling --home as a global before the
// subcommand fixes (a) `melo memory --home <p> status` parsing as
// subcommand=--home, and (b) `--home --json` silently consuming --json
// as a path. Returns { sub, flags: Set, home: string|null }.
//
// Contract:
//   - `--home <value>` accepted ANY position (before sub, after sub,
//     between flags). Only one occurrence; second --home throws.
//   - The value MUST NOT begin with `--` — that's the "next flag"
//     guard. Documented as such; users wanting a literal `--something`
//     path can use `--home=/--literal/path` form, also supported.
//   - Boolean flags (`--json`, `--full`) collected into the Set.
//   - First non-flag arg is the subcommand.
export function parseMemoryArgs(rawArgs) {
  const flags = new Set();
  let sub = null;
  let home = null;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--home' || arg === '-H') {
      if (home !== null) {
        throw new Error('`--home` may only be specified once.');
      }
      const value = rawArgs[i + 1];
      if (value === undefined) {
        throw new Error('`--home` requires a path argument.');
      }
      if (value.startsWith('--') || value.startsWith('-')) {
        throw new Error(
          `\`--home\` requires a path argument, got "${value}" which looks like a flag. ` +
          `Use --home=<path> if your path actually starts with a dash.`,
        );
      }
      home = value;
      i += 1;
      continue;
    }
    // Long-form `--home=/path` — works for paths that start with `-`.
    if (arg.startsWith('--home=')) {
      if (home !== null) {
        throw new Error('`--home` may only be specified once.');
      }
      const value = arg.slice('--home='.length);
      if (!value) {
        throw new Error('`--home=` requires a non-empty path.');
      }
      home = value;
      continue;
    }
    if (arg.startsWith('--') || arg.startsWith('-')) {
      flags.add(arg);
      continue;
    }
    if (sub === null) {
      sub = arg;
      continue;
    }
    // Extra positional — keep as-is in flags so the subcommand handler
    // can decide; current subcommands take no positionals so this is
    // effectively unused, but avoids silently dropping data.
    flags.add(arg);
  }
  return { sub, flags, home };
}

async function runMemoryCommand(rawArgs) {
  let parsed;
  try {
    parsed = parseMemoryArgs(rawArgs);
  } catch (err) {
    throw err;
  }
  const { sub, flags, home } = parsed;

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h' || flags.has('--help') || flags.has('-h')) {
    output.write(
      [
        'melo memory <subcommand>',
        '',
        'Subcommands:',
        '  status              Print memory-store snapshot + tier distribution',
        '  consolidate         Run a dreaming sweep now',
        '  fill-embeddings     Generate embeddings for any memories that lack one',
        '',
        'Flags (any position):',
        '  --json              Emit raw JSON instead of formatted text',
        '  --full              (consolidate only) Run a full sweep, not incremental',
        '  --home <path>       Override MELO_HOME for this invocation. Required when',
        '                      the desktop app uses a non-default home — the Swift',
        '                      wrapper sets MELO_HOME to projectDir/.tmp/melo-home-user',
        '                      so a shell-launched `melo memory status` queries the',
        '                      wrong store unless --home is passed.',
        '                      Use --home=<path> form if your path begins with `-`.',
        '',
      ].join('\n'),
    );
    return;
  }

  if (home) {
    // Setting MELO_HOME here re-runs every downstream resolver
    // (getMeloHome, collectMemoryStatus, memory store path) against
    // the override before the subcommand handler imports them.
    process.env.MELO_HOME = home;
  } else {
    // Auto-detect hint when the user invokes `melo memory ...` from a
    // project root whose default home looks empty but
    // `./.tmp/melo-home-user/desktop/store.sqlite` does exist. Just
    // prints to stderr — does NOT auto-switch (that would mask
    // genuine MELO_HOME mistakes). See maybeWarnDifferentHome.
    await maybeWarnDifferentHome();
  }

  if (sub === 'status') {
    await runMemoryStatusCommand({ json: flags.has('--json') });
    return;
  }
  if (sub === 'consolidate') {
    await runMemoryConsolidateCommand({
      full: flags.has('--full'),
      json: flags.has('--json'),
    });
    return;
  }
  if (sub === 'fill-embeddings') {
    await runMemoryFillEmbeddingsCommand({ json: flags.has('--json') });
    return;
  }
  throw new Error(
    `Unknown memory subcommand: "${sub}". Run \`melo memory help\` for a list.`,
  );
}

async function maybeWarnDifferentHome() {
  // Walk up from cwd looking for a project root that ships
  // `.tmp/melo-home-user/desktop/store.sqlite` (the desktop wrapper's
  // runtime home — see desktop-app/main.swift). If that path exists AND
  // the resolved MELO_HOME doesn't have a store.sqlite, surface a hint
  // pointing the user at --home.
  //
  // Hint goes to STDERR, not stdout — `melo memory status --json` must
  // stay parseable for any pipe consumer (cron / dashboards / tests).
  const { existsSync } = await import('node:fs');
  const { dirname, join: pathJoin } = await import('node:path');
  const { getMeloHome: resolveMeloHome } = await import('./config.js');
  const resolvedHome = resolveMeloHome();
  const resolvedStore = pathJoin(resolvedHome, 'desktop', 'store.sqlite');
  if (existsSync(resolvedStore)) return; // resolved home has data — nothing to warn

  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { // walk up at most 6 levels
    const candidate = pathJoin(dir, '.tmp', 'melo-home-user', 'desktop', 'store.sqlite');
    if (existsSync(candidate)) {
      process.stderr.write(
        `note: resolved MELO_HOME=${resolvedHome} has no store.sqlite, but\n` +
        `      ${pathJoin(dir, '.tmp/melo-home-user')} does. The Melo desktop\n` +
        `      app stores data there. Re-run with --home ${pathJoin(dir, '.tmp/melo-home-user')}\n` +
        `      to inspect that store, or set MELO_HOME explicitly.\n\n`,
      );
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

async function runMemoryStatusCommand({ json = false } = {}) {
  const { collectMemoryStatus, probeEmbeddingProviderAvailability } = await import('./memory/status.js');
  const snapshot = collectMemoryStatus();
  // Phase F-2 (2026-05-05): probe live embedder so users can see why
  // vec_memories / embedding_cache are empty without grepping logs.
  // Bounded — Ollama isAvailable times out at 2s, OpenAI/HTTP are
  // env-only checks. Wrapped in try/catch so a network glitch never
  // breaks the status output.
  let embedderProbe = null;
  try {
    embedderProbe = await probeEmbeddingProviderAvailability();
  } catch (err) {
    embedderProbe = { available: null, modelId: null, dims: null, reasons: { _probe: String(err?.message || err) } };
  }
  // Phase E follow-up (Codex 🔴 P0 2026-05-05): byKind / byAttic now
  // come from the snapshot's readOnly DB handle. The previous
  // implementation called store.memoryStats() which goes through the
  // writable getDb() singleton — that ran `PRAGMA journal_mode = WAL`
  // on a "read-only status" command and produced store.sqlite-wal /
  // -shm files in the user's MELO_HOME on every status check. The
  // collectMemoryStatus path opens with `{ readOnly: true }` and never
  // writes a PRAGMA.

  if (json) {
    output.write(JSON.stringify({ snapshot, embedder: embedderProbe }, null, 2) + '\n');
    return;
  }

  output.write('Melo memory status\n\n');
  output.write(`MELO_HOME       ${snapshot.meloHome}\n`);
  output.write(`store path      ${snapshot.store.path}\n`);
  output.write(`store exists    ${snapshot.store.exists ? 'yes' : 'no'}\n`);
  if (snapshot.store.exists) {
    output.write(`store size      ${fmtBytes(snapshot.store.sizeBytes)}\n`);
  }
  if (snapshot.store.openError) {
    output.write(`open error      ${snapshot.store.openError}\n`);
  }
  output.write('\n');
  output.write('Counts:\n');
  output.write(`  memories       ${snapshot.counts.memories ?? '—'}\n`);
  output.write(`  memories_fts   ${snapshot.counts.memoriesFts ?? '—'}\n`);
  output.write(`  vec_memories   ${snapshot.counts.vecMemories ?? '—'}\n`);
  output.write(`  embed_cache    ${snapshot.counts.embeddingCache ?? '—'}\n`);

  if (snapshot.store.exists) {
    output.write('\nBy kind:\n');
    const byKind = snapshot.byKind || {};
    if (!Object.keys(byKind).length) {
      output.write('  (no rows yet)\n');
    } else {
      for (const [kind, n] of Object.entries(byKind)) {
        output.write(`  ${kind.padEnd(14)} ${n}\n`);
      }
    }
    output.write('\nBy attic level (Hot / Warm / Cold):\n');
    const byAttic = snapshot.byAttic || {};
    if (!Object.keys(byAttic).length) {
      output.write('  (no rows yet)\n');
    } else {
      for (const [level, n] of Object.entries(byAttic)) {
        output.write(`  ${String(level).padEnd(14)} ${n}\n`);
      }
    }
  }

  output.write(`\nDreams dir      ${snapshot.dreams.dir}\n`);
  output.write(`Dream files     ${snapshot.dreams.count}\n`);
  if (snapshot.dreams.latest) {
    output.write(`Latest dream    ${snapshot.dreams.latest.name}\n`);
  }

  output.write('\nEmbedding:\n');
  output.write(`  provider       ${snapshot.embedding.provider}\n`);
  output.write(`  dims (config)  ${snapshot.embedding.dimsConfigured}\n`);
  output.write(`  stored model   ${snapshot.embedding.storedModelId || '—'}\n`);
  if (snapshot.embedding.drift?.hasDrift) {
    output.write(`  drift          stored=${snapshot.embedding.drift.stored} live=${snapshot.embedding.drift.inferredProvider}\n`);
  }
  if (embedderProbe) {
    if (embedderProbe.available) {
      output.write(`  live provider  ${embedderProbe.available} (model=${embedderProbe.modelId || '?'}, dims=${embedderProbe.dims ?? '?'})\n`);
    } else {
      output.write(`  live provider  none — vec_memories will stay empty until a provider is set up\n`);
      const reasons = embedderProbe.reasons || {};
      for (const [name, why] of Object.entries(reasons)) {
        output.write(`    - ${name.padEnd(8)} ${why}\n`);
      }
    }
  }

  output.write('\nRecall tuning (env-overridable):\n');
  output.write(`  MELO_MMR_LAMBDA              ${snapshot.tuning.mmrLambda}\n`);
  output.write(`  MELO_RECENCY_HALF_LIFE_DAYS  ${snapshot.tuning.recencyHalfLifeDays}\n`);
}

async function runMemoryFillEmbeddingsCommand({ json = false } = {}) {
  // Phase F-2b (2026-05-05): manual trigger for the same backfill loop
  // sendChatMessage runs after each chat (scheduleEmbeddingFillIn).
  // Useful when:
  //   • user just stood up Ollama / set OPENAI_API_KEY and wants to
  //     embed the existing 1099 rows without waiting for the next chat
  //   • diagnosing whether embedder is actually working — runs synchronously
  //     and reports rows-attempted vs rows-embedded
  // No-op when the embedder is unavailable; reports zero filled.
  const { collectMemoryStatus, probeEmbeddingProviderAvailability } = await import('./memory/status.js');
  const beforeSnap = collectMemoryStatus();
  const probe = await probeEmbeddingProviderAvailability().catch(() => null);
  if (!probe?.available) {
    if (json) {
      output.write(JSON.stringify({ ok: false, reason: 'no-embedder', probe }, null, 2) + '\n');
    } else {
      output.write('No live embedder available; nothing to fill.\n');
      output.write('Run `melo memory status` for the per-provider rejection reasons.\n');
    }
    return;
  }

  const { getResolvedConfig } = await import('./config.js');
  const config = await getResolvedConfig();
  const { scheduleEmbeddingFillIn } = await import('./memory/memoryPromotion.js');

  // getMemoriesWithoutEmbeddings has an internal LIMIT 200, so its
  // .length wraps the cap and would always show 200/200 on a large
  // store. Use a direct uncapped COUNT for accurate before/after.
  // The real backfill loop still walks 200 at a time — multiple CLI
  // invocations are expected for stores with thousands of NULL rows.
  async function uncappedNullCount() {
    const { DatabaseSync } = await import('node:sqlite');
    const { getMeloHome } = await import('./config.js');
    const { join: joinPath } = await import('node:path');
    const { existsSync } = await import('node:fs');
    const path = joinPath(getMeloHome(), 'desktop', 'store.sqlite');
    if (!existsSync(path)) return 0;
    let db = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const r = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NULL').get();
      return r?.n ?? 0;
    } catch {
      return null;
    } finally {
      try { db?.close(); } catch {}
    }
  }

  const pendingBefore = await uncappedNullCount();
  const start = Date.now();
  await scheduleEmbeddingFillIn(config);
  const elapsedMs = Date.now() - start;
  const pendingAfter = await uncappedNullCount();
  const filled = pendingBefore != null && pendingAfter != null
    ? Math.max(0, pendingBefore - pendingAfter)
    : 0;

  const afterSnap = collectMemoryStatus();
  const beforeMemories = beforeSnap.counts.memories ?? 0;
  const afterMemories = afterSnap.counts.memories ?? 0;
  // (Memories count shouldn't change during fill — we only embed existing
  // rows. Still surface it so a regression that ALSO inserts rows shows up.)

  if (json) {
    output.write(JSON.stringify({
      ok: true,
      pendingBefore,
      pendingAfter,
      filled,
      elapsedMs,
      provider: probe.available,
      modelId: probe.modelId,
      memoriesCount: { before: beforeMemories, after: afterMemories },
    }, null, 2) + '\n');
    return;
  }
  output.write(`Embedding fill-in via ${probe.available} (${probe.modelId || 'unknown model'}) finished in ${elapsedMs}ms.\n`);
  output.write(`  pending before  ${pendingBefore}\n`);
  output.write(`  filled          ${filled}\n`);
  output.write(`  pending after   ${pendingAfter}\n`);
  if (pendingAfter > 0) {
    output.write(`Note: ${pendingAfter} rows still pending — provider may be rate-limited; rerun.\n`);
  }
}

async function runMemoryConsolidateCommand({ full = false, json = false } = {}) {
  // triggerDreamingNow is the same entry the Desktop "Consolidate now"
  // button uses. Returns either { skipped: true, reason } when dreaming
  // is disabled (MELO_DREAMING_ENABLED=0), or the sweep summary
  // (examined / promoted / demoted / hits-pruned counts).
  const { triggerDreamingNow } = await import('./memory/dreaming/scheduler.js');
  const start = Date.now();
  const result = await triggerDreamingNow({ full });
  const elapsedMs = Date.now() - start;

  if (json) {
    output.write(JSON.stringify({ ...result, elapsedMs }, null, 2) + '\n');
    return;
  }

  if (result?.skipped) {
    output.write(`Dreaming skipped (${result.reason || 'unknown'}).\n`);
    if (result.reason === 'disabled') {
      output.write('Set MELO_DREAMING_ENABLED=1 (or unset MELO_DREAMING_ENABLED) to enable.\n');
    }
    return;
  }
  output.write(`Dreaming sweep finished in ${elapsedMs}ms (${full ? 'full' : 'incremental'}).\n`);
  if (result && typeof result === 'object') {
    if ('examined' in result)        output.write(`  examined         ${result.examined}\n`);
    if ('promotedToHot' in result)   output.write(`  promoted to Hot  ${result.promotedToHot}\n`);
    if ('demoted' in result)         output.write(`  demoted          ${result.demoted}\n`);
    if ('hitRowsPruned' in result)   output.write(`  hit rows pruned  ${result.hitRowsPruned}\n`);
  }
}

async function runDoctor() {
  const resolved = await getResolvedConfig();
  const fileConfig = await loadConfig();

  output.write('Melo doctor\n\n');
  output.write(`config path    ${getConfigPath()}\n`);
  output.write(`provider       ${resolved.provider}\n`);
  output.write(`auth mode      ${resolved.authMode}\n`);
  output.write(`base URL       ${resolved.baseUrl}\n`);
  output.write(`model          ${resolved.model}\n`);
  output.write(`api key        ${maskApiKey(resolved.apiKey)}\n`);
  if (resolved.authMode === 'codex') {
    output.write(
      `codex login    ${
        resolved.codexAuth?.loggedIn
          ? `${resolved.codexAuth.email || 'signed in'} (${resolved.codexAuth.plan || 'unknown'})`
          : 'not signed in'
      }\n`,
    );
    output.write(`config source  Codex desktop login (ChatGPT OAuth via codex/responses)\n`);
  } else {
    output.write(
      `config source  ${
        resolved.apiKey && resolved.apiKey === fileConfig.apiKey
          ? 'config file'
          : process.env.MELO_API_KEY
            ? 'MELO_API_KEY'
            : process.env.OPENAI_API_KEY
              ? 'OPENAI_API_KEY'
              : 'not set'
      }\n`,
    );
  }
  output.write(
    `network mode   ${
      process.env.MELO_MOCK_RESPONSE ? 'mock response enabled' : 'live provider'
    }\n\n`,
  );

  // ─── Search subsystem health ────────────────────────────────────────────
  // Tells you at a glance whether a `melo search` right now will hit the
  // real Google pipeline (playwright), fall back to Jina, or fail outright.
  output.write('search subsystem\n');
  try {
    const health = await checkSearchHealth({ signal: AbortSignal.timeout(5_000) });
    const pwTag = health.playwright.available ? 'available' : `unavailable${health.playwright.error ? ` (${health.playwright.error})` : ''}`;
    const jinaTag = health.jina.reachable
      ? `reachable${health.jina.status ? ` (HTTP ${health.jina.status})` : ''}`
      : `unreachable${health.jina.error ? ` (${health.jina.error})` : ''}`;
    output.write(`  playwright   ${pwTag}\n`);
    output.write(`  jina reader  ${jinaTag}\n`);
    if (health.cacheDb.exists) {
      const kb = (health.cacheDb.sizeBytes / 1024).toFixed(1);
      const ageStr = health.cacheDb.lastQueryAgeMs != null
        ? `${Math.round(health.cacheDb.lastQueryAgeMs / 60_000)} min ago`
        : 'no entries';
      output.write(`  cache db     ${health.cacheDb.path} (${kb} KB, ${health.cacheDb.rowCount} rows, last ${ageStr})\n`);
    } else {
      output.write(`  cache db     ${health.cacheDb.path} (not yet created)\n`);
    }
    output.write(`  overall      ${health.healthy ? 'healthy' : 'DEGRADED — no provider reachable'}\n\n`);
  } catch (error) {
    output.write(`  health check failed: ${error.message}\n\n`);
  }
}

async function handleConfig(args) {
  const [subcommand, key, ...rest] = args;

  if (!subcommand || subcommand === 'show') {
    const config = await getResolvedConfig();
    printConfig(config);
    return;
  }

  if (subcommand !== 'set') {
    throw new Error(`Unknown config subcommand: ${subcommand}`);
  }

  if (!key) {
    throw new Error(
      `Usage: melo config set <authMode|apiKey|model|baseUrl|systemPrompt> <value>`,
    );
  }

  const allowedKeys = new Set(['authMode', 'apiKey', 'model', 'baseUrl', 'systemPrompt']);
  if (!allowedKeys.has(key)) {
    throw new Error(`Unsupported config key: ${key}`);
  }

  const value = rest.join(' ').trim();
  if (!value) {
    throw new Error(`Missing value for config key: ${key}`);
  }

  if (key === 'authMode' && !VALID_AUTH_MODES.includes(value)) {
    throw new Error(`Unsupported authMode: ${value}. Use one of ${VALID_AUTH_MODES.join(', ')}.`);
  }
  if (key === 'baseUrl' && !/^https?:\/\//.test(value)) {
    throw new Error(`Invalid baseUrl: ${value}. Use a full http(s) URL.`);
  }

  const next = await updateConfig(key, value);
  output.write(`Updated ${key} in ${getConfigPath()}\n`);
  printConfig(next);
}

async function requestAssistant(messages) {
  const config = await getResolvedConfig();
  return createOpenAICompatibleReply({
    ...config,
    messages,
  });
}

// ─── /save-as-skill ──────────────────────────────────────────────────────────
//
// Turn the recent in-memory conversation into a reusable skill. We show the
// draft to the user and require an explicit "yes" before persisting — that
// way the user (or a Telegram confirmation echo) is always in the loop. If
// the user says "no" we just drop the draft; if they type a new hint we
// re-draft once.
//
// Exported for unit tests — the DI seams (replyFn / saveFn / io) let tests
// drive the full loop without hitting the network or the on-disk store.
export async function handleSaveAsSkillCommand({
  messages,
  hint = '',
  config,
  replyFn = createOpenAICompatibleReply,
  draftFn = draftSkillFromConversation,
  saveFn = createCustomSkill,
  io = output,
  readLine,
  signal,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    io.write('No conversation yet — have a chat first, then run /save-as-skill.\n\n');
    return { ok: false, error: 'NO_CONVERSATION' };
  }
  if (!config) {
    io.write('Cannot draft skill: no resolved config (run `melo config show`).\n\n');
    return { ok: false, error: 'MISSING_CONFIG' };
  }

  io.write('Drafting skill from the last few turns…\n');
  const drafted = await draftFn({
    messages,
    config,
    hint,
    signal,
    replyFn,
  });
  if (!drafted.ok) {
    io.write(`Draft failed: ${drafted.error}${drafted.reason ? ` — ${drafted.reason}` : ''}\n\n`);
    return drafted;
  }

  const skill = drafted.skill;
  io.write('\nProposed skill:\n');
  io.write(`  id           ${skill.id}\n`);
  io.write(`  name         ${skill.name}\n`);
  io.write(`  type         ${skill.type}\n`);
  io.write(`  description  ${skill.description || '(none)'}\n`);
  io.write(`  maxIters     ${skill.maxIterations}\n`);
  io.write('  systemPrompt:\n');
  const promptLines = String(skill.systemPrompt || '').split('\n');
  for (const line of promptLines) {
    io.write(`    ${line}\n`);
  }
  if (skill._suspicious) {
    io.write('  ⚠ _suspicious flag set — review the systemPrompt before saving.\n');
  }
  io.write('\n');

  if (!readLine) {
    // Non-interactive caller (e.g. Telegram bot path) — return the draft
    // and let the outer loop collect confirmation asynchronously.
    return { ok: true, pending: true, skill };
  }

  const answer = (await readLine('Save this skill? [y/N] ')).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    io.write('Discarded.\n\n');
    return { ok: true, saved: false, skill };
  }

  try {
    await saveFn(skill);
    io.write(`Saved skill "${skill.id}".\n\n`);
    return { ok: true, saved: true, skill };
  } catch (err) {
    io.write(`Save failed: ${err.message}\n\n`);
    return { ok: false, error: 'SAVE_FAILED', reason: err.message, skill };
  }
}

async function runOneShot(prompt) {
  if (!prompt.trim()) {
    throw new Error('Usage: melo chat "<prompt>"');
  }

  const reply = await requestAssistant([{ role: 'user', content: prompt }]);
  output.write(`${reply}\n`);
}

async function runInteractiveChat() {
  const rl = createInterface({ input, output });
  const messages = [];

  output.write('Melo Local\n');
  output.write('Type /help for commands. Type /exit to quit.\n\n');

  try {
    while (true) {
      const line = (await rl.question('you> ')).trim();

      if (!line) {
        continue;
      }

      if (line === '/exit' || line === '/quit') {
        output.write('Bye.\n');
        break;
      }

      if (line === '/help') {
        printHelp();
        continue;
      }

      if (line === '/config') {
        const config = await getResolvedConfig();
        printConfig(config);
        continue;
      }

      if (line.startsWith('/search ') || line === '/search') {
        const rest = line.slice('/search'.length).trim();
        if (!rest) {
          output.write('Usage: /search <query>\n\n');
          continue;
        }
        try {
          await runSearchCommand([rest]);
        } catch (error) {
          output.write(`Search error: ${error.message}\n`);
        }
        output.write('\n');
        continue;
      }

      if (line.startsWith('/history ') || line === '/history') {
        const rest = line.slice('/history'.length).trim();
        if (!rest) {
          output.write('Usage: /history <query>\n\n');
          continue;
        }
        try {
          await runHistoryCommand([rest]);
        } catch (error) {
          output.write(`History error: ${error.message}\n`);
        }
        output.write('\n');
        continue;
      }

      if (line === '/save-as-skill' || line.startsWith('/save-as-skill ')) {
        const hint = line.slice('/save-as-skill'.length).trim();
        try {
          const config = await getResolvedConfig();
          await handleSaveAsSkillCommand({
            messages,
            hint,
            config,
            readLine: (q) => rl.question(q),
          });
        } catch (error) {
          output.write(`Save-as-skill error: ${error.message}\n\n`);
        }
        continue;
      }

      messages.push({ role: 'user', content: line });
      output.write('melo> ');

      try {
        const reply = await requestAssistant(messages);
        messages.push({ role: 'assistant', content: reply });
        output.write(`${reply}\n\n`);
      } catch (error) {
        output.write(`Error: ${error.message}\n\n`);
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case undefined:
      await runInteractiveChat();
      return;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    case 'doctor':
      await runDoctor();
      return;
    case 'config':
      await handleConfig(args);
      return;
    case 'chat':
      await runOneShot(args.join(' '));
      return;
    case 'search':
      await runSearchCommand(args);
      return;
    case 'history':
      await runHistoryCommand(args);
      return;
    case 'memory':
      await runMemoryCommand(args);
      return;
    default:
      throw new Error(
        `Unknown command: ${command}. Run \`melo help\` for available commands.`,
      );
  }
}

// Only invoke `main()` when this file is the entry point (i.e. `node src/index.js`
// or the `melo` bin). Importing from this module for tests / tooling must NOT
// trigger the interactive REPL.
const isEntryPoint = (() => {
  try {
    return argv[1] && fileURLToPath(import.meta.url) === argv[1];
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().catch(error => {
    output.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
