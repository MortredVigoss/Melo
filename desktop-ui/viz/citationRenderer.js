// ─── Citation renderer + side drawer ────────────────────────────────────────
// Companion to vizRenderer.js. Handles the NotebookLM-style feature where the
// assistant can wrap factual claims in inline `<cite>` tags, each of which is
// rendered as a numbered pill. Clicking a pill opens a right-hand drawer that
// shows the cited file scrolled to the cited line range.
//
// Because the top-level chat render() does `innerHTML = …` every turn, the
// drawer lives OUTSIDE the chat root (appended to document.body) so it
// survives full re-renders. The pill click handler is registered with a
// global click delegate rather than per-pill listeners for the same reason.
//
// Public surface:
//   - CITE_TAG_PATTERN             — regex used by the inline renderer
//   - renderInlineSegmentWithCites(text, escapeHtml)
//                                    takes a plain chunk of assistant prose,
//                                    returns HTML with `<cite>` tags replaced
//                                    by clickable pills. The inline url/link
//                                    handling stays in renderInlineText; this
//                                    function is composed with that pipeline.
//   - collectCitationsByMessageId(messages)
//                                    builds { [messageId]: citations[] }
//                                    from a list of persisted assistant
//                                    messages, for drawer lookups.
//   - installCitationDrawer({ fetchPreview })
//                                    bootstraps the drawer DOM and global
//                                    click/ESC handlers. Call once on app
//                                    boot. `fetchPreview({ filePath }) →
//                                    Promise<{ content, language, ... }>` is
//                                    provided by the host so this module
//                                    stays transport-agnostic.

// Matches a `<cite>` tag previously validated + re-emitted by the backend's
// citation service. We intentionally only accept the canonical shape the
// backend produces — src="...", lines="N-M", optional data-cite-id — so an
// attacker can't smuggle HTML through a non-canonical tag that slipped past.
export const CITE_TAG_PATTERN =
  /<cite\b([^>]*)>([\s\S]*?)<\/cite>/gi;

const ATTR_PATTERN_CACHE = new Map();
function attrPattern(name) {
  let pattern = ATTR_PATTERN_CACHE.get(name);
  if (!pattern) {
    pattern = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i');
    ATTR_PATTERN_CACHE.set(name, pattern);
  }
  return pattern;
}
function readAttr(attrs, name) {
  const m = attrs.match(attrPattern(name));
  return m ? m[1] : '';
}

function parseLinesAttr(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parts = raw.split(/[\s-–:]+/).filter(Boolean);
  if (!parts.length) return null;
  const a = Number(parts[0]);
  const b = parts[1] != null ? Number(parts[1]) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { startLine: Math.min(a, b), endLine: Math.max(a, b) };
}

/**
 * Parse a prose chunk into alternating text/cite segments. Exposed for tests;
 * callers typically want `renderInlineSegmentWithCites` which wraps this.
 *
 * @returns {Array<{kind:'text', text:string}|{kind:'cite', src:string, startLine:number, endLine:number, quote:string}>}
 */
