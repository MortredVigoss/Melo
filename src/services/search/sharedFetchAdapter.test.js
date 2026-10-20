import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedFetchTool } from './sharedFetchAdapter.js';
import { toolCatalog } from '../../../shared/agent/tools.js';

test('shared fetch cannot implicitly escalate to browser or inject host-specific options', async () => {
  const effects = [];
  const tool = createSharedFetchTool({ id: 'fetch_url', async run(args) { effects.push(args); return { ok: true, output: 'Fixture page' }; } });
  assert.deepEqual(tool.parametersSchema, toolCatalog(['fetch_url'])[0].parameters);
  const receipt = await tool.run({ url: 'https://fixture.invalid/page' }, {});
  assert.equal(receipt.ok, true); assert.deepEqual(effects, [{ url: 'https://fixture.invalid/page', extract_mode: 'direct' }]);
  assert.equal(JSON.parse(receipt.output).freshness, 'unknown'); assert.equal(JSON.parse(receipt.output).text, 'Fixture page');
  await assert.rejects(tool.run({ url: 'https://fixture.invalid/page', extract_mode: 'playwright' }), { code: 'INVALID_TOOL_ARGUMENTS' });
  assert.equal(effects.length, 1);
});
