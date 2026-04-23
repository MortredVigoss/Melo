// Shared tokenizer for skill matching / indexing.
//
// Extracted from skillMatcher.js + skillIndex.js (Search audit C-1). Upgraded
// to use Intl.Segmenter for CJK word segmentation (Search audit C-2).
//
// Previously both files carried an identical copy of this function with a
// "keep in lockstep" comment; the duplicate existed to avoid a circular
// import between them. Centralising it here removes the drift risk — both
// modules now depend on this leaf module, so there's no cycle.
//
// Tokenizer contract:
//   - Lowercase.
//   - Split on whitespace + Unicode punctuation/symbols.
//   - For ASCII-only pieces, drop tokens shorter than MIN_WORD_LEN (3).
//   - For pieces containing any non-ASCII char (CJK, kana, hangul, emoji,
//     etc.), try Intl.Segmenter word segmentation so "天气真好" becomes
//     ["天气", "真好"] instead of one opaque token. We also emit the whole
//     piece so a trigger stored verbatim ("天气预报") still matches a message
//     that literally contains it — only cost is a few extra Set entries.
//
// The function is deterministic and has no external dependencies, so it's
// safe to import from anywhere.

export const MIN_WORD_LEN = 3;

// Intl.Segmenter is cheap to call but non-trivial to construct, so build one
// per interesting locale lazily and cache them. We use 'zh' as a reasonable
// default for CJK ideographs — ICU's word break data does a fine job on
// zh/ja mixed content in practice — and fall back gracefully if the runtime
// doesn't ship Segmenter at all (very old Node < 16).
let _cjkSegmenter = null;
function getCjkSegmenter() {
  if (_cjkSegmenter !== null) return _cjkSegmenter;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      _cjkSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    } else {
      _cjkSegmenter = false;
    }
  } catch {
    _cjkSegmenter = false;
  }
  return _cjkSegmenter;
}

// Which characters should be segmented via Intl.Segmenter rather than kept
// as a single whole-piece token. Kept conservative: CJK ideographs, kana,
// hangul, and bopomofo. Other non-ASCII pieces (emoji, accented latin)
// stay as one token — splitting accented text on grapheme boundaries would
// just produce noise for the kinds of skill triggers we actually have.
const CJK_SCRIPT_RE = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\u3100-\u312F]/;

function segmentCjkPiece(piece, out) {
  const seg = getCjkSegmenter();
  if (!seg) {
    // No Segmenter available — fall back to the legacy behaviour of keeping
    // the whole piece. Search recall is weaker but correctness is preserved.
    out.push(piece);
    return;
  }
  // Always keep the whole piece too so a trigger stored verbatim still fires
  // on a literal-match basis. Deduped later by Set semantics on the caller.
  out.push(piece);
  for (const { segment, isWordLike } of seg.segment(piece)) {
    if (!isWordLike) continue;
    const trimmed = segment.trim();
    if (!trimmed || trimmed === piece) continue;
    out.push(trimmed);
  }
}

/**
 * Tokenize text for matching. Returns a lowercased array of tokens; see the
 * module doc comment for the exact contract.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeForMatch(text) {
  if (typeof text !== 'string' || !text) return [];
  const normalized = text.toLowerCase();
  // Split on whitespace and Unicode punctuation/symbols; keep word chars.
  const pieces = normalized.split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
  const out = [];
  for (const piece of pieces) {
    if (/[^\x00-\x7f]/.test(piece)) {
      // Non-ASCII piece. If it contains CJK, try Intl.Segmenter; otherwise
      // keep the whole piece (covers emoji-heavy pieces, accented latin,
      // etc. where sub-segmenting would just produce noise).
      if (CJK_SCRIPT_RE.test(piece)) {
        segmentCjkPiece(piece, out);
      } else {
        out.push(piece);
      }
      continue;
    }
    if (piece.length >= MIN_WORD_LEN) out.push(piece);
  }
  return out;
}
