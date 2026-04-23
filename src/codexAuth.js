import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const CREDENTIAL_CACHE_TTL_MS = 60_000;
const NEGATIVE_CREDENTIAL_CACHE_TTL_MS = 5_000;
const MIN_TOKEN_VALIDITY_MS = 5 * 60_000;
const DEFAULT_CODEX_EXECUTABLE_CANDIDATES = Object.freeze([
  process.env.MELO_CODEX_PATH,
  process.env.CODEX_CLI_PATH,
  '/Applications/Codex.app/Contents/Resources/codex',
  '/usr/local/bin/codex',
  '/opt/homebrew/bin/codex',
  'codex',
]);
let cachedCredential = null;
let cachedCredentialResolvedAt = 0;

function escapeForAppleScript(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function getCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

// Legacy OpenClaw compatibility for older local installs that still store per-agent
// OAuth profiles under ~/.openclaw. Prefer ~/.codex/auth.json whenever it exists.
function getOpenClawHome() {
  return process.env.OPENCLAW_HOME || join(homedir(), '.openclaw');
}

export function getCodexAuthPath() {
  return join(getCodexHome(), 'auth.json');
}

function getOpenClawAuthProfilePaths() {
  const openClawHome = getOpenClawHome();
  return [
    join(openClawHome, 'agents', 'main', 'agent', 'auth-profiles.json'),
    join(openClawHome, 'agents', 'bot-2', 'agent', 'auth-profiles.json'),
  ];
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function isExpired(expiresAt) {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

async function readCodexAuthFile() {
  try {
    const raw = await readFile(getCodexAuthPath(), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null;
    }

    throw new Error(`Failed to read Codex auth file: ${error.message}`);
  }
}

async function readOpenClawAuthProfileFile() {
  for (const authPath of getOpenClawAuthProfilePaths()) {
    try {
      const raw = await readFile(authPath, 'utf8');
      const parsed = JSON.parse(raw);
      const profiles = parsed?.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {};
      const profileEntries = Object.entries(profiles);
      const prioritized = [
        profileEntries.find(([profileId, profile]) =>
          profileId === 'openai-codex:default' &&
          profile?.type === 'oauth' &&
          typeof profile?.access === 'string' &&
          profile.access.trim(),
        ),
        ...profileEntries.filter(([profileId, profile]) =>
          profileId !== 'openai-codex:default' &&
          profile?.provider === 'openai-codex' &&
          profile?.type === 'oauth' &&
          typeof profile?.access === 'string' &&
          profile.access.trim(),
        ),
      ].filter(Boolean);

      if (!prioritized.length) {
        continue;
      }

      const [profileId, profile] = prioritized[0];
      return {
        authPath,
        profileId,
        profile,
      };
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        continue;
      }

      throw new Error(`Failed to read OpenClaw auth profiles: ${error.message}`);
    }
  }

  return null;
}

function canUseCachedCredential(now = Date.now()) {
  if (!cachedCredential) {
    return false;
  }

  const ttlMs = cachedCredential.loggedIn
    ? CREDENTIAL_CACHE_TTL_MS
    : NEGATIVE_CREDENTIAL_CACHE_TTL_MS;
  if (now - cachedCredentialResolvedAt > ttlMs) {
    return false;
  }

  if (
    typeof cachedCredential.expiresAt === 'number' &&
    Number.isFinite(cachedCredential.expiresAt) &&
    cachedCredential.expiresAt - now <= MIN_TOKEN_VALIDITY_MS
  ) {
    return false;
  }

  return true;
}

function cacheResolvedCredential(credential) {
  cachedCredential = credential;
  cachedCredentialResolvedAt = Date.now();
  return credential;
}

export function invalidateCodexCredentialCache() {
  cachedCredential = null;
  cachedCredentialResolvedAt = 0;
}

function resolveAuthStateShape({
  source,
  authPath,
  authMode,
  accessToken,
  accountId,
  email,
  plan,
  expiresAt,
}) {
  const expired = isExpired(expiresAt);
  return {
    source,
    loggedIn: Boolean(accessToken) && !expired,
    authMode: authMode || null,
    email: email || null,
    plan: plan || null,
    accountId: accountId || null,
    expiresAt: expiresAt || null,
    expired,
    authPath,
    accessToken: accessToken || null,
  };
}

function resolveCodexFileCredential(authFile) {
  const accessToken = authFile?.tokens?.access_token || null;
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.['https://api.openai.com/auth'] || {};
  const profile = payload?.['https://api.openai.com/profile'] || {};
  const expiresAt = payload?.exp ? payload.exp * 1000 : null;

  return resolveAuthStateShape({
    source: 'codex',
    authPath: getCodexAuthPath(),
    authMode: authFile?.auth_mode || null,
    accessToken,
    accountId: auth.chatgpt_account_id || authFile?.tokens?.account_id || null,
    email: profile.email || null,
    plan: auth.chatgpt_plan_type || null,
    expiresAt,
  });
}

function resolveOpenClawCredential(openClawAuth) {
  const profile = openClawAuth?.profile || {};
  const accessToken = typeof profile.access === 'string' ? profile.access.trim() : '';
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.['https://api.openai.com/auth'] || {};
  const openaiProfile = payload?.['https://api.openai.com/profile'] || {};
  const expiresAt =
    Number.isFinite(Number(profile.expires)) && Number(profile.expires) > 0
      ? Number(profile.expires)
      : payload?.exp
        ? payload.exp * 1000
        : null;

  return resolveAuthStateShape({
    source: 'openclaw',
    authPath: openClawAuth?.authPath || null,
    authMode: 'oauth',
    accessToken,
    accountId: profile.accountId || auth.chatgpt_account_id || null,
    email: profile.email || openaiProfile.email || null,
    plan: auth.chatgpt_plan_type || null,
    expiresAt,
  });
}

async function resolveBestCodexCredential() {
  if (canUseCachedCredential()) {
    return cachedCredential;
  }

  const codexAuthFile = await readCodexAuthFile();
  const codexCredential = resolveCodexFileCredential(codexAuthFile);
  if (codexCredential.loggedIn) {
    return cacheResolvedCredential(codexCredential);
  }

  const openClawAuth = await readOpenClawAuthProfileFile();
  if (openClawAuth) {
    const openClawCredential = resolveOpenClawCredential(openClawAuth);
    if (openClawCredential.loggedIn) {
      return cacheResolvedCredential(openClawCredential);
    }

    if (!codexCredential.loggedIn && openClawCredential.accessToken) {
      return cacheResolvedCredential(openClawCredential);
    }
  }

  return cacheResolvedCredential(codexCredential);
}

export async function getCodexCredential() {
  return resolveBestCodexCredential();
}

export async function getCodexAuthState() {
  const credential = await getCodexCredential();
  return {
    loggedIn: credential.loggedIn,
    authMode: credential.authMode,
    email: credential.email,
    plan: credential.plan,
    accountId: credential.accountId,
    expiresAt: credential.expiresAt,
    expired: credential.expired,
    authPath: credential.authPath,
    source: credential.source,
  };
}

export async function getCodexAccessToken() {
  const credential = await getCodexCredential();
  if (!credential.loggedIn) {
    if (credential.expired) {
      throw new Error(
        'Codex login has expired. Reconnect Codex OAuth inside Melo and then retry.',
      );
    }
    throw new Error(
      'Codex login is not available. Connect Codex OAuth inside Melo and then retry.',
    );
  }

  return credential.accessToken;
}

export async function resolveCodexExecutable() {
  for (const candidate of DEFAULT_CODEX_EXECUTABLE_CANDIDATES) {
    const normalized = String(candidate || '').trim();
    if (!normalized) {
      continue;
    }

    if (normalized.includes('/')) {
      try {
        await access(normalized, constants.X_OK);
        return normalized;
      } catch {
        continue;
      }
    }

    try {
      const { stdout } = await execFile('which', [normalized]);
      const resolved = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean);
      if (resolved) {
        return resolved;
      }
    } catch {
      continue;
    }
  }

  return 'codex';
}

export async function startCodexOAuthLogin() {
  const codexExecutable = await resolveCodexExecutable();
  invalidateCodexCredentialCache();

  if (process.platform !== 'darwin') {
    return {
      launched: false,
      authPath: getCodexAuthPath(),
      manualCommand: `${codexExecutable} login --device-auth`,
      instructions:
        'Run this command in your terminal, complete the device-auth flow, and then refresh Melo.',
    };
  }

  const command = `${escapeForAppleScript(codexExecutable)} login --device-auth`;
  await execFile('osascript', [
    '-e',
    'tell application "Terminal"',
    '-e',
    'activate',
    '-e',
    `do script "${command}"`,
    '-e',
    'end tell',
  ]);
  invalidateCodexCredentialCache();

  return {
    launched: true,
    authPath: getCodexAuthPath(),
  };
}
