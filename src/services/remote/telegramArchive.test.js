import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('archived Telegram performs no network or state writes; saved data survives', { timeout: 60000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-telegram-archive-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { loadState } from './src/state/stateStore.js';
    import { updateAgentProfile } from './src/services/agent/agentMutations.js';
    import { testAgentChannelConnection } from './src/services/agent/channelConnection.js';
    import { processTelegramPollingCycle } from './src/services/remote/telegramPolling.js';
    import { telegramApiRequest, telegramApiFormRequest, sendTelegramAudioReply } from './src/services/remote/telegramApi.js';
    import { summarizeAgentPrompt } from './src/services/chat/systemPrompt.js';
    let requests = 0;
    globalThis.fetch = async () => { requests++; return { ok: true, json: async () => ({ username: 'fixture' }) }; };
    const channel = { enabled: true, botToken: 'fixture-token', chatId: 'fixture-chat', voiceReply: true, lastUpdateId: 123 };
    await updateAgentProfile('main', { channels: { telegram: channel } });
    await updateAgentProfile('main', { channels: { telegram: channel } }, { scope: 'project', projectId: 'fixture-project' });
    const saved = structuredClone((await loadState()).agentProfiles.main.channels.telegram);
    const before = await readFile(process.env.MELO_HOME + '/desktop/state.json', 'utf8');
    assert.deepEqual(await processTelegramPollingCycle(), { archived: true, hasActiveChannel: false, processedUpdateCount: 0, encounteredError: false });
    const archived = error => error.code === 'CHANNEL_ARCHIVED' && error.statusCode === 410;
    await assert.rejects(testAgentChannelConnection('main', 'telegram', { botToken: 'replacement' }), archived);
    await assert.rejects(telegramApiRequest(channel, 'sendMessage', { body: { text: 'blocked' } }), archived);
    await assert.rejects(telegramApiFormRequest(channel, 'sendPhoto', new FormData()), archived);
    await assert.rejects(sendTelegramAudioReply(channel, { chatId: 'fixture' }, Buffer.from('invalid-audio')), archived);
    assert.equal(requests, 0, 'No HTTP request, including the connection test or audio conversion fallback');
    assert.equal(await readFile(process.env.MELO_HOME + '/desktop/state.json', 'utf8'), before, 'Archive checks do not rewrite state');
    assert.doesNotMatch(summarizeAgentPrompt((await loadState()).agentProfiles.main), /Telegram\\(bot linked/);
    await updateAgentProfile('main', { name: 'Renamed', channels: { discord: { botToken: 'discord-fixture', channelId: 'fixture' } } });
    // 2026-10-17: Discord is archived too, so its connection test is also
    // intercepted before any network call. See discordArchive.test.js.
    await assert.rejects(testAgentChannelConnection('main', 'discord'), archived);
    assert.equal(requests, 0, 'Archived Discord does not connect either');
    const after = await loadState();
    assert.deepEqual(after.agentProfiles.main.channels.telegram, saved);
    assert.deepEqual(after.projectAgentOverrides['fixture-project'].main.channels.telegram, saved);
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), timeout: 55000,
    env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0' },
  });
  assert.equal(result.stderr.includes('OGG conversion failed'), false);
});
