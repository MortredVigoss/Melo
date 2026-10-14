import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTextUrls } from '../media/textUrls.js';
import { requestUrls } from '../retrieval/requestPolicy.js';
import { buildSearchPlan } from '../retrieval/searchRouter.js';

test('prose delimiters do not become URL paths; valid URL characters survive', () => {
  for (const tail of ['。', '，帮我总结', '；然后回答', '”', '」']) {
    assert.deepEqual(extractTextUrls(`看 https://example.com/报告${tail}`), ['https://example.com/报告']);
  }
  assert.deepEqual(extractTextUrls('(https://example.com/a_(b))'), ['https://example.com/a_(b)']);
  assert.deepEqual(extractTextUrls('https://example.com/%E3%80%82?q=a,b&x=1'), ['https://example.com/%E3%80%82?q=a,b&x=1']);
});

test('quoted data, translation and access denial never schedule URL reads', () => {
  for (const text of [
    '不要打开 https://example.com ，只解释结构',
    '不要访问这个网址 https://example.com',
    'Do not open https://example.com; explain the URL.',
    '翻译这句话："Open https://example.com"',
    'Translate https://example.com into Chinese',
    '解释这段代码：`fetch("https://example.com")`',
  ]) {
    assert.deepEqual(requestUrls(text), [], text);
    assert.equal(buildSearchPlan({ latestUserMessage: text }).route, 'none', text);
  }
});

test('requested quoted URLs, bare URLs and no-search link reads still work', () => {
  for (const text of [
    '请打开 “https://example.com”。', 'Read "https://example.com"',
    'https://example.com', '不要搜索其他网站，请打开 https://example.com',
    '请打开“https://example.com”并翻译页面',
    '请打开 https://example.com 并翻译页面',
  ]) {
    assert.deepEqual(requestUrls(text), ['https://example.com'], text);
    assert.equal(buildSearchPlan({ latestUserMessage: text }).route, 'fetch-url', text);
  }
});

test('Markdown destinations stop at unmatched closers before adjacent prose', () => {
  const url = 'https://www.kayak.com.au/flights/MEL-SYD/2026-10-31/2026-11-01?sort=price_a';
  assert.deepEqual(extractTextUrls(`[去看看](${url})查看当前价格`), [url]);
  assert.deepEqual(extractTextUrls('[百科](https://example.com/a_(b))查看'), ['https://example.com/a_(b)']);
  assert.deepEqual(extractTextUrls('https://[::1]/path?q=(a)&x=%29'), ['https://[::1]/path?q=(a)&x=%29']);
});
