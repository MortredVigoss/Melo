// Per-Agent permissions for this computer (这台电脑上, 2026-10-22): the desktop
// twin of the phone's 这台手机上. Device-local preferences, merged per Agent,
// never synced; the location tool is off until the user turns it on here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { loadState } from '../../state/stateStore.js';
import { updateLocalProfile } from './localProfile.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import { normalizeLocalPreferences, validateLocalPreferencePatch, agentDevicePermission } from '../../domain/settings/localPreferences.js';
import { deviceLocationTool } from '../../tools/builtins/deviceLocationTool.js';

test('only true grants for known keys and plausible Agent ids are kept; patches are validated', () => {
  const normalized = normalizeLocalPreferences({ agentDevice: { main: { location: true, bogus: true }, 'bad id!': { location: true }, research: { location: false }, builder: 'yes' } });
  assert.deepEqual(normalized.agentDevice, { main: { location: true } });
  assert.deepEqual(normalizeLocalPreferences({}).agentDevice, {});
  assert.equal(agentDevicePermission(normalized, 'main', 'location'), true);
  assert.equal(agentDevicePermission(normalized, 'research', 'location'), false);
  assert.equal(agentDevicePermission(undefined, 'main', 'location'), false);
  assert.deepEqual(validateLocalPreferencePatch({ agentDevice: { main: { location: false } } }), { agentDevice: { main: { location: false } } });
  for (const bad of [{ agentDevice: [] }, { agentDevice: { main: { calendar: true } } }, { agentDevice: { main: { location: 'yes' } } }, { agentDevice: { 'bad id!': { location: true } } }]) {
    assert.throws(() => validateLocalPreferencePatch(bad), /无效/, JSON.stringify(bad));
  }
});

test('switches are saved per Agent at once, merge without clearing other Agents, and the tool obeys them', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-agent-device-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await runWithRequestContext(createRequestContext({ home, env: { MELO_TEST_MODE: '1' } }), async () => {
    await updateLocalProfile({ preferences: { agentDevice: { main: { location: true } } } });
    await updateLocalProfile({ preferences: { agentDevice: { research: { location: true } } } });
    let prefs = (await loadState({ home })).settings.localPreferences;
    assert.deepEqual(prefs.agentDevice, { main: { location: true }, research: { location: true } }, 'one Agent at a time, the other stays');
    await updateLocalProfile({ preferences: { agentDevice: { main: { location: false } } } });
    prefs = (await loadState({ home })).settings.localPreferences;
    assert.deepEqual(prefs.agentDevice, { research: { location: true } }, 'turning off removes the grant');
    assert.deepEqual((await getDesktopBootstrap()).settings.localPreferences.agentDevice, { research: { location: true } }, 'the editor reads the same switches');

    // The tool: off → explained and the shell never asked; on → the shell is asked.
    let shellCalls = 0;
    const fetchImpl = async () => { shellCalls += 1; return { json: async () => ({ ok: true, latitude: -37.81, longitude: 144.96 }) }; };
    const off = await deviceLocationTool.run({}, { meloHome: home, agentId: 'main', fetchImpl });
    assert.equal(off.error, 'LOCATION_NOT_ENABLED');
    assert.match(off.output, /On this computer/);
    assert.equal(shellCalls, 0);
    const on = await deviceLocationTool.run({}, { meloHome: home, agentId: 'research', fetchImpl });
    assert.equal(on.ok, true);
    assert.equal(shellCalls, 1);
    assert.equal(deviceLocationTool.requiresPermission, false, 'the switch is the consent, as on the phone');
  });
});
