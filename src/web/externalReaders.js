import { captureBehavior } from '../runtime/runtimeBehavior.js';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { debugWarn } from '../debug.js';

const execFile = promisify(execFileCallback);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(dirname(__dirname));
const MELO_FOLDER_ROOT = dirname(PROJECT_ROOT);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 20_000;
const MIN_USEFUL_CHARS = 120;

const READER_ORDER = Object.freeze(['crawl4ai', 'scrapling', 'camoufox']);
const SCRAPLING_OUTPUT_FILE = 'content.md';
const CAMOUFOX_SCRIPT = join(__dirname, 'camoufoxReader.py');

// PROJECT_EXTERNAL_READERS_DIR is path-derived (uses __dirname only, no env),
// so it's safe to capture at module load — won't drift at runtime.
const PROJECT_EXTERNAL_READERS_DIR = join(PROJECT_ROOT, '.tmp', 'external-readers');

// 2026-05-12 §6 audit: the `MELO_EXTERNAL_READERS_DIR` env var and the
// derived dir/bin/pipx-venv path arrays were captured at module load
// (`const = process.env... || join(...)`).  That's the same CLAUDE.md
// §6 pattern the G-6 audit (6/6, b73c118) just cleaned up across the
// repo — a fresh `MELO_EXTERNAL_READERS_DIR` set after import wouldn't
// take effect, defeating test isolation and multi-profile scenarios.
// Lazy-resolved through call-time getters now; `meloExternalReadersDir()`
// re-reads `process.env` on every invocation.
//
// `PROJECT_ROOT` / `MELO_FOLDER_ROOT` stay as module-load consts because
// they're derived from `__dirname` only — that's a property of the source
// file's location, never changes at runtime.
function meloExternalReadersDir() {
  return process.env.MELO_EXTERNAL_READERS_DIR || join(MELO_FOLDER_ROOT, 'external-readers');
}

function externalReadersDirs() {
  return [meloExternalReadersDir(), PROJECT_EXTERNAL_READERS_DIR];
}

function externalReadersBinDirs() {
  return externalReadersDirs().map(dir => join(dir, 'bin'));
}

function externalReadersPipxVenvsDirs() {
  return externalReadersDirs().map(dir => join(dir, 'pipx', 'venvs'));
}

const USER_LOCAL_BIN = join(homedir(), '.local/bin');

function pipxVenvsDirs() {
  return [
    ...externalReadersPipxVenvsDirs(),
    join(homedir(), '.local/pipx/venvs'),
    join(homedir(), '.local/share/pipx/venvs'),
  ];
}

async function isExecutable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable({
  envName,
  fallback,
  candidates = [],
  _runCommand,
}) {
  const explicit = String(process.env[envName] || '').trim();
  if (explicit) return explicit;

  // Test seams assert the logical command names; avoid leaking local machine
  // paths into unit tests that do not execute a real subprocess.
  if (typeof _runCommand === 'function') return fallback;

  for (const candidate of candidates) {
    if (candidate && await isExecutable(candidate)) return candidate;
  }
  return fallback;
}

function cleanExternalReaderText(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function isUsefulContent(text = '') {
  return cleanExternalReaderText(text).replace(/\s+/g, '').length >= MIN_USEFUL_CHARS;
}

function resolveCookiesForUrl(url, config = {}, explicitCookies = '') {
  const explicit = String(explicitCookies || '').trim();
  if (explicit) return explicit;

  const domainCookies = config?.domainCookies;
  if (!domainCookies || typeof domainCookies !== 'object') return '';

  try {
    const hostname = new URL(url).hostname.replace(/^www\./i, '');
    for (const [domain, cookieStr] of Object.entries(domainCookies)) {
      const normalizedDomain = String(domain || '').replace(/^\./, '').replace(/^www\./i, '');
      if (!normalizedDomain) continue;
      if (hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)) {
        return String(cookieStr || '').trim();
      }
    }
  } catch {
    return '';
  }
  return '';
}

async function runCommand(command, args, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  maxBuffer = 4 * 1024 * 1024,
  env = process.env,
  _runCommand,
} = {}) {
  if (typeof _runCommand === 'function') {
    return _runCommand(command, args, { timeoutMs, signal, maxBuffer, env });
  }
  const { stdout } = await execFile(command, args, {
    timeout: timeoutMs,
    signal,
    maxBuffer,
    env,
  });
  return stdout || '';
}

