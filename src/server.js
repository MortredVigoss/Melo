import { createRouteRegistry } from './http/routeRegistry.js';
import { reconcileLegacyFacts } from './memory/factRecords.js';
import { startDerivedIndexing } from './runtime/derivedIndexing.js';
import { drainPostTurnTasks } from './runtime/postTurnTasks.js';
import { startBackgroundRuntime } from './runtime/backgroundStartup.js';
import { replayPortableMemory } from './services/chat/portableMemory.js';
import { recoverApprovalRuns } from './domain/approval/approvalService.js';
import { recoverTaskRuns } from './services/task/taskRunLifecycle.js';
import { loadState, updateStateAtomically as recoverStateAtomically } from './state/stateStore.js';
import { handleExecutionRoutes } from './http/executionRoutes.js';
import { handleMobileSyncRoute } from './http/mobileSyncRoutes.js';
import { matchesDomainRoute, handleDomainRoutes } from './http/domainRoutes.js';
import { createTtsRoutes } from './http/ttsRoutes.js';
import { handleChatRoutes } from './http/chatRoutes.js';
import { sendJson, startSse, writeSseEvent, readJsonBody } from './http/transport.js';
import { createRequestContext } from './runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from './runtime/requestScope.js';
import { errorPayload } from './services/chat/requestContract.js';
import { acquireServerHomeLock } from './runtime/serverLock.js';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySignedFileUrl, setServerOrigin } from './web/urlSigning.js';
import { isOriginAllowed } from './web/originCheck.js';
import { cleanupStalePlaywrightDaemons } from './web/playwrightFetcher.js';
// Stage 3a shutdown hook (2026-05-21 audit): pageRegistry holds persistent
// CDP Browser+page handles per browser_open call.  Without an explicit
// SIGTERM/SIGINT teardown they accumulate until process exit — and on Chrome
// side, the targets aren't released cleanly.  closeAllPages is best-effort
// (swallows individual close errors per design) so it can sit alongside
// cleanupStalePlaywrightDaemons without risking the rest of the shutdown
// sequence.
import { closeAllPages } from './services/browser/pageRegistry.js';
import { synthesizeWithEdgeTts as _synthesizeWithEdgeTts } from './services/tts/edgeTts.js';
import { stageChatDeletion, finishChatDeletions } from './services/chat/chatDeletion.js';
import { purgeStaleSoftDeletes, createChat, deleteChat, getDesktopBootstrap, prepareDesktopLaunchState, processTelegramPollingCycle, processDiscordPollingCycle, streamSearchFileGroups, updateChat, updateModelConfig, initMcpServers } from './desktopStore.js';
import { resolvePermission, getPendingPermissions, getSessionPermissions, clearSessionPermissions } from './tools/permissions.js';
import { resolveFileSafety } from './safety/fileSafetyGate.js';
import { connectMcpServer, disconnectMcpServer, getActiveMcpServers, shutdownMcpServers } from './mcp/manager.js';
import { backgroundRunner } from './tasks/backgroundRunner.js';
import { startApprovedBackgroundTask } from './tasks/approvedBackgroundTask.js';
import { getReminderScheduler } from './reminders/scheduler.js';
import { createReminderDelivery } from './reminders/delivery.js';
import { unregisterPlugin, getRegisteredPlugins, getPluginHooks } from './plugins/hooks.js';
import { resolveRuntimePaths } from './runtime/paths.js';
import { createRuntimeIdentity, publishRuntime, releaseRuntime } from './runtime/identity.js';
import { collectRuntimeDiagnostics } from './runtime/diagnostics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);
const uiDir = join(rootDir, 'desktop-ui');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.icns': 'image/icns',
};

// Content types for files served via the signed endpoint. Covers what image /
// PDF tools currently produce; unknowns fall through to application/octet-stream.
const SIGNED_FILE_MIME_TYPES = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
  '.avif': 'image/avif',
  '.svg':  'image/svg+xml',
  '.pdf':  'application/pdf',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.m4a':  'audio/mp4',
  '.ogg':  'audio/ogg',
  '.mp4':  'video/mp4',
  '.mov':  'video/quicktime',
  '.txt':  'text/plain; charset=utf-8',
};

function getArgValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }

  return fallback;
}

const host = getArgValue('--host', '127.0.0.1');
const port = Number(getArgValue('--port', process.env.MELO_DESKTOP_PORT || '43127'));
const telegramPollIntervalMs = Math.max(
  1500,
  Number(getArgValue('--telegram-poll-ms', process.env.MELO_TELEGRAM_POLL_MS || '3500')) || 3500,
);
let telegramPollTimer = null;
let telegramPollingStopped = false;

const discordPollIntervalMs = Math.max(
  1500,
  Number(getArgValue('--discord-poll-ms', process.env.MELO_DISCORD_POLL_MS || '3500')) || 3500,
);
let discordPollTimer = null;
let discordPollingStopped = false;

// ── Bot-channel polling singleton locks ───────────────────────────────────────
// Prevents two concurrent server instances (e.g. terminal + desktop app) from
// both polling the same bot token, which causes duplicate replies and SQLite
// "database closed" errors from concurrent writes.
const runtimePaths = resolveRuntimePaths();
const _LOCK_DIR = runtimePaths.home;
const runtimeIdentity = await createRuntimeIdentity({ paths: runtimePaths, host, port });
let runtimePublication = Promise.resolve();
const _TELEGRAM_LOCK_FILE = join(_LOCK_DIR, 'telegram-poller.lock');
const _DISCORD_LOCK_FILE = join(_LOCK_DIR, 'discord-poller.lock');

async function _acquirePollerLock(lockFile) {
  const { readFile, writeFile } = await import('node:fs/promises');
  try {
    const existing = await readFile(lockFile, 'utf8').catch(() => '');
    const existingPid = parseInt(existing.trim(), 10);
    if (existingPid && existingPid !== process.pid) {
      // Check if the holder is still alive
      try {
        process.kill(existingPid, 0); // signal 0 = liveness check, no actual signal
        return false; // another live instance holds the lock
      } catch {
        // Stale lock — process no longer exists, take over
      }
    }
  } catch { /* no lock file yet */ }
  try {
    await writeFile(lockFile, String(process.pid));
    return true;
  } catch {
    return false; // can't write lock, skip polling to be safe
  }
}

async function _releasePollerLock(lockFile) {
  const { unlink } = await import('node:fs/promises');
  await unlink(lockFile).catch(() => {});
}

