import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationMode, releaseOnly } from './release-policy.js';

test('ordinary full verification never calls installation or native release launch', async () => {
  let installs = 0;
  assert.equal(verificationMode([]), 'verify');
  assert.equal(await releaseOnly(verificationMode([]), [{ status: 'GREEN' }], async () => { installs++; }), false);
  assert.equal(installs, 0);
});
test('explicit release still refuses failed or incomplete prerequisites', async () => {
  let installs = 0;
  for (const status of ['RED', 'YELLOW']) await assert.rejects(releaseOnly('release', [{ status }], async () => { installs++; }), /GREEN/);
  assert.equal(installs, 0);
  await releaseOnly(verificationMode(['--release']), [{ status: 'GREEN' }], async () => { installs++; });
  assert.equal(installs, 1);
  assert.throws(() => verificationMode(['--install']), /Usage/);
});
