import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { getCodexAuthState } from './codexAuth.js';
import { atomicWriteJson } from './storage.js';
import { registerWebSearchTriggers } from './openai.js';

export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
export const CODEX_OAUTH_BASE_URL = 'https://chatgpt.com/backend-api';
export const LOCAL_MODEL_BASE_URL = 'http://127.0.0.1:11434/v1';

function deepFreezeCatalogs(catalogs) {
  for (const key of Object.keys(catalogs)) {
    if (Array.isArray(catalogs[key])) {
      Object.freeze(catalogs[key]);
    }
  }
  return Object.freeze(catalogs);
}

export const DEFAULT_MODEL_CATALOGS = deepFreezeCatalogs({
  local: ['llama3.1'],
  'api-key': ['gpt-4.1', 'gpt-4.1-mini'],
  codex: ['gpt-5.4', 'gpt-4.1', 'gpt-4.1-mini'],
});
export const VALID_AUTH_MODES = Object.freeze(['local', 'api-key', 'codex']);
export const DEFAULT_MODELS_BY_AUTH_MODE = Object.freeze({
  local: 'llama3.1',
  'api-key': 'gpt-4.1-mini',
  codex: 'gpt-5.4',
});

export const DEFAULT_CONFIG = Object.freeze({
  provider: 'openai-compatible',
  baseUrl: CODEX_OAUTH_BASE_URL,
  model: DEFAULT_MODELS_BY_AUTH_MODE.codex,
  systemPrompt:
    'You are Melo, a concise local coding assistant. Be practical, clear, and action-oriented.',
  authMode: 'codex',
  apiKey: '',
  // Dedicated Whisper transcription credentials. Used for audio/voice transcription
  // independently of the main chat API (useful in codex/local modes).
  whisperApiKey: '',
  whisperBaseUrl: '',
  modelCatalogs: DEFAULT_MODEL_CATALOGS,
  // Per-domain Cookie strings for authenticated web fetching.
  // Keys are hostnames (e.g. "y.qq.com", "bilibili.com"), values are Cookie header strings.
  // Example: { "y.qq.com": "uin=123456; skey=@abc123" }
  domainCookies: {},
  // Text-to-speech settings (reuses whisperApiKey / whisperBaseUrl credentials)
  ttsVoice: 'nova',   // OpenAI TTS voice: alloy | ash | coral | echo | nova | onyx | shimmer
  ttsModel: 'tts-1',  // tts-1 (fast) | tts-1-hd (higher quality) | gpt-4o-mini-tts
  // MiniMax T2A V2 — takes priority over OpenAI TTS when both fields are set
  minimaxApiKey: '',      // MiniMax platform API key
  minimaxGroupId: '',    // MiniMax GroupId (from platform dashboard)
  minimaxVoiceId: 'moss_audio_692b0bf2-37f0-11f1-8bff-3660266e7ed1',  // cloned voice
  ttsProvider: '',     // '' = default OpenAI | 'edge' = Edge TTS | 'minimax' = MiniMax
  ttsEdgeVoice: '',    // e.g. 'zh-CN-XiaoxiaoNeural'; empty = auto-detect by language
  ttsAutoPlay: false,  // "Auto-speak replies" — also enables Telegram voice reply
  // Optional third-party API keys
  lastFmApiKey: '',    // https://www.last.fm/api/account/create
  tavilyApiKey: '',    // https://tavily.com (web search)
  serpApiKey: '',      // https://serpapi.com (web search)
  // Browser MCP flags — set to true to auto-launch browser automation servers
  enablePlaywrightMcp:  false,  // @playwright/mcp (brew install playwright required)
  enableBrowserlessMcp: false,  // @browserless/mcp (cloud browser, needs BROWSERLESS_TOKEN)
  // Productivity MCP flags — chart generation + document conversion.
  // BOTH default to false: stdio MCP servers run arbitrary local
  // processes (file IO, network, exec), so the security model is
  // four-layer (see docs/MCP-SECURITY.md):
  //   1. installed (npx can pull the package)
  //   2. globally enabled (this flag) — server starts at boot
  //   3. agent authorised (agent.enabledMcpServerIds)
  //   4. per-call approval (tools/permissions.js modal)
  // Defaulting either flag to true would skip layers 3+4 the very
  // first time melo boots; explicit opt-in via Customize → Advanced
  // is required.
  enableAntvChartMcp:    false, // @antv/mcp-server-chart (25+ chart types)
  enableMarkdown2PdfMcp: false, // @99xio/markdown2pdf-mcp (md → PDF, local)
  // Extra web-search triggers (additive to built-in heuristics). Each item:
  //   { pattern: "regex source", flags?: "iu", weight: 2 }
  // Example:
  //   [{ pattern: "(港股|美股)行情", flags: "u", weight: 3 }]
  // User entries can only raise the search score; they cannot disable the
  // built-in triggers. Invalid regex strings are dropped silently.
  webSearchTriggers: [],
});

