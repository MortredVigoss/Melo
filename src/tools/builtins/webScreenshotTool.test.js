// web_screenshot: rendering tiers, URL guard, error envelope and output shape.
// Chrome / playwright-core are replaced by fakes (`_setDepsForTests`); the
// PNG → artifact → JPEG path runs for real through sharp on a generated image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { webScreenshotTool, _setDepsForTests, MAX_FULL_PAGE_HEIGHT, MODEL_IMAGE_MAX_WIDTH, MODEL_IMAGE_MAX_BYTES } from './webScreenshotTool.js';
import { isPublicHttpUrl, isPrivateHostname } from '../urlSafety.js';
import { finalizeToolResult, TOOL_ERROR_CODES, toolCodeHint } from '../toolResult.js';

const URL_OK = 'https://example.com/page';
let png;
test.before(async () => {
  png = await sharp({ create: { width: 1400, height: 900, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toBuffer();
});

let prevEnv;
test.beforeEach(() => { prevEnv = process.env.MELO_CDP_ENABLED; delete process.env.MELO_CDP_ENABLED; });
test.afterEach(() => {
  _setDepsForTests(null);
  if (prevEnv === undefined) delete process.env.MELO_CDP_ENABLED; else process.env.MELO_CDP_ENABLED = prevEnv;
});

function fakePage({ title = 'Example Domain', url = URL_OK, documentHeight = 900, goto, image } = {}) {
  const calls = { goto: [], screenshot: [], viewport: [], waitFor: [], closed: 0 };
  const page = {
    setViewportSize: async size => { calls.viewport.push(size); },
    goto: async (target, options) => { calls.goto.push([target, options]); if (goto) return goto(target, options); return null; },
    waitForSelector: async (selector, options) => { calls.waitFor.push([selector, options]); },
    title: async () => title,
    url: () => url,
    evaluate: async () => documentHeight,
    screenshot: async options => { calls.screenshot.push(options); return image || png; },
    close: async () => { calls.closed += 1; },
  };
  return { page, calls };
}

function cdpDeps(pageFixture, extra = {}) {
  const calls = { connect: 0, browserClosed: 0, newContext: 0, launch: 0 };
  const browser = {
    contexts: () => [{ newPage: async () => pageFixture.page }],
    newContext: async () => { calls.newContext += 1; return { newPage: async () => pageFixture.page }; },
    close: async () => { calls.browserClosed += 1; },
  };
  _setDepsForTests({
    connect: async ({ signal } = {}) => { calls.connect += 1; if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); return { browser, port: 9222, reused: true }; },
    launch: async () => { calls.launch += 1; throw new Error('launch must not be used on the CDP tier'); },
    settleMs: 0,
    ...extra,
  });
  return calls;
}

function headlessDeps(pageFixture, extra = {}) {
  const calls = { launch: [], browserClosed: 0, contexts: [], connect: 0 };
  _setDepsForTests({
    connect: async () => { calls.connect += 1; throw new Error('connect must not be used on the headless tier'); },
    chromeBinary: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    chromeExists: () => true,
    launch: async options => {
      calls.launch.push(options);
      return { newContext: async opts => { calls.contexts.push(opts); return { newPage: async () => pageFixture.page }; }, close: async () => { calls.browserClosed += 1; } };
    },
    settleMs: 0,
    ...extra,
  });
  return calls;
}

async function withWorkspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'melo-web-screenshot-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('declaration: web tool, network capability, no workspace, declared input keys and error codes', () => {
  assert.equal(webScreenshotTool.id, 'web_screenshot');
  assert.equal(webScreenshotTool.category, 'web');
  assert.equal(webScreenshotTool.capability, 'network');
  assert.equal(webScreenshotTool.needsWorkspace, false);
  assert.equal(webScreenshotTool.isConcurrencySafe, true);
  assert.equal(webScreenshotTool.requiresPermission, false);
  assert.deepEqual(webScreenshotTool.inputKeys, ['url', 'fullPage', 'width', 'waitFor']);
  assert.deepEqual(webScreenshotTool.parametersSchema.required, ['url']);
  assert.equal(webScreenshotTool.parametersSchema.properties.width.minimum, 480);
  assert.equal(webScreenshotTool.parametersSchema.properties.width.maximum, 1920);
  for (const code of ['BROWSER_UNAVAILABLE', 'LOAD_FAILED']) {
    assert.ok(TOOL_ERROR_CODES.includes(code), code);
    assert.match(toolCodeHint(code), /fetch_url/);
  }
});