async function _acquireTelegramLock() {
  return _acquirePollerLock(_TELEGRAM_LOCK_FILE);
}

async function _releaseTelegramLock() {
  return _releasePollerLock(_TELEGRAM_LOCK_FILE);
}

async function _acquireDiscordLock() {
  return _acquirePollerLock(_DISCORD_LOCK_FILE);
}

async function _releaseDiscordLock() {
  return _releasePollerLock(_DISCORD_LOCK_FILE);
}

// ── Whole-server singleton lock ──────────────────────────────────────────────
// The per-poller locks above prevent duplicate REST polling across processes,
// but they don't stop two server instances from both mutating state.json at
// the same time. persistStateAtomically uses tmp+rename so each WRITE is
// file-atomic, but cross-process read-modify-write cycles can still lose
// updates (one instance writes, the other's in-memory snapshot overwrites
// it). A single file-level lock here forces the second instance to back
// out before it starts serving any endpoint. See feedback_preserve_user_config.md.
let serverHomeLock;
async function _acquireServerLock() {
  serverHomeLock = await acquireServerHomeLock(_LOCK_DIR);
  return serverHomeLock;
}
async function _releaseServerLock() {
  await serverHomeLock?.release?.();
}

{
  const lockResult = await _acquireServerLock();
  if (!lockResult.acquired) {
    const detail = Array.isArray(lockResult.otherInstances) && lockResult.otherInstances.length
      ? ` — detected stray node server(s): ${lockResult.otherInstances
          .map(x => `pid ${x.pid}`)
          .join(', ')}. Kill them (\`kill <pid>\`) before relaunching Melo.`
      : '';
    process.stderr.write(
      `[melo-desktop] Another Melo server instance is already running` +
        (lockResult.holderPid ? ` (pid ${lockResult.holderPid})` : '') +
        `.${detail} Exiting to avoid corrupting shared state at ${_LOCK_DIR}.\n`,
    );
    process.exit(0);
  }
  // 'exit' event runs synchronously after all listeners fire; the
  // promise scheduled here is best-effort. SIGINT/SIGTERM are handled
  // by the bottom-of-file shutdown() function which calls
  // _releaseServerLock + cleanupStalePlaywrightDaemons + voice/lock
  // cleanups + server.close in proper order. Codex C fix #11 (review
  // #12, 2026-05-04): used to register SIGINT/SIGTERM handlers HERE
  // that called process.exit() — they pre-empted the shutdown()
  // listener at line 2300+ via Node's listener-order, skipping all
  // the lock-release / voice / playwright cleanup that shutdown()
  // does. Removed the SIGINT/SIGTERM registration here; shutdown()
  // owns the signal-handler lifecycle.
  process.on('exit', () => {
    _releaseServerLock().catch(() => {});
  });
}

const derivedIndexing = startDerivedIndexing({ home: runtimePaths.home, env: { ...process.env } });
await prepareDesktopLaunchState();
await recoverStateAtomically(state => {
  if (!state.chatDeletionCleanupVersion) { stageChatDeletion(state, (state.mobileDeletedChats || []).map(row => row.id)); state.chatDeletionCleanupVersion = 1; }
  return state;
});
await finishChatDeletions(runtimePaths.home);
await recoverStateAtomically(state => { replayPortableMemory(state); return state; });
reconcileLegacyFacts(await loadState());
await recoverStateAtomically(state => { recoverTaskRuns(state); recoverApprovalRuns(state); return state; });
const reminderScheduler = getReminderScheduler(runtimePaths.home);
await reminderScheduler.start(createReminderDelivery({ home: runtimePaths.home })).catch(() => {
  process.stderr.write('[reminder] startup failed; reminders were not overwritten.\n');
});
cleanupStalePlaywrightDaemons({ includeOrphans: true, onlyOrphans: true });

// Memory runtime — resolves providers (incl. shadow/routes), picks an
// embedding backend and arms the dreaming scheduler.  Never throws: any
// failure is logged and the server continues to boot.  Shutdown handler below
// calls `_memoryRuntime.stop()` to release timers.
const memoryBootContext = createRequestContext({home:runtimePaths.home,env:{...process.env}});
const _memoryRuntime = startBackgroundRuntime(() => runWithRequestContext(memoryBootContext, async () => {
  const { startMemoryRuntime } = await import('./memory/runtime.js');
  return startMemoryRuntime();
}), {
  onReady: runtime => { if (runtime?.schedulerStarted) process.stdout.write('[memory.runtime] dreaming scheduler armed\n'); },
  onError: err => process.stderr.write(`[memory.runtime] boot failed: ${err?.message || err}\n`),
});

// Soft-delete GC: drop tombstones older than 7 days at startup.  The
// undo window is 5 seconds; a week of grace is generous insurance
// against clock skew, manual restore-by-editing-state.json, and a user
// who finds an old soft-delete after digging through their backup.
// Failure is non-fatal — purge errors get logged and the server boots.
purgeStaleSoftDeletes({ olderThanDays: 7 }).then(({ purged }) => {
  if (purged > 0) {
    process.stdout.write(`[artifacts] purged ${purged} stale soft-delete(s)\n`);
  }
}).catch(err => {
  process.stderr.write(`[artifacts.purge] startup sweep failed: ${err?.message || err}\n`);
});



/**
 * CSRF-style guard for state-mutating POST endpoints. The server binds to
 * 127.0.0.1 by default, but a malicious page in the user's browser could
 * still fire form POSTs at us and get them accepted as same-origin-ish. We
 * require either: no Origin header (CLI / Node.js callers that don't set it),
 * or an Origin that matches our own host:port.
 *
 * Returns true when the request may proceed; otherwise writes a 403 JSON and
 * returns false so the caller can `return` immediately.
 */
function requireLocalOrigin(request, response) {
  const origin = request.headers?.origin;
  if (isOriginAllowed(origin, host, runtimeIdentity.port)) return true;

  sendJson(response, 403, {
    ok: false,
    error: 'FORBIDDEN_ORIGIN',
    message: `Origin "${origin}" is not allowed for this endpoint.`,
  });
  return false;
}







function getStaticPath(urlPath) {
  if (urlPath === '/' || urlPath === '/index.html') {
    return join(uiDir, 'index.html');
  }

  return join(uiDir, urlPath.replace(/^\/+/, ''));
}

