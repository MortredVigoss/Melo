import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenAICompatibleReply, discoverAvailableModels } from '../openai.js';
import { createRequestContext } from '../runtime/requestContext.js';
import { runWithRequestContext } from '../runtime/requestScope.js';
import { readCapabilityEvidence } from '../runtime/capabilities.js';

test('API-key transport preserves compatible paths and rejects incomplete provider replies', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-api-compat-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: req.url, key: req.headers.authorization, body });
    res.setHeader('content-type', body?.stream ? 'text/event-stream' : 'application/json');
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'vendor/model-v1' }] })); return; }
    if (body.model === 'denied') { res.writeHead(401); res.end('{"error":{"message":"Invalid fixture key"}}'); return; }
    if (body.stream) {
      res.write(': heartbeat\r\n\r\n');
      res.write(`data: ${JSON.stringify({ model: 'vendor/model-v1', choices: [{ delta: { content: '你好 API' }, finish_reason: null }] })}\r\n\r\n`);
      if (body.model !== 'truncated' && body.model !== 'done-only') {
        const finish_reason = body.model === 'length' ? 'length' : 'stop';
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason }] })}\n\n`);
      }
      if (body.model !== 'truncated' && body.model !== 'stop-only') res.write('data: [DONE]\n\n');
      res.end(); return;
    }
    res.end(JSON.stringify({ model: 'vendor/model-v1', choices: body.model === 'empty' ? [] : [{ message: { content: '你好 API' }, ...(body.model === 'length' ? { finish_reason: 'length' } : {}) }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = createRequestContext({ home, env: { MELO_MOCK_RESPONSE: '', NODE_TEST_CONTEXT: '', MELO_DIAGNOSTICS_RECORD: '1' } });
  const invoke = (model, { stream = false, path = '/v1' } = {}) => runWithRequestContext(context, async () => {
    let receipt; const deltas = [];
    const text = await createOpenAICompatibleReply({ authMode: 'api-key', apiKey: 'fixture-key', baseUrl: base + path,
      model, systemPrompt: 'Test only', messages: [{ role: 'user', content: 'Hello' }],
      ...(stream ? { onDelta: value => deltas.push(value.delta) } : {}), onProviderResponse: value => { receipt = value; } });
    return { text, receipt, deltas };
  });
  await t.test('JSON replies keep model identity and provider-specific base paths', async () => {
    for (const path of ['/api/v3', '/v1beta/openai', '/api/v1']) {
      const answer = await invoke('selected-model', { path });
      assert.equal(answer.text, '你好 API');
      assert.equal(answer.receipt.reportedModel, 'vendor/model-v1');
      assert.equal((await readCapabilityEvidence(home)).model.reportedModel, 'vendor/model-v1');
      assert.equal(requests.at(-1).path, path + '/chat/completions');
      assert.equal(requests.at(-1).key, 'Bearer fixture-key');
      assert.equal(requests.at(-1).body.model, 'selected-model');
    }
  });
  await t.test('empty JSON fails without a successful capability receipt', async () => {
    await assert.rejects(invoke('empty'), /empty|without.*reply/i);
    assert.equal((await readCapabilityEvidence(home)).model.ok, false);
  });
  await t.test('EOF with partial text but no completion event fails', async () => {
    await assert.rejects(invoke('truncated', { stream: true }), /incomplete|before.*complet/i);
    assert.equal((await readCapabilityEvidence(home)).model.ok, false);
  });
  await t.test('token limit termination is not a complete answer', async () => {
    await assert.rejects(invoke('length'), /length|limit/i);
    await assert.rejects(invoke('length', { stream: true }), /length|limit/i);
  });
  await t.test('compatible streams accept stop or DONE and preserve Unicode text', async () => {
    for (const model of ['stop-only', 'done-only', 'normal']) {
      const answer = await invoke(model, { stream: true });
      assert.equal(answer.text, '你好 API'); assert.deepEqual(answer.deltas, ['你好 API']);
      assert.equal(answer.receipt.reportedModel, 'vendor/model-v1');
    }
  });
  await t.test('401 is an error and model discovery retains namespaced IDs', async () => {
    await assert.rejects(invoke('denied'), /401.*Invalid fixture key/);
    const models = await runWithRequestContext(context, () => discoverAvailableModels({ authMode: 'api-key', apiKey: 'fixture-key', baseUrl: base + '/api/v3' }));
    assert.deepEqual(models, ['vendor/model-v1']);
  });
});