test('URL guard: only public http(s) without credentials', () => {
  assert.equal(isPublicHttpUrl('https://example.com/a?b=1').ok, true);
  for (const bad of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@example.com/',
    'http://localhost:3000', 'http://127.0.0.1:8080/', 'http://10.1.2.3/', 'http://172.20.0.1/', 'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/',
    'http://intranet/', 'http://printer.local/', 'not a url', '']) {
    assert.equal(isPublicHttpUrl(bad).ok, false, bad);
  }
  assert.equal(isPrivateHostname('8.8.8.8'), false);
  assert.equal(isPrivateHostname('100.70.0.1'), true);
});

test('private / invalid url → INVALID_URL before any browser work', async () => {
  const fixture = fakePage();
  const calls = cdpDeps(fixture);
  process.env.MELO_CDP_ENABLED = '1';
  for (const url of ['http://127.0.0.1:8080/admin', 'http://localhost/', 'https://u:p@example.com/', 'ftp://example.com/x', '']) {
    const result = finalizeToolResult(await webScreenshotTool.run({ url }));
    assert.equal(result.ok, false, url);
    assert.equal(result.error, 'INVALID_URL', url);
    assert.equal(result.code, 'INVALID_URL', url);
  }
  assert.equal(calls.connect, 0);
  assert.equal(fixture.calls.goto.length, 0);
});

test('MELO_CDP_ENABLED=1 → CDP tier: logged-in context, page closed, browser detached, headless launch untouched', async () => {
  await withWorkspace(async workspacePath => {
    const fixture = fakePage({ title: 'Example Domain', url: 'https://example.com/page?final=1' });
    const calls = cdpDeps(fixture);
    process.env.MELO_CDP_ENABLED = '1';
    const result = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK, waitFor: '#main' }, { workspacePath }));
    assert.equal(result.ok, true, result.output);
    assert.equal(result.meta.tier, 'cdp');
    assert.equal(calls.connect, 1);
    assert.equal(calls.launch, 0);
    assert.equal(calls.newContext, 0, 'the persistent (logged-in) context is reused, never a fresh one');
    assert.equal(calls.browserClosed, 1, 'CDP handle detached');
    assert.equal(fixture.calls.closed, 1, 'only the page we opened is closed');
    assert.deepEqual(fixture.calls.goto, [[URL_OK, { waitUntil: 'domcontentloaded', timeout: 20_000 }]]);
    assert.equal(fixture.calls.waitFor[0][0], '#main');
    assert.deepEqual(fixture.calls.screenshot, [{ type: 'png', fullPage: false }]);
    assert.deepEqual(fixture.calls.viewport, [{ width: 1280, height: 960 }]);
    assert.equal(result.meta.finalUrl, 'https://example.com/page?final=1');
    assert.equal(result.meta.title, 'Example Domain');
    assert.doesNotMatch(result.output, /no login state/i);
  });
});

test('flag off → headless tier with the local Chrome binary, one-shot browser closed, output says no login state', async () => {
  await withWorkspace(async workspacePath => {
    const fixture = fakePage();
    const calls = headlessDeps(fixture);
    const result = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK, width: 1024 }, { workspacePath }));
    assert.equal(result.ok, true, result.output);
    assert.equal(result.meta.tier, 'headless');
    assert.equal(calls.connect, 0);
    assert.deepEqual(calls.launch, [{ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--disable-gpu'] }]);
    assert.deepEqual(calls.contexts, [{ viewport: { width: 1024, height: 768 } }]);
    assert.equal(calls.browserClosed, 1);
    assert.equal(fixture.calls.closed, 1);
    assert.match(result.output, /no login state/i);
  });
});

