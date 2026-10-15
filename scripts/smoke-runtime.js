import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const baseUrl = process.env.MELO_SMOKE_BASE_URL || 'http://127.0.0.1:43129';
const execFileAsync = promisify(execFile);
async function request(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90000),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `${path}: ${payload.error || response.status}`);
  return payload;
}

// Refuse to mutate a user's running desktop, even if the caller picked its port.
const diagnostic = await request('/api/diagnostics');
assert.ok(process.env.MELO_HOME, 'MELO_HOME must point to the isolated smoke home');
assert.equal(diagnostic.config.mock, true, 'Smoke requires a mock model server');
assert.equal(diagnostic.paths.home, resolve(process.env.MELO_HOME));
const { stdout } = await execFileAsync(process.execPath, ['src/index.js', '--home', diagnostic.paths.home, 'doctor', '--json']);
const doctor = JSON.parse(stdout);
assert.equal(doctor.desktop.runtime.instanceId, diagnostic.desktop.runtime.instanceId);
assert.equal(doctor.config.model, diagnostic.config.model);
assert.equal(doctor.paths.configPath, diagnostic.paths.configPath);

const createdAgent = await request('/api/agents/create-custom', {});
const agentId = createdAgent.settings.selectedAgentId;
await request('/api/agents/update', {
  agentId, scope: 'global', patch: {
    name: 'Runtime regression agent', rolePrompt: 'Preserve this role during voice-only edits.', minimaxVoiceId: 'smoke-voice-before',
  },
});
await request('/api/settings', { activeView: 'customize', selectedCustomizeSection: 'agents', selectedAgentId: agentId });

const browser = await chromium.launch({
  executablePath: process.env.MELO_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const errors = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseUrl);
  assert.equal(await page.getByRole('dialog', { name: 'Productivity MCP consent' }).count(), 0);
  const form = page.locator(`form[data-form="agent-profile-update"][data-agent-id="${agentId}"]`);
  assert.equal(await form.locator('[name="minimaxVoiceId"]').isDisabled(),true,'Role settings start read-only');
  await form.locator('[data-action="form-settings-edit"]').click();
  await form.locator('[name="minimaxVoiceId"]').fill('smoke-voice-after');
  await form.locator('[name="ttsSpeed"]').fill('1.1');
  assert.equal(await form.evaluate(element => element.checkValidity()), true, 'Regression inputs must satisfy existing form constraints');
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/agents/update') && response.request().method() === 'POST', { timeout: 10000 }),
    form.locator('[data-action="form-settings-save"]').click(),
  ]);
  await page.reload();
  await form.waitFor();
  assert.equal(await form.locator('[name="name"]').inputValue(), 'Runtime regression agent');
  assert.equal(await form.locator('[name="rolePrompt"]').inputValue(), 'Preserve this role during voice-only edits.');
  assert.equal(await form.locator('[name="minimaxVoiceId"]').inputValue(), 'smoke-voice-after');
  assert.equal(Number(await form.locator('[name="ttsSpeed"]').inputValue()), 1.1);

  const createdChat = await request('/api/chats', { mode: 'chat', agentId });
  const chatId = createdChat.settings.selectedChatId;
  const keyword = `runtime-oolong-${Date.now()}`;
  const sent = await request('/api/chat/send', {
    chatId, mode: 'chat', content: 'Keep this recorded note for later.',
    attachments: [{ id: 'smoke-audio', kind: 'audio', url: 'data:audio/wav;base64,UklGRg==', fileName: 'fixture.wav' }],
    extractedMedia: [{ attachmentId: 'smoke-audio', kind: 'transcript', text: `I prefer ${keyword} tea.`, metadata: { source: 'native-speech-recognition' } }],
  });
  assert.ok(sent.assistantMessage?.content || sent.bootstrap?.activeChat?.messages?.some(message => message.role === 'assistant'));
  const restored = await request('/api/bootstrap');
  const audioMessage = restored.activeChat.messages.find(message => message.extractedMedia?.some(media => media.text.includes(keyword)));
  assert.ok(audioMessage, 'Transcript must survive normalization and persistence');
  const searched = await request(`/api/bootstrap?q=${encodeURIComponent(keyword)}`);
  assert.ok(JSON.stringify(searched.search).includes(keyword), 'Persisted transcript must be searchable');

  await request('/api/chat/send', {
    chatId, mode: 'chat', content: Array.from({ length: 75 }, (_, index) => `Regression paragraph ${index}: preserve the scroll position when the viewport changes.`).join('\n\n'),
  });
  await request('/api/settings', { activeView: 'chat', selectedChatId: chatId });
  await page.reload();
  const scroller = page.locator('.thread-scroll-region');
  await scroller.waitFor();
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.setViewportSize({ width: 1390, height: 960 });
  await page.waitForFunction(() => {
    const element = document.querySelector('.thread-scroll-region');
    return element && element.scrollHeight - element.scrollTop - element.clientHeight < 64;
  });
  await page.screenshot({ path: resolve(process.env.MELO_HOME, 'runtime-chat-smoke.png') });

  await request('/api/settings', { activeView: 'customize', selectedCustomizeSection: 'advanced' });
  await page.reload();
  await page.locator('.runtime-diagnostics').waitFor();
  assert.ok((await page.locator('.runtime-diagnostics').boundingBox()).width > 400, 'Advanced diagnostics must not be squeezed into the item-list column');
  await page.locator('.runtime-diagnostics').getByText('运行环境与存储', { exact: true }).click();
  assert.ok((await page.locator('.runtime-diagnostics').innerText()).includes(diagnostic.paths.home));
  await page.screenshot({ path: resolve(process.env.MELO_HOME, 'runtime-panel-smoke.png') });
  await page.setViewportSize({ width: 900, height: 900 });
  assert.ok(await page.locator('.page-advanced').evaluate(element => element.scrollWidth <= element.clientWidth + 2), 'Advanced pane must fit the narrow layout');
  assert.deepEqual(errors, [], 'No uncaught frontend exceptions');
  const finalDiagnostic = await request('/api/diagnostics');
  assert.notEqual(finalDiagnostic.capabilities.find(entry => entry.id === 'model').status, 'green', 'Mock responses must never report green');
  process.stdout.write('Runtime smoke passed: CLI/server identity, voice-only save + reload, transcript persistence + search, chat scrolling, rendered diagnostics, no frontend exceptions.\n');
} catch (error) {
  if (page) {
    await page.screenshot({ path: resolve(process.env.MELO_HOME, 'runtime-failed-smoke.png') }).catch(() => {});
    process.stderr.write(JSON.stringify({ errors, notices: await page.locator('.error-banner, .toast, [role="alert"]').allTextContents() }) + '\n');
  }
  throw error;
} finally {
  await browser.close();
}
