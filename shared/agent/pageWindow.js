import { estimateTextTokens } from './tokenEstimate.js';

// One page window costs about the same number of tokens whatever the script.
// The limit is in characters, and 20 000 characters of Latin text are about
// 5 000 tokens while 20 000 CJK characters are about 20 000: with the whole
// window shown to the model (2026-11-10 latency audit L2) a few Chinese pages
// would use up a member's input share. The window is shortened in proportion,
// and the continuation offset it reports is where the shortened window ends.
export const PAGE_WINDOW_TOKENS = 7000;
// The longest window in characters (the desktop default for fetch_url, and what the
// phone reader and the completion evidence rows use).
export const PAGE_WINDOW_CHARS = 20000;
export function windowChars(content, offset, maxChars, maxTokens = PAGE_WINDOW_TOKENS) {
  const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const slice = String(content).slice(start, start + maxChars);
  const tokens = estimateTextTokens(slice);
  if (tokens <= maxTokens || !slice.length) return maxChars;
  return Math.max(1000, Math.min(maxChars, Math.floor(slice.length * maxTokens / tokens)));
}
