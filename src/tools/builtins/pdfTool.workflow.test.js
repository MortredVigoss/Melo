// Tests pinning the PDF visual-review workflow that's embedded inside
// pdfTool.description. The point of these tests is regression
// protection: a future contributor who shortens the description (or
// moves the workflow elsewhere) without keeping the contract intact
// will trip these tests, not silently degrade the model's
// PDF-generation behaviour.
//
// The visual-review workflow is what closes Batch B's loop:
//   model writes PDF → calls render → reads page PNGs as vision
//   reference → self-checks layout/CJK/content → fixes & re-renders
//   if needed → returns FINAL PDF URL (not the page PNGs).
//
// We test:
//   1) the description carries the workflow keywords
//   2) buildToolsSystemPrompt actually includes it when pdfTool is
//      registered (the auto-injection path the chat 流 uses)
//   3) when pdfTool is filtered out of the agent's tool set, the
//      workflow is NOT in the rendered prompt (i.e. agents that
//      don't have PDF capability don't get cluttered with it)

import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfTool } from './pdfTool.js';
import { buildToolsSystemPrompt } from '../systemPrompt.js';

// ─── description content ────────────────────────────────────────────────────

test('pdfTool.description includes the explicit "VISUAL REVIEW WORKFLOW" header', () => {
  // Pin exact header so a refactor that renames the section gets
  // caught at this layer rather than the model silently losing the
  // self-check pattern.
  assert.match(pdfTool.description, /VISUAL REVIEW WORKFLOW/);
});

test('pdfTool.description points at the render action as the QA primitive', () => {
  // The workflow is meaningless if the model can't connect it to the
  // render action. Pin a couple of references so a refactor that
  // renames render or drops the back-reference is caught.
  assert.match(pdfTool.description, /call `render`/);
  assert.match(pdfTool.description, /pageRange:\s*"1-3"/);
});

test('pdfTool.description tells the model to self-check CJK tofu', () => {
  // CJK rendering correctness is the single most common silent
  // failure for melo's PDF pipeline (Chinese/Japanese characters
  // become "tofu" boxes when fonts aren't embedded). Pin this
  // explicitly so it can't get removed.
  assert.match(pdfTool.description, /tofu|CJK rendering/);
});

test('pdfTool.description tells the model to self-check layout + content fidelity', () => {
  // The three review axes the user asked for (2026-05-01 audit:
  // "中文乱码、表格溢出、标题错位、漏内容"). Each axis is pinned
  // so dropping one in a future edit fails the test.
  // Layout: titles centred / table cells aligned / overflow.
  assert.match(pdfTool.description, /layout|titles?|table|overflow/i);
  // Content fidelity: section presence / page order / numbers.
  assert.match(pdfTool.description, /content fidelity|every section|page order/i);
});

test('pdfTool.description forbids echoing the rendered page PNGs back to the user', () => {
  // Without this rule the model often reflexively replies with all
  // the render URLs. The user wants the final PDF, not its
  // screenshots. Pin the prohibition.
  assert.match(pdfTool.description, /Do NOT echo|do not echo/);
  assert.match(pdfTool.description, /FINAL PDF/);
});

test('pdfTool.description names the common fixes the model should reach for', () => {
  // The user's audit specifically mentioned HTML→PDF as the fallback
  // for CJK / complex layout. Make sure that's hard-pinned in the
  // description so it's the model's first instinct on visual issues.
  assert.match(pdfTool.description, /switch from `structured`.*to `write`|`write`.*HTML/);
  assert.match(pdfTool.description, /Playwright/);
});

test('pdfTool.description names exit conditions for the workflow', () => {
  // The loop has explicit exits (user says skip / trivial PDF /
  // poppler not installed). Without these the model would always
  // try to render even when it shouldn't.
  assert.match(pdfTool.description, /Skip the loop only when/);
  assert.match(pdfTool.description, /poppler-not-installed|brew install poppler|poppler/i);
});

// ─── buildToolsSystemPrompt integration ─────────────────────────────────────

test('buildToolsSystemPrompt: workflow appears verbatim when pdfTool is in the tool list', () => {
  const prompt = buildToolsSystemPrompt([pdfTool]);
  assert.match(prompt, /VISUAL REVIEW WORKFLOW/);
  // And the action itself is listed in the same prompt (we expect
  // both signal blocks to live next to each other).
  assert.match(prompt, /pdf/);
});

test('buildToolsSystemPrompt: workflow does NOT appear when pdfTool is filtered out', () => {
  // An agent profile that disables `pdf` shouldn't have its prompt
  // cluttered with PDF-specific guidance. Negative test pins this.
  const fakeTool = {
    id: 'fake',
    name: 'Fake',
    description: 'Just a placeholder tool for the test.',
    category: 'general',
    parametersSchema: { type: 'object', properties: {} },
    async run() { return { ok: true, output: 'noop' }; },
  };
  const prompt = buildToolsSystemPrompt([fakeTool]);
  assert.doesNotMatch(prompt, /VISUAL REVIEW WORKFLOW/);
  assert.doesNotMatch(prompt, /tofu/);
});

// (No "default-registry" sanity test — buildToolsSystemPrompt() with
// no args calls getAllTools(), which is empty in a unit test that
// doesn't bootstrap the full app. That assertion belongs to the
// registry bootstrap test, not here. The two prior tests with an
// explicit tool list pin the actual contract.)
