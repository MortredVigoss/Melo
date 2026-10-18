/**
 * web_screenshot tool
 *
 * Renders a public web page in the user's local Google Chrome and saves a PNG
 * screenshot into the chat workspace (`generated/screenshot-<uuid>.png`, the
 * same directory and signed-URL path the image tool uses), so the desktop UI
 * shows it as an attachment and the model can look at it.
 *
 * Rendering tiers, first that works:
 *   cdp       MELO_CDP_ENABLED=1 → attach to the running "Melo Chrome"
 *             (services/browser/connect.js) and open a page in its logged-in
 *             persistent context. Visible window, cookies and sessions apply.
 *   headless  otherwise, a one-shot headless launch of the same local Chrome
 *             binary through playwright-core. No login state.
 *   —         no Chrome binary → BROWSER_UNAVAILABLE (read the page with
 *             fetch_url instead). Nothing paid, nothing remote.
 *
 * Output: one line for the model plus a markdown image of the signed URL (the
 * UI turns markdown image URLs in replies into attachments). `meta.modelImage`
 * is a JPEG data URL (≤1280 px wide, ≤400 KB) the runner appends to the next
 * model request as an image input so the model can describe what it sees; it
 * never reaches persisted history (buildToolChainRecord drops it).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getMeloHome } from '../../config.js';
import { connectMeloChrome } from '../../services/browser/connect.js';
import { detectChromeBinary } from '../../services/browser/meloChrome.js';
import { requestEnvironment, currentRequestContext } from '../../runtime/requestScope.js';
import { isPublicHttpUrl } from '../urlSafety.js';

const GOTO_TIMEOUT_MS = 20_000;
const WAIT_FOR_TIMEOUT_MS = 8_000;
const SETTLE_MS = 600;
const DEFAULT_WIDTH = 1280;
const MIN_WIDTH = 480;
const MAX_WIDTH = 1920;
export const MAX_FULL_PAGE_HEIGHT = 6_000;
export const MODEL_IMAGE_MAX_WIDTH = 1280;
export const MODEL_IMAGE_MAX_BYTES = 400 * 1024;

// DI seams — tests inject fakes so no Chrome is launched. Production resolves
// the real implementations lazily (playwright-core / sharp stay off the cold
// startup path for users who never take a screenshot).
let _deps = {};
export function _setDepsForTests(deps = null) { _deps = deps && typeof deps === 'object' ? { ...deps } : {}; }

async function defaultLaunch(options) {
  const mod = await import('playwright-core');
  if (!mod?.chromium?.launch) throw new Error('playwright-core loaded but chromium.launch is missing');
  return mod.chromium.launch(options);
}

async function defaultSaveArtifact(directory, buffer, options) {
  const { saveImageArtifact } = await import('../../images/imageArtifacts.js');
  return saveImageArtifact(directory, buffer, options);
}

async function defaultEncodeModelImage(png) {
  let sharp;
  try { sharp = (await import('sharp')).default; } catch { return null; }
  const base = sharp(png, { limitInputPixels: 80_000_000 }).resize({ width: MODEL_IMAGE_MAX_WIDTH, withoutEnlargement: true });
  for (const quality of [72, 55, 40]) {
    const jpeg = await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (jpeg.length <= MODEL_IMAGE_MAX_BYTES) return jpeg;
  }
  return null;
}

async function defaultPngSize(png) {
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(png).metadata();
    return { width: meta.width || 0, height: meta.height || 0 };
  } catch { return { width: 0, height: 0 }; }
}

function abortError() { return new DOMException('Aborted', 'AbortError'); }

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || /timeout|timed out/i.test(String(error?.message || ''));
}

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === 'AbortError';
}

function clampWidth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(number)));
}

/** Load the page on an open Playwright page and capture it. */
async function capturePage(page, { url, fullPage, width, waitFor, signal, settleMs = SETTLE_MS }) {
  if (typeof page.setViewportSize === 'function') {
    try { await page.setViewportSize({ width, height: Math.round(width * 0.75) }); } catch { /* CDP pages may refuse; keep the window size */ }
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
  if (signal?.aborted) throw abortError();
  if (waitFor) {
    try { await page.waitForSelector(waitFor, { timeout: WAIT_FOR_TIMEOUT_MS }); } catch { /* best effort: screenshot what is there */ }
  }
  await sleep(Math.max(0, Number(settleMs) || 0), signal);
  const title = typeof page.title === 'function' ? await page.title().catch(() => '') : '';
  const finalUrl = typeof page.url === 'function' ? page.url() : url;
  const options = { type: 'png', fullPage: Boolean(fullPage) };
  let capped = false;
  if (fullPage) {
    const documentHeight = await page.evaluate(() => Math.max(
      document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0)).catch(() => 0);
    if (documentHeight > MAX_FULL_PAGE_HEIGHT) {
      capped = true;
      options.clip = { x: 0, y: 0, width, height: MAX_FULL_PAGE_HEIGHT };
    }
  }
  const png = await page.screenshot(options);
  if (signal?.aborted) throw abortError();
  return { png: Buffer.isBuffer(png) ? png : Buffer.from(png), title: String(title || ''), finalUrl: String(finalUrl || url), capped };
}

async function renderViaCdp(deps, options) {
  const { browser } = await deps.connect({ signal: options.signal });
  try {
    // The CDP-attached default context is the user's logged-in profile;
    // never create a fresh context here (it would have no cookies).
    const contexts = typeof browser.contexts === 'function' ? browser.contexts() : [];
    const context = (Array.isArray(contexts) && contexts[0]) ? contexts[0] : await browser.newContext();
    const page = await context.newPage();
    try { return await capturePage(page, options); }
    finally { try { await page.close(); } catch { /* best-effort */ } }
  } finally {
    // CDP detach only — the Chrome window stays open for reuse.
    try { await browser.close(); } catch { /* best-effort */ }
  }
}

async function renderHeadless(deps, executablePath, options) {
  const browser = await deps.launch({ executablePath, headless: true, args: ['--disable-gpu'] });
  try {
    const context = await browser.newContext({ viewport: { width: options.width, height: Math.round(options.width * 0.75) } });
    const page = await context.newPage();
    try { return await capturePage(page, options); }
    finally { try { await page.close(); } catch { /* best-effort */ } }
  } finally {
    try { await browser.close(); } catch { /* best-effort */ }
  }
}

function fail(error, output, extra = {}) {
  return { ok: false, error, output, meta: { executionStarted: false, ...extra } };
}

export const webScreenshotTool = {
  id: 'web_screenshot',
  name: 'Web Screenshot',
  description:
    'Take a screenshot of a public web page with the local Chrome and show it to the user as an image. ' +
    'Use this when the user wants to see what a page looks like; to read its text use fetch_url. ' +
    'Returns a markdown image of the saved PNG; the screenshot is also shown to you.',
  category: 'web',
  isConcurrencySafe: true,
  requiresPermission: false,
  capability: 'network',
  needsWorkspace: false,
  uiModule: 'search',
  inputKeys: ['url', 'fullPage', 'width', 'waitFor'],
  timeout: 60_000,
  parametersSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Public http(s) URL of the page to capture.' },
      fullPage: { type: 'boolean', description: 'Capture the whole scrollable page (capped at 6000 px tall) instead of the first screen. Default false.' },
      width: { type: 'integer', minimum: MIN_WIDTH, maximum: MAX_WIDTH, description: 'Viewport width in CSS pixels, 480–1920. Default 1280.' },
      waitFor: { type: 'string', description: 'Optional CSS selector to wait for (up to 8 s) before capturing, for pages that render late.' },
    },
    required: ['url'],
  },
  examples: [
    { url: 'https://example.com' },
    { url: 'https://news.ycombinator.com', fullPage: true, width: 1024 },
  ],

  async run({ url, fullPage = false, width, waitFor } = {}, context = {}) {
    const { signal, workspacePath } = context;
    const deps = {
      connect: connectMeloChrome,
      launch: defaultLaunch,
      chromeBinary: detectChromeBinary,
      chromeExists: path => existsSync(path),
      saveArtifact: defaultSaveArtifact,
      encodeModelImage: defaultEncodeModelImage,
      pngSize: defaultPngSize,
      env: null,
      settleMs: undefined,
      ..._deps,
      ...(context._screenshotDeps && typeof context._screenshotDeps === 'object' ? context._screenshotDeps : {}),
    };
    const checked = isPublicHttpUrl(url);
    if (!checked.ok) return fail('INVALID_URL', checked.reason);
    const selector = typeof waitFor === 'string' && waitFor.trim() ? waitFor.trim().slice(0, 200) : '';
    const viewportWidth = clampWidth(width ?? DEFAULT_WIDTH);
    const wantFullPage = fullPage === true;
    const env = deps.env || requestEnvironment();
    const cdpEnabled = env.MELO_CDP_ENABLED === '1';
    const binary = cdpEnabled ? null : deps.chromeBinary();
    const headlessAvailable = Boolean(binary && deps.chromeExists(binary));
    if (!cdpEnabled && !headlessAvailable) {
      return fail('BROWSER_UNAVAILABLE', 'No local Chrome found for screenshots; read the page with fetch_url instead.');
    }
    if (signal?.aborted) return fail('ABORTED', 'Screenshot cancelled.', { aborted: true });

    const renderOptions = { url: checked.url, fullPage: wantFullPage, width: viewportWidth, waitFor: selector, signal, settleMs: deps.settleMs ?? SETTLE_MS };
    const tier = cdpEnabled ? 'cdp' : 'headless';
    let captured;
    try {
      captured = cdpEnabled ? await renderViaCdp(deps, renderOptions) : await renderHeadless(deps, binary, renderOptions);
    } catch (error) {
      if (isAbortError(error, signal)) return { ok: false, error: 'ABORTED', output: 'Screenshot cancelled.', meta: { aborted: true, tier } };
      if (isTimeoutError(error)) return { ok: false, error: 'TIMEOUT', output: `The page did not finish loading within ${Math.round(GOTO_TIMEOUT_MS / 1000)} s: ${checked.url}`, meta: { timedOut: true, tier, url: checked.url } };
      const message = String(error?.message || error || 'unknown error');
      if (cdpEnabled && /Chrome binary|not found|ENOENT|playwright-core|Cannot find (package|module)/i.test(message)) {
        return { ok: false, error: 'BROWSER_UNAVAILABLE', output: `Melo Chrome is not available (${message.slice(0, 200)}); read the page with fetch_url instead.`, meta: { tier, url: checked.url } };
      }
      return { ok: false, error: 'LOAD_FAILED', output: `Could not render ${checked.url}: ${message.slice(0, 300)}`, meta: { tier, url: checked.url } };
    }
    if (signal?.aborted) return { ok: false, error: 'ABORTED', output: 'Screenshot cancelled.', meta: { aborted: true, tier } };

    const directory = typeof workspacePath === 'string' && workspacePath
      ? workspacePath
      : join(currentRequestContext()?.home || getMeloHome(), 'desktop', 'screenshots');
    const saved = await deps.saveArtifact(directory, captured.png, { prefix: 'screenshot', signal });
    const size = await deps.pngSize(saved.buffer || captured.png);
    const jpeg = await deps.encodeModelImage(saved.buffer || captured.png).catch(() => null);
    const title = captured.title.trim() || captured.finalUrl;
    const safeTitle = title.replace(/[\[\]\n\r]/g, ' ').trim().slice(0, 120) || 'page';
    const line = `Screenshot of "${safeTitle}" (${captured.finalUrl}, ${size.width}×${size.height}, tier ${tier}) saved.`;
    const note = captured.capped ? ` Full page capped at ${MAX_FULL_PAGE_HEIGHT} px.` : '';
    const loginNote = tier === 'headless' ? ' Headless render: no login state.' : '';
    return {
      ok: true,
      output: `${line}${note}${loginNote}\n\n![${safeTitle}](${saved.url})`,
      meta: {
        url: checked.url,
        finalUrl: captured.finalUrl,
        title: safeTitle,
        width: size.width,
        height: size.height,
        tier,
        fullPage: wantFullPage,
        capped: captured.capped,
        path: saved.path,
        signedUrl: saved.url,
        ...(jpeg ? { modelImage: `data:image/jpeg;base64,${jpeg.toString('base64')}` } : {}),
      },
    };
  },
};
