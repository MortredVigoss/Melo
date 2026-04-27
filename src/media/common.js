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
 * Combine N AbortSignals into one that fires when ANY of them aborts.
 * Falsy entries are filtered out. Returns undefined when nothing's left
 * so callers can spread it through unchanged.
 *
 * AbortSignal.any is Node 20.3+; package.json declares node >=18 so the
 * fallback path matters. Without it, calling .any() on Node 18 / early
 * 20 throws synchronously and silently degrades. Mirrors the pattern in
 * src/images/codexImageEngine.js → composeSignals.
 *
 * **Media-layer convention**: this and `combineSignals` are the ONLY
 * sanctioned ways to compose abort signals inside src/media/. Direct
 * `AbortSignal.any([...])` calls bypass the Node 18 fallback and have
 * caused regressions twice (Codex C #6, #10). Reviewers should flag
 * any new direct call.
 */
export function composeAbortSignals(...signals) {
  const filtered = signals.filter(Boolean);
  if (filtered.length === 0) return undefined;
  if (filtered.length === 1) return filtered[0];

  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(filtered);
  }

  // Manual fallback for Node <20.3
  for (const sig of filtered) {
    if (sig.aborted) return sig;
  }
  const controller = new AbortController();
  for (const sig of filtered) {
    sig.addEventListener('abort', () => {
      if (!controller.signal.aborted) controller.abort(sig?.reason);
    }, { once: true });
  }
  return controller.signal;
}

/**
 * Common ergonomic case: combine an optional external AbortSignal with an
 * internal timeout. Thin wrapper over composeAbortSignals — a numeric
 * `timeoutMs` is materialised into an AbortSignal first.
 */
export function combineSignals(externalSignal, timeoutMs) {
  const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : null;
  return composeAbortSignals(externalSignal, timeoutSignal);
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