test('width is clamped to 480–1920 and defaults to 1280', async () => {
  await withWorkspace(async workspacePath => {
    for (const [input, expected] of [[100, 480], [5000, 1920], ['abc', 1280], [undefined, 1280], [800.4, 800]]) {
      const fixture = fakePage();
      const calls = headlessDeps(fixture);
      const result = await webScreenshotTool.run({ url: URL_OK, width: input }, { workspacePath });
      assert.equal(result.ok, true);
      assert.equal(calls.contexts[0].viewport.width, expected, String(input));
    }
  });
});

test('no local Chrome and no CDP flag → BROWSER_UNAVAILABLE with a fetch_url hint', async () => {
  const fixture = fakePage();
  const calls = headlessDeps(fixture, { chromeBinary: () => null });
  let result = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'BROWSER_UNAVAILABLE');
  assert.equal(result.output, 'No local Chrome found for screenshots; read the page with fetch_url instead.');
  headlessDeps(fixture, { chromeExists: () => false });
  result = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK }));
  assert.equal(result.error, 'BROWSER_UNAVAILABLE');
  assert.equal(calls.launch.length, 0);
  assert.equal(fixture.calls.goto.length, 0);
});

test('CDP flag on but Melo Chrome cannot start → BROWSER_UNAVAILABLE', async () => {
  const fixture = fakePage();
  cdpDeps(fixture, { connect: async () => { throw new Error('Chrome binary not found at /Applications/Google Chrome.app — install Google Chrome or set MELO_CHROME_BINARY'); } });
  process.env.MELO_CDP_ENABLED = '1';
  const result = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'BROWSER_UNAVAILABLE');
  assert.match(result.output, /fetch_url/);
});

test('navigation timeout → TIMEOUT; other navigation errors → LOAD_FAILED; the browser is still closed', async () => {
  const timeoutError = Object.assign(new Error('page.goto: Timeout 20000ms exceeded.'), { name: 'TimeoutError' });
  let fixture = fakePage({ goto: async () => { throw timeoutError; } });
  let calls = headlessDeps(fixture);
  let result = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'TIMEOUT');
  assert.equal(result.code, 'TIMEOUT');
  assert.equal(result.meta.timedOut, true);
  assert.equal(calls.browserClosed, 1);
  assert.equal(fixture.calls.closed, 1);

  fixture = fakePage({ goto: async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED at https://example.com/page'); } });
  calls = headlessDeps(fixture);
  result = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK }));
  assert.equal(result.error, 'LOAD_FAILED');
  assert.match(result.output, /ERR_NAME_NOT_RESOLVED/);
  assert.match(toolCodeHint(result.code), /fetch_url/);
  assert.equal(calls.browserClosed, 1);
});

test('abort during navigation → ABORTED', async () => {
  const controller = new AbortController();
  const fixture = fakePage({ goto: async () => { controller.abort(); throw new DOMException('Aborted', 'AbortError'); } });
  const calls = headlessDeps(fixture);
  const result = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK }, { signal: controller.signal }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ABORTED');
  assert.equal(result.meta.aborted, true);
  assert.equal(calls.browserClosed, 1);
  const already = new AbortController(); already.abort();
  const early = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK }, { signal: already.signal }));
  assert.equal(early.error, 'ABORTED');
  assert.equal(fixture.calls.goto.length, 1, 'an already-aborted signal never opens a page');
});

