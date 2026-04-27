import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySignedFileUrl, setServerOrigin } from './web/urlSigning.js';
import { isOriginAllowed } from './web/originCheck.js';
import { defaultSkillProposalStore } from './agents/skillProposals.js';
import { collectMemoryStatus, withLiveProviderModelId } from './memory/status.js';
import { wipeEmbeddingsForDimChange } from './memory/store.js';
import { getEmbeddingProvider } from './memory/embedProviders/createEmbeddingProvider.js';
import {
  applyArtifactToWorkspaceFile,
  createCustomAgent,
  createArtifact,
  updateArtifact,
  deleteArtifact,
  createApproval,
  createChat,
  createExternalConnector,
  createProject,
  createTask,
  deleteChat,
  executeApproval,
  getDesktopBootstrap,
  invokeExternalConnectorTool,
  pingExternalConnector,
  prepareDesktopLaunchState,
  processTelegramPollingCycle,
  processDiscordPollingCycle,
  previewExternalConnectorPrompt,
  readExternalConnectorResource,
  rejectApproval,
  removeExternalConnector,
  runTask,
  runTaskLane,
  runLocalCommand,
  saveWorkspaceFile,
  selectWorkspaceFile,
  readWorkspaceFilePreview,
  sendChatMessage,
  streamSearchFileGroups,
  createCustomSkill,
  updateCustomSkill,
  removeCustomSkill,
  exportSkillAsMarkdown,
  importSkillFromMarkdown,
  promoteSkillToDisk,
  reloadDiskSkills,
  scanRecentChatsForSkillProposals,
  applySkillProposal,
  draftSkillFromChat,
  toggleConnector,
  toggleSkill,
  testAgentChannelConnection,
  updateAgentProfile,
  updateChat,
  updateTask,
  updateDesktopSettings,
  updateExternalConnector,
  updateModelConfig,
  updateProject,
  refreshModelCatalog,
  initMcpServers,
} from './desktopStore.js';
import { startCodexOAuthLogin } from './codexAuth.js';
import {
  resolvePermission,
  getPendingPermissions,
  getSessionPermissions,
  clearSessionPermissions,
  checkPermissionRule,
} from './tools/permissions.js';
import { connectMcpServer, disconnectMcpServer, getActiveMcpServers } from './mcp/manager.js';
import { backgroundRunner } from './tasks/backgroundRunner.js';
import { registerPlugin, unregisterPlugin, getRegisteredPlugins, getPluginHooks } from './plugins/hooks.js';
import { getSkillRunStats } from './agents/skillRuns.js';

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
const _LOCK_DIR = String(
  process.env.MELO_HOME ||
    join(dirname(dirname(fileURLToPath(import.meta.url))), '.tmp', 'melo-home'),
);
const _TELEGRAM_LOCK_FILE = join(_LOCK_DIR, 'telegram-poller.lock');
const _DISCORD_LOCK_FILE = join(_LOCK_DIR, 'discord-poller.lock');
const _SERVER_LOCK_FILE = join(_LOCK_DIR, 'melo-desktop-server.lock');

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
// Scan for ANY other node process running this repo's src/server.js, not just
// the PID recorded in the lock file. A stray `node src/server.js` launched
// before the Swift launcher can hold open handles on the same state.json and
// double-poll the same Telegram/Discord bots without ever having written to the
// lock file — so a pure PID-file check misses it. This scan is the backstop:
// if `ps` shows a SECOND node server.js, refuse to boot.
async function _scanForOtherServerInstances() {
  const { execFile } = await import('node:child_process');
  return new Promise(resolve => {
    execFile(
      'ps',
      ['-axo', 'pid=,command='],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        const selfPid = process.pid;
        const hits = [];
        for (const rawLine of String(stdout).split('\n')) {
          const line = rawLine.trim();
          if (!line) continue;
          const match = line.match(/^(\d+)\s+(.*)$/);
          if (!match) continue;
          const otherPid = Number(match[1]);
          const cmd = match[2];
          if (!otherPid || otherPid === selfPid) continue;
          // Target: any node invocation whose command line references this
          // repo's src/server.js. We look for the literal "src/server.js"
          // substring — both the Swift launcher form and a bare
          // `node src/server.js` from a terminal match.
          if (/\bnode\b/.test(cmd) && /src\/server\.js/.test(cmd)) {
            hits.push({ pid: otherPid, command: cmd });
          }
        }
        resolve(hits);
      },
    );
  });
}

async function _acquireServerLock() {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  try {
    await mkdir(_LOCK_DIR, { recursive: true });
  } catch {}
  // Belt-and-suspenders check: before trusting the PID file, look at the
  // process table. If another node is already running server.js, bail
  // regardless of what the lock file says. Previously a stray
  // `node src/server.js` could predate the Swift launcher, never write to
  // the lock file, and the later Swift-launched server would happily take
  // the lock while the stray kept polling — producing duplicate Telegram
  // replies.
  const otherInstances = await _scanForOtherServerInstances();
  if (otherInstances.length) {
    return { acquired: false, holderPid: otherInstances[0].pid, otherInstances };
  }
  try {
    const existing = await readFile(_SERVER_LOCK_FILE, 'utf8').catch(() => '');
    const existingPid = parseInt(existing.trim(), 10);
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0);
        return { acquired: false, holderPid: existingPid };
      } catch {
        // Stale lock — the holder is gone, we may take over.
      }
    }
  } catch {}
  try {
    await writeFile(_SERVER_LOCK_FILE, String(process.pid));
    return { acquired: true };
  } catch {
    return { acquired: false, holderPid: null };
  }
}

async function _releaseServerLock() {
  const { readFile, unlink } = await import('node:fs/promises');
  try {
    const pid = parseInt((await readFile(_SERVER_LOCK_FILE, 'utf8')).trim(), 10);
    if (pid === process.pid) {
      await unlink(_SERVER_LOCK_FILE).catch(() => {});
    }
  } catch {}
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
  const _releaseOnExit = () => {
    // fire-and-forget; we're shutting down either way
    _releaseServerLock().catch(() => {});
  };
  process.on('exit', _releaseOnExit);
  process.on('SIGINT', () => { _releaseOnExit(); process.exit(130); });
  process.on('SIGTERM', () => { _releaseOnExit(); process.exit(143); });
}

await prepareDesktopLaunchState();

