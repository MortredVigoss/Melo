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
