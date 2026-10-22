'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeRuntimeInfo, readRuntimeInfo, removeRuntimeInfo } = require('../runtime-info.cjs');

test('the runtime record is private to the user and replaced atomically', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melo-pet-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'runtime.json');
  const previousMask = process.umask(0o000);
  try { writeRuntimeInfo(file, { pid: 4242, controlUrl: 'http://127.0.0.1:50001', token: 'a'.repeat(64) }); }
  finally { process.umask(previousMask); }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readRuntimeInfo(file), { pid: 4242, controlUrl: 'http://127.0.0.1:50001', token: 'a'.repeat(64) });
  writeRuntimeInfo(file, { pid: 4243, controlUrl: 'http://127.0.0.1:50002', token: 'b'.repeat(64) });
  assert.equal(readRuntimeInfo(file).pid, 4243);
  assert.deepEqual(fs.readdirSync(dir), ['runtime.json'], 'no temporary file is left behind');
});

test('only the owning process removes its record; unreadable records read as absent', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melo-pet-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'runtime.json');
  writeRuntimeInfo(file, { pid: 7, controlUrl: 'http://127.0.0.1:1', token: 'c'.repeat(64) });
  assert.equal(removeRuntimeInfo(file, 8), false);
  assert.ok(fs.existsSync(file), 'a newer instance keeps its own record');
  assert.equal(removeRuntimeInfo(file, 7), true);
  assert.ok(!fs.existsSync(file));
  assert.equal(removeRuntimeInfo(file, 7), false);
  fs.writeFileSync(file, '[1,2]');
  assert.equal(readRuntimeInfo(file), null);
  fs.writeFileSync(file, 'not json');
  assert.equal(readRuntimeInfo(file), null);
  assert.equal(readRuntimeInfo(path.join(dir, 'missing.json')), null);
});