// Memory runtime — resolves providers (incl. shadow/routes), picks an
// embedding backend and arms the dreaming scheduler.  Never throws: any
// failure is logged and the server continues to boot.  Shutdown handler below
// calls `_memoryRuntime.stop()` to release timers.
const { startMemoryRuntime } = await import('./memory/runtime.js');
const _memoryRuntime = await startMemoryRuntime().catch(err => {
  process.stderr.write(`[memory.runtime] boot failed: ${err?.message || err}\n`);
  return { stop: () => {}, schedulerStarted: false };
});
if (_memoryRuntime?.schedulerStarted) {
  process.stdout.write('[memory.runtime] dreaming scheduler armed\n');
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

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
  if (isOriginAllowed(origin, host, port)) return true;

  sendJson(response, 403, {
    ok: false,
    error: 'FORBIDDEN_ORIGIN',
    message: `Origin "${origin}" is not allowed for this endpoint.`,
  });
  return false;
}

function startSse(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write(':ok\n\n');
}

function writeSseEvent(response, event, payload) {
  if (response.writableEnded || response.destroyed) {
    return;
  }

  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw);
}

function getStaticPath(urlPath) {
  if (urlPath === '/' || urlPath === '/index.html') {
    return join(uiDir, 'index.html');
  }

  return join(uiDir, urlPath.replace(/^\/+/, ''));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${host}:${port}`);

    if (url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    // ── Vendored Three.js from node_modules ─────────────────────────────────
    // The Demon 3D renderer (globe-flight, solar-system, …) needs Three.js on
    // the client. We serve the ESM build + its add-ons from node_modules via
    // stable URLs so the frontend importmap can resolve `three` and
    // `three/addons/...` without any bundler.
    if (url.pathname.startsWith('/vendor/three/') && request.method === 'GET') {
      const sub = url.pathname.slice('/vendor/three/'.length);
      // Only allow the two roots we actually need: the ESM build and the
      // example add-ons. Everything else 404s, preventing directory traversal
      // and casual probing of node_modules.
      let absPath = null;
      if (sub === 'three.module.min.js' || sub === 'three.module.js') {
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
    }

    // ── Shared classifier modules from src/media/ ────────────────────────────
    // The composer's Link button needs the same URL classifier that text-paste
    // promotion uses (detectUrlKind / promoteTextUrlsToAttachments) so that
    // YouTube links, .mp3, .pdf, etc. produce identical kind / mimeType / title
    // regardless of how the user attached them. The module is pure regex with
    // no Node dependencies — safe to import from the browser.
    if (url.pathname === '/shared/urlDetector.js' && request.method === 'GET') {
      const absPath = join(rootDir, 'src', 'media', 'urlDetector.js');
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
        sendJson(response, 404, { error: 'Shared module not found.' });
      }
      return;
    }

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
    if ((url.pathname === '/api/files/signed' || url.pathname.startsWith('/api/files/signed/')) && request.method === 'GET') {
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
    }

    if (url.pathname === '/api/launch/reset' && request.method === 'GET') {
      await prepareDesktopLaunchState();
      sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
      sendJson(response, 200, await getDesktopBootstrap(url.searchParams.get('q') || ''));
      return;
    }

    if (url.pathname === '/api/search/files' && request.method === 'GET') {
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
    }

    if (url.pathname === '/api/chats' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await createChat(body));
      return;
    }

    if (url.pathname === '/api/chats/update' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateChat(body.chatId, body.patch || {}));
      return;
    }

    if (url.pathname === '/api/chats/delete' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await deleteChat(body.chatId));
      return;
    }

    if (url.pathname === '/api/chat/send' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const abortController = new AbortController();
      const abortRequest = () => abortController.abort();
      request.once('aborted', abortRequest);
      response.once('close', () => {
        if (!response.writableFinished) {
          abortRequest();
        }
      });

      try {
        const payload = await sendChatMessage({
          ...body,
          signal: abortController.signal,
        });
        if (!response.writableEnded) {
          sendJson(response, 200, payload);
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          response.destroy();
          return;
        }
        throw error;
      }
      return;
    }

    if (url.pathname === '/api/chat/send/stream' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const abortController = new AbortController();
      const abortRequest = () => abortController.abort();
      request.once('aborted', abortRequest);
      response.once('close', () => {
        if (!response.writableFinished) {
          abortRequest();
        }
      });

      startSse(response);
      writeSseEvent(response, 'started', {
        chatId: body.chatId,
      });

      try {
        const payload = await sendChatMessage({
          ...body,
          signal: abortController.signal,
          onDelta: async chunk => {
            writeSseEvent(response, 'delta', chunk);
          },
          onReasoningDelta: async chunk => {
            writeSseEvent(response, 'reasoning', chunk);
          },
          sseEmitter: (event, data) => {
            writeSseEvent(response, event, data);
          },
        });

        writeSseEvent(response, 'done', payload);
        response.end();
      } catch (error) {
        if (abortController.signal.aborted) {
          writeSseEvent(response, 'aborted', {
            ok: true,
          });
          response.end();
          return;
        }

        writeSseEvent(response, 'error', {
          error: error?.message || 'Streaming request failed.',
        });
        response.end();
      }
      return;
    }

    // ── TTS endpoint ─────────────────────────────────────────────────────────
    if (url.pathname === '/api/tts/speak' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const text = String(body?.text || '').trim();
      if (!text) {
        sendJson(response, 400, { ok: false, error: 'text is required.' });
        return;
      }
      const { getResolvedConfig } = await import('./config.js');
      const { synthesizeSpeech, getTtsUnavailableReason } = await import('./tts.js');
      const config = await getResolvedConfig();
      const unavailable = getTtsUnavailableReason(config);
      if (unavailable) {
        sendJson(response, 422, { ok: false, error: unavailable });
        return;
      }
      const result = await synthesizeSpeech(text, config, {
        voice: body?.voice || undefined,
        model: body?.model || undefined,
      });
      if (!result) {
        sendJson(response, 502, {
          ok: false,
          error: 'TTS synthesis failed. Check that your API key supports the /audio/speech endpoint.',
        });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        audio: result.buffer.toString('base64'),
        mimeType: result.mimeType,
      });
      return;
    }

    // ── TTS sentence queue (streaming TTS: parallel synthesis, ordered playback) ─
    // Each sentence is synthesized in parallel but played in submission order.
    // Endpoint: /api/tts/queue-add  — add sentence, starts synthesis immediately
    //           /api/tts/queue-clear — stop playback & discard pending sentences
    if (url.pathname === '/api/tts/queue-add' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const text = String(body?.text || '').trim();
      if (!text) { sendJson(response, 400, { ok: false, error: 'text required' }); return; }
      const { getResolvedConfig } = await import('./config.js');
      const { getTtsUnavailableReason } = await import('./tts.js');
      const config = await getResolvedConfig();
      const unavailable = getTtsUnavailableReason(config);
      if (unavailable) { sendJson(response, 422, { ok: false, error: unavailable }); return; }
      // Start synthesis immediately; add its Promise to ordered playback queue
      // Edge TTS uses CLI synthesis; everything else goes through _synthesizeWithRecovery
      const audioPromise = config.ttsProvider === 'edge'
        ? _synthesizeWithEdgeTts(text, config)
        : _synthesizeWithRecovery(text, config, { voice: body?.voice });
      if (!globalThis._ttsQueue) globalThis._ttsQueue = [];
      const sessionId = globalThis._ttsQueueSession || 0;
      globalThis._ttsQueue.push({ audioPromise, sessionId });
      sendJson(response, 200, { ok: true });
      _runTtsQueue();
      return;
    }

    if (url.pathname === '/api/tts/queue-clear' && request.method === 'POST') {
      globalThis._ttsQueueSession = ((globalThis._ttsQueueSession || 0) + 1);
      globalThis._ttsQueue = [];
      if (globalThis._meloAfplayProcess) {
        try { globalThis._meloAfplayProcess.kill(); } catch {}
        globalThis._meloAfplayProcess = null;
      }
      if (globalThis._meloSayProcess) {
        try { globalThis._meloSayProcess.kill(); } catch {}
        globalThis._meloSayProcess = null;
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    // ── TTS synthesize-and-play (single utterance, bypasses WKWebView) ────────
    if (url.pathname === '/api/tts/speak-play' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const text = String(body?.text || '').trim();
      if (!text) {
        sendJson(response, 400, { ok: false, error: 'text is required.' });
        return;
      }
      const { getResolvedConfig } = await import('./config.js');
      const { synthesizeSpeech, getTtsUnavailableReason } = await import('./tts.js');
      const config = await getResolvedConfig();
      const unavailable = getTtsUnavailableReason(config);
      if (unavailable) {
        sendJson(response, 422, { ok: false, error: unavailable });
        return;
      }
      sendJson(response, 200, { ok: true });
      (async () => {
        try {
          const result = await _synthesizeWithRecovery(text, config, { voice: body?.voice });
          if (result?.buffer) await _playBufferWithAfplay(result.buffer, result.mimeType);
          else process.stderr.write('[tts/speak-play] synthesis returned null — no audio played\n');
        } catch (err) {
          process.stderr.write(`[tts/speak-play] ${err?.message || err}\n`);
        }
      })();
      return;
    }

    // ── speak-text: full-text TTS with sentence chunking ─────────────────────
    // Used by both the manual "Read aloud" button and auto-speak after streaming.
    // When ttsProvider='edge': sends full text to Edge TTS in one shot (~1-2s).
    // Otherwise: splits into sentences, synthesises in parallel via Fish Speech.
    if (url.pathname === '/api/tts/speak-text' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const text = String(body?.text || '').trim();
      if (!text) { sendJson(response, 400, { ok: false, error: 'text required' }); return; }
      const { getResolvedConfig } = await import('./config.js');
      const { getTtsUnavailableReason } = await import('./tts.js');
      const config = await getResolvedConfig();

      // ── Edge TTS fast path ────────────────────────────────────────────────
      if (config.ttsProvider === 'edge') {
        sendJson(response, 200, { ok: true, chunks: 1 });
        if (!globalThis._speakTextSession) globalThis._speakTextSession = 0;
        const sessionId = ++globalThis._speakTextSession;
        (async () => {
          try {
            const result = await _synthesizeWithEdgeTts(text, config);
            if (!result) { process.stderr.write('[edge-tts] synthesis returned null\n'); return; }
            if (globalThis._speakTextSession !== sessionId) return;
            await _playBufferWithAfplay(result.buffer, result.mimeType);
          } catch (e) {
            process.stderr.write(`[edge-tts] error: ${e?.message || e}\n`);
          }
        })();
        return;
      }

      // ── MiniMax fast path ─────────────────────────────────────────────────
      if (config.ttsProvider === 'minimax') {
        sendJson(response, 200, { ok: true, chunks: 1 });
        if (!globalThis._speakTextSession) globalThis._speakTextSession = 0;
        const sessionId = ++globalThis._speakTextSession;
        (async () => {
          try {
            const { synthesizeSpeech } = await import('./tts.js');
            const result = await synthesizeSpeech(text, config);
            if (!result) { process.stderr.write('[minimax-tts] synthesis returned null\n'); return; }
            if (globalThis._speakTextSession !== sessionId) return;
            await _playBufferWithAfplay(result.buffer, result.mimeType);
          } catch (e) {
            process.stderr.write(`[minimax-tts] error: ${e?.message || e}\n`);
          }
        })();
        return;
      }

      // ── Fish Speech / OpenAI path ─────────────────────────────────────────
      if (getTtsUnavailableReason(config)) {
        sendJson(response, 422, { ok: false, error: getTtsUnavailableReason(config) }); return;
      }

      // Split text into sentences (≤ 110 chars each — under F5-TTS 120-char limit)
      const sentences = _splitSentences(text, 110);

      sendJson(response, 200, { ok: true, chunks: sentences.length });

      if (!globalThis._speakTextSession) globalThis._speakTextSession = 0;
      const sessionId = ++globalThis._speakTextSession;

      (async () => {
        // Synthesise all sentences in parallel, then concatenate into a single
        // WAV and play once — eliminates inter-sentence gaps entirely.
        const audioPromises = sentences.map(s => _synthesizeWithRecovery(s, config, { voice: body?.voice }));
        let results;
        try {
          results = await Promise.all(audioPromises);
        } catch (e) {
          process.stderr.write(`[tts/speak-text] synthesis error: ${e?.message || e}\n`);
          return;
        }
        if (globalThis._speakTextSession !== sessionId) return; // stopped while synthesising

        const wavBuffers = results
          .filter(r => r?.buffer && /wav/i.test(r?.mimeType || ''))
          .map(r => r.buffer);

        if (wavBuffers.length > 0) {
          try {
            const combined = _concatWavBuffers(wavBuffers);
            await _playBufferWithAfplay(combined, 'audio/wav');
          } catch (e) {
            process.stderr.write(`[tts/speak-text] playback error: ${e?.message || e}\n`);
          }
        } else {
          // Fallback: non-WAV results (e.g. remote mp3) — play sequentially
          for (const result of results) {
            if (globalThis._speakTextSession !== sessionId) break;
            if (result?.buffer) {
              try { await _playBufferWithAfplay(result.buffer, result.mimeType); } catch {}
            }
          }
        }
      })();
      return;
    }

    // ── Stop afplay TTS ───────────────────────────────────────────────────────
    if (url.pathname === '/api/tts/speak-stop' && request.method === 'POST') {
      // Invalidate speak-text session so in-flight loops stop
      globalThis._speakTextSession = (globalThis._speakTextSession || 0) + 1;
      if (globalThis._meloAfplayProcess) {
        try { globalThis._meloAfplayProcess.kill(); } catch {}
        globalThis._meloAfplayProcess = null;
      }
      if (globalThis._meloSayProcess) {
        try { globalThis._meloSayProcess.kill(); } catch {}
        globalThis._meloSayProcess = null;
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    // ── Test playback for a candidate MiniMax config ─────────────────────────
    // Lets the connector settings UI verify a MiniMax key/groupId/voiceId
    // BEFORE persisting. Body: { apiKey, groupId, voiceId, text? }.
    // synthesizeSpeech receives a one-shot config override (no global save)
    // and on success the audio plays through host speakers via afplay so
    // the user hears the result immediately.
    if (url.pathname === '/api/tts/test-minimax' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const apiKey  = String(body?.apiKey  || '').trim();
      const groupId = String(body?.groupId || '').trim();
      const voiceId = String(body?.voiceId || '').trim();
      const text    = String(body?.text || '你好，这是 MiniMax 测试朗读').slice(0, 200);
      if (!apiKey || !voiceId) {
        sendJson(response, 400, { ok: false, error: 'apiKey and voiceId are required' });
        return;
      }
      try {
        const { testMinimaxSynthesis } = await import('./tts.js');
        // testMinimaxSynthesis explicitly ignores env vars so the user
        // tests the values they just typed, not a stale MINIMAX_API_KEY.
        const result = await testMinimaxSynthesis(text, { apiKey, groupId, voiceId });
        if (!result) {
          sendJson(response, 502, { ok: false, error: 'MiniMax synthesis returned null — check API key, Group ID, and voice ID.' });
          return;
        }
        // Play through host speakers (same pattern as /api/tts/speak-text).
        sendJson(response, 200, { ok: true, bytes: result.buffer.length });
        _playBufferWithAfplay(result.buffer, result.mimeType).catch(e => {
          process.stderr.write(`[tts/test-minimax] playback error: ${e?.message || e}\n`);
        });
      } catch (e) {
        sendJson(response, 400, { ok: false, error: e?.message || 'Unexpected error during synthesis' });
      }
      return;
    }

    // ── Native TTS via macOS `say` command (plays audio directly on host) ────
    // Uses `say` without -o so audio plays through system speakers immediately.
    // Responds immediately; a separate /api/tts/native-stop can kill the process.
    //
    // The UI now passes an explicit `voice` parameter (selected from
    // /api/tts/say-voices). Falls back to the legacy lang→voice heuristic
    // (Tingting/Yuna/Kyoko) when no explicit voice is supplied — preserves
    // backward-compatible behavior for any caller that hasn't migrated.
    if (url.pathname === '/api/tts/native' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const text = String(body?.text || '').trim().slice(0, 400);
      if (!text) {
        sendJson(response, 400, { ok: false, error: 'text is required.' });
        return;
      }
      const { spawn } = await import('node:child_process');
      const explicitVoice = String(body?.voice || '').trim();
      const lang = String(body?.lang || '').toLowerCase();
      const args = [];
      if (explicitVoice) {
        // UI selected a specific voice from the macOS voice list — trust it.
        // `say -v <name>` is happy with any output of `say -v '?'`.
        args.push('-v', explicitVoice);
      } else if (lang.startsWith('zh') || lang.startsWith('cmn')) {
        args.push('-v', 'Tingting');
      } else if (lang.startsWith('ko')) {
        args.push('-v', 'Yuna');
      } else if (lang.startsWith('ja')) {
        args.push('-v', 'Kyoko');
      }
      args.push('--', text);
      // Kill any running say process first
      if (globalThis._meloSayProcess) {
        try { globalThis._meloSayProcess.kill(); } catch {}
        globalThis._meloSayProcess = null;
      }
      const proc = spawn('/usr/bin/say', args, { detached: false });
      globalThis._meloSayProcess = proc;
      proc.on('exit', () => { if (globalThis._meloSayProcess === proc) globalThis._meloSayProcess = null; });
      sendJson(response, 200, { ok: true });
      return;
    }

    // ── List macOS `say` voices ──────────────────────────────────────────────
    // Parses `say -v '?'` output into [{ name, lang, sample }] so the UI can
    // populate the macOS voice dropdown with the actual voices installed on
    // this Mac (instead of recycling the browser's speechSynthesis list,
    // which is what the legacy "System voice" UI did and was confusingly
    // ineffective). Returns an empty list on non-macOS hosts.
    if (url.pathname === '/api/tts/say-voices' && request.method === 'GET') {
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const { parseSayVoiceList } = await import('./tts.js');
        const { stdout } = await execFileAsync('/usr/bin/say', ['-v', '?'], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        });
        sendJson(response, 200, { ok: true, voices: parseSayVoiceList(stdout) });
      } catch (err) {
        // Non-macOS host or `say` missing — empty list, not an error.
        sendJson(response, 200, { ok: true, voices: [], reason: err?.message || 'say unavailable' });
      }
      return;
    }

    // ── Stop native TTS (legacy path kept as alias) ───────────────────────────
    if (url.pathname === '/api/tts/native-stop' && request.method === 'POST') {
      if (globalThis._meloSayProcess) {
        try { globalThis._meloSayProcess.kill(); } catch {}
        globalThis._meloSayProcess = null;
      }
      if (globalThis._meloAfplayProcess) {
        try { globalThis._meloAfplayProcess.kill(); } catch {}
        globalThis._meloAfplayProcess = null;
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    // ── Audio transcription endpoint ─────────────────────────────────────────
    if (url.pathname === '/api/audio/transcribe' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const audioUrl = String(body?.url || '').trim();
      if (!audioUrl) {
        sendJson(response, 400, { ok: false, error: 'url is required.' });
        return;
      }
      const { getResolvedConfig } = await import('./config.js');
      const { extractAudioContent } = await import('./media/extractors/audioExtractor.js');
      const config = await getResolvedConfig();
      try {
        const result = await extractAudioContent(
          { kind: 'audio', url: audioUrl, name: 'audio' },
          { config },
        );
        const text = result?.content || result?.text || '';
        sendJson(response, 200, { ok: true, text });
      } catch (err) {
        sendJson(response, 500, { ok: false, error: err?.message || 'Transcription failed.' });
      }
      return;
    }

    // ── Tool permission endpoints ────────────────────────────────────────────
    if (url.pathname === '/api/tools/permission-response' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const { requestId, granted, scope = 'once', toolId = '' } = body;
      if (!requestId) {
        sendJson(response, 400, { ok: false, error: 'requestId is required.' });
        return;
      }
      const result = await resolvePermission(requestId, Boolean(granted), scope, toolId);
      sendJson(response, result.ok ? 200 : 404, result);
      return;
    }

    if (url.pathname === '/api/tools/pending-permissions' && request.method === 'GET') {
      sendJson(response, 200, { requestIds: getPendingPermissions() });
      return;
    }

    // Session permission rules (in-memory, cleared on restart).
    // Accepts optional ?chatId=<id> for per-chat isolation; without it,
    // returns the union across all chats / clears everything (legacy behavior).
    if (url.pathname === '/api/tools/session-permissions' && request.method === 'GET') {
      const chatIdParam = url.searchParams.get('chatId') || undefined;
      sendJson(response, 200, getSessionPermissions(chatIdParam));
      return;
    }

    if (url.pathname === '/api/tools/session-permissions/clear' && request.method === 'POST') {
      const chatIdParam = url.searchParams.get('chatId') || undefined;
      clearSessionPermissions(chatIdParam);
      sendJson(response, 200, { ok: true });
      return;
    }

    // Persistent permission rules (saved to config)
    if (url.pathname === '/api/tools/permission-rules' && request.method === 'GET') {
      const { getResolvedConfig } = await import('./config.js');
      const config = await getResolvedConfig();
      sendJson(response, 200, { rules: Array.isArray(config.toolPermissionRules) ? config.toolPermissionRules : [] });
      return;
    }

    if (url.pathname === '/api/tools/permission-rules/remove' && request.method === 'POST') {
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
      const { loadConfig, saveConfig } = await import('./config.js');
      const current = await loadConfig();
      const rules = Array.isArray(current.toolPermissionRules) ? current.toolPermissionRules : [];
      const updated = rules.filter(r => r.toolId !== toolId);
      await saveConfig({ ...current, toolPermissionRules: updated });
      sendJson(response, 200, { ok: true, rules: updated });
      return;
    }

    // ── MCP server management endpoints ─────────────────────────────────────
    if (url.pathname === '/api/mcp/servers' && request.method === 'GET') {
      sendJson(response, 200, { servers: getActiveMcpServers() });
      return;
    }

    if (url.pathname === '/api/mcp/connect' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const { name, command, args, env } = body;
      if (!name || !command) {
        sendJson(response, 400, { ok: false, error: 'name and command are required.' });
        return;
      }
      const result = await connectMcpServer(name, { command, args: args || [], env: env || {} });
      sendJson(response, result.connected ? 200 : 500, { ok: result.connected, ...result });
      return;
    }

    if (url.pathname === '/api/mcp/disconnect' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const { name } = body;
      if (!name) {
        sendJson(response, 400, { ok: false, error: 'name is required.' });
        return;
      }
      disconnectMcpServer(name);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/mcp/reload' && request.method === 'POST') {
      await initMcpServers();
      sendJson(response, 200, { ok: true, servers: getActiveMcpServers() });
      return;
    }

    // ── Background task endpoints ────────────────────────────────────────────
    // Start a background shell command and stream its output via SSE.
    if (url.pathname === '/api/background-tasks/run' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const { command, workspacePath, timeout } = body;
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

      const runId = backgroundRunner.start({
        command,
        workspacePath,
        timeout: timeout || undefined,
        signal: abortController.signal,
        onComplete: (record) => {
          writeSseEvent(response, 'done', {
            runId: record.id,
            status: record.status,
            exitCode: record.exitCode,
          });
          response.end();
        },
      });

      writeSseEvent(response, 'started', { runId });

      // Subscribe to output and forward as SSE chunks
      const catchUp = backgroundRunner.subscribe(runId, chunk => {
        writeSseEvent(response, 'output', { chunk });
      });
      if (catchUp) {
        writeSseEvent(response, 'output', { chunk: catchUp });
      }

      return;
    }

    if (url.pathname === '/api/background-tasks/status' && request.method === 'GET') {
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
    }

    if (url.pathname === '/api/background-tasks/kill' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const { runId } = body;
      if (!runId) {
        sendJson(response, 400, { ok: false, error: 'runId is required.' });
        return;
      }
      backgroundRunner.kill(runId);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/background-tasks/list' && request.method === 'GET') {
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
    }

    // ── Plugin hook management endpoints ────────────────────────────────────
    if (url.pathname === '/api/plugins' && request.method === 'GET') {
      const plugins = getRegisteredPlugins().map(id => ({
        id,
        hooks: getPluginHooks(id),
      }));
      sendJson(response, 200, { plugins });
      return;
    }

    if (url.pathname === '/api/plugins/unregister' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const { pluginId } = body;
      if (!pluginId) {
        sendJson(response, 400, { ok: false, error: 'pluginId is required.' });
        return;
      }
      unregisterPlugin(pluginId);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/projects' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await createProject(body));
      return;
    }

    if (url.pathname === '/api/projects/update' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateProject(body.projectId, body.patch || {}));
      return;
    }

    if (url.pathname === '/api/tasks' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await createTask(body));
      return;
    }

    if (url.pathname === '/api/tasks/update' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateTask(body.taskId, body.patch || {}));
      return;
    }

    if (url.pathname === '/api/tasks/run' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await runTask(body.taskId));
      return;
    }

    if (url.pathname === '/api/tasks/run-lane' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await runTaskLane(body.owner));
      return;
    }

    if (url.pathname === '/api/approvals' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await createApproval(body));
      return;
    }

    if (url.pathname === '/api/approvals/execute' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await executeApproval(body.approvalId));
      return;
    }

    if (url.pathname === '/api/approvals/reject' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await rejectApproval(body.approvalId));
      return;
    }

    if (url.pathname === '/api/connectors/external' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await createExternalConnector(body));
      return;
    }

    if (url.pathname === '/api/connectors/external/update' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateExternalConnector(body.connectorId, body.patch || {}));
      return;
    }

    if (url.pathname === '/api/connectors/external/remove' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await removeExternalConnector(body.connectorId));
      return;
    }

    if (url.pathname === '/api/connectors/external/ping' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await pingExternalConnector(body.connectorId));
      return;
    }

    if (url.pathname === '/api/connectors/external/resource' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await readExternalConnectorResource(body));
      return;
    }

    if (url.pathname === '/api/connectors/external/prompt' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await previewExternalConnectorPrompt(body));
      return;
    }

    if (url.pathname === '/api/connectors/external/invoke' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await invokeExternalConnectorTool(body));
      return;
    }

    if (url.pathname === '/api/workspace/select-file' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await selectWorkspaceFile(body.filePath));
      return;
    }

    if (url.pathname === '/api/workspace/save-file' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await saveWorkspaceFile(body));
      return;
    }

    // Read-only workspace-file preview for the citation side viewer.
    // Unlike select-file, this does NOT mutate state; it just returns the
    // file contents so the UI can render them in the source drawer beside
    // the chat. Path traversal / absolute paths are rejected by the
    // underlying workspace-file service, so only files inside the active
    // project's workspacePath can be read.
    if (url.pathname === '/api/workspace/citation-preview' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await readWorkspaceFilePreview(body));
      return;
    }

    if (url.pathname === '/api/artifacts' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await createArtifact(body));
      return;
    }

    if (url.pathname === '/api/artifacts/apply' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await applyArtifactToWorkspaceFile(body));
      return;
    }

    if (url.pathname === '/api/artifacts/update' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateArtifact(body?.artifactId, body?.patch || {}));
      return;
    }

    if (url.pathname === '/api/artifacts/delete' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await deleteArtifact(body?.artifactId));
      return;
    }

    if (url.pathname === '/api/command/run' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await runLocalCommand(body));
      return;
    }

    if (url.pathname === '/api/settings' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateDesktopSettings(body));
      return;
    }

    if (url.pathname === '/api/settings/model' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateModelConfig(body));
      return;
    }

    if (url.pathname === '/api/settings/model/options' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await refreshModelCatalog(body));
      return;
    }

    if (url.pathname === '/api/settings/model/oauth/start' && request.method === 'POST') {
      sendJson(response, 200, await startCodexOAuthLogin());
      return;
    }

    if (url.pathname === '/api/customize/skill-toggle' && request.method === 'POST') {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      sendJson(response, 200, await toggleSkill(body.skillId));
      return;
    }

    if (url.pathname === '/api/customize/connector-toggle' && request.method === 'POST') {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      sendJson(response, 200, await toggleConnector(body.connectorId));
      return;
    }

    if (url.pathname === '/api/skills/custom' && request.method === 'POST') {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      sendJson(response, 200, await createCustomSkill(body.skill));
      return;
    }

    if (url.pathname === '/api/skills/custom/update' && request.method === 'POST') {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateCustomSkill(body.skillId, body.patch));
      return;
    }

    if (url.pathname === '/api/skills/custom/remove' && request.method === 'POST') {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      sendJson(response, 200, await removeCustomSkill(body.skillId));
      return;
    }

    // Phase 5C — UI entry point for "Save chat as skill".
    // The body is `{ chatId, hint? }`. The response is the `{ ok, skill?, error?,
    // reason?, raw? }` envelope from draftSkillFromConversation. We never
    // auto-persist the drafted skill — the UI pre-fills the create-skill form
    // with it and the user confirms manually, mirroring the REPL flow.
    if (url.pathname === '/api/skills/draft-from-chat' && request.method === 'POST') {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      const result = await draftSkillFromChat(String(body?.chatId || ''), {
        hint: String(body?.hint || ''),
      });
      sendJson(response, 200, result);
      return;
    }

    // Phase 3.1.3 — export a skill (built-in or custom) as SKILL.md. GET-only,
    // query-string driven so it's trivial to hit from the browser or a curl
    // debug script: /api/skills/export?id=<skillId>. Body is JSON
    // {id, markdown} to keep UI parsing symmetric with import.
    if (url.pathname === '/api/skills/export' && request.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      if (!id) {
        sendJson(response, 400, { error: 'missing ?id= query parameter' });
        return;
      }
      try {
        const result = await exportSkillAsMarkdown(id);
        sendJson(response, 200, result);
      } catch (err) {
        sendJson(response, 404, { error: err.message });
      }
      return;
    }

    // Phase 3.1.3 — import a skill from SKILL.md text. Body:
    //   { markdown: "---\nname: …\n---\n…", writeToDisk?: bool, idOverride?: string }
    // Returns the refreshed bootstrap envelope on success.
    if (url.pathname === '/api/skills/import' && request.method === 'POST') {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      try {
        const bootstrap = await importSkillFromMarkdown(String(body?.markdown || ''), {
          writeToDisk: Boolean(body?.writeToDisk),
          idOverride: body?.idOverride ? String(body.idOverride) : null,
        });
        sendJson(response, 200, bootstrap);
      } catch (err) {
        sendJson(response, 400, { error: err.message });
      }
      return;
    }

    // Phase 3.1.3 — promote a JSON-only custom skill to disk (mirrors it to
    // ~/.melo/desktop/skills/<id>/SKILL.md and flips origin).
    if (url.pathname === '/api/skills/promote-to-disk' && request.method === 'POST') {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      try {
        const bootstrap = await promoteSkillToDisk(String(body?.skillId || ''));
        sendJson(response, 200, bootstrap);
      } catch (err) {
        sendJson(response, 400, { error: err.message });
      }
      return;
    }

    // Phase 3.1.3 — force-reload disk skills after the user manually edited a
    // SKILL.md on disk. UI exposes this as a "Refresh from disk" button in
    // Customize → Skills.
    if (url.pathname === '/api/skills/reload-disk' && request.method === 'POST') {
      if (!requireLocalOrigin(request, response)) return;
      try {
        const bootstrap = await reloadDiskSkills();
        sendJson(response, 200, bootstrap);
      } catch (err) {
        sendJson(response, 500, { error: err.message });
      }
      return;
    }

    // Phase 3.3.4 — skill-run telemetry for the health panel. Read-only,
    // local-only server so no Origin gate is required.
    if (url.pathname === '/api/skills/runs/stats' && request.method === 'GET') {
      try {
        const skillId = url.searchParams.get('skillId') || undefined;
        const windowDaysRaw = url.searchParams.get('windowDays');
        const windowDays = windowDaysRaw && !isNaN(Number(windowDaysRaw))
          ? Number(windowDaysRaw)
          : undefined;
        const stats = getSkillRunStats({ skillId, windowDays });
        sendJson(response, 200, stats);
      } catch (err) {
        sendJson(response, 500, { error: err.message });
      }
      return;
    }

    // Phase 3 — memory subsystem status for the Customize → Memory panel.
    // Pure read-only: collectMemoryStatus opens store.sqlite read-only, never
    // touches state.json or _meta.  Safe to poll from the UI without any
    // rate-limiting.  If an embedding provider is currently configured we
    // also check for modelId drift so the UI can flash a warning chip.
    if (url.pathname === '/api/memory/status' && request.method === 'GET') {
      try {
        const base = collectMemoryStatus();
        let providerModelId = null;
        try {
          const embedder = await getEmbeddingProvider();
          providerModelId = embedder?.modelId || null;
        } catch {
          // Provider init failure is non-fatal for the status view — the
          // snapshot still shows stored state, just without the live check.
        }
        sendJson(response, 200, withLiveProviderModelId(base, providerModelId));
      } catch (err) {
        sendJson(response, 500, { error: err?.message || String(err) });
      }
      return;
    }

    // Phase 3 — explicit destructive action: wipe every stored embedding so
    // the next embed pass repopulates from the current provider's vector
    // space.  Requires an explicit `{ confirm: "YES, WIPE EMBEDDINGS" }`
    // body token — the UI must show a confirmation dialog before sending.
    // Memory rows themselves are untouched; only the `embedding` column is
    // cleared and vec_memories is dropped + rebuilt on next write.
    // Rule 5 (preserve config): this endpoint does NOT touch state.json,
    // agent profiles, channel tokens, or any user-configured secret.
    if (url.pathname === '/api/memory/wipe-embeddings' && request.method === 'POST') {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      if (String(body?.confirm || '') !== 'YES, WIPE EMBEDDINGS') {
        sendJson(response, 400, {
          error: 'missing or invalid confirm token',
          expected: 'YES, WIPE EMBEDDINGS',
        });
        return;
      }
      try {
        let dims = Number(body?.dims);
        if (!Number.isFinite(dims) || dims <= 0) {
          // Fall back to whatever the provider reports, else the canonical.
          try {
            const embedder = await getEmbeddingProvider();
            dims = Number(embedder?.dims) || 1024;
          } catch {
            dims = 1024;
          }
        }
        const cleared = wipeEmbeddingsForDimChange(dims);
        sendJson(response, 200, { cleared, dims });
      } catch (err) {
        sendJson(response, 500, { error: err?.message || String(err) });
      }
      return;
    }

    // Read-only listing of background-clustered skill proposals (Phase 3D).
    // GET is safe — no Origin gate — but the route still only binds to
    // 127.0.0.1 by the server default.
    if (url.pathname === '/api/skill-proposals' && request.method === 'GET') {
      sendJson(response, 200, { proposals: defaultSkillProposalStore.list() });
      return;
    }

    if (url.pathname === '/api/skill-proposals/dismiss' && request.method === 'POST') {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      const dismissed = defaultSkillProposalStore.dismiss(body.seedId);
      sendJson(response, 200, { dismissed });
      return;
    }

    // Phase 3.4.1 — manual rescan trigger. The scan also fires
    // automatically after each assistant turn; this endpoint lets the UI
    // force one (e.g. after importing chats from another device).
    if (url.pathname === '/api/skill-proposals/rescan' && request.method === 'POST') {
      if (!requireLocalOrigin(request, response)) return;
      try {
        const result = await scanRecentChatsForSkillProposals();
        sendJson(response, 200, {
          ...result,
          proposals: defaultSkillProposalStore.list(),
        });
      } catch (err) {
        sendJson(response, 500, { error: err.message });
      }
      return;
    }

    // Phase 3.4.2 — apply an upgrade proposal. The UI calls this after the
    // user approves an upgrade card: it merges the proposed triggers into
    // the target skill, appends the systemPrompt appendix, and writes the
    // reference file. Create-kind proposals still go through the separate
    // skill-drafting flow.
    if (url.pathname.startsWith('/api/skill-proposals/')
        && url.pathname.endsWith('/apply')
        && request.method === 'POST') {
      if (!requireLocalOrigin(request, response)) return;
      const seedId = decodeURIComponent(
        url.pathname.slice('/api/skill-proposals/'.length, -'/apply'.length),
      );
      try {
        const result = await applySkillProposal(seedId);
        if (result?.ok) {
          sendJson(response, 200, result);
        } else {
          const status = result?.error === 'NOT_FOUND' ? 404
            : result?.error === 'BAD_SEED_ID' ? 400
            : result?.error === 'UNSUPPORTED_KIND' ? 400
            : result?.error === 'BUILTIN_TARGET' ? 400
            : result?.error === 'BUNDLED_TARGET' ? 403
            : result?.error === 'TARGET_MISSING' ? 404
            : result?.error === 'NO_STATE' ? 500
            : 400;
          sendJson(response, status, result || { ok: false, error: 'UNKNOWN' });
        }
      } catch (err) {
        sendJson(response, 500, { ok: false, error: 'INTERNAL', reason: err.message });
      }
      return;
    }

    if (url.pathname === '/api/agents/update' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(
        response,
        200,
        await updateAgentProfile(body.agentId, body.patch || {}, {
          scope: body.scope,
          projectId: body.projectId,
          clearProjectOverride: Boolean(body.clearProjectOverride),
          activeView: body.activeView,
        }),
      );
      return;
    }

    if (url.pathname === '/api/agents/create-custom' && request.method === 'POST') {
      sendJson(response, 200, await createCustomAgent());
      return;
    }

    if (url.pathname === '/api/agents/channel/test' && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(
        response,
        200,
        await testAgentChannelConnection(
          body.agentId,
          body.channelId,
          body.patch || {},
          {
            scope: body.scope,
            projectId: body.projectId,
          },
        ),
      );
      return;
    }

    const filePath = getStaticPath(url.pathname);
    const content = await readFile(filePath);
    response.writeHead(200, {
      'content-type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
    });
    response.end(content);
  } catch (error) {
    const statusCode = error?.code === 'ENOENT' ? 404 : 500;
    sendJson(response, statusCode, {
      error: error.message || 'Unknown server error.',
    });
  }
});