function normalizeCatalogEntry(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map(value => String(value || '').trim())
        .filter(Boolean),
    ),
  );
}

export function normalizeAuthMode(value) {
  const candidate = String(value || '')
    .trim()
    .toLowerCase();
  return VALID_AUTH_MODES.includes(candidate) ? candidate : DEFAULT_CONFIG.authMode;
}

export function normalizeModelCatalogs(modelCatalogs = {}) {
  return {
    local: normalizeCatalogEntry(modelCatalogs.local || DEFAULT_MODEL_CATALOGS.local),
    'api-key': normalizeCatalogEntry(
      modelCatalogs['api-key'] || DEFAULT_MODEL_CATALOGS['api-key'],
    ),
    codex: normalizeCatalogEntry(modelCatalogs.codex || DEFAULT_MODEL_CATALOGS.codex),
  };
}

function resolveDefaultModelForAuthMode(authMode, modelCatalogs = DEFAULT_MODEL_CATALOGS) {
  const normalizedAuthMode = normalizeAuthMode(authMode);
  const defaultModel = String(DEFAULT_MODELS_BY_AUTH_MODE[normalizedAuthMode] || '').trim();
  const catalog = Array.isArray(modelCatalogs?.[normalizedAuthMode]) ? modelCatalogs[normalizedAuthMode] : [];
  if (defaultModel && catalog.includes(defaultModel)) {
    return defaultModel;
  }
  return String(catalog[0] || defaultModel || DEFAULT_CONFIG.model).trim();
}

function resolveModelForAuthMode({ authMode, requestedModel, modelCatalogs }) {
  const normalizedRequestedModel = String(requestedModel || '').trim();
  if (!normalizedRequestedModel) {
    return resolveDefaultModelForAuthMode(authMode, modelCatalogs);
  }

  const normalizedAuthMode = normalizeAuthMode(authMode);
  const allowedCatalog = Array.isArray(modelCatalogs?.[normalizedAuthMode])
    ? modelCatalogs[normalizedAuthMode]
    : [];
  if (allowedCatalog.includes(normalizedRequestedModel)) {
    return normalizedRequestedModel;
  }

  const appearsInKnownCatalog = Object.values(modelCatalogs || {}).some(values =>
    Array.isArray(values) && values.includes(normalizedRequestedModel),
  );
  if (appearsInKnownCatalog) {
    return resolveDefaultModelForAuthMode(normalizedAuthMode, modelCatalogs);
  }

  return normalizedRequestedModel;
}

function normalizeWebSearchTriggers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(entry => {
      if (!entry || typeof entry !== 'object') return null;
      const patternStr = typeof entry.pattern === 'string' ? entry.pattern.trim() : '';
      if (!patternStr) return null;
      // Validate that the pattern compiles — drop invalid entries here so the
      // runtime `registerWebSearchTriggers` only ever sees good shapes.
      try {
        new RegExp(patternStr, typeof entry.flags === 'string' ? entry.flags : 'iu');
      } catch {
        return null;
      }
      const weight = Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : 1;
      return {
        pattern: patternStr,
        flags: typeof entry.flags === 'string' ? entry.flags : 'iu',
        weight,
      };
    })
    .filter(Boolean);
}

