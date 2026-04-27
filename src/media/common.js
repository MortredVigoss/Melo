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

/**
 * Combine an optional external AbortSignal with an internal timeout. Returns
 * a single signal that fires when EITHER aborts. Returns undefined when both
 * args are missing so callers can spread it through unchanged.
 *
 * AbortSignal.any is Node 20.3+; package.json still declares node >=18 so
 * the fallback path matters. Without it, calling .any() on Node 18 / early
 * 20 throws synchronously and silently degrades to null. Mirrors the
 * pattern in src/images/codexImageEngine.js → composeSignals.
 */
export function combineSignals(externalSignal, timeoutMs) {
  const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : null;
  if (!externalSignal && !timeoutSignal) return undefined;
  if (!externalSignal) return timeoutSignal;
  if (!timeoutSignal) return externalSignal;

  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([externalSignal, timeoutSignal]);
  }

  if (externalSignal.aborted) return externalSignal;
  if (timeoutSignal.aborted) return timeoutSignal;

  const controller = new AbortController();
  const forwardAbort = signal => () => {
    if (!controller.signal.aborted) controller.abort(signal?.reason);
  };
  externalSignal.addEventListener('abort', forwardAbort(externalSignal), { once: true });
  timeoutSignal.addEventListener('abort', forwardAbort(timeoutSignal), { once: true });
  return controller.signal;
}

export async function fetchText(url, { timeoutMs = 10000, headers = {}, signal } = {}) {
  if (signal?.aborted) return null;
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: combineSignals(signal, timeoutMs),
  });

  if (!response.ok) {
    return null;
  }

  return {
    text: await response.text(),
    contentType: String(response.headers.get('content-type') || '').toLowerCase(),
  };
}

export async function fetchBuffer(url, { timeoutMs = 20000, headers = {}, signal } = {}) {
  if (signal?.aborted) return null;
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: combineSignals(signal, timeoutMs),
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
