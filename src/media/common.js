export function normalizeMediaText(value = '', maxLength = 12000) {
  const normalized = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`
    : normalized;
}

export async function fetchText(url, { timeoutMs = 10000, headers = {} } = {}) {
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    return null;
  }

  return {
    text: await response.text(),
    contentType: String(response.headers.get('content-type') || '').toLowerCase(),
  };
}

export async function fetchBuffer(url, { timeoutMs = 20000, headers = {} } = {}) {
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    return null;
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: String(response.headers.get('content-type') || '').toLowerCase(),
  };
}

export function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code) || 0))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16) || 0))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function fileExtension(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  const match = normalized.match(/\.([a-z0-9]+)(?:$|[?#])/i);
  return match ? match[1] : '';
}
