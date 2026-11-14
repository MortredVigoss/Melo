// Bootstrap-level contract for the mcpPresets array the Advanced page renders.
//
// Until 2026-11-14 a preset could be `unpinned` (only `browserless` ever was:
// its npm package did not exist) and the page showed it as unavailable. That
// preset and the state are gone; what must hold now is simpler and stricter:
// every preset the bootstrap offers names an exact release.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'melo-mcp-presets-test-'));
process.env.MELO_HOME = TEMP_HOME;

const { getDesktopBootstrap } = await import('../services/desktop/bootstrap.js');

test('bootstrap.mcpPresets offers no preset that cannot be enabled', async () => {
  const bootstrap = await getDesktopBootstrap();
  const presets = bootstrap?.customize?.mcpPresets;
  assert.ok(Array.isArray(presets) && presets.length, 'mcpPresets must be a non-empty array');
  assert.deepEqual(presets.map(p => p.id).sort(),
    ['antv-chart', 'markdown2pdf', 'melo-douyin', 'melo-public-media', 'melo-xiaohongshu', 'mermaid', 'playwright']);
  assert.equal(presets.some(p => p.id === 'browserless'), false);
  for (const preset of presets) assert.equal('unpinned' in preset, false, `${preset.id}: the unpinned state no longer exists`);
  for (const entry of bootstrap.customize.mcpAuthSurface) assert.equal('unpinned' in entry, false, entry.id);
});

test('a saved enableBrowserlessMcp flag is ignored: nothing is offered, connected or authorised for it', async () => {
  const { buildEffectiveMcpServers, usableMcpServerIds } = await import('../mcp/presets.js');
  assert.deepEqual(buildEffectiveMcpServers({}, { enableBrowserlessMcp: true }), {});
  assert.deepEqual(usableMcpServerIds({ enableBrowserlessMcp: true }), []);
  const { buildMcpFlags } = await import('../mcp/init.js');
  assert.equal('enableBrowserlessMcp' in buildMcpFlags({ enableBrowserlessMcp: true }), false);
});

test('bootstrap.mcpPresets all presets pin an exact npm or managed binary release', async () => {
  const bootstrap = await getDesktopBootstrap();
  const presets = bootstrap?.customize?.mcpPresets;
  assert.deepEqual(presets.filter(p => p.transport === 'managed-http').map(p => p.id).sort(), ['melo-douyin', 'melo-xiaohongshu']);
  for (const preset of presets) {
    if (preset.transport==='in-process'){
      assert.equal(preset.id,'melo-public-media');assert.equal(preset.command,undefined);assert.equal(preset.version,'1.0.0');continue;
    }
    if (preset.transport === 'managed-http') {
      assert.match(preset.version, /^v\d+\.\d+\.\d+$/);
      assert.equal(preset.args, undefined);
      continue;
    }
    const lastArg = preset.args[preset.args.length - 1];
    assert.match(
      lastArg,
      /@\d+\.\d+\.\d+$/,
      `${preset.id} last arg must be <package>@<semver>, got: ${lastArg}`,
    );
  }
});

// Cleanup
process.on('exit', () => {
  try { rmSync(TEMP_HOME, { recursive: true, force: true }); } catch {}
});