// ── Native say streaming queue (Bug 1 fix 2026-05-12) ─────────────────────────
//
// Sequential queue for /usr/bin/say invocations.  The streaming TTS UI used
// to POST one /api/tts/native per detected sentence break; the old endpoint
// kill+replaced the previous `say` process on every call, so multi-sentence
// streams played only the last sentence.  This queue lets sentences chain
// (next starts on previous exit), with `clear()` available for preemption
// (Stop button / new chat send).  Spawn is injected lazily so the import
// pulls only the pure state machine — no node:child_process needed for tests.


const ttsRoutes = createTtsRoutes({ startVoicePackServers });

// ── Vendored Three.js from node_modules ─────────────────────────────────
// The Demon 3D renderer (globe-flight, solar-system, …) needs Three.js on
// the client. We serve the ESM build + its add-ons from node_modules via
// stable URLs so the frontend importmap can resolve `three` and
// `three/addons/...` without any bundler.
// ── Shared classifier modules from src/media/ ────────────────────────────
// The composer's Link button needs the same URL classifier that text-paste
// promotion uses (detectUrlKind / promoteTextUrlsToAttachments) so that
// YouTube links, .mp3, .pdf, etc. produce identical kind / mimeType / title
// regardless of how the user attached them. The module is pure regex with
// no Node dependencies — safe to import from the browser.
// The TTS panel's "自定义语音" activation needs the same priority
// chain that node-side unit tests lock — single source of truth
// for cache-valid / saved-default / first-agent / nothing-configured.
// ── Signed workspace-file endpoint ───────────────────────────────────────
// Tools that produce files (image edits, generated PDFs, MiniMax images)
// mint a signed URL via src/web/urlSigning.js → signWorkspaceFileUrl(), and
// the UI fetches the file here. Signature validation is delegated to
// verifySignedFileUrl, which also enforces the expiry check.
//
// The URL carries the file's basename as a path segment
// (`/api/files/signed/<name>`) purely so the client-side URL detector can
// identify the media type from the extension — the server ignores that
// segment entirely and only trusts the query-string signature.
// Session permission rules (in-memory, cleared on restart).
// Accepts optional ?chatId=<id> for per-chat isolation; without it,
// returns the union across all chats / clears everything (legacy behavior).
// Persistent permission rules (saved to config)
// ── File-safety persistent allowlist (Phase 3b/3c) ──────────────────────
// ── Domain cookies (Phase 4: Xiaohongshu/Douyin extraction reliability) ─
//
// Read-side: list the domains that have a cookie string saved. We
// deliberately DO NOT return the cookie value — domain cookies can
// contain session secrets and the management UI only needs presence
// info to render rows. Add/replace lands the new value, remove
// drops it. This keeps the SSE-rendered settings page from
// splattering session tokens across the DOM.
// ── MCP server management endpoints ─────────────────────────────────────
// Toggle a built-in MCP preset on/off by flipping its config flag.
// Body: { flag: 'enableAntvChartMcp', enabled: true }
// The flag must match an existing `enable*Mcp` field on the resolved
// config; arbitrary writes are refused.  After the write, MCP servers
// are re-bootstrapped so the new state takes effect immediately.
// ── Background task endpoints ────────────────────────────────────────────
// Start a background shell command and stream its output via SSE.
// ── Plugin hook management endpoints ────────────────────────────────────
const coreRoutes = createRouteRegistry([
  { method: 'GET', paths: ["/api/health"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      sendJson(response, 200, { ok: true, runtime: runtimeIdentity });
      return;
    } },
  { method: 'GET', paths: ["/api/diagnostics"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      sendJson(response, 200, await collectRuntimeDiagnostics({ runtime: runtimeIdentity, includeStorage: url.searchParams.get('storage') === '1', probe: url.searchParams.get('probe') === '1' }));
      return;
    } },
  { method: 'GET', id: "/vendor/three/*", match: url => url.pathname.startsWith('/vendor/three/'), auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      const sub = url.pathname.slice('/vendor/three/'.length);
      // Only allow the two roots we actually need: the ESM build and the
      // example add-ons. Everything else 404s, preventing directory traversal
      // and casual probing of node_modules.
      let absPath = null;
      if (['three.module.min.js', 'three.module.js', 'three.core.min.js', 'three.core.js'].includes(sub)) {
        absPath = join(rootDir, 'node_modules', 'three', 'build', sub);
      } else if (sub.startsWith('addons/')) {
        // `addons/controls/OrbitControls.js` → examples/jsm/controls/OrbitControls.js
        const addonPath = sub.slice('addons/'.length).replace(/\.\.+/g, '');
        absPath = join(rootDir, 'node_modules', 'three', 'examples', 'jsm', addonPath);
      }
      if (!absPath) {
        sendJson(response, 404, { error: 'Unknown vendor path.' });
        return;
      }
      try {
        const fileStat = await stat(absPath);
        if (!fileStat.isFile()) throw new Error('not a file');
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': fileStat.size,
          'cache-control': 'public, max-age=86400',
        });
        createReadStream(absPath).pipe(response);
      } catch {
        sendJson(response, 404, { error: 'Vendor asset not found.' });
      }
      return;
    } },
  { method: 'GET', paths: ["/shared/localPreferences.js"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => { response.writeHead(200, {'content-type':'text/javascript; charset=utf-8','cache-control':'no-cache'}); createReadStream(join(rootDir,'src','domain','settings','localPreferences.js')).pipe(response); return; } },
  { method: 'GET', paths: ["/shared/urlDetector.js","/shared/textUrls.js"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      const absPath = join(rootDir, 'src', 'media', url.pathname.endsWith('/textUrls.js') ? 'textUrls.js' : 'urlDetector.js');
      try {
        const fileStat = await stat(absPath);
        if (!fileStat.isFile()) throw new Error('not a file');
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': fileStat.size,
          // This module controls attachment classification in the composer.
          // Keep it fresh so platform-link fixes (e.g. Douyin/Xiaohongshu
          // pages should render as link previews, not <video>) apply on the
          // next app reload instead of being stuck behind Chromium's module
          // cache for a day.
          'cache-control': 'no-cache',
        });
        createReadStream(absPath).pipe(response);
      } catch {
        sendJson(response, 404, { error: 'Shared module not found.' });
      }
      return;
    } },
  { method: 'GET', paths: ["/shared/minimaxVoiceResolver.js","/shared/modelCatalog.js","/shared/executionScene.js","/shared/replyDocument.js"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      const absPath = join(rootDir, 'src', 'shared', url.pathname.split('/').at(-1));
      try {
        const fileStat = await stat(absPath);
        if (!fileStat.isFile()) throw new Error('not a file');
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': fileStat.size,
          // Resolver behaviour drives saved/default voice activation, which
          // is exactly the kind of fix users want immediately. Match the
          // urlDetector.js policy (no-cache) so a hot-fix doesn't sit
          // behind a 24-hour cache.
          'cache-control': 'no-cache',
        });
        createReadStream(absPath).pipe(response);
      } catch {
        sendJson(response, 404, { error: 'Shared module not found.' });
      }
      return;
    } },
  { method: 'GET', id: "/api/files/signed*", match: url => (url.pathname === '/api/files/signed' || url.pathname.startsWith('/api/files/signed/')), auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      const absPath = verifySignedFileUrl(url.searchParams);
      if (!absPath) {
        sendJson(response, 403, { error: 'Invalid or expired signature.' });
        return;
      }
      let fileStat;
      try {
        fileStat = await stat(absPath);
      } catch {
        sendJson(response, 404, { error: 'File not found.' });
        return;
      }
      if (!fileStat.isFile()) {
        sendJson(response, 404, { error: 'Not a regular file.' });
        return;
      }
      const mime = SIGNED_FILE_MIME_TYPES[extname(absPath).toLowerCase()] || 'application/octet-stream';
      response.writeHead(200, {
        'content-type': mime,
        'content-length': fileStat.size,
        // Short cache — file contents at a signed URL are immutable for the
        // lifetime of the signature, so let the browser reuse them.
        'cache-control': 'private, max-age=300',
      });
      const stream = createReadStream(absPath);
      stream.on('error', () => { try { response.end(); } catch { /* ignore */ } });
      stream.pipe(response);
      return;
    } },
  { method: 'GET', paths: ["/api/launch/reset"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      await prepareDesktopLaunchState();
await recoverStateAtomically(state => {
  if (!state.chatDeletionCleanupVersion) { stageChatDeletion(state, (state.mobileDeletedChats || []).map(row => row.id)); state.chatDeletionCleanupVersion = 1; }
  return state;
});
await finishChatDeletions(runtimePaths.home);
      sendJson(response, 200, { ok: true });
      return;
    } },
  { method: 'GET', paths: ["/api/bootstrap"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      sendJson(response, 200, await getDesktopBootstrap(url.searchParams.get('q') || ''));
      return;
    } },
  { method: 'GET', paths: ["/api/search/files"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      const query = url.searchParams.get('q') || '';
      const projectId = url.searchParams.get('projectId') || '';
      startSse(response);

      try {
        // Emit file-group events (one per file, carrying up to 3
        // representative lines).  The transitional per-line 'hit' event
        // was retired in P3 follow-up #3 — clients must consume 'group'
        // and drill into `group.hits` for per-line metadata.
        const summary = await streamSearchFileGroups(query, projectId, async group => {
          writeSseEvent(response, 'group', group);
        });
        writeSseEvent(response, 'done', summary);
        response.end();
      } catch (error) {
        writeSseEvent(response, 'error', {
          error: error?.message || 'File search failed.',
        });
        response.end();
      }
      return;
    } },
  { method: 'POST', paths: ["/api/chats"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await createChat(body));
      return;
    } },
  { method: 'POST', paths: ["/api/chats/update"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateChat(body.chatId, body.patch || {}));
      return;
    } },
  { method: 'POST', paths: ["/api/chats/delete"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await deleteChat(body.chatId));
      return;
    } },
  { method: 'POST', paths: ["/api/chat/send","/api/chat/send/stream"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      await handleChatRoutes(request, response, url);
      return;
    } },
  { method: 'POST', paths: ["/api/tools/permission-response"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      const {
        requestId,
        granted,
        scope = 'once',
        toolId = '',
        kind = '',
        confirmInput = '',
        persistent = false,
      } = body;
      if (!requestId || typeof granted !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'requestId and a boolean granted decision are required.' });
        return;
      }
      // file_safety prompts (fileSafetyGate.js) and tool-runner prompts
      // (permissions.js) share the same SSE event but have completely
      // different resolver APIs. The discriminator on the response is
      // `kind: 'file_safety'`; everything else falls through to the
      // legacy tool-runner resolver.
      if (kind === 'file_safety') {
        const fileScope = granted ? scope : 'deny';
        const result = await resolveFileSafety(requestId, fileScope, {
          confirmInput,
          persistent: Boolean(persistent),
        });
        // file-safety responses always return 200 with the result body.
        // ok:false carries a recoverable reason (e.g. CONFIRMATION_MISMATCH)
        // that the UI inspects to decide whether to keep the dialog open
        // for retry. Sending a 4xx here would force the api() helper to
        // throw and lose the structured reason.
        sendJson(response, 200, result);
        return;
      }
      const result = await resolvePermission(requestId, Boolean(granted), scope, toolId);
      sendJson(response, 200, result);
      return;
    } },
  { method: 'GET', paths: ["/api/tools/pending-permissions"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      sendJson(response, 200, { requestIds: getPendingPermissions() });
      return;
    } },
  { method: 'GET', paths: ["/api/tools/session-permissions"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      const chatIdParam = url.searchParams.get('chatId') || undefined;
      sendJson(response, 200, getSessionPermissions(chatIdParam));
      return;
    } },
  { method: 'POST', paths: ["/api/tools/session-permissions/clear"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const chatIdParam = url.searchParams.get('chatId') || undefined;
      clearSessionPermissions(chatIdParam);
      sendJson(response, 200, { ok: true });
      return;
    } },
  { method: 'GET', paths: ["/api/tools/permission-rules"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      const { getResolvedConfig } = await import('./config.js');
      const config = await getResolvedConfig();
      sendJson(response, 200, { rules: Array.isArray(config.toolPermissionRules) ? config.toolPermissionRules : [] });
      return;
    } },
  { method: 'POST', paths: ["/api/tools/permission-rules/remove"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      const { toolId } = body;
      if (!toolId) {
        sendJson(response, 400, { ok: false, error: 'toolId is required.' });
        return;
      }
      // Use loadConfig (pure disk state) + spread — same reasoning as
      // persistPermissionRule. Passing only { toolPermissionRules } would
      // wipe apiKey / whisperApiKey / domainCookies / etc. because
      // saveConfig normalizes missing fields back to DEFAULT_CONFIG.
      // Wrapped in withConfigLock so a concurrent updateModelConfig /
      // permissions write can't race the load → modify → save here.
      const { loadConfig, saveConfig, withConfigLock } = await import('./config.js');
      const updated = await withConfigLock(async () => {
        const current = await loadConfig();
        const rules = Array.isArray(current.toolPermissionRules) ? current.toolPermissionRules : [];
        const next = rules.filter(r => body.id ? r.id !== body.id : r.toolId !== toolId);
        await saveConfig({ ...current, toolPermissionRules: next });
        return next;
      });
      sendJson(response, 200, { ok: true, rules: updated });
      return;
    } },
  { method: 'GET', paths: ["/api/safety/file-allowlist"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      const { listFileSafetyRules } = await import('./safety/fileSafetyAllowlist.js');
      const rules = await listFileSafetyRules();
      sendJson(response, 200, { rules });
      return;
    } },
  { method: 'POST', paths: ["/api/safety/file-allowlist/remove"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      const { id } = body;
      if (!id) {
        sendJson(response, 400, { ok: false, error: 'id is required.' });
        return;
      }
      const { removeFileSafetyRule, listFileSafetyRules } = await import('./safety/fileSafetyAllowlist.js');
      const removed = await removeFileSafetyRule(id);
      const rules = await listFileSafetyRules();
      sendJson(response, 200, { ok: true, removed, rules });
      return;
    } },
  { method: 'GET', paths: ["/api/settings/domain-cookies"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      const { getResolvedConfig } = await import('./config.js');
      const { createHash } = await import('node:crypto');
      const config = await getResolvedConfig();
      const map = (config.domainCookies && typeof config.domainCookies === 'object')
        ? config.domainCookies
        : {};
      // Codex review follow-up (Phase 4 🟠 2026-05-04): the previous
      // shape exposed the last 6 chars of the cookie value as a
      // "tail preview" to help the user identify stale rules. Even
      // 6 chars of a session token is a partial-secret leak — Codex
      // review correctly flagged this. Replace with a non-reversible
      // SHA-256 prefix (8 hex chars = 32 bits, plenty for distinguishing
      // ~thousands of rules per the birthday bound). The user can still
      // tell "did I update this cookie?" because the fingerprint
      // changes when the value changes, but no part of the original
      // cookie reaches the DOM.
      const hosts = Object.keys(map).map(host => {
        const value = typeof map[host] === 'string' ? map[host] : '';
        const length = value.length;
        const fingerprint = length
          ? createHash('sha256').update(value).digest('hex').slice(0, 8)
          : '';
        return { host, length, fingerprint };
      });
      sendJson(response, 200, { hosts });
      return;
    } },
  { method: 'POST', paths: ["/api/settings/domain-cookies/upsert"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      const { host, cookieString } = body;
      if (typeof host !== 'string' || !host.trim()) {
        sendJson(response, 400, { ok: false, error: 'host is required.' });
        return;
      }
      if (typeof cookieString !== 'string' || !cookieString.trim()) {
        sendJson(response, 400, { ok: false, error: 'cookieString is required.' });
        return;
      }
      const normalizedHost = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!normalizedHost) {
        sendJson(response, 400, { ok: false, error: 'host is required.' });
        return;
      }
      // Same withConfigLock + spread-current pattern as
      // persistPermissionRule — saveConfig normalizes missing fields
      // back to DEFAULT_CONFIG, so passing `{ domainCookies: ... }`
      // alone would wipe apiKey / whisperApiKey / etc.
      const { loadConfig, saveConfig, withConfigLock } = await import('./config.js');
      await withConfigLock(async () => {
        const current = await loadConfig();
        const next = { ...(current.domainCookies && typeof current.domainCookies === 'object' ? current.domainCookies : {}) };
        next[normalizedHost] = cookieString;
        await saveConfig({ ...current, domainCookies: next });
      });
      sendJson(response, 200, { ok: true });
      return;
    } },
  { method: 'POST', paths: ["/api/settings/domain-cookies/remove"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      const { host } = body;
      if (typeof host !== 'string' || !host.trim()) {
        sendJson(response, 400, { ok: false, error: 'host is required.' });
        return;
      }
      const normalizedHost = host.trim().toLowerCase();
      const { loadConfig, saveConfig, withConfigLock } = await import('./config.js');
      const removed = await withConfigLock(async () => {
        const current = await loadConfig();
        const map = current.domainCookies && typeof current.domainCookies === 'object'
          ? { ...current.domainCookies }
          : {};
        if (!(normalizedHost in map)) return false;
        delete map[normalizedHost];
        await saveConfig({ ...current, domainCookies: map });
        return true;
      });
      sendJson(response, 200, { ok: true, removed });
      return;
    } },
  { method: 'GET', paths: ["/api/mcp/servers"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      sendJson(response, 200, { servers: getActiveMcpServers() });
      return;
    } },
  { method: 'POST', paths: ["/api/mcp/connect"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      const { name, command, args, env } = body;
      if (!name || !command) {
        sendJson(response, 400, { ok: false, error: 'name and command are required.' });
        return;
      }
      const result = await connectMcpServer(name, { command, args: args || [], env: env || {} });
      sendJson(response, result.connected ? 200 : 500, { ok: result.connected, ...result });
      return;
    } },
  { method: 'POST', paths: ["/api/mcp/disconnect"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      const { name } = body;
      if (!name) {
        sendJson(response, 400, { ok: false, error: 'name is required.' });
        return;
      }
      disconnectMcpServer(name);
      sendJson(response, 200, { ok: true });
      return;
    } },
  { method: 'POST', paths: ["/api/mcp/reload"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      await initMcpServers();
      sendJson(response, 200, { ok: true, servers: getActiveMcpServers() });
      return;
    } },
  { method: 'POST', paths: ["/api/mcp/preset-toggle"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      const flag = String(body?.flag || '').trim();
      // Strict boolean — security-sensitive switch.  `Boolean(body.enabled)`
      // would coerce the strings "false" / "0" to true (Codex 🟠 audit
      // 2026-04-28); reject anything that isn't a literal boolean.
      const enabledRaw = body?.enabled;
      if (typeof enabledRaw !== 'boolean') {
        sendJson(response, 400, {
          ok: false,
          error: '`enabled` must be a literal boolean (true/false)',
        });
        return;
      }
      const enabled = enabledRaw;
      // Whitelist: only the four built-in MCP flags are toggleable here.
      // Anything else routes through the regular config / mcpServers
      // editing flow.  Hardcoded list (rather than dynamic introspection)
      // so a stray POST can't enable an arbitrary boolean elsewhere in
      // config.json.
      const ALLOWED_MCP_FLAGS = new Set([
        'enablePlaywrightMcp',
        'enableBrowserlessMcp',
        'enableAntvChartMcp',
        'enableMarkdown2PdfMcp',
        'enableMermaidMcp',
      ]);
      if (!ALLOWED_MCP_FLAGS.has(flag)) {
        sendJson(response, 400, { ok: false, error: `Unknown MCP preset flag: ${flag}` });
        return;
      }
      // Codex 四轮 audit 2026-04-29: enable on unpinned preset
      // refused (would 假启用); disable always allowed for legacy
      // cleanup. The rule lives in manager.js so it's unit-testable
      // without spinning up the http server.
      const { mcpPresetToggleRefusalReason } = await import('./mcp/manager.js');
      const refusalReason = mcpPresetToggleRefusalReason(flag, enabled);
      if (refusalReason) {
        sendJson(response, 409, { ok: false, error: refusalReason });
        return;
      }
      const { updateConfig } = await import('./config.js');
      await updateConfig(flag, enabled);
      // Re-bootstrap so the toggled server connects (or its tools get
      // unregistered if disabled).  Failures are logged inside
      // initMcpServers; the API returns ok regardless because the config
      // write itself succeeded.
      await initMcpServers();
      sendJson(response, 200, { ok: true, flag, enabled, servers: getActiveMcpServers() });
      return;
    } },
  { method: 'POST', paths: ["/api/background-tasks/run"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      const { command } = body;
      if (!command) {
        sendJson(response, 400, { ok: false, error: 'command is required.' });
        return;
      }

      const abortController = new AbortController();
      request.once('aborted', () => abortController.abort());
      response.once('close', () => {
        if (!response.writableFinished) abortController.abort();
      });

      startSse(response);

      let runId;
      try {
        runId = await startApprovedBackgroundTask(backgroundRunner, body, {
          signal: abortController.signal,
          detachAfterApproval: true,
          sseEmitter: (event, payload) => writeSseEvent(response, event, payload),
          onComplete: (record) => {
            if (response.destroyed) return;
            writeSseEvent(response, 'done', {
              runId: record.id,
              status: record.status,
              exitCode: record.exitCode,
            });
            response.end();
          },
        });
      } catch (error) {
        writeSseEvent(response, 'done', { status: 'denied', error: error.message });
        response.end();
        return;
      }

      writeSseEvent(response, 'started', { runId });

      // Subscribe to output and forward as SSE chunks
      const onOutput = chunk => { if (!response.destroyed) writeSseEvent(response, 'output', { chunk }); };
      const catchUp = response.destroyed ? '' : backgroundRunner.subscribe(runId, onOutput);
      response.once('close', () => backgroundRunner.unsubscribe(runId, onOutput));
      if (catchUp) {
        writeSseEvent(response, 'output', { chunk: catchUp });
      }

      return;
    } },
  { method: 'GET', paths: ["/api/background-tasks/status"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      const runId = url.searchParams.get('runId');
      if (!runId) {
        sendJson(response, 400, { ok: false, error: 'runId is required.' });
        return;
      }
      const record = backgroundRunner.status(runId);
      if (!record) {
        sendJson(response, 404, { ok: false, error: 'Run not found.' });
        return;
      }
      sendJson(response, 200, {
        runId: record.id,
        status: record.status,
        exitCode: record.exitCode,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        outputPreview: record.output.slice(-2000),
      });
      return;
    } },
  { method: 'POST', paths: ["/api/background-tasks/kill"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      const { runId } = body;
      if (!runId) {
        sendJson(response, 400, { ok: false, error: 'runId is required.' });
        return;
      }
      backgroundRunner.kill(runId);
      sendJson(response, 200, { ok: true });
      return;
    } },
  { method: 'GET', paths: ["/api/background-tasks/list"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      const runs = backgroundRunner.list().map(r => ({
        runId: r.id,
        command: r.command.slice(0, 120),
        status: r.status,
        exitCode: r.exitCode,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      }));
      sendJson(response, 200, { runs });
      return;
    } },
  { method: 'GET', paths: ["/api/plugins"], auth: 'local-read', handler: async ({request,response,url,requireLocalOrigin}) => {
      const plugins = getRegisteredPlugins().map(id => ({
        id,
        hooks: getPluginHooks(id),
      }));
      sendJson(response, 200, { plugins });
      return;
    } },
  { method: 'POST', paths: ["/api/plugins/unregister"], auth: 'local-write', handler: async ({request,response,url,requireLocalOrigin}) => {
      const body = await readJsonBody(request);
      const { pluginId } = body;
      if (!pluginId) {
        sendJson(response, 400, { ok: false, error: 'pluginId is required.' });
        return;
      }
      unregisterPlugin(pluginId);
      sendJson(response, 200, { ok: true });
      return;
    } },
]);

