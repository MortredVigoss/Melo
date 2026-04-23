import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinkContent, extractReadableHtml } from './linkExtractor.js';

const SAMPLE_HTML = `
  <html>
    <head><title>Test Article</title></head>
    <body>
      <article>
        <h1>Test Heading</h1>
        <p>This is the article body text used for extraction testing.</p>
      </article>
    </body>
  </html>
`;

test('extractLinkContent accepts text/html content-type', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    headers: {
      get: header => {
        if (header === 'content-type') return 'text/html; charset=utf-8';
        return null;
      },
    },
    text: async () => SAMPLE_HTML,
  });

  try {
    const result = await extractLinkContent('https://example.com/article');
    assert.ok(result !== null, 'should extract text/html pages');
    assert.equal(result?.kind, 'article');
    assert.match(result?.text || '', /article body text/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('extractLinkContent accepts application/xhtml+xml content-type', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    headers: {
      get: header => {
        if (header === 'content-type') return 'application/xhtml+xml; charset=utf-8';
        return null;
      },
    },
    text: async () => SAMPLE_HTML,
  });

  try {
    const result = await extractLinkContent('https://example.com/page.xhtml');
    assert.ok(result !== null, 'should extract application/xhtml+xml pages');
    assert.equal(result?.kind, 'article');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('extractLinkContent rejects non-HTML content-type like application/json', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    headers: {
      get: header => {
        if (header === 'content-type') return 'application/json';
        return null;
      },
    },
    text: async () => '{}',
  });

  try {
    const result = await extractLinkContent('https://example.com/api');
    assert.equal(result, null, 'should return null for non-HTML content');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('extractLinkContent returns null for failed HTTP responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
  });

  try {
    const result = await extractLinkContent('https://example.com/missing');
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('extractReadableHtml extracts xhtml content correctly', () => {
  const xhtmlContent = `
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
    <html xmlns="http://www.w3.org/1999/xhtml">
      <head><title>XHTML Page</title></head>
      <body>
        <article>
          <h1>XHTML Article</h1>
          <p>Content from an XHTML document.</p>
        </article>
      </body>
    </html>
  `;

  const result = extractReadableHtml(xhtmlContent, 'https://example.com/page.xhtml');
  assert.ok(result !== null, 'should extract XHTML documents');
  assert.match(result?.text || '', /XHTML Article/);
});