// ── WAV buffer concatenation ──────────────────────────────────────────────────
// Merges an array of PCM WAV buffers into a single WAV buffer.
// All inputs must have the same sample rate / channels / bit-depth (guaranteed
// when they all come from the same F5-TTS model).
function _concatWavBuffers(wavBuffers) {
  if (!wavBuffers.length) return Buffer.alloc(0);
  let sampleRate = 24000, numChannels = 1, bitsPerSample = 16;
  const pcmChunks = [];
  for (const buf of wavBuffers) {
    if (!buf || buf.length < 44) continue;
    numChannels   = buf.readUInt16LE(22);
    sampleRate    = buf.readUInt32LE(24);
    bitsPerSample = buf.readUInt16LE(34);
    // Locate 'data' sub-chunk (usually at offset 36, but search to be safe)
    let dataStart = 44;
    for (let i = 12; i < Math.min(buf.length - 8, 256); i++) {
      if (buf[i] === 0x64 && buf[i+1] === 0x61 && buf[i+2] === 0x74 && buf[i+3] === 0x61) {
        dataStart = i + 8; // skip 'data' tag (4) + size field (4)
        break;
      }
    }
    pcmChunks.push(buf.subarray(dataStart));
  }
  const pcm = Buffer.concat(pcmChunks);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);                                          // fmt chunk size
  header.writeUInt16LE(1, 20);                                           // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample >> 3), 28); // byte rate
  header.writeUInt16LE(numChannels * (bitsPerSample >> 3), 32);          // block align
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ── Sentence splitter for speak-text endpoint ────────────────────────────────
function _splitSentences(text, maxLen = 110) {
  const BREAK = /[。！？\n]|[.!?](?=\s|$)/;
  const sentences = [];
  let buf = '';
  for (const char of text) {
    buf += char;
    if (BREAK.test(char)) {
      const s = buf.trim();
      if (s.length >= 2) sentences.push(s);
      buf = '';
    }
    // Force-split if buffer exceeds maxLen (no punctuation in sight)
    if (buf.length >= maxLen) {
      const s = buf.trim();
      if (s.length >= 2) sentences.push(s);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail.length >= 2) sentences.push(tail);
  return sentences.length ? sentences : [text.slice(0, maxLen)];
}

// ── Edge TTS synthesis (Microsoft neural voices, ~1-2s, requires internet) ───
// Requires `edge-tts` CLI: pip install edge-tts
// Auto-resolves binary from MELO_EDGE_TTS_BIN env, system PATH, and common conda/pip locations.
async function _resolveEdgeTtsBin() {
  // 1. Explicit env override
  if (process.env.MELO_EDGE_TTS_BIN) return process.env.MELO_EDGE_TTS_BIN;

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const { homedir } = await import('node:os');

  // 2. Common install paths (conda, pip user install, pyenv, homebrew python)
  const home = homedir();
  const candidates = [
    // System / PATH — try first
    'edge-tts',
    // Anaconda / Miniconda
    `${home}/opt/anaconda3/bin/edge-tts`,
    `${home}/anaconda3/bin/edge-tts`,
    `${home}/miniconda3/bin/edge-tts`,
    `${home}/opt/miniconda3/bin/edge-tts`,
    // pip user install
    `${home}/.local/bin/edge-tts`,
    // Homebrew Python
    '/opt/homebrew/bin/edge-tts',
    '/usr/local/bin/edge-tts',
  ];

  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ['--version'], { timeout: 3000 });
      return bin;
    } catch {}
  }
  return 'edge-tts'; // last resort — let it fail with a clear error
}