test('success: PNG saved in the workspace generated dir with a signed URL, markdown image in output, bounded JPEG in meta.modelImage', async () => {
  await withWorkspace(async workspacePath => {
    const fixture = fakePage({ title: 'Example [Domain]\nline two' });
    headlessDeps(fixture);
    const result = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK }, { workspacePath }));
    assert.equal(result.ok, true, result.output);
    assert.equal(result.status, 'ok');
    assert.ok(result.meta.path.startsWith(join(workspacePath, 'generated', 'screenshot-')), result.meta.path);
    assert.ok(result.meta.path.endsWith('.png'));
    assert.ok((await stat(result.meta.path)).size > 0);
    assert.match(result.meta.signedUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/files\/signed\/screenshot-[^?]+\.png\?p=.+&e=\d+&s=.+$/);
    assert.equal(result.meta.width, 1400); assert.equal(result.meta.height, 900);
    assert.equal(result.meta.url, URL_OK);
    assert.equal(result.meta.title, 'Example  Domain  line two');
    assert.match(result.output, /^Screenshot of "Example  Domain  line two" \(https:\/\/example\.com\/page, 1400×900, tier headless\) saved\./);
    assert.ok(result.output.includes(`\n\n![Example  Domain  line two](${result.meta.signedUrl})`), 'markdown image for the UI attachment');
    assert.match(result.meta.modelImage, /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/);
    const jpeg = Buffer.from(result.meta.modelImage.slice('data:image/jpeg;base64,'.length), 'base64');
    assert.ok(jpeg.length <= MODEL_IMAGE_MAX_BYTES);
    const info = await sharp(jpeg).metadata();
    assert.equal(info.format, 'jpeg');
    assert.ok(info.width <= MODEL_IMAGE_MAX_WIDTH, `model image width ${info.width}`);
    assert.equal(info.width, 1280, 'downscaled from 1400 px');
  });
});

