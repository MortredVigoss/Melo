// Bootstrap-level contract for the mcpPresets array. Codex 三轮 audit
// 2026-04-29: getBuiltinMcpPresets() now marks unpinned presets with
// `unpinned: true` (browserless today, while its npm package is 404).
// The Advanced UI relies on that field to disable the toggle and show
// "unavailable · 未锁定版本" — so it MUST round-trip through the
// bootstrap projection or the UI silently slips back to "假启用".

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'melo-mcp-presets-test-'));
process.env.MELO_HOME = TEMP_HOME;

const { getDesktopBootstrap } = await import('../services/desktop/bootstrap.js');

test('bootstrap.mcpPresets includes browserless with unpinned: true', async () => {
  const bootstrap = await getDesktopBootstrap();
  const presets = bootstrap?.customize?.mcpPresets;
  assert.ok(Array.isArray(presets) && presets.length, 'mcpPresets must be a non-empty array');
  const browserless = presets.find(p => p.id === 'browserless');
  assert.ok(browserless, 'browserless preset must appear in mcpPresets');
  assert.equal(
    browserless.unpinned,
    true,
    'browserless must surface unpinned:true so Advanced UI disables its toggle and shows "unavailable · 未锁定版本"',
  );
});

test('bootstrap.mcpPresets pinned presets carry unpinned: false explicitly (boolean coercion)', async () => {
  const bootstrap = await getDesktopBootstrap();
  const presets = bootstrap?.customize?.mcpPresets;
  // playwright + antv-chart + markdown2pdf + mermaid all have
  // pinned versions, so unpinned must be exactly false (NOT
  // undefined). The defensive Boolean(preset.unpinned) cast in
  // desktopBootstrap.js relies on this — without it the UI's
  // !preset.unpinned check would behave differently for `false`
  // vs `undefined` if some downstream serializer dropped falsy
  // fields.
  for (const id of ['playwright', 'antv-chart', 'markdown2pdf', 'mermaid']) {
    const preset = presets.find(p => p.id === id);
    assert.ok(preset, `${id} preset must appear`);
    assert.equal(preset.unpinned, false, `${id} must have unpinned: false (boolean), got ${preset.unpinned}`);
  }
});

test('bootstrap.mcpPresets ALL pinned presets have args ending in @<exact-version>', async () => {
  // Catches a future addition to BUILTIN_MCP_PRESETS that forgets
  // to register a PINNED_VERSIONS entry — the unpinned-flag would
  // catch it server-side, but this test catches it at bootstrap
  // boundary where most callers actually consume the data.
  const bootstrap = await getDesktopBootstrap();
  const presets = bootstrap?.customize?.mcpPresets;
  for (const preset of presets) {
    if (preset.unpinned) continue;
    const lastArg = preset.args[preset.args.length - 1];
    assert.match(
      lastArg,
      /@\d+\.\d+\.\d+$/,
      `${preset.id} (pinned) last arg must be <package>@<semver>, got: ${lastArg}`,
    );
  }
});

// Cleanup
process.on('exit', () => {
  try { rmSync(TEMP_HOME, { recursive: true, force: true }); } catch {}
});
