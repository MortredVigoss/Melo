import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';

test('Telegram archive survives startup, HTTP tests and Agent edits without deleting history', { timeout: 60000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-telegram-ui-'));
  let requests = 0;
  const trap = createServer((req, res) => { requests++; res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"result":[]}'); });
  trap.listen(0, '127.0.0.1'); await once(trap, 'listening');
  await mkdir(join(home, 'desktop'));
  const telegram = { enabled: true, botToken: 'fixture-preserved-secret', chatId: 'fixture-chat', lastUpdateId: 123, voiceReply: true };
  const discord = { enabled: true, botToken: 'fixture-discord-secret', guildId: '1', channelId: 'discord-preserved', lastUpdateId: '9', voiceReply: true };
  const savedDiscordChannelId = discord.channelId;
  await writeFile(join(home, 'desktop/state.json'), JSON.stringify({
    agentProfiles: { main: { channels: { telegram, discord } } },
    chats: [{ id: 'telegram-history', title: 'Telegram history retained', agentId: 'main', source: 'telegram', messages: [{ id: 'history-message', role: 'user', content: 'Keep this history', createdAt: new Date().toISOString() }] }],
    settings: { activeView: 'agent', selectedAgentId: 'main' },
  }));
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
    env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0', MELO_TELEGRAM_API_BASE: `http://127.0.0.1:${trap.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'exit'); let browser;
  t.after(async () => { await browser?.close(); child.kill('SIGTERM'); await closed; await new Promise(resolve => trap.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const base = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => { log += chunk; const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited before startup')); });
  });
  const boot = async () => (await fetch(base + '/api/bootstrap')).json();
  const initial = (await boot()).customize.agents.find(agent => agent.id === 'main');
  const savedTelegram = initial.channels.find(channel => channel.id === 'telegram');
  assert.equal(savedTelegram.archived, true); assert.equal(savedTelegram.statusLabel, 'Archived');
  assert.equal(savedTelegram.enabled, true); assert.equal(savedTelegram.botToken, telegram.botToken);
  const blocked = await fetch(base + '/api/agents/channel/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'main', channelId: 'telegram', patch: { botToken: 'do-not-save' } }) });
  assert.equal(blocked.status, 410); assert.equal((await blocked.json()).code, 'CHANNEL_ARCHIVED');
  await assert.rejects(access(join(home, 'telegram-poller.lock')), { code: 'ENOENT' });
  await assert.rejects(access(join(home, 'discord-poller.lock')), { code: 'ENOENT' });
  const blockedDiscord = await fetch(base + '/api/agents/channel/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'main', channelId: 'discord', patch: { botToken: 'do-not-save' } }) });
  assert.equal(blockedDiscord.status, 410); assert.equal((await blockedDiscord.json()).code, 'CHANNEL_ARCHIVED');
  browser = await launchTestChrome(chromium);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ activeView: 'agent', selectedAgentId: 'main' }) });
  await page.goto(base);
  const form = page.locator('form[data-form=agent-profile-update]'); await form.waitFor();
  await form.locator('[data-action=form-settings-edit]').click();
  if (await form.locator('.agent-channels>summary').count()) await form.locator('.agent-channels>summary').click();
  assert.equal(await form.locator('[name^=telegram],[data-channel-id=telegram]').count(), 0);
  assert.equal(await form.locator('[name=voiceReplyMode]').isVisible(), true);
  // 2026-10-17: Discord archived too — no Discord inputs, no channel tabs, but
  // the shared voice card stays editable and saved Discord config survives.
  assert.equal(await form.locator('[name^=discord],[data-channel-id=discord]').count(), 0);
  assert.equal(await form.locator('[data-action=switch-agent-channel-tab]').count(), 0);
  await form.locator('[name=name]').fill('Archive preservation');
  await form.locator('[name=voicePersonality]').fill('Preserve accessible voice settings');
  await form.locator('[data-action=form-settings-save]').click(); await form.locator('[data-edit-status=saved]').waitFor();
  const after = await boot(), agent = after.customize.agents.find(agent => agent.id === 'main');
  assert.deepEqual(agent.channels.find(channel => channel.id === 'telegram'), savedTelegram);
  assert.equal(agent.channels.find(channel => channel.id === 'discord').archived, true);
  assert.equal(agent.channels.find(channel => channel.id === 'discord').channelId, savedDiscordChannelId);
  assert.equal(agent.voicePersonality, 'Preserve accessible voice settings');
  assert.ok(after.chats.some(chat => chat.id === 'telegram-history'));
  assert.equal(requests, 0, 'Old enabled flag never starts Telegram polling');
  assert.deepEqual(errors, []);
});
