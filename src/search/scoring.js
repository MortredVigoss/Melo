import {
  codeUnitIndexToGraphemeIndex,
  normalizeSearchValue,
  sliceByGrapheme,
  splitGraphemes,
  tokenizeHaystack,
  tokenizeQuery,
} from './tokenizer.js';

export { normalizeSearchValue };

export function isSubsequenceMatch(text = '', query = '') {
  let queryIndex = 0;
  for (let index = 0; index < text.length && queryIndex < query.length; index += 1) {
    if (text[index] === query[queryIndex]) {
      queryIndex += 1;
    }
  }
  return queryIndex === query.length;
}

export function fuzzySubsequenceScore(query, target) {
  if (!query || !target) {
    return 0;
  }

  let searchIndex = 0;
  let gapPenalty = 0;

  for (const char of query) {
    const foundAt = target.indexOf(char, searchIndex);
    if (foundAt === -1) {
      return 0;
    }
    gapPenalty += Math.max(0, foundAt - searchIndex);
    searchIndex = foundAt + 1;
  }

  return Math.max(18, 140 - gapPenalty - Math.max(0, target.length - query.length));
}

export function fuzzySearchScore(query, ...values) {
  const haystack = tokenizeHaystack(values.filter(Boolean).join('\n'));
  const { tokens, graphemes, raw } = tokenizeQuery(query);

  if (!raw || !haystack) {
    return 0;
  }

  let score = 0;
  if (haystack === raw) {
    score += 1200;
  }
  if (haystack.startsWith(raw)) {
    score += 880;
  }

  const exactIndex = haystack.indexOf(raw);
  if (exactIndex >= 0) {
    // Use Math.ceil(exactIndex / 3) instead of exactIndex * 6 so the floor
    // (420) isn't reached until ~1020 chars in. The old formula hit the floor
    // at only ~57 chars, which meant any match inside a typical message body
    // scored the same as a match buried at the end of a 10 000-char document.
    score += Math.max(420, 760 - Math.ceil(exactIndex / 3));
  }

  for (const token of tokens) {
    const tokenIndex = haystack.indexOf(token);
    if (tokenIndex >= 0) {
      // Same fix for per-token position penalty (floor at ~750 chars vs 60).
      score += Math.max(90, 240 - Math.ceil(tokenIndex / 5));
      continue;
    }

    if (isSubsequenceMatch(haystack, token)) {
      score += 120;
    }
    score += fuzzySubsequenceScore(token, haystack);
  }

  for (const grapheme of graphemes) {
    if (haystack.includes(grapheme)) {
      score += 24;
    }
  }

  if (!score && isSubsequenceMatch(haystack, raw)) {
    score += 160;
  }

  if (!score) {
    score = fuzzySubsequenceScore(raw, haystack);
  }

  if (!score) {
    return 0;
  }

  return score + Math.max(0, 90 - Math.floor(haystack.length / 10));
}

export function weightedKeywordScore(query, keywords = []) {
  const entries = Array.isArray(keywords)
    ? keywords
    : String(keywords || '')
        .split(/\s+/)
        .filter(Boolean)
        .map(keyword => ({ keyword, weight: 1 }));

  return entries.reduce((total, entry) => {
    const keyword = String(entry?.keyword || '').trim();
    const weight = Number(entry?.weight);
    if (!keyword) {
      return total;
    }

    const baseScore = fuzzySearchScore(query, keyword);
    if (!baseScore) {
      return total;
    }

    return total + Math.round(baseScore * (Number.isFinite(weight) ? weight : 1));
  }, 0);
}

export function buildSearchSnippet(text, query, maxLength = 96) {
  const rawText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!rawText) {
    return 'Untitled result';
  }

  const graphemes = splitGraphemes(rawText);
  if (graphemes.length <= maxLength) {
    return rawText;
  }

  const normalizedText = rawText.toLowerCase();
  const { tokens, graphemes: cjkGraphemes, raw } = tokenizeQuery(query);
  const candidates = [...tokens, ...cjkGraphemes, raw].filter(Boolean);
  const matchToken = candidates.find(token => normalizedText.includes(token));
  if (!matchToken) {
    return `${sliceByGrapheme(rawText, 0, Math.max(1, maxLength - 1))}…`;
  }

  const matchIndex = normalizedText.indexOf(matchToken);
  const matchGraphemeIndex = codeUnitIndexToGraphemeIndex(rawText, matchIndex);
  const start = Math.max(0, matchGraphemeIndex - Math.floor(maxLength * 0.32));
  const end = Math.min(graphemes.length, start + maxLength);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < graphemes.length ? '…' : '';
  return `${prefix}${sliceByGrapheme(rawText, start, end).trim()}${suffix}`;
}
