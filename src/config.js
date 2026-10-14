import { requestEnvironment, currentRequestContext, runWithRequestContext } from './runtime/requestScope.js';
import { createRequestContext } from './runtime/requestContext.js';
import { dirname, join } from 'node:path';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { getCodexAuthState } from './codexAuth.js';
import { atomicWriteJson } from './storage.js';
import { registerSearchTriggers as registerWebSearchTriggers } from './retrieval/searchRouter.js';
import { resolveRuntimePaths } from './runtime/paths.js';
import { DEFAULT_MODEL_CATALOGS, DEFAULT_MODELS_BY_AUTH_MODE } from './shared/modelCatalog.js';

export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
export const CODEX_OAUTH_BASE_URL = 'https://chatgpt.com/backend-api';
export const LOCAL_MODEL_BASE_URL = 'http://127.0.0.1:11434/v1';

export { DEFAULT_MODEL_CATALOGS, DEFAULT_MODELS_BY_AUTH_MODE } from './shared/modelCatalog.js';
export const VALID_AUTH_MODES = Object.freeze(['local', 'api-key', 'codex']);

export const DEFAULT_CONFIG = Object.freeze({
  extraFast: Object.freeze({ enabled: false, revision: 0, measurements: {} }),
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
  // Empty by default — was previously a baked-in cloned voice id, which
  // meant the moment a user added a MiniMax key (even just to test the
  // connector form), every TTS call routed through MiniMax with this preset
  // voice. No UX surface warned about it. Users now explicitly pick a
  // voice from the agent panel before MiniMax becomes the active path.
  minimaxVoiceId: '',
  ttsSpeed: 1.0,        // MiniMax voice_setting.speed: 0.5–2.0, 1.0 = normal
  ttsPitch: 0,          // MiniMax voice_setting.pitch: -12–12, 0 = normal
  ttsVol: 1.0,          // MiniMax voice_setting.vol: 0.1–10.0, 1.0 = normal
  ttsProvider: '',     // '' = default OpenAI | 'edge' = Edge TTS | 'minimax' = MiniMax
  ttsEdgeVoice: '',    // e.g. 'zh-CN-XiaoxiaoNeural'; empty = auto-detect by language
  ttsAutoPlay: false,  // "Auto-speak replies" — also enables Telegram voice reply
  // Monotonic revision number bumped by every model-config write that
  // carries an `_autosaveRevision` metadata field. Server uses it to
  // reject a stale autosave (older inflight fetch landing AFTER a
  // newer pending body) from overwriting fresher saved state. Reset
  // to 0 means "never autosaved"; explicit Save without the meta
  // field bumps to max(current, Date.now()), invalidating any
  // in-flight autosave revisions older than that. See
  // updateModelConfig in src/desktopStore.js + Codex audit 2026-04-28.
  autosaveRevision: 0,
  // Optional third-party API keys
  lastFmApiKey: '',    // https://www.last.fm/api/account/create
  tavilyApiKey: '',    // https://tavily.com (web search)
  serpApiKey: '',      // https://serpapi.com (web search)
  // Browser MCP flags — set to true to auto-launch browser automation servers
  enablePlaywrightMcp:  false,  // @playwright/mcp (brew install playwright required)
  enableBrowserlessMcp: false,  // @browserless/mcp (cloud browser, needs BROWSERLESS_TOKEN)
  // Productivity MCP flags — chart generation + document conversion.
  // ALL THREE default to false (Codex C 2026-04-29 二轮 audit):
  // even though the per-agent whitelist gates tool *call*, it does
  // NOT gate the npm download / install scripts / server startup
  // code that run as soon as `initMcpServers` spawns these stdio
  // children. Default-true would mean every fresh install executes
  // three external npm packages with zero user click, opening a
  // supply-chain attack surface that no in-melo gate can close.
  //
  // The product still recommends turning these on — that lives in
  // the first-boot consent modal (see `productivityMcpsConsented`
  // below) which lists the exact pinned versions and lets the user
  // either accept all three or skip with one click. Once accepted,
  // they ride through every later boot without a prompt.
  //
  // 4-layer security model (see docs/MCP-SECURITY.md):
  //   1. installed (npx can pull the package)
  //   2. globally enabled (this flag) — first-boot consent modal sets it
  //   3. agent authorised (agent.enabledMcpServerIds, deny-all default)
  //   4. per-call approval (tools/permissions.js modal)
  //
  // Browser MCPs (playwright/browserless) stay default-off too —
  // they ship browser automation that can read any URL (file://,
  // intranet) and need a different consent surface than the chart
  // / markdown ones bundled into the consent modal.
  enableAntvChartMcp:    false, // @antv/mcp-server-chart (25+ chart types)
  enableMarkdown2PdfMcp: false, // @99xio/markdown2pdf-mcp (md → PDF, local — does NOT render mermaid blocks)
  enableMermaidMcp:      false, // mcp-mermaid (hustcc / antv-team author, mermaid-isomorphic + playwright)
  // First-boot consent gate for the three productivity MCPs above.
  // Stays false until the user dismisses the consent modal in either
  // direction (Enable all / Skip). Once true, the modal is never
  // shown again on this MELO_HOME. Toggling the underlying flags
  // afterwards happens through Customize → Advanced as usual.
  productivityMcpsConsented: false,
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

// Past `DEFAULT_MODEL_CATALOGS.codex` shapes shipped by older melo
// builds.  Keys here are the exact arrays a user disk could contain
// because the user never explicitly customised the catalog —
// loadConfig() back then would just round-trip the default through
// disk on first save, leaving an indistinguishable fingerprint.
//
// Codex 2026-04-29 audit: when we change the default codex catalog
// (5.5+5.4+4.1, user feedback "为什么备选都是 4.1"), already-saved
// disks that match one of these obsolete fingerprints get the
// in-place upgrade. A genuinely-customised catalog (anything not
// in this list) is left alone — we can't safely guess intent.
const KNOWN_OBSOLETE_CODEX_CATALOGS = Object.freeze([
  Object.freeze(['gpt-5.5', 'gpt-5.4', 'gpt-4.1']),  // last pre-GPT-6 default
  Object.freeze(['gpt-5.4', 'gpt-4.1', 'gpt-4.1-mini']),  // pre-5.5 default
  Object.freeze(['gpt-5.5', 'gpt-4.1', 'gpt-4.1-mini']),  // 5.5 first cut, before B
]);

function arraysEqualOrdered(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * If the saved codex catalog exactly matches a previously-shipped
 * `DEFAULT_MODEL_CATALOGS.codex`, return the current default
 * (migrating in place). Otherwise return the saved catalog
 * unchanged — the user customised it, hands off.
 *
 * Pure helper.  Exported so tests can pin all three contract
 * branches (fresh / obsolete-persisted / custom).
 */
export function migrateCodexCatalog(savedCatalog) {
  if (!Array.isArray(savedCatalog)) return savedCatalog;
  for (const obsolete of KNOWN_OBSOLETE_CODEX_CATALOGS) {
    if (arraysEqualOrdered(savedCatalog, obsolete)) {
      return [...DEFAULT_MODEL_CATALOGS.codex];
    }
  }
  return savedCatalog;
}

export function normalizeAuthMode(value) {
  const candidate = String(value || '')
    .trim()
    .toLowerCase();
  return VALID_AUTH_MODES.includes(candidate) ? candidate : DEFAULT_CONFIG.authMode;
}

export function normalizeModelCatalogs(modelCatalogs = {}) {
  // Apply the codex-catalog migration BEFORE the falsy-fallback step.
  // Order matters: a missing `modelCatalogs.codex` (undefined) drops
  // straight to DEFAULT_MODEL_CATALOGS.codex, so migration only runs
  // when the user has a saved-but-obsolete shape on disk.
  const migratedCodex = migrateCodexCatalog(modelCatalogs.codex);
  return {
    local: normalizeCatalogEntry(modelCatalogs.local || DEFAULT_MODEL_CATALOGS.local),
    'api-key': normalizeCatalogEntry(
      modelCatalogs['api-key'] || DEFAULT_MODEL_CATALOGS['api-key'],
    ),
    codex: normalizeCatalogEntry(migratedCodex || DEFAULT_MODEL_CATALOGS.codex),
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

  // OAuth and API-key catalogs share OpenAI model IDs. Removing an older
  // model from the suggested OAuth list must not rewrite an explicit pin.
  if (['codex', 'api-key'].includes(normalizedAuthMode) &&
      ['codex', 'api-key'].some(mode => modelCatalogs?.[mode]?.includes(normalizedRequestedModel))) {
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

function normalizeConfigShape(config = {}, { skipModelNormalize = false } = {}) {
  const authMode = normalizeAuthMode(config.authMode || DEFAULT_CONFIG.authMode);
  const modelCatalogs = normalizeModelCatalogs(config?.modelCatalogs);
  // `skipModelNormalize` is the catalog-only opt-out for
  // `refreshModelCatalog`: when refresh writes a new catalog map,
  // the saved `model` may legitimately not appear in the new
  // catalog (e.g. user saved `gpt-4.1-mini` under api-key, then
  // refresh discovered only `['gpt-4.1']`). The default
  // `resolveModelForAuthMode` would silently fold the saved model
  // back to the catalog's first entry — that's a write to the
  // model field as a side effect of "Read available models",
  // which violates the catalog-only contract. Refresh therefore
  // passes `skipModelNormalize: true` so the saved model rides
  // through verbatim, and the user keeps explicit ownership of
  // the field.  Codex audit 2026-04-29.
  const incomingModel = String(config.model || '').trim();
  const resolvedModel = (skipModelNormalize || config.activeLlmProfileId)
    ? (incomingModel || resolveDefaultModelForAuthMode(authMode, modelCatalogs))
    : resolveModelForAuthMode({
        authMode,
        requestedModel: incomingModel,
        modelCatalogs,
      });
  return {
    ...DEFAULT_CONFIG,
    ...config,
    authMode,
    baseUrl: String(config.baseUrl || DEFAULT_CONFIG.baseUrl).trim(),
    model: resolvedModel,
    systemPrompt: String(config.systemPrompt || DEFAULT_CONFIG.systemPrompt),
    apiKey: String(config.apiKey || ''),
    whisperApiKey: String(config.whisperApiKey || ''),
    whisperBaseUrl: String(config.whisperBaseUrl || ''),
    modelCatalogs,
    webSearchTriggers: normalizeWebSearchTriggers(config.webSearchTriggers),
  };
}

export function getMeloHome() {
  return resolveRuntimePaths().home;
}

export function getConfigPath() {
  return join(getMeloHome(), 'config.json');
}

async function ensureParentDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function loadConfig({ skipModelNormalize = false } = {}) {
  // `skipModelNormalize` is the catalog-only opt-out propagated from
  // refresh/catalog-only callers (refreshModelCatalog,
  // getResolvedConfig({skipModelNormalize})). Without forwarding it
  // here, the very first read from disk would already fold the saved
  // out-of-catalog model — and any later `{skipModelNormalize:true}`
  // would be operating on the already-clobbered value, with no way
  // back to the user's saved choice. Default false keeps every other
  // caller — startup, regular saves, every loadConfig() outside the
  // refresh path — strictly normalized so a stale on-disk model
  // still gets safely folded to a real one. Codex audit 2026-04-29.
  const configPath = getConfigPath();

  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeConfigShape(parsed, { skipModelNormalize });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return normalizeConfigShape(DEFAULT_CONFIG, { skipModelNormalize });
    }

    throw new Error(`Failed to read config at ${configPath}: ${error.message}`);
  }
}

export async function saveConfig(nextConfig, options = {}) {
  // `options.skipModelNormalize` is forwarded to `normalizeConfigShape`
  // — see that function's comment block for why catalog-only writers
  // (refreshModelCatalog) need to bypass the model resolution step.
  const configPath = getConfigPath();
  await ensureParentDir(configPath);

  const payload = normalizeConfigShape(nextConfig, options);
  await atomicWriteJson(configPath, payload);
  await chmod(configPath, 0o600);
  return payload;
}

// Serialize every config read-modify-write through one queue. Without
// this, two concurrent `updateModelConfig` (or any `loadConfig → modify
// → saveConfig` caller) could both read the same baseline, both pass
// their guards (autosave revision check, keepIfBlank, etc.), and then
// race to saveConfig — last writer wins, silently clobbering the
// other's patch. Mirrors the queue pattern in src/state/stateStore.js.
// Codex audit 2026-04-28 (revision gate without atomicity is just
// a slower race).
const configWriteQueues = new Map();

/**
 * Run a config read-modify-write transaction under the shared
 * config queue. Caller's `work` function should perform the whole
 * `loadConfig → mutate → saveConfig` sequence inside its body.
 *
 * @template T
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withConfigLock(work) {
  const context = currentRequestContext() || createRequestContext();
  const key = context.home;
  const next = (configWriteQueues.get(key) || Promise.resolve()).catch(() => {}).then(() => runWithRequestContext(context, work));
  configWriteQueues.set(key, next);
  const cleanup = () => { if (configWriteQueues.get(key) === next) configWriteQueues.delete(key); };
  next.then(cleanup, cleanup);
  return next;
}

export async function updateConfig(key, value) {
  return withConfigLock(async () => {
    const current = await loadConfig();
    return saveConfig({
      ...current,
      [key]: value,
    });
  });
}

export async function getResolvedConfig({ skipModelNormalize = false } = {}) {
  const env = { ...requestEnvironment() };
  // `skipModelNormalize` propagates the catalog-only contract used
  // by `refreshModelCatalog` all the way through the API/UI surface
  // (Codex audit 2026-04-29). Without this, even after the on-disk
  // model survived `saveConfig({skipModelNormalize:true})`,
  // `getResolvedConfig` would re-fold it back to catalog[0] when
  // building the bootstrap response. The "Read available models"
  // click would then hand the front-end a silently rewritten
  // model, the form would render that value, and the next Save
  // would persist the wrong choice. Refresh-only path; default
  // remains the original strict normalization for normal startup
  // and saves so a stale on-disk value still gets safely folded.
  // Forward the catalog-only opt-out down into loadConfig so the
  // very first read from disk doesn't already fold the saved
  // out-of-catalog model — without this, the resolved-model logic
  // below would only ever see a pre-folded `fileConfig.model`.
  const fileConfig = await loadConfig({ skipModelNormalize });
  const authMode = normalizeAuthMode(
    (fileConfig.activeLlmProfileId ? fileConfig.authMode : env.MELO_AUTH_MODE || fileConfig.authMode) || DEFAULT_CONFIG.authMode,
  );
  const codexAuth = await getCodexAuthState();
  const baseUrl =
    fileConfig.activeLlmProfileId ? fileConfig.baseUrl : env.MELO_BASE_URL ||
    env.OPENAI_BASE_URL ||
    fileConfig.baseUrl;
  const normalizedBaseUrl =
    authMode === 'codex' && (!baseUrl || baseUrl === OPENAI_API_BASE_URL)
      ? CODEX_OAUTH_BASE_URL
      : baseUrl;
  const modelCatalogs = normalizeModelCatalogs(fileConfig.modelCatalogs);
  const requestedModel = fileConfig.activeLlmProfileId ? fileConfig.model : env.MELO_MODEL || fileConfig.model;
  const resolvedModel = (skipModelNormalize || fileConfig.activeLlmProfileId)
    ? (String(requestedModel || '').trim() || resolveDefaultModelForAuthMode(authMode, modelCatalogs))
    : resolveModelForAuthMode({
        authMode,
        requestedModel,
        modelCatalogs,
      });

  const resolved = {
    ...normalizeConfigShape(fileConfig, { skipModelNormalize }),
    provider: env.MELO_PROVIDER || fileConfig.provider,
    baseUrl: normalizedBaseUrl,
    model: resolvedModel,
    systemPrompt: env.MELO_SYSTEM_PROMPT || fileConfig.systemPrompt,
    authMode,
    apiKey: fileConfig.activeLlmProfileId ? fileConfig.apiKey :
      env.MELO_API_KEY ||
      env.OPENAI_API_KEY ||
      fileConfig.apiKey,
    modelCatalogs,
    codexAuth,
  };

  // Push user-defined web-search triggers into the openai.js module so that
  // `shouldEnableCodexNativeWebSearch` picks them up without threading config
  // through every call site. Called on every resolve — idempotent, cheap.
  if (!currentRequestContext()) registerWebSearchTriggers(resolved.webSearchTriggers);

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
