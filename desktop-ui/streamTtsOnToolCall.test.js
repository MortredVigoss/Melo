/**
 * desktop-ui/streamTtsOnToolCall.test.js
 *
 * Regression guard for the 2026-05-12 mid-utterance TTS truncation bug.
 *
 * The bug: `_streamTtsOnToolCall()` in app.js used to fire `speak-stop`,
 * `queue-clear`, `speechSynthesis.cancel()`, and WKWebView `stopAudio`
 * on every `<tool_call>` stream event.  Intent was "drop intermediate
 * 我正在搜索... narration".  But it also killed COMPLETED sentences
 * mid-afplay, producing reports like "好的，让我帮你查询天" cut off when
 * the next event happened to be a tool_call.  Any agent reply that
 * called a tool was affected, on every engine (MiniMax / API / Edge /
 * macOS / Browser).
 *
 * The fix: only clear the unflushed `_streamTts.buffer` and
 * `_streamTts.browserBatch` — those are genuinely intermediate (no
 * sentence break detected yet, or batched-but-unspoken).  Anything in
 * `_ttsQueue` or already mid-afplay was a complete sentence — let it
 * finish.
 *
 * Why source-level (not real-behavior): the function is a tiny piece
 * of mutating-state logic inside a 14k-line app.js that has no
 * extraction harness.  Importing app.js for unit testing isn't
 * feasible.  The regression we're guarding against is structural —
 * "never re-introduce these specific kill calls" — so source-level
 * pattern checks are the right tool here, plus a small block of
 * positive assertions about what the function MUST contain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appJsSource = readFileSync(join(here, 'app.js'), 'utf8');

// Pull out just the body of _streamTtsOnToolCall so a regex match on a
// suspicious string in some other unrelated function doesn't false-trip
// (or false-clear) this test.
function getStreamTtsOnToolCallBody(source) {
  const startMatch = source.match(/function\s+_streamTtsOnToolCall\s*\(\)\s*\{/);
  if (!startMatch) return null;
  // Walk braces from the opening { to find the matching close.
  const openIdx = source.indexOf('{', startMatch.index);
  let depth = 0;
  for (let i = openIdx; i < source.length; i += 1) {
    const c = source[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  return null;
}

// Strip comments before pattern-matching so the explanatory comment
// referencing the removed call sites (which is desirable documentation)
// doesn't false-trigger the regression guards.
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/\/\/[^\n]*/g, '');         // line comments
}

const body = getStreamTtsOnToolCallBody(appJsSource);
const codeOnly = body ? stripComments(body) : null;

test('_streamTtsOnToolCall exists and is parseable', () => {
  assert.ok(body, 'must find `function _streamTtsOnToolCall() { ... }` in app.js');
});

// ─── Negative assertions: the killers MUST NOT come back ─────────────────────

test('_streamTtsOnToolCall does NOT call /api/tts/speak-stop (would kill complete sentences in afplay)', () => {
  assert.equal(/speak-stop/.test(codeOnly), false,
    'speak-stop call would re-introduce the mid-afplay truncation bug');
});

test('_streamTtsOnToolCall does NOT call /api/tts/queue-clear (would drop completed-sentence queue)', () => {
  assert.equal(/queue-clear/.test(codeOnly), false,
    'queue-clear would discard sentences that the assistant already finished — those should play');
});

test('_streamTtsOnToolCall does NOT call speechSynthesis.cancel (would cut real-browser TTS mid-sentence)', () => {
  assert.equal(/speechSynthesis\.cancel/.test(codeOnly), false,
    'speechSynthesis.cancel would re-introduce the bug for real-browser voice');
});

test('_streamTtsOnToolCall does NOT post WKWebView stopAudio (the WKWebView batches at flush — already silent)', () => {
  assert.equal(/stopAudio/.test(codeOnly), false,
    'WKWebView stopAudio is unnecessary — that engine batches to flush, never mid-stream playback');
});

// ─── Positive assertions: the intermediate-text discard MUST stay ─────────────

test('_streamTtsOnToolCall clears _streamTts.buffer (unflushed partial sentence)', () => {
  assert.match(codeOnly, /_streamTts\.buffer\s*=\s*['"]['"]/,
    'must clear .buffer — the unflushed "我正在搜索..." partial intent narration');
});

test('_streamTtsOnToolCall clears _streamTts.browserBatch (WKWebView accumulator)', () => {
  assert.match(codeOnly, /_streamTts\.browserBatch\s*=\s*['"]['"]/,
    'must clear .browserBatch — WKWebView never-spoken-yet batched sentences');
});

test('_streamTtsOnToolCall flags _streamTts.hasToolCalls = true', () => {
  assert.match(codeOnly, /_streamTts\.hasToolCalls\s*=\s*true/,
    'must mark the session as having had tool calls (other code branches off this)');
});