const server = createServer((request, response) => runWithRequestContext(createRequestContext({ bootstrapBase: String(request.headers['x-melo-bootstrap-base'] || '').slice(0,80) }), async () => {
  try {
    const url = new URL(request.url || '/', `http://${host}:${port}`);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !requireLocalOrigin(request, response)) return;

    if (await handleMobileSyncRoute(request, response, url)) return;
    if (await handleExecutionRoutes(request, response, url, runtimePaths.home)) return;
    if (ttsRoutes.matches(request, url)) {
      await ttsRoutes.handle(request, response, url);
      return;
    }

    if (matchesDomainRoute(request, url)) {
      await handleDomainRoutes(request, response, url, requireLocalOrigin);
      return;
    }

    if (await coreRoutes.handle(request, response, url, requireLocalOrigin)) return;
    if (!['GET','HEAD'].includes(request.method)) { sendJson(response,405,{error:'Method not allowed'}); return; }
    const filePath = getStaticPath(url.pathname);
    const content = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const headers = {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
    };
    // Melo's own browser modules change frequently during local iteration.
    // WKWebView can otherwise keep a stale app.js module after a patch and
    // show a blank shell until the cache expires. Keep vendor/assets cacheable
    // through their dedicated routes, but always revalidate app shell files.
    if (['.html', '.js', '.css'].includes(ext)) {
      headers['cache-control'] = 'no-cache';
    }
    response.writeHead(200, {
      ...headers,
    });
    response.end(content);
  } catch (error) {
    const statusCode = error?.statusCode || (error?.code === 'ENOENT' ? 404 : 500);
    sendJson(response, statusCode, errorPayload(error, currentRequestContext()));
  }
}));