function normalizeConfigShape(config = {}) {
  const authMode = normalizeAuthMode(config.authMode || DEFAULT_CONFIG.authMode);
  const modelCatalogs = normalizeModelCatalogs(config?.modelCatalogs);
  return {
    ...DEFAULT_CONFIG,
    ...config,
    authMode,
    baseUrl: String(config.baseUrl || DEFAULT_CONFIG.baseUrl).trim(),
    model: resolveModelForAuthMode({
      authMode,
      requestedModel: config.model || DEFAULT_CONFIG.model,
      modelCatalogs,
    }),
    systemPrompt: String(config.systemPrompt || DEFAULT_CONFIG.systemPrompt),
    apiKey: String(config.apiKey || ''),
    whisperApiKey: String(config.whisperApiKey || ''),
    whisperBaseUrl: String(config.whisperBaseUrl || ''),
    modelCatalogs,
    webSearchTriggers: normalizeWebSearchTriggers(config.webSearchTriggers),
  };
}

export function getMeloHome() {
  return process.env.MELO_HOME || join(homedir(), '.melo');
}

export function getConfigPath() {
  return join(getMeloHome(), 'config.json');
}

async function ensureParentDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function loadConfig() {
  const configPath = getConfigPath();

  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeConfigShape(parsed);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return normalizeConfigShape(DEFAULT_CONFIG);
    }

    throw new Error(`Failed to read config at ${configPath}: ${error.message}`);
  }
}

export async function saveConfig(nextConfig) {
  const configPath = getConfigPath();
  await ensureParentDir(configPath);

  const payload = normalizeConfigShape(nextConfig);
  await atomicWriteJson(configPath, payload);
  return payload;
}

export async function updateConfig(key, value) {
  const current = await loadConfig();
  return saveConfig({
    ...current,
    [key]: value,
  });
}

export async function getResolvedConfig() {
  const fileConfig = await loadConfig();
  const authMode = normalizeAuthMode(
    process.env.MELO_AUTH_MODE || fileConfig.authMode || DEFAULT_CONFIG.authMode,
  );
  const codexAuth = await getCodexAuthState();
  const baseUrl =
    process.env.MELO_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    fileConfig.baseUrl;
  const normalizedBaseUrl =
    authMode === 'codex' && (!baseUrl || baseUrl === OPENAI_API_BASE_URL)
      ? CODEX_OAUTH_BASE_URL
      : baseUrl;
  const modelCatalogs = normalizeModelCatalogs(fileConfig.modelCatalogs);
  const resolvedModel = resolveModelForAuthMode({
    authMode,
    requestedModel: process.env.MELO_MODEL || fileConfig.model,
    modelCatalogs,
  });

  const resolved = {
    ...normalizeConfigShape(fileConfig),
    provider: process.env.MELO_PROVIDER || fileConfig.provider,
    baseUrl: normalizedBaseUrl,
    model: resolvedModel,
    systemPrompt: process.env.MELO_SYSTEM_PROMPT || fileConfig.systemPrompt,
    authMode,
    apiKey:
      process.env.MELO_API_KEY ||
      process.env.OPENAI_API_KEY ||
      fileConfig.apiKey,
    modelCatalogs,
    codexAuth,
  };

  // Push user-defined web-search triggers into the openai.js module so that
  // `shouldEnableCodexNativeWebSearch` picks them up without threading config
  // through every call site. Called on every resolve — idempotent, cheap.
  registerWebSearchTriggers(resolved.webSearchTriggers);

  return resolved;
}

export function maskApiKey(value) {
  if (!value) {
    return '(not set)';
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}***`;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
