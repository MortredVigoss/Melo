/**
 * Parameter-validation regressions for the PDF tool's new
 * workspace auto-output routing.
 *
 * We don't exercise the actual Playwright → PDF pipeline (it needs a local
 * browser). The tests pin the new optional-path behaviour for `write` and
 * ensure the schema was relaxed correctly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfTool } from './pdfTool.js';

test('write: missing content → INVALID_PARAMS', async () => {
  const result = await pdfTool.run(
    { action: 'write' },
    { workspacePath: '/tmp/melo-test-ws' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_PARAMS');
  assert.match(result.output, /content/i);
});

test('write: no path AND no workspace → NO_OUTPUT_PATH', async () => {
  const result = await pdfTool.run(
    { action: 'write', content: 'hi' },
    { workspacePath: undefined },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NO_OUTPUT_PATH');
});

test('write: explicit path not ending in .pdf → INVALID_PARAMS', async () => {
  const result = await pdfTool.run(
    { action: 'write', path: '/tmp/out.txt', content: 'hi' },
    { workspacePath: '/tmp/melo-test-ws' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_PARAMS');
  assert.match(result.output, /\.pdf/);
});

test('read: missing path → INVALID_PARAMS', async () => {
  const result = await pdfTool.run({ action: 'read' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_PARAMS');
});

test('unknown action → INVALID_ACTION', async () => {
  const result = await pdfTool.run({ action: 'bogus', path: '/tmp/x' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_ACTION');
});

test('no action → INVALID_PARAMS', async () => {
  const result = await pdfTool.run({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_PARAMS');
});

test('schema: only action required (path no longer required)', () => {
  assert.deepEqual(pdfTool.parametersSchema.required, ['action']);
});

test('schema: path description mentions optional auto-save', () => {
  const pathDesc = pdfTool.parametersSchema.properties.path.description;
  assert.match(pathDesc, /omitted/i);
  assert.match(pathDesc, /workspace/i);
});
