/**
 * clipboardTool.test.js
 *
 * The write path piped text into the platform command through `require(...)`
 * inside an ES module, so every write failed with "require is not defined".
 * These tests run the real pipe against stand-in commands: the clipboard of
 * the person running the tests is never read or replaced.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clipboardTool, _setClipboardCommandsForTests } from './clipboardTool.js';

const SAVE_STDIN = "const fs=require('node:fs');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>fs.writeFileSync(process.argv[1],Buffer.concat(chunks)));";

test('clipboard write pipes the exact text into the command and reports the length', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'melo-clipboard-'));
  const sink = join(dir, 'received.txt');
  t.after(async () => { _setClipboardCommandsForTests(null); await rm(dir, { recursive: true, force: true }); });
  _setClipboardCommandsForTests({
    read: [process.execPath, ['-e', "process.stdout.write('from the stand-in')"]],
    write: [process.execPath, ['-e', SAVE_STDIN, sink]],
  });

  const text = '第一行 $& "quoted"\nsecond line\n' + 'x'.repeat(70_000);   // longer than one pipe buffer
  const result = await clipboardTool.run({ action: 'write', content: text });
  assert.equal(result.ok, true, result.output);
  assert.equal(result.meta.length, text.length);
  assert.equal(await readFile(sink, 'utf8'), text);

  const read = await clipboardTool.run({ action: 'read' });
  assert.equal(read.ok, true);
  assert.equal(read.output, 'from the stand-in');
});

test('clipboard write reports a failing or missing command as WRITE_FAILED without throwing', async t => {
  t.after(() => _setClipboardCommandsForTests(null));

  // Exits before reading its input: the pipe error must not escape as an uncaught exception.
  _setClipboardCommandsForTests({ read: ['true', []], write: [process.execPath, ['-e', 'process.exit(3)']] });
  const failed = await clipboardTool.run({ action: 'write', content: 'y'.repeat(90_000) });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'WRITE_FAILED');
  assert.match(failed.output, /Cannot write clipboard/);

  _setClipboardCommandsForTests({ read: ['true', []], write: [join(tmpdir(), 'melo-no-such-clipboard-command'), []] });
  const missing = await clipboardTool.run({ action: 'write', content: 'text' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'WRITE_FAILED');
});

test('clipboard write still refuses empty and oversized content before running anything', async t => {
  t.after(() => _setClipboardCommandsForTests(null));
  let ran = false;
  _setClipboardCommandsForTests({ get write() { ran = true; return ['true', []]; }, read: ['true', []] });
  assert.equal((await clipboardTool.run({ action: 'write' })).error, 'INVALID_PARAMS');
  assert.equal((await clipboardTool.run({ action: 'write', content: 'z'.repeat(100_001) })).error, 'TOO_LARGE');
  assert.equal(ran, false);
});