test('modelImage is omitted when the JPEG cannot be made small enough', async () => {
  await withWorkspace(async workspacePath => {
    const fixture = fakePage();
    headlessDeps(fixture, { encodeModelImage: async () => null });
    const result = await webScreenshotTool.run({ url: URL_OK }, { workspacePath });
    assert.equal(result.ok, true);
    assert.equal('modelImage' in result.meta, false);
    assert.match(result.output, /!\[.*\]\(http/);
  });
});

test('fullPage: capture is capped at 6000 px tall and the cap is reported', async () => {
  await withWorkspace(async workspacePath => {
    const tall = fakePage({ documentHeight: 20_000 });
    headlessDeps(tall);
    let result = await webScreenshotTool.run({ url: URL_OK, fullPage: true, width: 1000 }, { workspacePath });
    assert.equal(result.ok, true, result.output);
    assert.deepEqual(tall.calls.screenshot, [{ type: 'png', fullPage: true, clip: { x: 0, y: 0, width: 1000, height: MAX_FULL_PAGE_HEIGHT } }]);
    assert.equal(result.meta.capped, true);
    assert.equal(result.meta.fullPage, true);
    assert.match(result.output, /capped at 6000 px/);

    const short = fakePage({ documentHeight: 3000 });
    headlessDeps(short);
    result = await webScreenshotTool.run({ url: URL_OK, fullPage: true }, { workspacePath });
    assert.deepEqual(short.calls.screenshot, [{ type: 'png', fullPage: true }]);
    assert.equal(result.meta.capped, false);
  });
});

test('without a workspace the PNG lands under <home>/desktop/screenshots', async () => {
  await withWorkspace(async home => {
    const prevHome = process.env.MELO_HOME;
    process.env.MELO_HOME = home;
    try {
      const fixture = fakePage();
      headlessDeps(fixture);
      const result = await webScreenshotTool.run({ url: URL_OK });
      assert.equal(result.ok, true, result.output);
      assert.ok(result.meta.path.startsWith(join(home, 'desktop', 'screenshots', 'generated', 'screenshot-')), result.meta.path);
    } finally {
      if (prevHome === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = prevHome;
    }
  });
});

// ─── Bug audit 2026-10-18: T2 (redirect / subresource guard), T10 (model image), T16 (IPv6 forms) ──

import { isBlockedRequestUrl, IMAGE_NOT_ATTACHED_NOTE, MODEL_IMAGE_WIDTHS } from './webScreenshotTool.js';

test('T16: IPv4-translated / NAT64 / 6to4 / benchmarking forms are private; their public counterparts are not', () => {
  for (const bad of ['http://[::ffff:0:7f00:1]/', 'http://[::ffff:0:127.0.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://[64:ff9b::127.0.0.1]/', 'http://[64:ff9b:1::1]/',
    'http://[2002:7f00:1::]/', 'http://[2002:c0a8:101::]/', 'http://198.18.0.1/', 'http://198.19.255.254/', 'http://[fec0::1]/', 'http://[2001:db8::1]/',
    'http://[::7f00:1]/', 'http://192.0.2.1/', 'http://203.0.113.9/', 'http://[::FFFF:7F00:1]/', 'http://[fe80::1%25eth0]/', 'http://[::ffff:169.254.169.254]/']) {
    assert.equal(isPublicHttpUrl(bad).ok, false, bad);
  }
  for (const good of ['http://[2001:4860:4860::8888]/', 'http://[2002:808:808::]/', 'http://[64:ff9b::808:808]/', 'http://[::ffff:8.8.8.8]/', 'http://198.17.0.1/', 'http://198.20.0.1/', 'http://1.1.1.1/']) {
    assert.equal(isPublicHttpUrl(good).ok, true, good);
  }
  assert.equal(isPrivateHostname('[::ffff:0:7f00:1]'), true);
  assert.equal(isPrivateHostname('[zz::1]'), true, 'unparseable literals fail closed');
  assert.equal(isBlockedRequestUrl('data:text/html,hi'), false);
  assert.equal(isBlockedRequestUrl('about:blank'), false);
  assert.equal(isBlockedRequestUrl('file:///etc/passwd'), true);
  assert.equal(isBlockedRequestUrl('http://169.254.169.254/latest/meta-data'), true);
  assert.equal(isBlockedRequestUrl('https://cdn.example.com/a.js'), false);
});

test('T2: a redirect that lands on a loopback address is refused after goto (INVALID_URL) and nothing is captured', async () => {
  await withWorkspace(async workspacePath => {
    let landed = URL_OK;
    const fixture = fakePage({ goto: async () => { landed = 'http://127.0.0.1:43127/api/local-write'; }, url: undefined });
    fixture.page.url = () => landed;
    headlessDeps(fixture);
    const result = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK }, { workspacePath }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_URL');
    assert.match(result.output, /local or private address/);
    assert.match(result.output, /127\.0\.0\.1/);
    assert.equal(result.meta.blockedPrivateNavigation, true);
    assert.equal(fixture.calls.screenshot.length, 0, 'no screenshot of the private page');
    assert.equal(fixture.calls.closed, 1, 'page still closed');
  });
});

test('T2: page.route aborts requests to private hosts (subresources, iframes, blocked main-frame redirects) and continues public ones', async () => {
  await withWorkspace(async workspacePath => {
    const routed = [];
    const makeRequest = (url, navigation = false) => ({ url: () => url, isNavigationRequest: () => navigation, frame: () => 'main' });
    const fixture = fakePage();
    let handler = null;
    fixture.page.mainFrame = () => 'main';
    fixture.page.route = async (pattern, fn) => { routed.push(pattern); handler = fn; };
    fixture.page.unroute = async () => { handler = null; };
    const originalGoto = fixture.page.goto;
    fixture.page.goto = async (target, options) => {
      // Simulate the page loading: main frame, a public script, a private iframe and a metadata subresource.
      const decisions = [];
      for (const [url, navigation] of [[target, true], ['https://cdn.example.com/app.js', false], ['http://192.168.1.10/panel', false], ['http://169.254.169.254/latest/meta-data', false]]) {
        await handler({ continue: async () => decisions.push(['continue', url]), abort: async reason => decisions.push(['abort', url, reason]), request: () => makeRequest(url, navigation) }, makeRequest(url, navigation));
      }
      fixture.decisions = decisions;
      return originalGoto(target, options);
    };
    headlessDeps(fixture);
    const result = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK }, { workspacePath }));
    assert.equal(result.ok, true, result.output);
    assert.deepEqual(routed, ['**/*'], 'the guard is installed before navigation');
    assert.equal(handler, null, 'the guard is removed afterwards');
    assert.deepEqual(fixture.decisions, [
      ['continue', URL_OK], ['continue', 'https://cdn.example.com/app.js'],
      ['abort', 'http://192.168.1.10/panel', 'blockedbyclient'], ['abort', 'http://169.254.169.254/latest/meta-data', 'blockedbyclient'],
    ]);
    assert.match(result.output, /2 request\(s\) to local\/private hosts were blocked/);

    // A blocked main-frame navigation (the redirect target itself) → INVALID_URL even when goto throws net::ERR_FAILED.
    const redirect = fakePage({ goto: async () => { throw new Error('net::ERR_FAILED'); } });
    redirect.page.mainFrame = () => 'main';
    let redirectHandler = null;
    redirect.page.route = async (_pattern, fn) => { redirectHandler = fn; };
    redirect.page.unroute = async () => {};
    const baseGoto = redirect.page.goto;
    redirect.page.goto = async (target, options) => {
      await redirectHandler({ continue: async () => {}, abort: async () => {}, request: () => makeRequest('http://10.0.0.5/admin', true) }, makeRequest('http://10.0.0.5/admin', true));
      return baseGoto(target, options);
    };
    headlessDeps(redirect);
    const refused = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK }, { workspacePath }));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'INVALID_URL');
    assert.match(refused.output, /10\.0\.0\.5/);
    assert.equal(redirect.calls.screenshot.length, 0);
  });
});