// ── WAV buffer concatenation ──────────────────────────────────────────────────
// Merges an array of PCM WAV buffers into a single WAV buffer.
// All inputs must have the same sample rate / channels / bit-depth (guaranteed
// when they all come from the same F5-TTS model).


// ── Sentence splitter for speak-text endpoint ────────────────────────────────


// ── Edge TTS — implementation in src/services/tts/edgeTts.js (shared with
// src/tts.js so the inline-fallback path and the explicit speak-text path
// can never drift). See top-of-file import for _synthesizeWithEdgeTts.

// ── TTS abort registry — every in-flight synthesis fetch (MiniMax / Edge /
// OpenAI / Fish-Speech) registers an AbortController so /api/tts/queue-clear
// and /api/tts/speak-stop can actually halt the network call instead of
// only invalidating the session counter. Without this, the synthesis ran
// to its full TTS_TIMEOUT_MS=180s ignoring the user's stop click.




// ── TTS synthesis with F5-TTS auto-recovery ───────────────────────────────────
// Wraps synthesizeSpeech: if synthesis returns null (e.g. F5-TTS in broken state),
// restarts the voice-pack server and retries once.




// ── TTS helpers ───────────────────────────────────────────────────────────────




server.listen(port, host, () => {
  runtimeIdentity.port = server.address().port;
  runtimePublication = publishRuntime(runtimeIdentity).catch(error => process.stderr.write(`[runtime] metadata unavailable: ${error.code || 'write-failed'}\n`));
  process.stdout.write(`Melo desktop server listening at http://${host}:${runtimeIdentity.port}\n`);
  // Publish the origin so tools can mint signed file URLs against it.
  setServerOrigin(`http://${host}:${runtimeIdentity.port}`);
  // Initialise MCP servers after the HTTP server is ready
  initMcpServers().catch(err => {
    process.stderr.write(`[mcp] Startup error: ${err.message}\n`);
  });
  // Auto-start voice pack servers, then schedule watchdog
  startVoicePackServers();
  scheduleF5TtsWatchdog();
});