async function _synthesizeWithEdgeTts(text, config = {}) {
  const { execFile } = await import('node:child_process');
  const { readFile, unlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: jp } = await import('node:path');

  const input = String(text || '').trim().slice(0, 4096);
  if (!input) return null;

  // Auto-detect language and pick the best neural voice
  const hasChinese = /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(input);
  const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF]/.test(input);
  const hasKorean = /[\uAC00-\uD7AF\u1100-\u11FF]/.test(input);
  let defaultVoice;
  if (hasChinese) defaultVoice = 'zh-CN-XiaoxiaoNeural';
  else if (hasJapanese) defaultVoice = 'ja-JP-NanamiNeural';
  else if (hasKorean) defaultVoice = 'ko-KR-SunHiNeural';
  else defaultVoice = 'en-US-AriaNeural';

  const voice = String(config.ttsEdgeVoice || defaultVoice);
  const tmpFile = jp(tmpdir(), `melo-edge-tts-${Date.now()}.mp3`);
  const bin = await _resolveEdgeTtsBin();

  return new Promise((resolve) => {
    execFile(
      bin,
      ['--voice', voice, '--text', input, '--write-media', tmpFile],
      { timeout: 30_000 },
      async (err) => {
        if (err) {
          process.stderr.write(`[edge-tts] exec error (bin=${bin}): ${err.message}\n`);
          resolve(null);
          return;
        }
        try {
          const buffer = await readFile(tmpFile);
          resolve({ buffer, mimeType: 'audio/mpeg' });
        } catch (e) {
          process.stderr.write(`[edge-tts] read error: ${e.message}\n`);
          resolve(null);
        } finally {
          unlink(tmpFile).catch(() => {});
        }
      },
    );
  });
}

