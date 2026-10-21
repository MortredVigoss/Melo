import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureEmulator} from './android-target.js';

test('runtime fixtures select one ready Emulator and refuse phones, extra devices and stale selection', () => {
  const header = 'List of devices attached\n';
  assert.equal(fixtureEmulator(header + 'emulator-5554\tdevice\n'), 'emulator-5554');
  assert.equal(fixtureEmulator(header + 'emulator-5554\tdevice\r\n', 'emulator-5554'), 'emulator-5554');
  for (const devices of ['', 'RFCX714K7TR\tdevice', 'emulator-5554\toffline', 'emulator-5554\tdevice\nRF-fixture\tunauthorized', 'emulator-5554\tdevice\nemulator-5556\tdevice']) assert.throws(() => fixtureEmulator(header + devices));
  assert.throws(() => fixtureEmulator(header + 'emulator-5554\tdevice', 'RFCX714K7TR'));
});
