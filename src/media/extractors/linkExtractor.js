import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { normalizeMediaText } from '../common.js';

const FETCH_TIMEOUT_MS = 10000;
const MAX_CONTENT_CHARS = 8000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

export function extractReadableHtml(html = '', url = '') {
  try {
    const dom = new JSDOM(String(html || ''), { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article?.textContent?.trim()) {
      return null;
    }

    return {
      kind: 'article',
      text: normalizeMediaText(article.textContent, MAX_CONTENT_CHARS),
      metadata: {
        title: article.title || '',
        byline: article.byline || '',
        siteName: article.siteName || '',
        excerpt: normalizeMediaText(article.excerpt || '', 400),
        url,
        source: 'readability',
      },
    };
  } catch {
    return null;
  }
}

export async function extractLinkContent(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; MeloReader/0.2)',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (!response.ok) {
      return null;
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return null;
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength && contentLength > MAX_HTML_BYTES) {
      return null;
    }

    const html = await response.text();
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
      return null;
    }

    return extractReadableHtml(html, url);
  } catch {
    return null;
  }
}
