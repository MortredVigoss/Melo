import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceLocationTool, formatLocation, LOCATION_TIMEOUT_MS } from './deviceLocationTool.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { updateLocalProfile } from '../../services/settings/localProfile.js';
import { bootstrapBuiltinTools, getTool } from '../registry.js';
import { toolCapabilityAllowed, normalizeCapabilities } from '../../domain/agent/capabilities.js';
import { toolGroupOf } from '../toolGroups.js';

const reply = body => async (url, options) => { reply.calls.push({ url, options }); return { json: async () => body }; };
reply.calls = [];

// A home whose 这台电脑上 switch is on for `main` (agentDevicePermissions.test.js covers the switch itself).
async function homeWithLocation(t) {
  const home = await mkdtemp(join(tmpdir(), 'melo-location-tool-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await runWithRequestContext(createRequestContext({ home, env: { MELO_TEST_MODE: '1' } }), () => updateLocalProfile({ preferences: { agentDevice: { main: { location: true } } } }));
  return home;
}

test('desktop location comes from the app shell on port + 1, rounded to about 1 km', async t => {
  reply.calls = [];
  const result = await deviceLocationTool.run({}, { meloHome: await homeWithLocation(t), agentId: 'main', requestContext: { env: { MELO_DESKTOP_PORT: '43127' } },
    fetchImpl: reply({ ok: true, latitude: -37.81361, longitude: 144.96332, accuracy: 35, city: 'Melbourne', region: 'Victoria', country: 'Australia', timeZone: 'Australia/Melbourne' }) });
  assert.equal(reply.calls[0].url, 'http://127.0.0.1:43128/location');
  assert.equal(reply.calls[0].options.headers['x-melo-native'], 'location', 'the shell only answers with its private header');
  assert.equal(result.ok, true);
  assert.match(result.output, /Melbourne, Victoria, Australia/);
  assert.match(result.output, /-37\.81, 144\.96/);
  assert.doesNotMatch(result.output, /-37\.8136|144\.9633/, 'precise coordinates never reach the model');
  assert.deepEqual([result.meta.latitude, result.meta.longitude], [-37.81, 144.96]);
});

test('a denied permission or a missing desktop app is explained, not a crash', async t => {
  const meloHome = await homeWithLocation(t);
  const denied = await deviceLocationTool.run({}, { meloHome, agentId: 'main', fetchImpl: reply({ ok: false, error: 'denied' }) });
  assert.equal(denied.ok, false); assert.equal(denied.error, 'LOCATION_DENIED'); assert.match(denied.output, /System Settings/);
  const offline = await deviceLocationTool.run({}, { meloHome, agentId: 'main', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(offline.error, 'DESKTOP_SHELL_UNAVAILABLE'); assert.match(offline.output, /ask the user for the city/i);
  assert.match(formatLocation({ latitude: 1, longitude: 2 }), /no place name/);
});

test('every Agent with the base abilities can use it, and it is always offered (core group)', () => {
  bootstrapBuiltinTools();
  assert.equal(getTool('device_location')?.id, 'device_location', 'registered');
  assert.equal(toolCapabilityAllowed('device_location', normalizeCapabilities({ network: true }), {}, deviceLocationTool), true);
  assert.equal(toolCapabilityAllowed('device_location', normalizeCapabilities({ readFiles: true }), {}, deviceLocationTool), false, 'an Agent without network cannot');
  assert.equal(toolGroupOf('device_location'), 'core');
});

test('a fix slower than the tool waits is reported as a timeout, not as a missing desktop app', async t => {
  const meloHome = await homeWithLocation(t);
  // Like fetch(): rejects at once on an already-aborted signal, otherwise when it aborts.
  const hang = async (_url, { signal }) => { if (signal.aborted) throw signal.reason; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  // AbortSignal.timeout does not keep the process alive; the server always is.
  const alive = setInterval(() => {}, 1000);
  const slow = await deviceLocationTool.run({}, { meloHome, agentId: 'main', fetchImpl: hang, locationTimeoutMs: 20 });
  clearInterval(alive);
  assert.equal(slow.error, 'LOCATION_TIMEOUT');
  assert.ok(LOCATION_TIMEOUT_MS > 20_000, 'the shell gives up first (15 s fix + 5 s place name)');
  const controller = new AbortController();
  const pending = deviceLocationTool.run({}, { meloHome, agentId: 'main', fetchImpl: hang, signal: controller.signal });
  controller.abort(new Error('user stopped'));
  await assert.rejects(pending, /user stopped/, 'a stopped turn is not turned into a location error');
});

test('location is personal data: off per Agent until the user turns it on for this computer (no dialog per use)', async t => {
  assert.equal(deviceLocationTool.requiresPermission, false, 'the 这台电脑上 switch is the consent, as on the phone');
  const home = await mkdtemp(join(tmpdir(), 'melo-location-off-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let reads = 0;
  const result = await deviceLocationTool.run({}, { meloHome: home, agentId: 'main', fetchImpl: async () => { reads += 1; return { json: async () => ({ ok: true, latitude: 1, longitude: 2 }) }; } });
  assert.equal(result.error, 'LOCATION_NOT_ENABLED');
  assert.equal(reads, 0, 'the shell was never asked');
});