async function readWithCrawl4AI(url, {
  signal,
  maxChars = DEFAULT_MAX_CHARS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  _runCommand,
} = {}) {
  const bin = await resolveExecutable({
    envName: 'MELO_CRAWL4AI_BIN',
    fallback: 'crwl',
    candidates: [
      ...externalReadersBinDirs().map(dir => join(dir, 'crwl')),
      ...externalReadersPipxVenvsDirs().map(root => join(root, 'crawl4ai', 'bin', 'crwl')),
      join(USER_LOCAL_BIN, 'crwl'),
      '/opt/homebrew/bin/crwl',
      '/usr/local/bin/crwl',
    ],
    _runCommand,
  });
  const args = [
    'crawl',
    url,
    '-o',
    process.env.MELO_CRAWL4AI_OUTPUT || 'markdown-fit',
    '--bypass-cache',
  ];
  if (process.env.MELO_CRAWL4AI_BROWSER_CONFIG) {
    args.push('-B', process.env.MELO_CRAWL4AI_BROWSER_CONFIG);
  }
  if (process.env.MELO_CRAWL4AI_CRAWLER_CONFIG) {
    args.push('-C', process.env.MELO_CRAWL4AI_CRAWLER_CONFIG);
  }

  const raw = await runCommand(bin, args, {
    timeoutMs,
    signal,
    _runCommand,
  });
  const content = cleanExternalReaderText(raw).slice(0, maxChars);
  return isUsefulContent(content)
    ? { content, method: 'crawl4ai' }
    : null;
}

async function readWithScrapling(url, {
  signal,
  maxChars = DEFAULT_MAX_CHARS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cookies = '',
  config,
  _runCommand,
} = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'melo-scrapling-'));
  const outputPath = join(tempDir, SCRAPLING_OUTPUT_FILE);
  const bin = await resolveExecutable({
    envName: 'MELO_SCRAPLING_BIN',
    fallback: 'scrapling',
    candidates: [
      ...externalReadersBinDirs().map(dir => join(dir, 'scrapling')),
      ...externalReadersPipxVenvsDirs().map(root => join(root, 'scrapling', 'bin', 'scrapling')),
      join(USER_LOCAL_BIN, 'scrapling'),
      '/opt/homebrew/bin/scrapling',
      '/usr/local/bin/scrapling',
    ],
    _runCommand,
  });
  const cookieStr = resolveCookiesForUrl(url, config, cookies);
  const args = [
    'extract',
    'stealthy-fetch',
    url,
    outputPath,
    '--network-idle',
    '--ai-targeted',
    '--disable-resources',
    '--timeout',
    String(Math.max(1000, timeoutMs)),
  ];
  if (cookieStr) {
    args.push('-H', `Cookie: ${cookieStr}`);
  }

  try {
    await runCommand(bin, args, {
      timeoutMs: timeoutMs + 2500,
      signal,
      maxBuffer: 2 * 1024 * 1024,
      _runCommand,
    });
    const raw = await readFile(outputPath, 'utf8');
    const content = cleanExternalReaderText(raw).slice(0, maxChars);
    return isUsefulContent(content)
      ? { content, method: 'scrapling' }
      : null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readWithCamoufox(url, {
  signal,
  maxChars = DEFAULT_MAX_CHARS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cookies = '',
  config,
  _runCommand,
} = {}) {
  const pythonBin = await resolveExecutable({
    envName: 'MELO_CAMOUFOX_PYTHON',
    fallback: process.env.PYTHON || 'python3',
    candidates: [
      ...pipxVenvsDirs().map(root => join(root, 'camoufox/bin/python')),
      '/opt/homebrew/bin/python3.12',
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
    ],
    _runCommand,
  });
  const cookieStr = resolveCookiesForUrl(url, config, cookies);
  const raw = await runCommand(pythonBin, [
    CAMOUFOX_SCRIPT,
    url,
    String(maxChars),
    cookieStr,
  ], {
    timeoutMs: timeoutMs + 5000,
    signal,
    _runCommand,
  });

  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { content: raw };
  }

  const content = cleanExternalReaderText(payload?.content || '').slice(0, maxChars);
  return isUsefulContent(content)
    ? { content, method: payload?.method || 'camoufox', finalUrl: payload?.url || url }
    : null;
}

export async function readUrlWithExternalReader(kind, url, options = {}) {
  const behavior = options.behavior || captureBehavior(options.config);
  if (behavior.MELO_DISABLE_EXTERNAL_WEB_READERS === '1') return null;
  if (!READER_ORDER.includes(kind)) return null;

  if (kind === 'crawl4ai') return readWithCrawl4AI(url, options);
  if (kind === 'scrapling') return readWithScrapling(url, options);
  if (kind === 'camoufox') return readWithCamoufox(url, options);
  return null;
}

export async function readUrlWithExternalReaders(url, {
  preferred = READER_ORDER,
  signal,
  maxChars = DEFAULT_MAX_CHARS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cookies = '',
  config,
  _runCommand,
  behavior = captureBehavior(config),
} = {}) {
  if (behavior.MELO_DISABLE_EXTERNAL_WEB_READERS === '1') return null;

  const order = (Array.isArray(preferred) ? preferred : [preferred])
    .map(value => String(value || '').trim())
    .filter(value => READER_ORDER.includes(value));

  for (const kind of order) {
    if (signal?.aborted) return null;
    try {
      const result = await readUrlWithExternalReader(kind, url, {
        behavior,
        signal,
        maxChars,
        timeoutMs,
        cookies,
        config,
        _runCommand,
      });
      if (result?.content) return result;
    } catch (error) {
      debugWarn('external-reader', `${kind} failed for ${url}:`, error?.message || error);
    }
  }
  return null;
}

export const EXTERNAL_READER_ORDER = READER_ORDER;