export function parseCiteSegments(text = '') {
  const input = String(text || '');
  const segments = [];
  let cursor = 0;
  CITE_TAG_PATTERN.lastIndex = 0;
  let match;
  while ((match = CITE_TAG_PATTERN.exec(input))) {
    if (match.index > cursor) {
      segments.push({ kind: 'text', text: input.slice(cursor, match.index) });
    }
    const attrs = match[1] || '';
    const src = readAttr(attrs, 'src');
    const lines = parseLinesAttr(readAttr(attrs, 'lines'));
    const quote = (match[2] || '').trim();
    if (src && lines && quote) {
      segments.push({
        kind: 'cite',
        src,
        startLine: lines.startLine,
        endLine: lines.endLine,
        // Quote came in HTML-escaped from the backend (it re-emits &lt; etc.);
        // we leave it escaped here — renderers can escape again at will and
        // entity double-escaping is harmless for the display surface.
        quote,
      });
    } else if (quote) {
      // Malformed tag — fall back to the inner text so the user still sees
      // the claim, just without a clickable pill.
      segments.push({ kind: 'text', text: quote });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < input.length) {
    segments.push({ kind: 'text', text: input.slice(cursor) });
  }
  return segments;
}

/**
 * Render one prose chunk with inline cite pills. The provided `escapeHtml`
 * function is used for all text segments so this module doesn't need to own
 * an escape policy — it just composes with whatever the host app is using.
 * Returns HTML as a string.
 */
export function renderInlineSegmentWithCites(text, escapeHtml) {
  const segments = parseCiteSegments(text);
  if (segments.length === 1 && segments[0].kind === 'text') {
    return escapeHtml(segments[0].text);
  }
  // Pill numbering is stable within a single prose chunk.
  let pillIndex = 0;
  return segments
    .map(seg => {
      if (seg.kind === 'text') return escapeHtml(seg.text);
      pillIndex += 1;
      return renderPillHtml(seg, pillIndex, escapeHtml);
    })
    .join('');
}

function renderPillHtml(cite, index, escapeHtml) {
  // Keep the full quote on the pill as the accessible tooltip so the user
  // can preview the claim without opening the drawer.
  const tooltip = `${cite.src}:${cite.startLine}${
    cite.endLine !== cite.startLine ? `-${cite.endLine}` : ''
  } · ${cite.quote}`;
  return (
    `<button type="button" class="cite-pill" data-cite-pill ` +
    `data-cite-src="${escapeHtml(cite.src)}" ` +
    `data-cite-start="${cite.startLine}" ` +
    `data-cite-end="${cite.endLine}" ` +
    `data-cite-quote="${escapeHtml(cite.quote)}" ` +
    `title="${escapeHtml(tooltip)}">` +
    `<span class="cite-pill-num">${index}</span>` +
    `</button>`
  );
}

// ─── Side drawer ───────────────────────────────────────────────────────────

let drawerBootstrapped = false;
let drawerFetchPreview = null;
const previewCache = new Map(); // src → Promise<{ content, language, truncated }>

/**
 * Install the citation drawer. Must be called once during app boot, AFTER
 * document.body exists. Adopts a function the host uses to fetch file
 * previews so this module stays transport-agnostic.
 *
 * @param {object} params
 * @param {(opts:{filePath:string}) => Promise<{content:string, language?:string, truncated?:boolean, path?:string}>} params.fetchPreview
 */
export function installCitationDrawer({ fetchPreview }) {
  if (drawerBootstrapped) {
    // Updating the fetcher is fine (e.g. if API base changes mid-session).
    drawerFetchPreview = fetchPreview;
    return;
  }
  drawerBootstrapped = true;
  drawerFetchPreview = fetchPreview;

  const drawer = document.createElement('aside');
  drawer.className = 'citation-drawer';
  drawer.setAttribute('aria-hidden', 'true');
  drawer.innerHTML = `
    <div class="citation-drawer-backdrop" data-cite-close></div>
    <div class="citation-drawer-panel" role="dialog" aria-label="Source citation preview">
      <header class="citation-drawer-header">
        <div class="citation-drawer-header-main">
          <div class="citation-drawer-title" data-cite-title>Source</div>
          <div class="citation-drawer-meta" data-cite-meta></div>
        </div>
        <button type="button" class="citation-drawer-close" data-cite-close aria-label="Close">×</button>
      </header>
      <div class="citation-drawer-quote" data-cite-quote-box></div>
      <div class="citation-drawer-body" data-cite-body>
        <div class="citation-drawer-placeholder">Loading source…</div>
      </div>
    </div>
  `;
  document.body.appendChild(drawer);

  // Global click delegate — catches pill clicks AND the drawer's own close
  // controls. Lives on document so it survives the chat root's innerHTML
  // replacements.
  document.addEventListener('click', event => {
    const pill = event.target.closest?.('[data-cite-pill]');
    if (pill) {
      event.preventDefault();
      const src = pill.dataset.citeSrc;
      const startLine = Number(pill.dataset.citeStart) || 1;
      const endLine = Number(pill.dataset.citeEnd) || startLine;
      const quote = pill.dataset.citeQuote || '';
      openCitationDrawer({ src, startLine, endLine, quote });
      return;
    }
    if (event.target.closest?.('[data-cite-close]')) {
      closeCitationDrawer();
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drawer.classList.contains('is-open')) {
      closeCitationDrawer();
    }
  });
}

function escapeText(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function openCitationDrawer({ src, startLine, endLine, quote }) {
  if (!drawerBootstrapped) return;
  const drawer = document.querySelector('.citation-drawer');
  if (!drawer) return;
  drawer.classList.add('is-open');
  drawer.setAttribute('aria-hidden', 'false');

  const titleEl = drawer.querySelector('[data-cite-title]');
  const metaEl = drawer.querySelector('[data-cite-meta]');
  const quoteEl = drawer.querySelector('[data-cite-quote-box]');
  const bodyEl = drawer.querySelector('[data-cite-body]');
  if (!titleEl || !metaEl || !quoteEl || !bodyEl) return;

  titleEl.textContent = src;
  metaEl.textContent =
    endLine === startLine
      ? `Line ${startLine}`
      : `Lines ${startLine}–${endLine}`;
  quoteEl.textContent = quote || '';

  bodyEl.innerHTML = '<div class="citation-drawer-placeholder">Loading source…</div>';

  const preview = await fetchPreviewCached(src).catch(err => ({ error: err }));

  if (!drawer.classList.contains('is-open')) {
    // User closed the drawer while we were loading; nothing to do.
    return;
  }

  if (!preview || preview.error) {
    bodyEl.innerHTML =
      `<div class="citation-drawer-error">Could not load source: ` +
      `${escapeText(preview?.error?.message || 'unknown error')}</div>`;
    return;
  }

  bodyEl.innerHTML = renderSourceBody(preview, { startLine, endLine });

  // Smooth-scroll the first highlighted line into the middle of the viewport.
  const target = bodyEl.querySelector('[data-cite-highlight-anchor]');
  if (target) {
    // requestAnimationFrame so the layout has settled before measuring.
    requestAnimationFrame(() => {
      try {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch {
        target.scrollIntoView();
      }
    });
  }
}

function closeCitationDrawer() {
  const drawer = document.querySelector('.citation-drawer');
  if (!drawer) return;
  drawer.classList.remove('is-open');
  drawer.setAttribute('aria-hidden', 'true');
}

function fetchPreviewCached(src) {
  if (!drawerFetchPreview) return Promise.reject(new Error('drawer not installed'));
  if (previewCache.has(src)) return previewCache.get(src);
  const p = Promise.resolve(drawerFetchPreview({ filePath: src })).catch(err => {
    // Drop failed lookups so a retry has a chance.
    previewCache.delete(src);
    throw err;
  });
  previewCache.set(src, p);
  return p;
}

/**
 * Clear the in-memory preview cache. Called by the host when the active
 * project changes, since workspace-relative paths could shadow different
 * files across projects.
 */
export function resetCitationPreviewCache() {
  previewCache.clear();
}

function renderSourceBody(preview, { startLine, endLine }) {
  const content = String(preview?.content || '');
  if (!content) {
    return '<div class="citation-drawer-placeholder">Source is empty.</div>';
  }
  const lines = content.split('\n');
  const rendered = lines
    .map((line, idx) => {
      const lineNo = idx + 1;
      const inRange = lineNo >= startLine && lineNo <= endLine;
      const isAnchor = lineNo === startLine;
      const cls =
        'citation-drawer-line' + (inRange ? ' is-highlighted' : '');
      const anchor = isAnchor ? ' data-cite-highlight-anchor' : '';
      return (
        `<div class="${cls}"${anchor}>` +
        `<span class="citation-drawer-lineno">${lineNo}</span>` +
        `<span class="citation-drawer-linebody">${escapeText(line) || '&nbsp;'}</span>` +
        `</div>`
      );
    })
    .join('');
  const truncNote = preview.truncated
    ? '<div class="citation-drawer-truncation">… [source was truncated to fit preview]</div>'
    : '';
  return `<pre class="citation-drawer-code" data-language="${escapeText(
    preview.language || 'text',
  )}">${rendered}</pre>${truncNote}`;
}

/**
 * Build { messageId → citations[] } from a list of chat messages. The chat
 * render path is the one that actually needs this map, but exposing it here
 * keeps citation lookup logic in one module.
 */
export function collectCitationsByMessageId(messages = []) {
  const map = {};
  if (!Array.isArray(messages)) return map;
  for (const message of messages) {
    if (!message || !message.id) continue;
    if (Array.isArray(message.citations) && message.citations.length) {
      map[message.id] = message.citations;
    }
  }
  return map;
}
