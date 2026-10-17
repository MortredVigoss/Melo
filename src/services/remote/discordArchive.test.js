import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-17: user archived Discord alongside Telegram ("暂时归档 telegram
// discord 这些"). Same contract as telegramArchive.test.js: no polling, no
// outgoing REST, no gateway/voice client, HTTP 410 CHANNEL_ARCHIVED on every
// entry point, and the saved token / guild / channel ids survive untouched.
test('archived Discord performs no network, voice or state writes; saved data survives', { timeout: 60000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-discord-archive-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { loadState } from './src/state/stateStore.js';
    import { updateAgentProfile } from './src/services/agent/agentMutations.js';
    import { testAgentChannelConnection } from './src/services/agent/channelConnection.js';
    import { processDiscordPollingCycle } from './src/services/remote/discordPolling.js';
    import { discordApiRequest, sendDiscordMediaReply, pingDiscordChannel, fetchDiscordUpdates } from './src/services/remote/discordApi.js';
    import { getDiscordVoiceRuntime } from './src/services/remote/discordVoiceRuntime.js';
    import { summarizeAgentPrompt } from './src/services/chat/systemPrompt.js';
    import { ARCHIVED_AGENT_CHANNELS, isAgentChannelAvailable } from './src/shared/channelAvailability.js';
    assert.ok(ARCHIVED_AGENT_CHANNELS.includes('discord'));
    assert.equal(isAgentChannelAvailable('discord'), false);
    let requests = 0;
    globalThis.fetch = async () => { requests++; return { ok: true, json: async () => ({ id: 'bot', username: 'fixture' }) }; };
    const channel = { enabled: true, botToken: 'discord-fixture-token', guildId: 'guild-1', channelId: 'chan-1', voiceReply: true, lastUpdateId: '42' };
    await updateAgentProfile('main', { channels: { discord: channel } });
    await updateAgentProfile('main', { channels: { discord: channel } }, { scope: 'project', projectId: 'fixture-project' });
    const saved = structuredClone((await loadState()).agentProfiles.main.channels.discord);
    assert.equal(saved.botToken, channel.botToken);
    assert.equal(saved.guildId, channel.guildId);
    assert.equal(saved.channelId, channel.channelId);
    const before = await readFile(process.env.MELO_HOME + '/desktop/state.json', 'utf8');
    assert.deepEqual(await processDiscordPollingCycle(), { archived: true, hasActiveChannel: false, processedUpdateCount: 0, encounteredError: false });
    const archived = error => error.code === 'CHANNEL_ARCHIVED' && error.statusCode === 410 && error.permanent === true;
    await assert.rejects(testAgentChannelConnection('main', 'discord', { botToken: 'replacement' }), archived);
    await assert.rejects(discordApiRequest(channel, '/channels/chan-1/messages', { method: 'POST', body: { content: 'blocked' } }), archived);
    await assert.rejects(sendDiscordMediaReply(channel, { channelId: 'chan-1' }, Buffer.from('audio')), archived);
    await assert.rejects(pingDiscordChannel(channel), archived);
    await assert.rejects(fetchDiscordUpdates(channel), archived);
    const voice = getDiscordVoiceRuntime();
    await assert.rejects(voice._getClient('main', channel.botToken), archived);
    await assert.rejects(voice.handleTextCommand({ incoming: { content: '/join' }, agentId: 'main', profile: {}, discordChannel: channel, botUserId: 'bot', resolveConfig: () => ({}) }), archived);
    assert.equal(requests, 0, 'No HTTP request from polling, connection test, REST sends or voice runtime');
    assert.equal(await readFile(process.env.MELO_HOME + '/desktop/state.json', 'utf8'), before, 'Archive checks do not rewrite state');
    assert.doesNotMatch(summarizeAgentPrompt((await loadState()).agentProfiles.main), /Discord\\(bot linked/);
    await updateAgentProfile('main', { name: 'Renamed' });
    const after = await loadState();
    assert.deepEqual(after.agentProfiles.main.channels.discord, saved, 'Global Discord config preserved through unrelated edits');
    assert.deepEqual(after.projectAgentOverrides['fixture-project'].main.channels.discord, saved, 'Project Discord override preserved');
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), timeout: 55000,
    env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0' },
  });
  assert.equal(result.stderr.includes('Discord poll error'), false);
});
