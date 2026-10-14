import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { atomicWriteJson } from '../storage.js';

test('HTTP rejects foreign-origin execution and approvals; startup delivers persisted reminders', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'melo-http-audit-fixes-'));
  await atomicWriteJson(join(root, 'desktop/state.json'), {
    chats: [{ id: 'reminder-chat', title: 'Reminder fixture', mode: 'chat', agentId: 'main', source: 'desktop', messages: [] }],
    settings: { selectedChatId: 'reminder-chat' },
  });
  await atomicWriteJson(join(root, 'reminders.json'), [{ id: 'overdue-test', chatId: 'reminder-chat', text: 'Boot recovery fixture', fireAt: 1 }]);
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, MELO_HOME: root, MELO_TEST_MODE: '1', MELO_MOCK_RESPONSE: 'isolated test',
      MELO_DREAMING_ENABLED: '0', MELO_DIAGNOSTICS_RECORD: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', chunk => { logs += chunk; });
  const closed = once(child, 'exit');
  t.after(async () => {
    const force = setTimeout(() => child.kill('SIGKILL'), 6000);
    child.kill('SIGTERM');
    await closed;
    clearTimeout(force);
    await rm(root, { recursive: true, force: true });
  });
  const base = await new Promise((resolveBase, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${logs.slice(-1500)}`)), 20000);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Server exited: ${logs.slice(-1500)}`)); });
    child.stdout.on('data', chunk => {
      logs += chunk;
      const match = logs.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolveBase(match[1]); }
    });
  });
  async function post(path, body, origin = base) {
    return fetch(base + path, { method: 'POST', headers: { 'content-type': 'text/plain', origin },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  }
  const denied = await post('/api/background-tasks/run', { command: 'printf blocked > blocked.txt', workspacePath: root }, 'https://untrusted.example');
  assert.equal(denied.status, 403);
  await assert.rejects(access(join(root, 'blocked.txt')), { code: 'ENOENT' });

  const stream = await post('/api/background-tasks/run', { command: 'printf approved > approved.txt', workspacePath: root });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  let data = '';
  while (!/event: tool_permission\ndata: [^\n]+\n/.test(data)) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    data += new TextDecoder().decode(chunk.value);
  }
  const permission = JSON.parse(data.match(/event: tool_permission\ndata: ([^\n]+)/)[1]);
  await assert.rejects(access(join(root, 'approved.txt')), { code: 'ENOENT' });
  assert.doesNotMatch(data, /event: started/);
  const decision = { kind: 'file_safety', requestId: permission.requestId, granted: true, scope: 'once' };
  assert.equal((await post('/api/tools/permission-response', decision, 'https://untrusted.example')).status, 403);
  assert.equal((await (await post('/api/tools/permission-response', decision)).json()).ok, true);
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    data += new TextDecoder().decode(chunk.value);
  }
  assert.match(data, /event: started/);
  assert.match(data, /event: done/);
  assert.equal(await readFile(join(root, 'approved.txt'), 'utf8'), 'approved');
  await post('/api/settings', { selectedChatId: 'reminder-chat' });
  const boot = await (await fetch(base + '/api/bootstrap')).json();
  assert.ok(boot.activeChat.messages.some(message => message.id === 'reminder_overdue-test'));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'reminders.json'), 'utf8')), []);
  // A second server using this home must remain blocked even on another port.
  const duplicate = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, MELO_HOME: root, MELO_TEST_MODE: '1', MELO_MOCK_RESPONSE: 'isolated test', MELO_DREAMING_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let duplicateLog = '';
  duplicate.stderr.on('data', chunk => { duplicateLog += chunk; });
  duplicate.stdout.resume();
  const duplicateTimeout = setTimeout(() => duplicate.kill('SIGKILL'), 10000);
  await once(duplicate, 'exit');
  clearTimeout(duplicateTimeout);
  assert.match(duplicateLog, /Another Melo server instance/);
  assert.equal((await fetch(base + '/api/health')).ok, true);

  // Exercise pre-model media extraction through HTTP; a mock model cannot
  // manufacture these requests, and the positive case prevents false greens.
  const hits = [];
  const fixture = createServer((req, res) => {
    hits.push(req.url);
    res.setHeader('content-type', 'text/html');
    res.end('<html><title>Local fixture</title><body><article>' + 'Local test content. '.repeat(80) + '</article></body></html>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/report`;
  for (const content of [
    `不要打开 ${fixtureUrl} ，只解释网址结构`,
    `翻译这句话："Open ${fixtureUrl}"`,
    `解释代码：\`fetch("${fixtureUrl}")\``,
  ]) {
    const result = await post('/api/chat/send', { chatId: 'reminder-chat', mode: 'chat', content });
    assert.equal(result.ok, true, await result.text());
    assert.deepEqual(hits, [], content);
  }
  const readResult = await post('/api/chat/send', {
    chatId: 'reminder-chat', mode: 'chat', content: `读取 ${fixtureUrl}。`,
  });
  assert.equal(readResult.ok, true, await readResult.text());
  assert.ok(hits.includes('/report'), 'explicit read must fetch the clean URL');
  assert.ok(hits.every(path => path === '/report'), 'prose punctuation must not be sent to the server');
  const diagnostics = await (await fetch(base + '/api/diagnostics')).json();
  assert.equal(diagnostics.paths.home, resolve(root));
});