// ── TTS synthesis with F5-TTS auto-recovery ───────────────────────────────────
// Wraps synthesizeSpeech: if synthesis returns null (e.g. F5-TTS in broken state),
// restarts the voice-pack server and retries once.
async function _synthesizeWithRecovery(text, config, opts = {}) {
  const { synthesizeSpeech } = await import('./tts.js');
  let result = await synthesizeSpeech(text, config, opts);
  if (result) return result;

  // Synthesis returned null — check if this is a local F5-TTS endpoint
  const whisperUrl = String(config?.whisperBaseUrl || '');
  if (!/127\.0\.0\.1:7860/.test(whisperUrl)) return null; // remote endpoint, don't interfere

  process.stdout.write('[tts] Synthesis failed — restarting F5-TTS and retrying...\n');
  try {
    await startVoicePackServers({ force: true });
    const ready = await _waitForF5Tts(90_000);
    if (!ready) {
      process.stderr.write('[tts] F5-TTS did not recover within 90s.\n');
      return null;
    }
    result = await synthesizeSpeech(text, config, opts);
    if (result) {
      process.stdout.write('[tts] F5-TTS recovery successful.\n');
    } else {
      process.stderr.write('[tts] F5-TTS synthesis still failing after restart.\n');
    }
  } catch (err) {
    process.stderr.write(`[tts] Recovery error: ${err?.message || err}\n`);
  }
  return result;
}