// ── Voice pack auto-start / restart ──────────────────────────────────────────
async function startVoicePackServers({ force = false } = {}) {
  if (process.env.MELO_TEST_MODE === '1') return;
  const { spawn, execSync } = await import('node:child_process');
  const { access } = await import('node:fs/promises');

  const voicePackDir = join(rootDir, 'voice-packs', 'custom-voice');
  const startScript = join(voicePackDir, 'start.sh');
  const healthUrl = 'http://127.0.0.1:7860/health';

  if (force) {
    // Kill any existing F5-TTS process on port 7860
    try {
      // Only kill the process LISTENING on 7860 (the fish-speech server itself),
      // NOT clients connected to it (which includes this node process during synthesis).
      execSync("lsof -ti tcp:7860 -sTCP:LISTEN | xargs kill -9 2>/dev/null || true", { stdio: 'ignore' });
      process.stdout.write('[voice-pack] Killed existing F5-TTS process.\n');
    } catch {}
    // Brief pause to let the port free up
    await new Promise(r => setTimeout(r, 1500));
  } else {
    // Check if already running (healthy)
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        process.stdout.write('[voice-pack] F5-TTS already running.\n');
        return;
      }
    } catch {}
  }

  // Check start.sh exists
  try {
    await access(startScript);
  } catch {
    return; // no voice pack installed, skip silently
  }

  process.stdout.write(`[voice-pack] ${force ? 'Restarting' : 'Starting'} F5-TTS custom voice server...\n`);
  const proc = spawn('bash', [startScript], {
    detached: false,
    stdio: 'ignore',
    env: { ...process.env },
  });
  proc.unref();

  // Poll until healthy (max 120s) — fire-and-forget poll when not forced
  const deadline = Date.now() + 120_000;
  const poll = async () => {
    if (Date.now() > deadline) {
      process.stderr.write('[voice-pack] F5-TTS did not become healthy within 120s.\n');
      return;
    }
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        process.stdout.write('[voice-pack] F5-TTS ready.\n');
        return;
      }
    } catch {}
    setTimeout(poll, 5000);
  };
  setTimeout(poll, force ? 5000 : 8000);
}

