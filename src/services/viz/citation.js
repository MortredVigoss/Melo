// ─── Citation service (NotebookLM-style source pins) ────────────────────────
// Demon-mode sibling of vizSpec.js. When Demon is on AND the active project
// has workspace files, this module tells the model to wrap factual claims
// that came from a specific file span in a `<cite src=".." lines="N-M">…</cite>`
// tag inline in its reply. The desktop UI then renders each tag as a numbered
// pill; clicking the pill opens a side drawer with that file scrolled to the
// cited range.
//
// Why inline tags rather than a trailer (as viz-spec uses):
//   - Citations are *attached to a sentence*, not to the whole reply. A
//     trailer would force the user to guess which claim each citation backs.
//   - Each cite should render IN-LINE as a small pill the user can click
//     exactly where the assertion is made.
//
// Remote channels (Telegram/Discord) get a plain-text fallback: the <cite>
// wrapper is stripped and only the inner quote text survives — TG/DC cannot
// render interactive pills or open a side drawer.
//
// Public surface:
//   - buildCitationInstructions(opts)  — system-prompt block (emit side)
//   - extractCitations(text, opts)     — parse+normalize tags (parse side)
//   - CITATION_TAG_GLOBAL_PATTERN      — exported for test assertions only
//
// The tag shape intentionally avoids free-form HTML so that a prompt-injection
// attacker cannot smuggle malicious attributes through. `extractCitations`
// only reads `src`, `lines`, and the inner text; everything else is ignored.

// Max raw cite tags we'll parse off one reply. If the model spams thousands,
// we drop the overflow.
const MAX_CITATIONS = 64;

// Absolute cap on the inner "quote" text — avoids a pathological reply where
// a cite wraps the entire reply body and blows past the DOM.
const MAX_QUOTE_LENGTH = 400;

// Max lines a single citation can span. If the model asks for lines="1-999"
// we truncate to a sensible window so the side viewer stays scannable.
const MAX_LINE_SPAN = 240;

// Matches `<cite src="..." lines="N" or "N-M">…</cite>`. Non-greedy on the
// inner content so adjacent cites don't merge. The attribute block is parsed
// separately so order doesn't matter.
export const CITATION_TAG_GLOBAL_PATTERN =
  /<cite\b([^>]*)>([\s\S]*?)<\/cite>/gi;