async function _waitForF5Tts(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = 'http://127.0.0.1:7860/health';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 4000));
  }
  return false;
}

// ── TTS helpers ───────────────────────────────────────────────────────────────
async function _playBufferWithAfplay(buffer, mimeType) {
  const { writeFile, unlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: jp } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const ext = mimeType === 'audio/mpeg' ? 'mp3' : 'wav';
  const tmpFile = jp(tmpdir(), `melo-tts-${Date.now()}.${ext}`);
  await writeFile(tmpFile, buffer);
  await new Promise((resolve) => {
    if (globalThis._meloAfplayProcess) {
      try { globalThis._meloAfplayProcess.kill(); } catch {}
    }
    const proc = spawn('/usr/bin/afplay', [tmpFile], { detached: false });
    globalThis._meloAfplayProcess = proc;
    proc.on('exit', async () => {
      if (globalThis._meloAfplayProcess === proc) globalThis._meloAfplayProcess = null;
      await unlink(tmpFile).catch(() => {});
      resolve();
    });
    proc.on('error', resolve);
  });
}

async function _runTtsQueue() {
  if (globalThis._ttsQueueRunning) return;
  globalThis._ttsQueueRunning = true;
  while (globalThis._ttsQueue?.length > 0) {
    const item = globalThis._ttsQueue.shift();
    if (item.sessionId !== (globalThis._ttsQueueSession || 0)) continue; // stale
    try {
      const result = await item.audioPromise;
      if (item.sessionId !== (globalThis._ttsQueueSession || 0)) break; // cleared mid-flight
      if (result?.buffer) await _playBufferWithAfplay(result.buffer, result.mimeType);
    } catch (e) {
      process.stderr.write(`[tts-queue] ${e?.message || e}\n`);
    }
  }
  globalThis._ttsQueueRunning = false;
}

server.listen(port, host, () => {
  process.stdout.write(`Melo desktop server listening at http://${host}:${port}\n`);
  // Publish the origin so tools can mint signed file URLs against it.
  setServerOrigin(`http://${host}:${port}`);
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

function shutdown() {
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
  ]).finally(() => {
    server.close(() => {
      process.exit(0);
    });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