// ── F5-TTS periodic watchdog ─────────────────────────────────────────────────
// Every 5 minutes, ping the health endpoint. If it's down, restart automatically.
function scheduleF5TtsWatchdog() {
  setTimeout(async () => {
    try {
      // 10s timeout — F5-TTS event loop is now free during inference (executor fix),
      // so 10s is generous enough to distinguish "busy" from "actually down".
      const res = await fetch('http://127.0.0.1:7860/health', { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error('unhealthy');
    } catch {
      process.stderr.write('[voice-pack] F5-TTS watchdog: server down, restarting...\n');
      startVoicePackServers({ force: true }).catch(() => {});
    }
    scheduleF5TtsWatchdog(); // reschedule
  }, 5 * 60 * 1000); // every 5 minutes
}

function scheduleTelegramPoll(delayMs = 0) {
  if (telegramPollingStopped) {
    return;
  }

  if (telegramPollTimer) {
    clearTimeout(telegramPollTimer);
    telegramPollTimer = null;
  }

  telegramPollTimer = setTimeout(() => {
    telegramPollTimer = null;
    void runTelegramPollLoop();
  }, Math.max(0, delayMs));
  telegramPollTimer.unref?.();
}

async function runTelegramPollLoop() {
  if (telegramPollingStopped) {
    return;
  }

  const startedAt = Date.now();
  try {
    const result = await processTelegramPollingCycle();
    if (!telegramPollingStopped) {
      // Always wait at least TELEGRAM_POLL_MIN_DELAY_MS between cycles so a
      // transient fast-failure (empty result, 200 OK, no updates) can't
      // spin the CPU or hammer a remote endpoint into a rate-limit wall.
      // The normal long-poll path still waits on the remote `timeout=`
      // parameter, so this floor only kicks in on short-circuits.
      const TELEGRAM_POLL_MIN_DELAY_MS = 250;
      const nextDelayMs = !result?.hasActiveChannel
        ? telegramPollIntervalMs
        : result?.encounteredError
          ? telegramPollIntervalMs
          : TELEGRAM_POLL_MIN_DELAY_MS;
      if (process.env.MELO_TG_DEBUG === '1') {
        process.stdout.write(
          `[tg-loop] cycle done elapsed=${Date.now() - startedAt}ms active=${
            Boolean(result?.hasActiveChannel)
          } processed=${Number(result?.processedUpdateCount || 0)} error=${Boolean(
            result?.encounteredError,
          )}\n`,
        );
      }
      scheduleTelegramPoll(nextDelayMs);
    }
  } catch (error) {
    process.stderr.write(`Telegram poll error: ${error.message || String(error)}\n`);
    if (!telegramPollingStopped) {
      scheduleTelegramPoll(telegramPollIntervalMs);
    }
  }
}

// Acquire singleton lock before starting Telegram polling.
// If another live server process already holds the lock, skip polling entirely.
_acquireTelegramLock().then(acquired => {
  if (acquired) {
    scheduleTelegramPoll(0);
  } else {
    process.stdout.write(
      `[tg] Another server instance is already polling Telegram — skipping on port ${port}.\n`,
    );
  }
});

// Discord polling — mirrors the Telegram loop above with its own singleton lock
// so the two pollers never share state and can run independently.
function scheduleDiscordPoll(delayMs = 0) {
  if (discordPollingStopped) {
    return;
  }

  if (discordPollTimer) {
    clearTimeout(discordPollTimer);
    discordPollTimer = null;
  }

  discordPollTimer = setTimeout(() => {
    discordPollTimer = null;
    void runDiscordPollLoop();
  }, Math.max(0, delayMs));
  discordPollTimer.unref?.();
}

async function runDiscordPollLoop() {
  if (discordPollingStopped) {
    return;
  }

  const startedAt = Date.now();
  try {
    const result = await processDiscordPollingCycle();
    if (!discordPollingStopped) {
      // Discord REST does NOT long-poll — fetchDiscordUpdates returns
      // immediately. Without a floor the success branch would tight-loop
      // against Discord's rate limits. Same mitigation as the Telegram
      // loop above.
      const DISCORD_POLL_MIN_DELAY_MS = 1000;
      const nextDelayMs = !result?.hasActiveChannel
        ? discordPollIntervalMs
        : result?.encounteredError
          ? discordPollIntervalMs
          : DISCORD_POLL_MIN_DELAY_MS;
      if (process.env.MELO_DC_DEBUG === '1') {
        process.stdout.write(
          `[dc-loop] cycle done elapsed=${Date.now() - startedAt}ms active=${
            Boolean(result?.hasActiveChannel)
          } processed=${Number(result?.processedUpdateCount || 0)} error=${Boolean(
            result?.encounteredError,
          )}\n`,
        );
      }
      scheduleDiscordPoll(nextDelayMs);
    }
  } catch (error) {
    process.stderr.write(`Discord poll error: ${error.message || String(error)}\n`);
    if (!discordPollingStopped) {
      scheduleDiscordPoll(discordPollIntervalMs);
    }
  }
}

_acquireDiscordLock().then(acquired => {
  if (acquired) {
    scheduleDiscordPoll(0);
  } else {
    process.stdout.write(
      `[dc] Another server instance is already polling Discord — skipping on port ${port}.\n`,
    );
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const serverClosed = new Promise(resolve => server.close(resolve));
  server.closeIdleConnections?.();
  const deadline = setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(0);
  }, 5000);
  deadline.unref?.();
  telegramPollingStopped = true;
  discordPollingStopped = true;
  if (telegramPollTimer) {
    clearTimeout(telegramPollTimer);
    telegramPollTimer = null;
  }
  if (discordPollTimer) {
    clearTimeout(discordPollTimer);
    discordPollTimer = null;
  }
  try { _memoryRuntime?.stop?.(); } catch {}
  try { _nativeSayQueue?.clear?.(); } catch {}
  try { globalThis._meloAfplayProcess?.kill?.('SIGTERM'); } catch {}
  try { shutdownMcpServers(); } catch {}
  // Signal only this run's browser processes; low-level imports never own exit.
  try {
    cleanupStalePlaywrightDaemons();
  } catch {}
  // Stage 3a shutdown hook (2026-05-21 audit): close every registered CDP
  // page+browser handle the browser_* tools opened.  Same fail-soft shape
  // as the playwright daemon cleanup above — closeAllPages already swallows
  // individual errors internally, but the outer try/catch is belt-and-braces
  // so any future close-throw doesn't shortcut the rest of shutdown().
  // Returns a Promise but we don't await it on the synchronous path here;
  // it's added to the Promise.allSettled below where it can run in parallel
  // with telegram/discord/server lock release.
  const pageRegistryShutdown = closeAllPages().catch(() => {});
  // Tear down Discord voice runtime — destroys Gateway websockets + voice
  // connections so the bot disappears from voice channels cleanly on quit.
  // Lazy-import so we don't pull discord.js into cold-start when voice is
  // never used.
  const voiceShutdown = import('./services/remote/discordVoiceRuntime.js')
    .then(m => m.getDiscordVoiceRuntime().shutdown())
    .catch(() => {});
  Promise.allSettled([
    _releaseTelegramLock(),
    _releaseDiscordLock(),
    voiceShutdown,
    pageRegistryShutdown,
    backgroundRunner.shutdown(),
    reminderScheduler.stop(),
    drainPostTurnTasks(runtimePaths.home, { timeoutMs: 2000 }).catch(() => {}).then(() => derivedIndexing.stop()),
    serverClosed,
    // Codex C fix #11 (review #12, 2026-05-04): server-lock release
    // moved here from a separate SIGINT/SIGTERM listener that was
    // pre-empting this shutdown() via Node's listener-order. Now
    // shutdown() owns the full release sequence so a single signal
    // handler reliably tears everything down.
    _releaseServerLock(),
    runtimePublication.then(() => releaseRuntime(runtimeIdentity)),
  ]).finally(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// uncaughtException / unhandledRejection — emergency-exit path.
// (Codex P2 from review #11/#12, 2026-05-04: hygiene cleanup
// previously didn't cover these paths. Top-level shutdown now does.)
//
// process state is untrusted after uncaught exception → don't try
// shutdown()'s async lock-release Promise chain (locks recover via
// next-start stale-lock detection). Synchronous owned-process cleanup fires
// reliably even from a corrupt event loop.
function _emergencyExit(label, errorObj) {
  try { process.stderr.write(`[melo-server] ${label}: ${errorObj?.stack || errorObj}\n`); } catch {}
  try { cleanupStalePlaywrightDaemons(); } catch {}
  process.exit(1);
}
process.on('uncaughtException', err => _emergencyExit('uncaughtException', err));
process.on('unhandledRejection', reason => _emergencyExit('unhandledRejection', reason));
