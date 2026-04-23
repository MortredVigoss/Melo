const WORD_SEGMENTER = new Intl.Segmenter([], { granularity: 'word' });
const GRAPHEME_SEGMENTER = new Intl.Segmenter([], { granularity: 'grapheme' });
const CJK_GRAPHEME_PATTERN =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

export function normalizeSearchValue(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeQuery(value = '') {
  const normalized = normalizeSearchValue(value);
  if (!normalized) {
    return { raw: '', tokens: [], graphemes: [] };
  }

  const tokens = [];
  for (const { segment, isWordLike } of WORD_SEGMENTER.segment(normalized)) {
    if (isWordLike && segment.trim()) {
      tokens.push(segment);
    }
  }

  const graphemes = [];
  for (const { segment } of GRAPHEME_SEGMENTER.segment(normalized)) {
    if (CJK_GRAPHEME_PATTERN.test(segment)) {
      graphemes.push(segment);
    }
  }

  return { raw: normalized, tokens, graphemes };
}

export function tokenizeHaystack(value = '') {
  return normalizeSearchValue(value);
}

export function splitGraphemes(value = '') {
  return [...GRAPHEME_SEGMENTER.segment(String(value || ''))].map(entry => entry.segment);
}

export function sliceByGrapheme(value = '', start = 0, end = Infinity) {
  return splitGraphemes(value)
    .slice(Math.max(0, start), Math.max(start, end))
    .join('');
}

export function codeUnitIndexToGraphemeIndex(value = '', codeUnitIndex = 0) {
  const graphemes = splitGraphemes(value);
  let offset = 0;

  for (let index = 0; index < graphemes.length; index += 1) {
    if (offset >= codeUnitIndex) {
      return index;
    }
    offset += graphemes[index].length;
  }

  return graphemes.length;
}
