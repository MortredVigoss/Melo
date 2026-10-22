import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceLocationTool, formatLocation, LOCATION_TIMEOUT_MS } from './deviceLocationTool.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool } from '../executor.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { capabilityScopeForProfile, withElevationSurface } from '../../domain/agent/capabilityScope.js';
import { bootstrapBuiltinTools, getTool } from '../registry.js';
import { toolCapabilityAllowed, normalizeCapabilities } from '../../domain/agent/capabilities.js';
import { toolGroupOf } from '../toolGroups.js';

const reply = body => async (url, options) => { reply.calls.push({ url, options }); return { json: async () => body }; };
reply.calls = [];

test('desktop location comes from the app shell on port + 1, rounded to about 1 km', async () => {
  reply.calls = [];
  const result = await deviceLocationTool.run({}, { requestContext: { env: { MELO_DESKTOP_PORT: '43127' } },
    fetchImpl: reply({ ok: true, latitude: -37.81361, longitude: 144.96332, accuracy: 35, city: 'Melbourne', region: 'Victoria', country: 'Australia', timeZone: 'Australia/Melbourne' }) });
  assert.equal(reply.calls[0].url, 'http://127.0.0.1:43128/location');
  assert.equal(reply.calls[0].options.headers['x-melo-native'], 'location', 'the shell only answers with its private header');
  assert.equal(result.ok, true);
  assert.match(result.output, /Melbourne, Victoria, Australia/);
  assert.match(result.output, /-37\.81, 144\.96/);
  assert.doesNotMatch(result.output, /-37\.8136|144\.9633/, 'precise coordinates never reach the model');
  assert.deepEqual([result.meta.latitude, result.meta.longitude], [-37.81, 144.96]);
});

test('a denied permission or a missing desktop app is explained, not a crash', async () => {
  const denied = await deviceLocationTool.run({}, { fetchImpl: reply({ ok: false, error: 'denied' }) });
  assert.equal(denied.ok, false); assert.equal(denied.error, 'LOCATION_DENIED'); assert.match(denied.output, /System Settings/);
  const offline = await deviceLocationTool.run({}, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
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

test('a fix slower than the tool waits is reported as a timeout, not as a missing desktop app', async () => {
  const hang = async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  // AbortSignal.timeout does not keep the process alive; the server always is.
  const alive = setTimeout(() => {}, 1000);
  const slow = await deviceLocationTool.run({}, { fetchImpl: hang, locationTimeoutMs: 20 });
  clearTimeout(alive);
  assert.equal(slow.error, 'LOCATION_TIMEOUT');
  assert.ok(LOCATION_TIMEOUT_MS > 20_000, 'the shell gives up first (15 s fix + 5 s place name)');
  const controller = new AbortController();
  const pending = deviceLocationTool.run({}, { fetchImpl: hang, signal: controller.signal });
  controller.abort(new Error('user stopped'));
  await assert.rejects(pending, /user stopped/, 'a stopped turn is not turned into a location error');
});

test('location is personal data: each use needs approval, and a channel without a live desktop stream never reads it', async t => {
  assert.equal(deviceLocationTool.requiresPermission, true);
  const home = await mkdtemp(join(tmpdir(), 'melo-location-approval-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // A Telegram turn: its emitter is wrapped (always a function) and sendChatMessage marks it without a surface.
  const capabilityScope = withElevationSurface(capabilityScopeForProfile({ id: 'main', capabilities: normalizeCapabilities({ network: true }) }), false);
  const requestContext = Object.freeze({ ...createRequestContext({ home, chatId: 'telegram-chat', runId: 'run-remote' }), capabilityScope, permissionSurface: 'none' });
  let reads = 0;
  const counted = { ...deviceLocationTool, run: async () => { reads += 1; return { ok: true, output: 'Location: x' }; } };
  const started = Date.now();
  const result = await runWithRequestContext(requestContext, () => executeTool(counted, {}, { chatId: 'telegram-chat', requestContext, sseEmitter: () => {}, workspacePath: home }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'PERMISSION_NO_SURFACE');
  assert.ok(Date.now() - started < 1000, 'answered at once, not after the 120 s approval timeout');
  assert.equal(reads, 0, 'the shell was never asked');
});
