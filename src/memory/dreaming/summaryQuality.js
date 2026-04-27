/**
 * Reference-free summary-quality heuristic (F-2C).
 *
 * `offline/compact.js` falls back to a local LLM (qwen2.5:3b by default) for
 * the L1 compact summary.  When the LLM hallucinates, our regression net is
 * thin: unit tests cover the path, not the *content* of the summary.  This
 * module gives us a cheap, dependency-free score so we can flag bad LLM
 * output and (optionally) fall back to the rule-based summariser.
 *
 * Three signals make up the score — all reference-free, all O(n) over the
 * input length:
 *
 *   1. lengthOk          — boolean.  Summaries shorter than 10 chars or
 *                          longer than 1500 chars are almost always wrong
 *                          (truncation / runaway respectively).
 *   2. entityCoverage    — fraction of the source's top-8 entities that the
 *                          summary still mentions.  Catches "the LLM forgot
 *                          to name what we were talking about".
 *   3. tokenGroundedness — fraction of the summary's content tokens that
 *                          also appear in the source.  Catches hallucinated
 *                          new terms.
 *
 * Score = 0.1 · length + 0.4 · entityCoverage + 0.5 · tokenGroundedness.
 * Default pass threshold is 0.6 (overridable via opts or env).
 *
 * Why these weights, briefly:
 *   - tokenGroundedness gets the largest weight because it directly measures
 *     fabrication — the failure mode we care about most.
 *   - entityCoverage protects against "summary stays grounded but drops the
 *     subject", e.g. omitting the proper noun the conversation was about.
 *   - length is a sanity gate, not a quality signal — small weight, hard
 *     issue flag.
 *
 * The functions in this module are pure aside from `auditSummary`, which
 * appends a one-line entry to the daily DREAMS.md so operators can see
 * quality trends alongside the existing dreaming-sweep records.
 */

import { mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getMeloHome } from '../../config.js';

export const QUALITY_DEFAULT_THRESHOLD = 0.6;
export const QUALITY_MIN_LENGTH = 10;
export const QUALITY_MAX_LENGTH = 1500;
export const QUALITY_TOP_ENTITIES = 8;

const CJK_RE = /[一-鿿぀-ヿ가-힯]/;

// Lightweight content-word stopwords.  Same spirit as `frame.js::STOPWORDS`
// but kept independent: we want grounding to ignore filler tokens that
// appear in both source and summary by accident.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'this', 'that',
  'with', 'from', 'have', 'has', 'was', 'were', 'will', 'would', 'can',
  'could', 'should', 'just', 'only', 'what', 'when', 'where', 'which',
  'who', 'why', 'how', 'okay', 'yes', 'yeah', 'sure', 'thanks', 'please',
  'about', 'some', 'any', 'all', 'there', 'here', 'they', 'them', 'their',
  'is', 'it', 'be', 'as', 'an', 'a', 'on', 'in', 'to', 'of', 'or', 'by',
  'we', 'i', 'me', 'my', 'us', 'our', 'do', 'did', 'does', 'so', 'if',
]);

/**
 * Tokenise content words.  Latin runs of length ≥ 2 (lowercased) plus any
 * CJK code points as single-character tokens.  CJK is intentionally per-char
 * so single-character keywords (e.g. 改) still register; the entity stage
 * picks up multi-char names separately as bigrams.
 */
export function tokenize(text = '') {
  const out = [];
  const s = String(text || '');
  // Latin / Cyrillic / etc.
  for (const m of s.toLowerCase().matchAll(/[\p{Ll}\p{Lu}\p{N}]{2,}/gu)) {
    const tok = m[0];
    if (!STOPWORDS.has(tok)) out.push(tok);
  }
  // CJK characters individually.  We skip the stopword filter here because
  // single CJK chars are too ambiguous to denylist generically.
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (CJK_RE.test(ch)) out.push(ch);
  }
  return out;
}

/**
 * Pull out the most "named" tokens from `text` — proper nouns, acronyms,
 * and CJK bigrams.  Ranked by frequency, capped at QUALITY_TOP_ENTITIES so
 * a long source doesn't drown the comparison.
 */
