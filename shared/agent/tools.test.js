import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRuntimeConfig, normalizeFetchedPage, normalizeSearchResponse, searchRequest } from './tools.js';
import { startTurn, advanceTurn } from './turn.js';

test('malformed search endpoints never become an executable capability', () => {
  for (const endpoint of ['invalid', 'file:///private', 'https://user:secret@example.com', 'https://', 'https://example.com/#fragment', 'https://example.com/with space']) {
    const config = { search: { backend: 'http', endpoint } };
    assert.equal(normalizeRuntimeConfig(config).search.endpoint, '', endpoint);
    assert.throws(() => searchRequest({ query: 'test' }, config), { code: 'SEARCH_UNAVAILABLE' });
  }
  for (const endpoint of ['https://example.com/search?q=x', 'http://127.0.0.1:1234/search', 'http://[::1]:1234/search']) {
    assert.equal(normalizeRuntimeConfig({ search: { backend: 'http', endpoint } }).search.endpoint, endpoint);
  }
});

test('all Hosts get identical safe defaults; Brave fills its one shared endpoint', () => {
  assert.equal(normalizeRuntimeConfig().search.backend, 'none');
  assert.equal(normalizeRuntimeConfig().search.browserFallback, false);
  const config = normalizeRuntimeConfig({ search: { backend: 'http', provider: 'brave' } });
  assert.equal(config.search.endpoint, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(config.search.credentialRef, 'search');
  const request = searchRequest({ query: '中文 & / 😀', maxResults: 3 }, config);
  assert.equal(new URL(request.url).searchParams.get('q'), '中文 & / 😀');
  assert.equal(request.credentialHeader, 'X-Subscription-Token');
  assert.equal('credential' in request, false);
});

test('source normalization never converts retrieval time into live status', () => {
  const receipt = normalizeSearchResponse({ results: [{ url: 'https://fixture.invalid', title: 'Fixture', snippet: 'Hours unavailable' }, { url: 'javascript:alert(1)' }] }, { fetchedAt: '2026-10-17T01:00:00Z' });
  assert.equal(receipt.results.length, 1); assert.equal(receipt.freshness, 'unknown');
  assert.equal(receipt.results[0].observedAt, undefined);
  assert.equal(normalizeSearchResponse({ results: [{ url: 'file:///private' }] }).ok, false);
});

test('static HTML parser drops scripts/styles and handles unclosed markup in linear scans', () => {
  const receipt = normalizeFetchedPage({ url: 'https://fixture.invalid', contentType: 'text/html', content: '<p>餐厅&nbsp;A</p><script>send_secret()</script><style>.x{}</style><p>Hours unknown</p>' });
  assert.equal(receipt.text, '餐厅 A Hours unknown'); assert.equal(receipt.reading, 'static_html');
  const broken = normalizeFetchedPage({ contentType: 'text/html', content: 'Visible<script>' + '<script>'.repeat(100_000) });
  assert.equal(broken.text, 'Visible');
});

test('a completed phone goal cannot be reissued under a fresh call ID', () => {
  let state = startTurn({ runId: 'r', turnId: 't', allowedTools: ['phone_use'], now: 1000 });
  const event = (type, fields = {}) => { state = advanceTurn(state, { type, runId: 'r', turnId: 't', ...fields }, 1000); };
  const argumentsValue = { goal: 'Open Maps', purpose: 'action' };
  event('request'); event('calls', { calls: [{ id: 'first', name: 'phone_use', arguments: argumentsValue }] });
  assert.deepEqual(state.permitted, ['first']);
  event('result', { callId: 'first', ok: true });
  event('request'); event('calls', { calls: [{ id: 'second', name: 'phone_use', arguments: argumentsValue }] });
  assert.deepEqual(state.permitted, []); assert.equal(state.rejections.second, 'REPEATED_TASK');
});

// 2026-11-10. The phone's page reader used to return the first 32 000 characters and nothing else:
// the rest of a long page could not be read, and one Chinese page cost about 32 000 input tokens in
// every later request. A read now returns one window of the page and says where to read on.
test('a page read returns one window sized by tokens and reads on from the offset it reports', async () => {
  const { toolCatalog, validateCommonTool } = await import('./tools.js');
  const { PAGE_WINDOW_CHARS, PAGE_WINDOW_TOKENS } = await import('./pageWindow.js');
  const { estimateTextTokens } = await import('./tokenEstimate.js');
  const read = (content, offset) => normalizeFetchedPage({ url: 'https://fixture.invalid/page', contentType: 'text/plain', content, ...(offset === undefined ? {} : { offset }) }, { fetchedAt: 't' });
  // A short page is whole and unchanged in shape.
  const short = read('Opening hours: nine to five.');
  assert.deepEqual([short.text, short.truncated, short.length, 'nextOffset' in short, 'offset' in short], ['Opening hours: nine to five.', false, 28, false, false]);
  // Latin text keeps the full window; the rest is reachable.
  const english = 'forecast for the coming week '.repeat(1500).trim();
  const first = read(english);
  assert.deepEqual([first.text.length, first.truncated, first.nextOffset, first.length], [PAGE_WINDOW_CHARS, true, PAGE_WINDOW_CHARS, english.length]);
  // Chinese text gets a shorter window of about the same token cost.
  const chinese = '明天墨尔本多云转晴，气温十五到十九度。'.repeat(600);
  const head = read(chinese);
  assert.equal(head.text.length < 9000 && head.text.length >= 1000, true, String(head.text.length));
  assert.equal(estimateTextTokens(head.text) <= PAGE_WINDOW_TOKENS, true);
  assert.equal(head.nextOffset, head.text.length);
  // Reading on from each reported offset reconstructs the page exactly, with no overlap and no gap.
  for (const page of [english, chinese]) {
    let offset = 0, joined = '', parts = 0;
    for (;;) {
      const part = read(page, offset); joined += part.text; parts += 1;
      assert.equal(part.truncated, offset > 0 || part.nextOffset !== undefined);
      if (offset > 0) assert.equal(part.offset, offset);
      if (part.nextOffset === undefined) break;
      assert.equal(part.nextOffset > offset, true, 'every part makes progress'); offset = part.nextOffset;
      assert.equal(parts < 20, true);
    }
    assert.equal(joined, page); assert.equal(parts > 1, true);
  }
  // A window never starts or ends inside a surrogate pair, whatever offset the model sends.
  const emoji = 'a'.repeat(PAGE_WINDOW_CHARS - 1) + '😀' + 'b'.repeat(50);
  const cut = read(emoji);
  assert.deepEqual([cut.text.isWellFormed(), cut.nextOffset], [true, PAGE_WINDOW_CHARS - 1]);
  assert.equal(read(emoji, cut.nextOffset).text.startsWith('😀b'), true);
  const inside = read(emoji, PAGE_WINDOW_CHARS);
  assert.deepEqual([inside.text.isWellFormed(), inside.offset], [true, PAGE_WINDOW_CHARS - 1]);
  // An offset at or past the end is an empty part with a hint, not an error and not a restart.
  const past = read('hello world', 500);
  assert.deepEqual([past.ok, past.text, past.offset, past.truncated, 'nextOffset' in past], [true, '', 11, true, false]);
  assert.match(past.hint, /nothing further to read/);
  // An unusable offset reads from the start.
  for (const bad of [-5, 2.5, '7000', null, NaN]) assert.equal(read(english, bad).text, first.text, String(bad));
  // An empty page is still not a successful read.
  assert.equal(read('   ').ok, false);
  // The tool definition tells the model how to read on, and the contract accepts only a whole, non-negative offset.
  const spec = toolCatalog(['fetch_url'])[0];
  assert.match(spec.description, /nextOffset/); assert.deepEqual(spec.parameters.required, ['url']);
  assert.deepEqual(validateCommonTool('fetch_url', { url: 'https://fixture.invalid/page', offset: 7000 }), { url: 'https://fixture.invalid/page', offset: 7000 });
  for (const args of [{ url: 'https://fixture.invalid/page', offset: -1 }, { url: 'https://fixture.invalid/page', offset: 1.5 }, { url: 'https://fixture.invalid/page', offset: '7' }, { url: 'https://fixture.invalid/page', page: 2 }, { url: 'https://fixture.invalid/page', offset: 10000001 }])
    assert.throws(() => validateCommonTool('fetch_url', args), { code: 'INVALID_TOOL_ARGUMENTS' }, JSON.stringify(args));
});

test('the execution record says which part of a page was read', async () => {
  const { executionScene } = await import('./execution.js');
  let scene = executionScene({ action: 'create', runId: 'r', chatId: 'c', query: 'q', at: '2026-11-10T00:00:00Z' });
  const record = (id, result) => { scene = executionScene({ action: 'event', scene, at: '2026-11-10T00:00:01Z', event: { kind: 'operation', id, name: 'fetch_url', module: 'search', status: 'completed', result } }); return scene.operations.find(row => row.id === id).resultSummary; };
  const chinese = '明天墨尔本多云转晴，气温十五到十九度。'.repeat(600);
  const head = normalizeFetchedPage({ url: 'https://fixture.invalid/p', contentType: 'text/plain', content: chinese });
  const tail = normalizeFetchedPage({ url: 'https://fixture.invalid/p', contentType: 'text/plain', content: chinese, offset: head.nextOffset });
  assert.equal(record('a', head), `已读取网页文本第 1–${head.text.length} 字符，全文 ${chinese.length} 字符，其余可续读。内容时效仍需核对。`);
  assert.equal(record('b', tail), `已读取网页文本第 ${head.nextOffset + 1}–${chinese.length} 字符，全文 ${chinese.length} 字符。内容时效仍需核对。`);
  assert.equal(record('c', normalizeFetchedPage({ url: 'https://fixture.invalid/s', contentType: 'text/plain', content: 'short page' })), '已读取网页文本 10 字符。内容时效仍需核对。');
  // A result from a host that does not report the page length keeps the earlier wording.
  assert.equal(record('d', { ok: true, text: 'x'.repeat(40), truncated: true }), '已读取网页文本 40 字符（已截断）。内容时效仍需核对。');
});

// 2026-11-10 agent audit: toLowerCase() can change a string's length ("İ" becomes two units), after
// which tag names were read at shifted offsets and script bodies came out as page text.
test('the static HTML reader removes scripts and styles after a character whose lowercase is longer', () => {
  const page = normalizeFetchedPage({ url: 'https://fixture.invalid/tr', contentType: 'text/html', content: '<h1>İstanbul İZMİR</h1><script>var secret = 1;</script><SCRIPT>second()</SCRIPT><p>Visible</p><Style>.x{color:red}</Style><p>End</p>' });
  assert.equal(page.text, 'İstanbul İZMİR Visible End');
});

test('unit conversions keep significant digits for small results', async () => {
  const { calculateNumber } = await import('./arithmetic.js');
  const convert = (value, from, to) => calculateNumber({ action: 'convert', value, from, to }).result;
  assert.equal(convert(1, 'mm', 'mi'), 6.21371e-7); assert.equal(convert(100, 'kb', 'tb'), 9.31323e-8);
  assert.notEqual(convert(1, 'mg', 'lb'), 0.000002);
  // Ordinary results are unchanged.
  assert.equal(convert(20, 'celsius', 'fahrenheit'), 68); assert.equal(convert(10, 'km', 'mi'), 6.213712); assert.equal(convert(0, 'km', 'mi'), 0);
});
