import test from 'node:test';
import assert from 'node:assert/strict';
import { shellRequest, observeShellWeb } from './shellWebObservation.js';
import { observeTool } from './executionObservation.js';
import { createExecutionScene, applyExecutionEvent, finishExecutionScene, moduleActivity, visibleSceneSources } from '../shared/executionScene.js';
import { recoverSceneObservations, executionSearchContext } from '../services/chat/executionScenes.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashTool } from './builtins/bashTool.js';
import { executeToolCalls } from './executor.js';
import { resolveFileSafety } from '../safety/fileSafetyGate.js';
import { createExecutionRecorder, readExecutionScene } from '../services/chat/executionScenes.js';

const command = 'curl -sSL --max-time 20 "https://www.bing.com/search?q=neurons&format=rss" | head -c 8000';
const rss = count => `<rss><channel><title>Bing: neurons</title><link>https://www.bing.com/search?q=neurons</link>${Array.from({ length: count }, (_, i) => `<item><title>${i === 12 ? 'Neurons target' : `Page ${i}`}</title><link>https://example.test/${i}</link><description>Actual summary ${i}</description></item>`).join('')}</channel></rss>`;

test('real shell HTTP response travels through the executor and persistence, and stays waiting until permission', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-shell-observation-'));
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/rss+xml'); res.end(rss(24)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const recorder = createExecutionRecorder({ home, runId: 'actual-curl', chatId: 'fixture' }, 'neurons');
  let prompts = 0;
  const results = await executeToolCalls([{ id: 'curl', tool: bashTool, args: { command: `curl -sSL --max-time 5 http://127.0.0.1:${server.address().port}/search?q=neurons` } }], {
    meloHome: home, workspacePath: home, chatId: 'fixture',
    sseEmitter(type, event) {
      if (type === 'execution_event') recorder.event(event);
      if (type === 'tool_permission') {
        prompts++; assert.equal(moduleActivity(recorder.scene, 'search').status, 'waiting');
        assert.equal(recorder.scene.operations[0].startedAt, undefined);
        queueMicrotask(() => resolveFileSafety(event.requestId, 'once'));
      }
    },
  });
  assert.equal(prompts, 1); assert.equal(results[0].result.ok, true);
  await recorder.finish('completed');
  const saved = await readExecutionScene(home, 'actual-curl');
  assert.equal(saved.sources.length, 24); assert.equal(saved.operations[0].status, 'completed');
  assert.ok(saved.operations[0].startedAt); assert.equal(saved.operations[0].output.length, 2200);
});

test('actual curl lifecycle activates search, extracts all RSS sources before output truncation, and caps display only', () => {
  const scene = createExecutionScene({ runId: 'curl', query: 'neurons' });
  for (const status of ['queued', 'running']) applyExecutionEvent(scene, observeTool({ id: 'call', name: 'bash', args: { command }, status }));
  assert.equal(moduleActivity(scene, 'search').status, 'running');
  assert.equal(scene.sources.length, 0);
  const stdout = rss(24);
  applyExecutionEvent(scene, observeTool({ id: 'call', name: 'bash', args: { command }, result: { ok: true, output: stdout, meta: { stdout, exitCode: 0 } } }));
  finishExecutionScene(scene);
  assert.equal(scene.operations.length, 1);
  assert.equal(scene.operations[0].output.length, 2200);
  assert.equal(moduleActivity(scene, 'search').status, 'completed');
  assert.equal(scene.sources.length, 24);
  assert.equal(visibleSceneSources(scene).length, 5);
  assert.equal(visibleSceneSources(scene, true).length, 10);
  assert.equal(visibleSceneSources(scene)[0].title, 'Neurons target');
  assert.ok(scene.sources.every(s => s.appeared && !s.accessed && s.reading === 'snippet'));
});

test('denied/failed curl and text containing commands never invent a visit', () => {
  for (const cmd of ['echo curl https://example.test', 'false && curl https://example.test', 'python3 script.py', 'cat saved.xml', 'curl -H "Origin: https://origin.test"', 'curl -d "url=https://example.test" https://api.test', 'curl "https://example.test?token=secret"', 'curl "https://example.test/unclosed']) {
    assert.equal(shellRequest(cmd), null, cmd);
    assert.equal(observeShellWeb({ command: cmd }, { ok: true, output: rss(10) }), null, cmd);
  }
  const denied = observeTool({ id: 'denied', name: 'bash', args: { command }, result: { ok: false, meta: { denied: true }, output: rss(3) } });
  assert.equal(denied.status, 'failed'); assert.deepEqual(denied.sources, []);
});