export function extractEntities(text = '') {
  const counts = new Map();
  const s = String(text || '');

  // Capitalised Latin words (proper nouns / titles).  Length ≥ 2 so single
  // sentence-initial caps like "I" don't count.
  for (const m of s.matchAll(/\b[A-Z][A-Za-z0-9_-]{1,}\b/g)) {
    const key = m[0].toLowerCase();
    if (STOPWORDS.has(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // All-caps acronyms (LRU, API, MMR…)
  for (const m of s.matchAll(/\b[A-Z]{2,}\b/g)) {
    const key = m[0].toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // CJK bigrams — sliding window over consecutive CJK chars.
  for (let i = 0; i < s.length - 1; i += 1) {
    const a = s[i];
    const b = s[i + 1];
    if (CJK_RE.test(a) && CJK_RE.test(b)) {
      const key = a + b;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, QUALITY_TOP_ENTITIES)
    .map(([key]) => key);
}

/**
 * Score a summary against its source.
 *
 * @param {string} summary
 * @param {string} source
 * @param {Object} [opts]
 * @param {number} [opts.minLength]   override min char count
 * @param {number} [opts.maxLength]   override max char count
 * @param {number} [opts.threshold]   pass threshold (default env or 0.6)
 * @returns {{
 *   score: number,
 *   pass: boolean,
 *   threshold: number,
 *   metrics: {
 *     lengthChars: number,
 *     lengthOk: boolean,
 *     entityCoverage: number,
 *     tokenGroundedness: number,
 *     entitiesChecked: number,
 *     summaryTokens: number,
 *   },
 *   issues: string[],
 * }}
 */
export function evaluateSummaryQuality(summary, source, opts = {}) {
  const minLen = Number.isFinite(opts.minLength) ? opts.minLength : QUALITY_MIN_LENGTH;
  const maxLen = Number.isFinite(opts.maxLength) ? opts.maxLength : QUALITY_MAX_LENGTH;
  const threshold = Number.isFinite(opts.threshold)
    ? opts.threshold
    : Number(process.env.MELO_SUMMARY_QUALITY_THRESHOLD) || QUALITY_DEFAULT_THRESHOLD;

  const summaryStr = String(summary == null ? '' : summary).trim();
  const sourceStr = String(source == null ? '' : source).trim();
  const len = summaryStr.length;

  // Empty inputs short-circuit so the caller gets a deterministic "fail"
  // rather than NaN scores.
  if (!summaryStr || !sourceStr) {
    return {
      score: 0,
      pass: false,
      threshold,
      metrics: {
        lengthChars: len,
        lengthOk: false,
        entityCoverage: 0,
        tokenGroundedness: 0,
        entitiesChecked: 0,
        summaryTokens: 0,
      },
      issues: !summaryStr ? ['empty summary'] : ['empty source'],
    };
  }

  const lengthOk = len >= minLen && len <= maxLen;

  const summaryTokens = new Set(tokenize(summaryStr));
  const sourceTokens = new Set(tokenize(sourceStr));
  let intersect = 0;
  for (const tok of summaryTokens) if (sourceTokens.has(tok)) intersect += 1;
  const tokenGroundedness = summaryTokens.size ? intersect / summaryTokens.size : 0;

  const sourceEntities = extractEntities(sourceStr);
  const summaryLower = summaryStr.toLowerCase();
  const matched = sourceEntities.filter(e => summaryLower.includes(e)).length;
  const entityCoverage = sourceEntities.length ? matched / sourceEntities.length : 1;

  const score =
    (lengthOk ? 0.1 : 0) +
    0.4 * entityCoverage +
    0.5 * tokenGroundedness;

  const issues = [];
  if (len < minLen) issues.push(`summary too short (${len}<${minLen} chars)`);
  if (len > maxLen) issues.push(`summary too long (${len}>${maxLen} chars)`);
  if (entityCoverage < 0.5) {
    issues.push(`low entity coverage (${Math.round(entityCoverage * 100)}% of top-${sourceEntities.length})`);
  }
  if (tokenGroundedness < 0.6) {
    issues.push(`low groundedness (${Math.round(tokenGroundedness * 100)}% of summary tokens in source)`);
  }

  return {
    score: Number(score.toFixed(3)),
    pass: score >= threshold,
    threshold,
    metrics: {
      lengthChars: len,
      lengthOk,
      entityCoverage: Number(entityCoverage.toFixed(3)),
      tokenGroundedness: Number(tokenGroundedness.toFixed(3)),
      entitiesChecked: sourceEntities.length,
      summaryTokens: summaryTokens.size,
    },
    issues,
  };
}

/**
 * Resolve the dreams diary file for `iso`.  Captures `getMeloHome()` lazily
 * but synchronously at call time so a follow-up async write can't observe a
 * different home (CLAUDE.md §6).
 */
export function summaryDiaryPath(iso = new Date().toISOString(), homeOverride = null) {
  const day = iso.slice(0, 10);
  const home = homeOverride || getMeloHome();
  return join(home, 'desktop', 'dreams', `${day}.md`);
}

/**
 * Append a one-line audit entry to the daily diary file.  Returns the path
 * that was written.
 */
export function appendSummaryAuditLine({ label, evaluation, iso = new Date().toISOString(), homeOverride = null } = {}) {
  const path = summaryDiaryPath(iso, homeOverride);
  mkdirSync(dirname(path), { recursive: true });
  const header = existsSync(path)
    ? ''
    : `# Melo Dream Diary — ${iso.slice(0, 10)}\n\n_Auto-generated audit of Melo's background memory consolidation sweeps. Safe to delete; no runtime dependency._\n\n`;
  const mark = evaluation.pass ? 'PASS' : 'FAIL';
  const m = evaluation.metrics;
  const issuesStr = evaluation.issues.length ? ` — ${evaluation.issues.join('; ')}` : '';
  const block =
    `## Summary audit ${iso}\n\n` +
    `\`${mark}\` **${label}** — score=${evaluation.score.toFixed(3)} · threshold=${evaluation.threshold} · ` +
    `len=${m.lengthChars} · entity=${(m.entityCoverage * 100).toFixed(0)}% (top-${m.entitiesChecked}) · ` +
    `grounded=${(m.tokenGroundedness * 100).toFixed(0)}% (${m.summaryTokens} toks)${issuesStr}\n\n---\n\n`;
  appendFileSync(path, header + block, 'utf8');
  return path;
}

/**
 * Convenience wrapper: evaluate + write to diary.  Diary write failures are
 * swallowed so the caller's hot path never breaks because of audit IO.
 *
 * @returns {{
 *   score: number, pass: boolean, threshold: number,
 *   metrics: object, issues: string[],
 *   diaryPath: string|null,
 *   diaryError: string|null,
 * }}
 */
export function auditSummary({
  summary,
  source,
  label = 'summary',
  threshold,
  write = true,
  homeOverride = null,
} = {}) {
  const evaluation = evaluateSummaryQuality(summary, source, threshold == null ? {} : { threshold });
  let diaryPath = null;
  let diaryError = null;
  if (write) {
    try {
      diaryPath = appendSummaryAuditLine({ label, evaluation, homeOverride });
    } catch (err) {
      diaryError = err?.message || String(err);
    }
  }
  return { ...evaluation, diaryPath, diaryError };
}
