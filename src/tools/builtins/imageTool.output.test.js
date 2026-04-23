/**
 * Parameter-validation regressions for the image tool's new
 * `generate` action and workspace auto-output routing.
 *
 * Network / disk paths are deliberately out of scope here — the tests
 * exercise only the code paths that reject invalid input before any
 * MiniMax / sharp call fires.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { imageTool } from './imageTool.js';

test('generate: missing prompt → INVALID_PARAMS', async () => {
  const result = await imageTool.run({ action: 'generate' }, { workspacePath: '/tmp/melo-test-ws' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_PARAMS');
  assert.match(result.output, /prompt/i);
});

test('generate: missing MiniMax credentials → NOT_CONFIGURED', async () => {
  // Temporarily clear both the env and the passed config
  const prevKey = process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_API_KEY;
  try {
    const result = await imageTool.run(
      { action: 'generate', prompt: 'a cat' },
      { workspacePath: '/tmp/melo-test-ws', config: {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'NOT_CONFIGURED');
    assert.match(result.output, /MiniMax/);
    assert.match(result.output, /minimaxApiKey/);
  } finally {
    if (prevKey !== undefined) process.env.MINIMAX_API_KEY = prevKey;
  }
});

test('generate: no workspace and no output → NO_OUTPUT_PATH', async () => {
  const result = await imageTool.run(
    { action: 'generate', prompt: 'a cat' },
    { workspacePath: undefined, config: { minimaxApiKey: 'fake-key' } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NO_OUTPUT_PATH');
});

test('process: missing path → INVALID_PARAMS (not NO_OUTPUT_PATH)', async () => {
  const result = await imageTool.run(
    { action: 'process', width: 100 },
    { workspacePath: '/tmp/melo-test-ws' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_PARAMS');
  assert.match(result.output, /path/i);
});

test('unknown action → INVALID_ACTION when path is present', async () => {
  // We need a path to pass the ocr/info/process gate before the fall-through
  // hits the INVALID_ACTION branch. Supply a non-existent path — the file
  // existence check will fail first, which is a different (valid) error.
  // Use a 0-byte temp file to clear the existence check.
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'melo-img-'));
  const tmpFile = join(dir, 'x.png');
  await writeFile(tmpFile, Buffer.from([0])); // 1-byte file, passes existence + size check
  const result = await imageTool.run({ action: 'bogus', path: tmpFile }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_ACTION');
});

test('no action → INVALID_PARAMS', async () => {
  const result = await imageTool.run({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_PARAMS');
});

test('schema lists the generate action', () => {
  const actionEnum = imageTool.parametersSchema.properties.action.enum;
  assert.ok(Array.isArray(actionEnum));
  assert.ok(actionEnum.includes('generate'));
  assert.ok(actionEnum.includes('process'));
  assert.ok(actionEnum.includes('ocr'));
  assert.ok(actionEnum.includes('info'));
});

test('schema: action is the only required field (path no longer required)', () => {
  // Generate doesn't need `path`, so we loosened the required list.
  assert.deepEqual(imageTool.parametersSchema.required, ['action']);
});

test('schema exposes prompt + aspectRatio for the generate action', () => {
  const props = imageTool.parametersSchema.properties;
  assert.ok(props.prompt);
  assert.ok(props.aspectRatio);
  assert.ok(Array.isArray(props.aspectRatio.enum));
  assert.ok(props.aspectRatio.enum.includes('1:1'));
  assert.ok(props.aspectRatio.enum.includes('16:9'));
});
