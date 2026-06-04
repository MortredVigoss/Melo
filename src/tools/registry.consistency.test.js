/**
 * 2026-05-23 architecture audit闭环 (Tier 1 consistency): pin three
 * cross-tool consistency invariants the audit found drifting:
 *
 *   1. `category` enum — no `'files'` ghost category alongside
 *      `'filesystem'`; both produced separate system-prompt sections
 *      for the same concept.
 *   2. `tool.name` — Title Case (e.g. "File Read"), no CamelCase
 *      outliers ("FileRead") or sentence-case ("Browser open").
 *   3. `examples` — every registered tool surfaces at least one
 *      example.  `systemPrompt.js` reads `tool.examples[0]` to give
 *      the LLM few-shot — tools without examples silently get less
 *      grounding than peers.
 *
 * These are static invariants over the registered tool list; the
 * test imports the registry, bootstraps built-ins, and asserts.  If
 * future tools drift any of the three, this test fails before the
 * tool ships to the LLM prompt.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapBuiltinTools, getAllTools, clearRegistry } from './registry.js';

test.before(() => {
  // bootstrapBuiltinTools is idempotent — safe whether registry was
  // already populated by another test runner.
  bootstrapBuiltinTools();
});

test('all registered tools use the unified `filesystem` category (no `files` ghost)', () => {
  const ghost = getAllTools().filter(t => t.category === 'files');
  assert.equal(ghost.length, 0,
    `tools using deprecated category='files' (should be 'filesystem'): ${ghost.map(t => t.id).join(', ')}`);
});

test('all registered tools use Title Case `name` (no CamelCase / sentence-case)', () => {
  // Title Case: every space-separated token starts with uppercase.
  // Single-word names are vacuously Title Case ("Bash", "Image", etc.).
  // CamelCase like "FileRead" has no space between tokens → fails.
  // Sentence-case like "Browser open" has a lowercase second token → fails.
  const offenders = [];
  for (const tool of getAllTools()) {
    const name = tool.name || '';
    // Allow special-case parenthetical suffix: "Media Info (yt-dlp)".
    // Strip parenthetical for token check.
    const checkable = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const tokens = checkable.split(/\s+/);
    const camelCaseSuspect = tokens.length === 1
      && /[a-z][A-Z]/.test(checkable)
      && checkable.length > 4; // 'Bash' single token is fine
    const sentenceCaseSuspect = tokens.some((t, i) => i > 0 && t[0] && /[a-z]/.test(t[0]));
    if (camelCaseSuspect || sentenceCaseSuspect) {
      offenders.push(`${tool.id}: "${name}"`);
    }
  }
  assert.equal(offenders.length, 0,
    `tool.name must be Title Case; offenders:\n  ${offenders.join('\n  ')}`);
});

test('every registered tool exposes at least one `examples` entry (systemPrompt reads examples[0])', () => {
  const missing = getAllTools()
    .filter(t => !Array.isArray(t.examples) || t.examples.length === 0)
    .map(t => t.id);
  assert.equal(missing.length, 0,
    `tools missing examples (systemPrompt.js:84 reads tool.examples[0]):\n  ${missing.join('\n  ')}`);
});

test('tool.id is snake_case (no mixedCase or kebab-case drift)', () => {
  // id is the LLM-facing handle in tool calls.  Repo convention is
  // snake_case ("file_read", "browser_open", "web_search").  Anything
  // else creates protocol mismatch at the prompt boundary.
  const offenders = [];
  for (const tool of getAllTools()) {
    const id = tool.id || '';
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      offenders.push(`"${id}"`);
    }
  }
  assert.equal(offenders.length, 0,
    `tool.id must be snake_case; offenders: ${offenders.join(', ')}`);
});