test('T10: the model image keeps shrinking (960/720/480 px) until it fits 400 KB; when nothing fits the output says the model has no image', async () => {
  await withWorkspace(async workspacePath => {
    // A noisy 1280×4000 full-page capture: ~700 KB at 1280 px / q40, fits only after downscaling.
    let seed = 42;
    const noise = Buffer.alloc(1280 * 4000 * 3);
    for (let i = 0; i < noise.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise[i] = seed & 255; }
    const tallPng = await sharp(noise, { raw: { width: 1280, height: 4000, channels: 3 } }).png().toBuffer();
    const fixture = fakePage({ image: tallPng, documentHeight: 4000 });
    headlessDeps(fixture);
    const result = finalizeToolResult(await webScreenshotTool.run({ url: URL_OK, fullPage: true }, { workspacePath }));
    assert.equal(result.ok, true, result.output);
    assert.match(result.meta.modelImage, /^data:image\/jpeg;base64,/);
    const jpeg = Buffer.from(result.meta.modelImage.slice('data:image/jpeg;base64,'.length), 'base64');
    assert.ok(jpeg.length <= MODEL_IMAGE_MAX_BYTES, `model image ${jpeg.length} bytes`);
    const info = await sharp(jpeg).metadata();
    assert.ok(info.width < MODEL_IMAGE_MAX_WIDTH, `downscaled below 1280 px (got ${info.width})`);
    assert.ok(MODEL_IMAGE_WIDTHS.includes(info.width), `width ${info.width} is one of the ladder steps`);
    assert.doesNotMatch(result.output, /screenshot not attached/);

    const none = fakePage();
    headlessDeps(none, { encodeModelImage: async () => null });
    const noImage = await webScreenshotTool.run({ url: URL_OK }, { workspacePath });
    assert.equal(noImage.ok, true);
    assert.equal('modelImage' in noImage.meta, false);
    assert.ok(noImage.output.includes(IMAGE_NOT_ATTACHED_NOTE), noImage.output);
    assert.match(noImage.output, /fetch_url/);
  });
});
