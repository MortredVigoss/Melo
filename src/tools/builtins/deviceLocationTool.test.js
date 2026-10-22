import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceLocationTool, formatLocation } from './deviceLocationTool.js';
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