test('Google JS response is a search attempt with no invented results; real HTML result is only a snippet', () => {
  const args = { command: 'curl -sL "https://www.google.com/search?q=neurons"' };
  const blocked = observeShellWeb(args, { ok: true, meta: { stdout: '<html><title>Google Search</title><a href="/httpservice/retry/enablejs">Enable JavaScript</a></html>' } });
  assert.equal(blocked.module, 'search'); assert.equal(blocked.sources.length, 0); assert.match(blocked.resultSummary, /JavaScript/);
  const parsed = observeShellWeb(args, { ok: true, meta: { stdout: '<html><title>Google Search</title><div class="g"><a href="https://example.test/target"><h3>Neurons</h3></a><div class="VwiC3b">Returned snippet</div></div><a href="https://unrelated.test/">footer</a></html>' } });
  assert.equal(parsed.sources.length, 1); assert.equal(parsed.sources[0].reading, 'snippet'); assert.ok(!parsed.sources[0].accessed);
});

test('legacy recovery is deterministic, preserves terminal history and never completes an ambiguous truncated URL', () => {
  const target = 'https://example.test/user/' + 'long-real-identifier'.repeat(4);
  const scene = createExecutionScene({ runId: 'old', query: '再去看看' });
  const prefix = rss(4).replace('</channel></rss>', '') + `<item><title>Neurons target</title><link>${target.slice(0, -8)}`;
  applyExecutionEvent(scene, { kind: 'operation', id: 'call', name: 'bash', module: 'tools', status: 'running', at: '2026-10-07T00:00:00Z' });
  applyExecutionEvent(scene, { kind: 'operation', id: 'call', name: 'bash', module: 'tools', status: 'completed', output: prefix, at: '2026-10-07T00:00:10Z' });
  finishExecutionScene(scene, { at: '2026-10-07T00:00:20Z' });
  const before = structuredClone(scene);
  const history = { message: { content: `[Target](${target})` }, searchContext: 'neurons target' };
  const restored = recoverSceneObservations(scene, history);
  assert.deepEqual(scene, before);
  assert.equal(restored.status, 'completed'); assert.equal(restored.finishedAt, scene.finishedAt);
  assert.deepEqual(restored.events, scene.events); assert.equal(restored.restSeed, scene.restSeed);
  assert.deepEqual(restored.selectedImageIds, scene.selectedImageIds);
  assert.equal(restored.operations[0].finishedAt, scene.operations[0].finishedAt);
  assert.equal(restored.sources.length, 5); assert.equal(moduleActivity(restored, 'search').status, 'completed');
  const source = restored.sources.find(s => s.url === target);
  assert.ok(source.appeared && source.cited && source.recovered); assert.equal(source.accessed, false); assert.equal(source.reading, 'unknown');
  assert.deepEqual(recoverSceneObservations(scene, history), restored);
  assert.deepEqual(recoverSceneObservations(restored, history), restored);
  const ambiguous = observeShellWeb({}, { ok: true, output: prefix }, { citationUrls: [target, target + 'other'] });
  assert.equal(ambiguous.sources.length, 4);
});

test('follow-up relevance uses actual prior user context without treating citations as proof of visits', () => {
  assert.equal(executionSearchContext([{ role: 'user', content: 'find neurons' }], '再去看看'), 'find neurons');
  assert.equal(executionSearchContext([{ role: 'user', content: 'find neurons' }], '北京明天天气'), '');
  const scene = createExecutionScene({ runId: 'citation', query: '再去看看' }); finishExecutionScene(scene);
  const restored = recoverSceneObservations(scene, { message: { content: '[Neurons](https://example.test)' } });
  assert.equal(restored.operations.length, 0); assert.equal(restored.sources[0].cited, true); assert.equal(restored.sources[0].accessed, false);
  assert.equal(moduleActivity(restored, 'search').status, 'recorded');
});