function parseAttribute(attrs, name) {
  const pattern = new RegExp(
    `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  );
  const match = attrs.match(pattern);
  if (!match) return '';
  return (match[2] ?? match[3] ?? match[4] ?? '').trim();
}

function parseLineRange(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  // Accept "N", "N-M", "N–M" (em dash), or "N:M".
  const parts = raw.split(/[\s-–:]+/).filter(Boolean);
  if (!parts.length) return null;
  const start = Number(parts[0]);
  const end = parts[1] != null ? Number(parts[1]) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const a = Math.max(1, Math.floor(Math.min(start, end)));
  const b = Math.max(a, Math.floor(Math.max(start, end)));
  // Clamp span so a cite spanning the entire file stays human-sized.
  const capped = Math.min(b, a + MAX_LINE_SPAN - 1);
  return { startLine: a, endLine: capped };
}

function normalizeSrc(src) {
  const trimmed = String(src || '').trim();
  if (!trimmed) return '';
  // Reject absolute paths, drive letters, and parent-dir traversal — the
  // citation preview endpoint will enforce these too, but rejecting at parse
  // time means the bad cite is dropped (replaced by its inner text) before
  // it ever reaches the client.
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) return '';
  if (trimmed.split(/[\\/]/).some(part => part === '..')) return '';
  // Strip leading ./ for consistency.
  return trimmed.replace(/^\.\//, '');
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function cleanQuote(innerText) {
  const collapsed = decodeEntities(String(innerText || ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return '';
  return collapsed.length > MAX_QUOTE_LENGTH
    ? `${collapsed.slice(0, MAX_QUOTE_LENGTH - 1).trimEnd()}…`
    : collapsed;
}

/**
 * Produce the system-prompt section that tells the model how to emit
 * `<cite>` tags. Returns an empty string when the instruction should not
 * be injected.
 *
 * Gating:
 *   - `enabled` must be true (Demon toggle)
 *   - `isRemoteChannel` must be false (TG/DC cannot render pills)
 *   - `hasProjectFiles` must be true (nothing to cite from otherwise)
 *
 * @param {object} opts
 * @param {boolean} [opts.enabled]
 * @param {boolean} [opts.isRemoteChannel]
 * @param {boolean} [opts.hasProjectFiles]
 * @returns {string}
 */
export function buildCitationInstructions({
  enabled = false,
  isRemoteChannel = false,
  hasProjectFiles = false,
} = {}) {
  if (!enabled || isRemoteChannel || !hasProjectFiles) return '';

  return [
    'Source citation mode is ENABLED. When — AND ONLY WHEN — a factual claim',
    'in your reply came from a SPECIFIC span of a file you have already read',
    'from the project workspace in this conversation, wrap that claim in an',
    'inline `<cite>` tag so the user can verify it against the source file.',
    '',
    'Tag shape (all attributes required):',
    '  <cite src="relative/path/from/workspace" lines="N" or "N-M">short quoted claim</cite>',
    '',
    'Rules:',
    '  - Use a `<cite>` tag INLINE, in the middle of prose, wrapping only',
    '    the phrase/clause the source backs — not the entire sentence.',
    '  - `src` must be a workspace-relative path you have actually read in',
    '    this conversation via a read-file tool call. Never cite a file you',
    '    have not opened, and never cite absolute paths or parent-dir paths.',
    '  - `lines` is 1-based and inclusive. Use a single number for a one-line',
    '    citation ("lines=\\"42\\""), or "N-M" for a span ("lines=\\"42-48\\"").',
    '  - The inner text must be a short paraphrase or exact quote that maps',
    '    to the cited line range. Keep it under ~300 characters.',
    '  - Do NOT cite:',
    '    * General knowledge, common sense, or your own inference',
    '    * Chat history or prior user messages',
    '    * Files you have not actually opened this conversation',
    '  - At most a few citations per reply — only when they materially help',
    '    the user verify the claim. A reply with zero citations is fine.',
    '  - Do NOT cite inside fenced code blocks. Cites are for prose only.',
  ].join('\n');
}

/**
 * Parse `<cite>` tags out of a reply.
 *
 * Returns `{ text, citations }`:
 *   - On desktop: `text` keeps the tags intact so the frontend can render
 *     inline pills, and `citations` is an ordered array of the parsed
 *     `{ id, src, startLine, endLine, quote }` records.
 *   - On remote channels: `text` has each tag replaced with just its inner
 *     quote text (plain-text fallback), and `citations` is empty — TG/DC
 *     cannot render pills.
 *   - Tags with invalid `src`, missing/bad `lines`, or empty inner text are
 *     always stripped to their inner quote regardless of channel, so a
 *     malformed cite degrades gracefully instead of leaking raw tags.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.isRemoteChannel]
 * @returns {{ text: string, citations: Array<{id:string, src:string, startLine:number, endLine:number, quote:string}> }}
 */
export function extractCitations(text = '', { isRemoteChannel = false } = {}) {
  const source = String(text || '');
  const citations = [];
  let counter = 0;

  const rewritten = source.replace(CITATION_TAG_GLOBAL_PATTERN, (_full, attrs, inner) => {
    const quote = cleanQuote(inner);
    const src = normalizeSrc(parseAttribute(attrs, 'src'));
    const range = parseLineRange(parseAttribute(attrs, 'lines'));

    // Any validation failure → fall back to the inner text. Never leak
    // a malformed tag to the user, and never drop the underlying claim.
    if (!src || !range || !quote) return quote;

    // On remote channels we always collapse to inner text.
    if (isRemoteChannel) return quote;

    // Overflow past MAX_CITATIONS also collapses to inner text.
    if (counter >= MAX_CITATIONS) return quote;

    counter += 1;
    const id = `c${counter}`;
    citations.push({
      id,
      src,
      startLine: range.startLine,
      endLine: range.endLine,
      quote,
    });

    // Re-emit a canonical tag — inner text normalized, attributes in
    // fixed order — so downstream rendering is deterministic and immune to
    // attribute-order tricks.
    const escapedQuote = quote
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<cite data-cite-id="${id}" src="${src}" lines="${range.startLine}-${range.endLine}">${escapedQuote}</cite>`;
  });

  return { text: rewritten, citations };
}
