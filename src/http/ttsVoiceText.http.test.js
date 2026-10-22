// Per-Agent voice through the real server (2026-10-22): /api/tts/voice-text
// answers with the Agent's mode and the text to speak; a TTS request that
// names an Agent is synthesised with that Agent's voice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('voice-text follows the Agent card: summary extracts, full and off pass through, unknown Agents read in full', { timeout: 60000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-tts-voice-'));
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'exit');
  t.after(async () => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM');
    await closed;
    clearTimeout(kill);
    await rm(home, { recursive: true, force: true });
  });
  let log = '';
  child.stderr.on('data', chunk => { log += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(log.slice(-1000))), 15000);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(log.slice(-1000))); });
    child.stdout.on('data', chunk => {
      log += chunk;
      const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  };
  // The Agent card settings (no voice style instructions, so no model is called).
  for (const [agentId, voiceReplyMode] of [['research', 'off'], ['builder', 'full']]) {
    assert.equal((await post('/api/agents/update', { agentId, patch: { voiceReplyMode }, scope: 'global' })).status, 200);
  }
  const text = '首先，我查了三个来源。然后我比较了它们的说法。最终结论：墨尔本明天晴，最高 30 度，带件薄外套就够了。附带说明：数据来自气象局。';

  const summary = await post('/api/tts/voice-text', { text, agentId: 'main' });
  assert.equal(summary.status, 200);
  assert.equal(summary.body.mode, 'summary', 'a known Agent defaults to the brief spoken summary');
  assert.match(summary.body.text, /墨尔本明天晴/);

  const off = await post('/api/tts/voice-text', { text, agentId: 'research' });
  assert.deepEqual(off.body, { ok: true, mode: 'off', text });

  const full = await post('/api/tts/voice-text', { text, agentId: 'builder' });
  assert.deepEqual(full.body, { ok: true, mode: 'full', text });

  const nobody = await post('/api/tts/voice-text', { text, agentId: 'nobody' });
  assert.deepEqual(nobody.body, { ok: true, mode: 'full', text });

  assert.equal((await post('/api/tts/voice-text', { agentId: 'main' })).status, 400);
});
